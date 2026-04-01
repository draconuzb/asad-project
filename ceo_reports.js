const storage = require('./storage');
const { formatDbDateStr, formatNumber, normalizeMonthKey } = require('./utils');
const { generatePdfReport } = require('./pdf_generator');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('./logger');

/**
 * Compute delta between current and previous values.
 * Returns a formatted string like "↑ +33%" or "↓ -12%" or "—" if no previous data.
 */
function computeDelta(current, previous, lang = 'uz') {
    const { t } = require('./i18n');
    if (previous === 0 && current === 0) return t(lang, 'delta_same');
    if (previous === 0) return current > 0 ? t(lang, 'delta_new') : t(lang, 'delta_same');
    const diff = current - previous;
    const pct = ((diff / Math.abs(previous)) * 100).toFixed(0);
    if (diff > 0) return t(lang, 'delta_up', { pct });
    if (diff < 0) return t(lang, 'delta_down', { pct: -Math.abs(pct) });
    return t(lang, 'delta_same');
}

/**
 * Get the previous date in YYYY-MM-DD format.
 */
function getPrevDateYmd(dateYmd, daysBefore = 1) {
    const [y, m, d] = dateYmd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - daysBefore);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Get the previous week range (Mon-Sun) from a given start date.
 */
function getPrevWeekRange(startYmd) {
    return { start: getPrevDateYmd(startYmd, 7), end: getPrevDateYmd(startYmd, 1) };
}

/**
 * Get the previous month range from target month/year.
 */
function getPrevMonthRange(year, month) {
    const prevDt = new Date(Date.UTC(year, month - 2, 1));
    const prevY = prevDt.getUTCFullYear();
    const prevM = prevDt.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
    return {
        start: `${prevY}-${String(prevM).padStart(2, '0')}-01`,
        end: `${prevY}-${String(prevM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    };
}

/**
 * Generate a daily CEO report using DATE-FILTERED data for the target date
 * and CUMULATIVE data for ongoing status indicators.
 */
async function generateDailyReport(targetDateYmd, lang = 'uz') {
    const { t } = require('./i18n');
    const todayYmd = storage.getTodayString();
    const [y, m, d] = targetDateYmd.split('-').map(Number);
    const rawMonthName = t('uz', `month_${m}`); // Always use Uzbek for internal key
    const monthContext = normalizeMonthKey(`${rawMonthName} ${y}`);
    const monthName = t(lang, `month_${m}`); // Localized month name for display
    
    // 1. Fetch Data
    const dayData = await storage.fetchAllData(targetDateYmd, targetDateYmd, monthContext);
    
    const yesterdayYmd = getPrevDateYmd(targetDateYmd, 1);
    const yesterdayData = await storage.fetchAllData(yesterdayYmd, yesterdayYmd);
    
    const startOfMonthYmd = `${y}-${String(m).padStart(2, '0')}-01`;
    const mtdData = await storage.fetchAllData(startOfMonthYmd, targetDateYmd, monthContext, true);

    
    // For Empty Rooms — use live data for today/future, historical snapshot for past
    let emptyRooms = [];
    let potentialData = null;
    let hasHistoricalSnapshot = false;
    if (targetDateYmd >= todayYmd) {
        emptyRooms = await storage.getEmptyRooms();
    } else {
        // Try historical snapshot
        const historicalRooms = await storage.getEmptyRoomsForDate(targetDateYmd);
        if (historicalRooms !== null) {
            emptyRooms = historicalRooms;
            hasHistoricalSnapshot = true;
            potentialData = await storage.calculatePotentialIncomeForDate(targetDateYmd);
        }
    }
    
    const displayDate = formatDbDateStr(targetDateYmd);
    
    // Introductory text
    let summary = t(lang, 'report_daily_title') + '\n';
    summary += t(lang, 'report_date_label', { date: formatDbDateStr(targetDateYmd) }) + '\n\n';
    summary += t(lang, 'report_intro_daily') + '\n\n';
    
    // --- SECTION 1: KUNLIK HOLAT ---
    summary += t(lang, 'sec_daily', { date: targetDateYmd.split('-').reverse().join('.') }) + '\n';
    
    // Leads Delta
    const lToday = dayData.leadsTotal || 0;
    const lYest = yesterdayData.leadsTotal || 0;
    summary += t(lang, 'metric_leads', { count: lToday, delta: computeDelta(lToday, lYest, lang) }) + '\n';
    
    // Rejections Delta
    const rToday = dayData.rejectionsTotal || 0;
    const rYest = yesterdayData.rejectionsTotal || 0;
    summary += t(lang, 'metric_rejections', { count: rToday, delta: computeDelta(rToday, rYest, lang) }) + '\n';
    
    // Debtors — show cumulative balance per month
    const qarzBalances = await storage.getQarzdorlarBalance();
    const qarzMonths = Object.keys(qarzBalances);
    if (qarzMonths.length > 0) {
        let totalQarzAmt = 0, totalQarzCount = 0;
        for (const qm of qarzMonths) {
            totalQarzAmt += qarzBalances[qm].amount;
            totalQarzCount += qarzBalances[qm].count;
        }
        summary += t(lang, 'metric_debtors', { count: totalQarzCount, amount: formatNumber(totalQarzAmt, lang) }) + '\n';
        for (const qm of qarzMonths) {
            const b = qarzBalances[qm];
            if (b.amount === 0 && b.count === 0) continue;
            summary += `   📅 ${qm}: ${formatNumber(b.amount, lang)} ${t(lang, 'unit_som')} / ${b.count} ${t(lang, 'unit_student')}\n`;
        }
        summary += '\n';
    } else {
        summary += t(lang, 'metric_debtors', { count: 0, amount: formatNumber(0, lang) }) + '\n\n';
    }
    
    // Daily Finance Delta
    summary += t(lang, 'sec_finance') + '\n';
    
    // Norasmiy Block
    const nKirimToday = parseFloat(dayData.finance.income_norasmiy) || 0;
    const nKirimYest = parseFloat(yesterdayData.finance.income_norasmiy) || 0;
    const nChiqimToday = parseFloat(dayData.finance.expense_norasmiy) || 0;
    const nChiqimYest = parseFloat(yesterdayData.finance.expense_norasmiy) || 0;
    const nQoldiqToday = nKirimToday - nChiqimToday;
    const nQoldiqYest = nKirimYest - nChiqimYest;
    
    summary += `   ` + t(lang, 'fin_norasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: formatNumber(nKirimToday, lang), delta: computeDelta(nKirimToday, nKirimYest, lang) }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: formatNumber(nChiqimToday, lang), delta: computeDelta(nChiqimToday, nChiqimYest, lang) }) + `\n`;
    
    if (dayData.finance.expense_details && dayData.finance.expense_details.length > 0) {
        const maxExpenseItems = 15;
        dayData.finance.expense_details.slice(0, maxExpenseItems).forEach(exp => {
            summary += `         🔸 ${exp.type}: ${formatNumber(exp.amount, lang)} ` + t(lang, 'unit_som') + `\n`;
        });
        if (dayData.finance.expense_details.length > maxExpenseItems) {
            summary += `         ... +${dayData.finance.expense_details.length - maxExpenseItems} ` + t(lang, 'more_items') + `\n`;
        }
    }
    
    summary += `     ` + t(lang, 'fin_balance', { amount: formatNumber(nQoldiqToday, lang), delta: computeDelta(nQoldiqToday, nQoldiqYest, lang) }) + `\n`;
    
    // Rasmiy Block
    const rKirimToday = parseFloat(dayData.finance.income_rasmiy) || 0;
    const rKirimYest = parseFloat(yesterdayData.finance.income_rasmiy) || 0;
    const rChiqimToday = parseFloat(dayData.finance.expense_rasmiy) || 0;
    const rChiqimYest = parseFloat(yesterdayData.finance.expense_rasmiy) || 0;
    const rQoldiqToday = rKirimToday - rChiqimToday;
    const rQoldiqYest = rKirimYest - rChiqimYest;
    
    summary += `   ` + t(lang, 'fin_rasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: formatNumber(rKirimToday, lang), delta: computeDelta(rKirimToday, rKirimYest, lang) }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: formatNumber(rChiqimToday, lang), delta: computeDelta(rChiqimToday, rChiqimYest, lang) }) + `\n`;
    summary += `     ` + t(lang, 'fin_balance', { amount: formatNumber(rQoldiqToday, lang), delta: computeDelta(rQoldiqToday, rQoldiqYest, lang) }) + `\n\n`;

    const probTotal = dayData.problems.length || 0;
    summary += t(lang, 'sec_problems', { count: probTotal }) + '\n';
    
    const davomadPerc = dayData.attendance.expected > 0 
        ? ((dayData.attendance.attended / dayData.attendance.expected) * 100).toFixed(1) 
        : 0;
    summary += t(lang, 'metric_attendance_daily', { percent: davomadPerc }) + '\n\n';
    
    
    // --- SECTION 2: OYLIK HOLAT ---
    summary += t(lang, 'sec_monthly', { month: monthName.toUpperCase(), year: y }) + '\n';
    
    const mtdLeads = mtdData.leadsTotal || 0;
    summary += t(lang, 'metric_leads_mtd', { count: mtdLeads }) + '\n';
    if (mtdData.leads && Object.keys(mtdData.leads).length > 0) {
        for (const [sub, count] of Object.entries(mtdData.leads).sort((a, b) => b[1] - a[1])) {
            summary += `   🔹 ${sub}: ${count}\n`;
        }
    }
    
    const mtdRads = mtdData.rejectionsTotal || 0;
    summary += t(lang, 'metric_rejections_mtd', { count: mtdRads }) + `\n`;
    if (mtdData.rejections && Object.keys(mtdData.rejections).length > 0) {
        for (const [sub, count] of Object.entries(mtdData.rejections).sort((a, b) => b[1] - a[1])) {
            summary += `   🔸 ${sub}: ${count}\n`;
        }
    }
    
    // Qarzdorlar for current month context
    const mtdQarz = qarzBalances[monthContext] || { amount: 0, count: 0 };
    summary += t(lang, 'metric_debtors_mtd', { count: mtdQarz.count, amount: formatNumber(mtdQarz.amount, lang) }) + '\n\n';
    
    summary += t(lang, 'sec_finance') + '\n';
    
    // MTD Norasmiy Block
    const mtdNorasmiyKirim = parseFloat(mtdData.finance.income_norasmiy) || 0;
    const mtdNorasmiyChiqim = parseFloat(mtdData.finance.expense_norasmiy) || 0;
    const mtdNorasmiyQoldiq = mtdNorasmiyKirim - mtdNorasmiyChiqim;
    
    summary += `   ` + t(lang, 'fin_norasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: formatNumber(mtdNorasmiyKirim, lang), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: formatNumber(mtdNorasmiyChiqim, lang), delta: '' }) + `\n`;
    
    if (mtdData.finance.expense_details && mtdData.finance.expense_details.length > 0) {
        const expAgg = {};
        mtdData.finance.expense_details.forEach(exp => {
            if(!expAgg[exp.type]) expAgg[exp.type] = 0;
            expAgg[exp.type] += exp.amount;
        });
        for (const [type, amt] of Object.entries(expAgg)) {
             summary += `         🔸 ${type}: ${formatNumber(amt, lang)} ` + t(lang, 'unit_som') + `\n`;
        }
    }
    summary += `     ` + t(lang, 'fin_balance', { amount: formatNumber(mtdNorasmiyQoldiq, lang), delta: '' }) + `\n`;
    
    // MTD Rasmiy Block
    const mtdRasmiyKirim = parseFloat(mtdData.finance.income_rasmiy) || 0;
    const mtdRasmiyChiqim = parseFloat(mtdData.finance.expense_rasmiy) || 0;
    const mtdRasmiyQoldiq = mtdRasmiyKirim - mtdRasmiyChiqim;
    
    summary += `   ` + t(lang, 'fin_rasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: formatNumber(mtdRasmiyKirim, lang), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: formatNumber(mtdRasmiyChiqim, lang), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_balance', { amount: formatNumber(mtdRasmiyQoldiq, lang), delta: '' }) + `\n\n`;
    
    
    // --- SECTION 3: BO'SH XONALAR + POTENTSIAL DAROMAD ---
    if (emptyRooms.length > 0) {
        summary += t(lang, 'sec_empty_rooms', { count: emptyRooms.length }) + '\n';

        // Group by period
        const periodGroups = {};
        emptyRooms.forEach(r => {
            const p = r.period || 'Boshqa vaqt';
            if(!periodGroups[p]) periodGroups[p] = [];
            periodGroups[p].push(r);
        });

        for (const [period, rooms] of Object.entries(periodGroups)) {
            const periodLabel = (period === 'Tushlikgacha') ? t(lang, 'label_period_morning') :
                               (period === 'Tushlikdan keyin') ? t(lang, 'label_period_afternoon') :
                               (period === "To'liq kun") ? t(lang, 'label_period_full') :
                               (period === "Boshqa vaqt") ? t(lang, 'label_period_other') : period;

            summary += `   🔸 ${periodLabel}: ${rooms.length} ${t(lang, 'unit_ta')}\n`;
            rooms.forEach(r => {
                summary += `      • ${r.branch} ${t(lang, 'label_filial')}, ${r.room}-${t(lang, 'label_room')} (${r.days} ${r.time})\n`;
            });
        }
        summary += '\n';

        // Potential Income calculation
        if (!potentialData) potentialData = await storage.calculatePotentialIncome();
        summary += t(lang, 'sec_potential_income') + '\n';
        summary += t(lang, 'potential_income_total', {
            amount: formatNumber(potentialData.totalPotential, lang),
            count: potentialData.roomCount
        }) + '\n';
        for (const [branch, data] of Object.entries(potentialData.byBranch)) {
            summary += t(lang, 'potential_income_branch', {
                branch,
                rooms: data.rooms,
                amount: formatNumber(data.potential, lang)
            }) + '\n';
        }
        summary += '\n';
    } else {
        summary += t(lang, 'sec_empty_rooms', { count: 0 }) + '\n';
        summary += t(lang, 'potential_income_zero') + '\n\n';
    }
    
    summary += t(lang, 'report_footer') + `\n`;


    return summary;
}


/**
 * Build a data object suitable for PDF generation from date range
 */
async function buildPdfData(startDateYmd, endDateYmd, titleStr, lang = 'uz') {
    const { t } = require('./i18n');
    const [y, m] = endDateYmd.split('-').map(Number);
    const rawMonthName = t('uz', `month_${m}`);
    const monthContext = normalizeMonthKey(`${rawMonthName} ${y}`);
    const startOfMonthYmd = `${y}-${String(m).padStart(2, '0')}-01`;

    // --- OPTIMIZED SINGLE-PASS FETCHING ---
    const periodData = await storage.fetchAllData(startDateYmd, endDateYmd, monthContext);
    const cumulativeData = await storage.fetchAllData(startOfMonthYmd, endDateYmd, monthContext, true);
    const financeByMonth = await storage.getFinanceByMonth();
    
    logger.dlog('ceo_debug.log', 'ceo_reports.js:buildPdfData', 'buildPdfData finance', { 
        hypothesisId: 'A', 
        periodFinance: periodData.finance, 
        cumulativeFinance: cumulativeData.finance 
    });

    // Empty rooms — live for today/future, historical snapshot for past
    const todayYmd = storage.getTodayString();
    let bxTotal = 0;
    const beforeLunchRooms = [];
    const afterLunchRooms = [];
    const fullDayRooms = [];
    const otherRooms = [];
    let hasHistoricalSnapshot = false;

    let potentialIncome = { totalPotential: 0, roomCount: 0, byBranch: {}, byPeriod: {}, rooms: [] };
    if (endDateYmd >= todayYmd) {
        const boxObj = await storage.getEmptyRooms();
        bxTotal = boxObj.length;
        for (const r of boxObj) {
            if (r.period === 'Tushlikgacha') beforeLunchRooms.push(r);
            else if (r.period === 'Tushlikdan keyin') afterLunchRooms.push(r);
            else if (r.period === "To'liq kun") fullDayRooms.push(r);
            else otherRooms.push(r);
        }
        potentialIncome = await storage.calculatePotentialIncome();
    } else {
        // Try historical snapshot for past dates
        const historicalRooms = await storage.getEmptyRoomsForDate(endDateYmd);
        if (historicalRooms !== null) {
            hasHistoricalSnapshot = true;
            bxTotal = historicalRooms.length;
            for (const r of historicalRooms) {
                if (r.period === 'Tushlikgacha') beforeLunchRooms.push(r);
                else if (r.period === 'Tushlikdan keyin') afterLunchRooms.push(r);
                else if (r.period === "To'liq kun") fullDayRooms.push(r);
                else otherRooms.push(r);
            }
            const histPotential = await storage.calculatePotentialIncomeForDate(endDateYmd);
            if (histPotential) potentialIncome = histPotential;
        }
    }

    return {
        dateStr: titleStr || `${formatDbDateStr(startDateYmd)} — ${formatDbDateStr(endDateYmd)}`,
        monthContext: monthContext,
        isPastDate: endDateYmd < todayYmd,
        hasHistoricalSnapshot,

        // Day/Period specific metrics
        periodLeadsBreakdown: periodData.leads,
        periodRadObj: periodData.rejections,
        periodRadTotal: periodData.rejectionsTotal,
        periodQarzObj: periodData.debtors,
        financeObj: periodData.finance,
        probTotal: periodData.problems.length,
        davomatObj: periodData.attendance,
        problemsObj: periodData.problems,

        // Month cumulative metrics
        leadTotal: cumulativeData.leadsTotal,
        leadsBreakdown: cumulativeData.leads,
        radTotal: cumulativeData.rejectionsTotal,
        radObj: cumulativeData.rejections,
        qarzObj: cumulativeData.debtors,
        qFinanceObj: cumulativeData.finance,

        // Finance by month for PDF Section 4
        financeByMonth,

        // Extra status
        bxTotal,
        beforeLunchRooms,
        afterLunchRooms,
        fullDayRooms,
        otherRooms,
        potentialIncome,
        lang // Pass lang for PDF generation
    };
}

/**
 * Generate a PDF for on-demand report request
 * @returns {string} path to the generated PDF file
 */
async function generateOnDemandPdf(startDateYmd, endDateYmd, titleStr, lang = 'uz') {
    const data = await buildPdfData(startDateYmd, endDateYmd, titleStr, lang);
    
    logger.dlog('ceo_debug.log', 'ceo_reports.js:generateOnDemandPdf', 'data to generatePdfReport', { 
        hypothesisId: 'D', 
        hasFinanceObj: !!data.financeObj, 
        hasQFinanceObj: !!data.qFinanceObj 
    });
    const sanitizedDate = (startDateYmd || 'report').replace(/[^a-zA-Z0-9-]/g, '_');
    const pdfPath = path.join('/tmp', `report_${sanitizedDate}_${crypto.randomBytes(8).toString('hex')}.pdf`);
    await generatePdfReport(data, pdfPath, lang);
    return pdfPath;
}

/**
 * Generate a cumulative all-time report (Umumiy Xisobot).
 * Shows all-time totals — not filtered by date.
 */
async function generateUmumiyReport(lang = 'uz') {
    const { t } = require('./i18n');
    // Passing null for dates fetches all-time cumulative data
    const allData = await storage.fetchAllData(null, null);
    const financeByMonth = await storage.getFinanceByMonth();
    const months = Object.keys(financeByMonth);

    let summary = t(lang, 'report_umumiy_title') + '\n';
    summary += t(lang, 'report_all_time') + '\n\n';
    
    // Summary Metrics
    summary += t(lang, 'metric_leads_total', { count: allData.leadsTotal }) + '\n';
    // Leads breakdown by subject
    if (allData.leads && Object.keys(allData.leads).length > 0) {
        for (const [sub, count] of Object.entries(allData.leads).sort((a, b) => b[1] - a[1])) {
            if (count === 0) continue;
            summary += `   \u{1F539} ${sub}: ${count}\n`;
        }
    }
    summary += t(lang, 'metric_rejections_total', { count: allData.rejectionsTotal }) + '\n';
    // Rejections breakdown by subject
    if (allData.rejections && Object.keys(allData.rejections).length > 0) {
        for (const [sub, count] of Object.entries(allData.rejections).sort((a, b) => b[1] - a[1])) {
            if (count === 0) continue;
            summary += `   \u{1F538} ${sub}: ${count}\n`;
        }
    }
    const umumiyQarz = await storage.getQarzdorlarBalance();
    const umumiyQarzMonths = Object.keys(umumiyQarz);
    let umumiyTotalAmt = 0, umumiyTotalCnt = 0;
    for (const m of umumiyQarzMonths) { umumiyTotalAmt += umumiyQarz[m].amount; umumiyTotalCnt += umumiyQarz[m].count; }
    summary += t(lang, 'metric_debtors_total', { count: umumiyTotalCnt, amount: formatNumber(umumiyTotalAmt, lang) }) + '\n';
    for (const m of umumiyQarzMonths) {
        const b = umumiyQarz[m];
        if (b.amount === 0 && b.count === 0) continue;
        summary += `   📅 ${m}: ${formatNumber(b.amount, lang)} ${t(lang, 'unit_som')} / ${b.count} ${t(lang, 'unit_student')}\n`;
    }
    summary += '\n';

    if (months.length > 0) {
        summary += t(lang, 'sec_finance_monthly') + '\n\n';
        
        // Sort months chronologically
        months.sort((a, b) => {
            const [mA, yA] = a.split(' ');
            const [mB, yB] = b.split(' ');
            const yearDiff = parseInt(yA) - parseInt(yB);
            if (yearDiff !== 0) return yearDiff;

            // Simplified month sorting logic (find month index in translations)
            const getMonthIdx = (name) => {
                for (let i = 1; i <= 12; i++) {
                    if (t('uz', `month_${i}`) === name || t('ru', `month_${i}`) === name) return i;
                }
                return 0;
            };
            return getMonthIdx(mA) - getMonthIdx(mB);
        });

        for (const month of months) {
            const data = financeByMonth[month];
            if (data.income === 0 && data.expense === 0) continue;

            summary += `📅 **${month.toUpperCase()}:**\n`;
            
            // Norasmiy
            const nKirim = parseFloat(data.income_norasmiy) || 0;
            const nChiqim = parseFloat(data.expense_norasmiy) || 0;
            const nQoldiq = nKirim - nChiqim;
            summary += `   ` + t(lang, 'fin_norasmiy') + `\n`;
            summary += `     ` + t(lang, 'fin_income', { amount: nKirim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
            summary += `     ` + t(lang, 'fin_expense', { amount: nChiqim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
            summary += `     ` + t(lang, 'fin_balance', { amount: nQoldiq.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
            
            // Rasmiy
            const rKirim = parseFloat(data.income_rasmiy) || 0;
            const rChiqim = parseFloat(data.expense_rasmiy) || 0;
            const rQoldiq = rKirim - rChiqim;
            summary += `   ` + t(lang, 'fin_rasmiy') + `\n`;
            summary += `     ` + t(lang, 'fin_income', { amount: rKirim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
            summary += `     ` + t(lang, 'fin_expense', { amount: rChiqim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
            summary += `     ` + t(lang, 'fin_balance', { amount: rQoldiq.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n\n`;
        }
    } else {
        summary += t(lang, 'sec_finance') + '\n';
        summary += t(lang, 'fin_no_data') + '\n\n';
    }
    
    const davomadPerc = allData.attendance.expected > 0 
        ? ((allData.attendance.attended / allData.attendance.expected) * 100).toFixed(1) 
        : 0;
    summary += t(lang, 'metric_attendance_total', { percent: davomadPerc }) + '\n\n';

    // Potential Income
    const umumiyPotential = await storage.calculatePotentialIncome();
    if (umumiyPotential.roomCount > 0) {
        summary += t(lang, 'sec_potential_income') + '\n';
        summary += t(lang, 'potential_income_total', {
            amount: formatNumber(umumiyPotential.totalPotential, lang),
            count: umumiyPotential.roomCount
        }) + '\n';
        for (const [branch, data] of Object.entries(umumiyPotential.byBranch)) {
            summary += t(lang, 'potential_income_branch', {
                branch, rooms: data.rooms, amount: formatNumber(data.potential, lang)
            }) + '\n';
        }
        summary += '\n';
    } else {
        summary += t(lang, 'potential_income_zero') + '\n\n';
    }

    summary += t(lang, 'report_footer');

    return summary;
}

/**
 * Builds data uniquely structured for the Umumiy (All-time Cumulative) PDF.
 */
async function buildUmumiyPdfData(lang = 'uz') {
    const { t } = require('./i18n');
    // --- OPTIMIZED SINGLE-PASS FETCHING ---
    const allData = await storage.fetchAllData(null, null);

    const qarzByMonth = await storage.getDebtorByMonth();
    const financeByMonth = await storage.getFinanceByMonth();

    const boxObj = await storage.getEmptyRooms();
    const bxTotal = boxObj.length;
    const bxGrouped = { 'Tushlikgacha': [], 'Tushlikdan keyin': [], "To'liq kun": [], 'Boshqa': [] };
    for (const r of boxObj) {
        if (bxGrouped[r.period]) bxGrouped[r.period].push(r);
        else bxGrouped['Boshqa'].push(r);
    }

    const potentialIncome = await storage.calculatePotentialIncome();

    return {
        isUmumiy: true,
        dateStr: t(lang, 'report_all_time'),
        leadsObj: allData.leads,
        leadTotal: allData.leadsTotal,
        qarzByMonth,
        qarzObj: allData.debtors,
        radObj: allData.rejections,
        radTotal: allData.rejectionsTotal,
        bxTotal,
        bxGrouped,
        davomatObj: allData.attendance,
        financeByMonth,
        monthContext: t(lang, 'report_all_time'),
        probTotal: allData.problems.length,
        problemsObj: allData.problems,
        potentialIncome,
        lang
    };
}

/**
 * Generate a PDF for the cumulative all-time report (Umumiy Xisobot).
 * @returns {string} path to the generated PDF file
 */
async function generateUmumiyPdf(lang = 'uz') {
    const data = await buildUmumiyPdfData(lang);
    const { generateUmumiyPdfReport } = require('./pdf_generator');
    const pdfPath = path.join('/tmp', `umumiy_report_${crypto.randomBytes(8).toString('hex')}.pdf`);
    await generateUmumiyPdfReport(data, pdfPath, lang);
    return pdfPath;
}

/**
 * Generate a financial overview report showing monthly history.
 */
async function generateFinancialOverview(lang = 'uz') {
    const { t } = require('./i18n');
    const financeByMonth = await storage.getFinanceByMonth();
    const months = Object.keys(financeByMonth);

    if (months.length === 0) {
        return t(lang, 'report_finance_title') + `\n\n` + t(lang, 'fin_no_data');
    }

    let summary = t(lang, 'report_finance_title') + `\n\n`;

    // Iterate through months
    for (const month of months) {
        const data = financeByMonth[month];
        if (data.income === 0 && data.expense === 0) continue;

        summary += `📅 **${month.toUpperCase()}:**\n`;
        
        // Norasmiy
        const nKirim = parseFloat(data.income_norasmiy) || 0;
        const nChiqim = parseFloat(data.expense_norasmiy) || 0;
        const nQoldiq = nKirim - nChiqim;
        
        summary += `   ` + t(lang, 'fin_norasmiy') + `\n`;
        summary += `     ■ ` + t(lang, 'fin_income', { amount: nKirim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }).replace('📈 ', '') + `\n`;
        summary += `     ■ ` + t(lang, 'fin_expense', { amount: nChiqim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }).replace('📉 ', '') + `\n`;
        summary += `     ■ ` + t(lang, 'fin_balance', { amount: nQoldiq.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }).replace('💰 ', '') + `\n`;
        
        // Rasmiy
        const rKirim = parseFloat(data.income_rasmiy) || 0;
        const rChiqim = parseFloat(data.expense_rasmiy) || 0;
        const rQoldiq = rKirim - rChiqim;
        
        summary += `   ` + t(lang, 'fin_rasmiy') + `\n`;
        summary += `     ■ ` + t(lang, 'fin_income', { amount: rKirim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }).replace('📈 ', '') + `\n`;
        summary += `     ■ ` + t(lang, 'fin_expense', { amount: rChiqim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }).replace('📉 ', '') + `\n`;
        summary += `     ■ ` + t(lang, 'fin_balance', { amount: rQoldiq.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }).replace('💰 ', '') + `\n\n`;
    }

    return summary;
}

/**
 * Generate a weekly CEO report for the given Mon–Sun date range.
 * Shows: week's activity + monthly cumulative context.
 */
async function generateWeeklyReport(startDateYmd, endDateYmd, lang = 'uz') {
    const { t } = require('./i18n');
    // Use end date's month for MTD context (correct at month boundaries)
    const [y, m, d] = startDateYmd.split('-').map(Number);
    const [ey, em, ed] = endDateYmd.split('-').map(Number);
    const startOfMonthYmd = `${ey}-${String(em).padStart(2, '0')}-01`;
    const uzMonthName = t('uz', `month_${em}`);
    const monthContext = normalizeMonthKey(`${uzMonthName} ${ey}`);
    const monthName = t(lang, `month_${em}`);

    const weeksMonths = [];
    weeksMonths.push(normalizeMonthKey(`${t('uz', `month_${m}`)} ${y}`));
    if (m !== em || y !== ey) {
        weeksMonths.push(normalizeMonthKey(`${t('uz', `month_${em}`)} ${ey}`));
    }

    // Fetch data for the week, filtering strictly by the accounting months of the week
    const weekData = await storage.fetchAllData(startDateYmd, endDateYmd, weeksMonths);
    
    // Fetch Monthly data (MTD)
    const mtdData = await storage.fetchAllData(startOfMonthYmd, endDateYmd, monthContext, true);
    const displayStart = startDateYmd.split('-').reverse().join('.');
    const displayEnd = endDateYmd.split('-').reverse().join('.');

    let summary = t(lang, 'report_weekly_title') + '\n';
    summary += t(lang, 'report_week_label', { start: displayStart, end: displayEnd }) + '\n\n';
    summary += t(lang, 'report_intro_weekly') + '\n\n';
    
    summary += `━━━━ 📅 ` + t(lang, 'report_week_label', { start: displayStart, end: displayEnd }).replace('📅 *Hafta:* ', '').replace(/\*/g, '').toUpperCase() + ` ━━━━\n`;
    
    // Leads/Rad
    summary += t(lang, 'metric_leads', { count: weekData.leadsTotal, delta: '' }) + '\n';
    if (weekData.leads && Object.keys(weekData.leads).length > 0) {
        for (const [sub, count] of Object.entries(weekData.leads).sort((a, b) => b[1] - a[1])) {
            summary += `   🔹 ${sub}: ${count}\n`;
        }
    }

    summary += t(lang, 'metric_rejections', { count: weekData.rejectionsTotal, delta: '' }) + '\n';
    if (weekData.rejections && Object.keys(weekData.rejections).length > 0) {
        for (const [sub, count] of Object.entries(weekData.rejections).sort((a, b) => b[1] - a[1])) {
            summary += `   🔸 ${sub}: ${count}\n`;
        }
    }

    // Debtors — cumulative running balances (not week-filtered, as debtors represent ongoing obligations)
    const weekQarzBal = await storage.getQarzdorlarBalance();
    const weekQarzMonths = Object.keys(weekQarzBal);
    if (weekQarzMonths.length > 0) {
        let wTotalAmt = 0, wTotalCnt = 0;
        for (const qm of weekQarzMonths) { wTotalAmt += weekQarzBal[qm].amount; wTotalCnt += weekQarzBal[qm].count; }
        summary += t(lang, 'metric_debtors', { count: wTotalCnt, amount: formatNumber(wTotalAmt, lang) }) + '\n';
        for (const qm of weekQarzMonths) {
            const b = weekQarzBal[qm];
            if (b.amount === 0 && b.count === 0) continue;
            summary += `   📅 ${m}: ${formatNumber(b.amount, lang)} ${t(lang, 'unit_som')} / ${b.count} ${t(lang, 'unit_student')}\n`;
        }
        summary += '\n';
    } else {
        summary += t(lang, 'metric_debtors', { count: 0, amount: formatNumber(0, lang) }) + '\n\n';
    }

    // Moliya Section
    summary += t(lang, 'sec_finance') + '\n';
    
    // Norasmiy
    const nKirim = parseFloat(weekData.finance.income_norasmiy) || 0;
    const nChiqim = parseFloat(weekData.finance.expense_norasmiy) || 0;
    const nQoldiq = nKirim - nChiqim;
    summary += `   ` + t(lang, 'fin_norasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: nKirim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: nChiqim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_balance', { amount: nQoldiq.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
    
    // Rasmiy
    const rKirim = parseFloat(weekData.finance.income_rasmiy) || 0;
    const rChiqim = parseFloat(weekData.finance.expense_rasmiy) || 0;
    const rQoldiq = rKirim - rChiqim;
    summary += `   ` + t(lang, 'fin_rasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: rKirim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: rChiqim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_balance', { amount: rQoldiq.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n\n`;
    
    // Problems
    const probCount = weekData.problems ? weekData.problems.length : 0;
    summary += t(lang, 'sec_problems', { count: probCount }) + '\n';

    const davomadPerc = weekData.attendance.expected > 0 
        ? ((weekData.attendance.attended / weekData.attendance.expected) * 100).toFixed(1) 
        : 0;
    summary += t(lang, 'metric_attendance_weekly', { percent: davomadPerc }) + '\n\n';

    summary += t(lang, 'sec_mtd', { month: monthName.toUpperCase() }) + '\n';
    
    summary += t(lang, 'metric_leads_mtd', { count: mtdData.leadsTotal }) + '\n';
    summary += t(lang, 'metric_rejections_mtd', { count: mtdData.rejectionsTotal }) + '\n';
    const weekMtdQarz = weekQarzBal[monthContext] || { amount: 0, count: 0 };
    summary += t(lang, 'metric_debtors_mtd', { count: weekMtdQarz.count, amount: formatNumber(weekMtdQarz.amount, lang) }) + '\n\n';

    // MTD Moliya
    summary += t(lang, 'sec_finance') + '\n';
    
    // MTD Norasmiy Block
    const mtdNorasmiyKirim = parseFloat(mtdData.finance.income_norasmiy) || 0;
    const mtdNorasmiyChiqim = parseFloat(mtdData.finance.expense_norasmiy) || 0;
    const mtdNorasmiyQoldiq = mtdNorasmiyKirim - mtdNorasmiyChiqim;
    
    summary += `   ` + t(lang, 'fin_norasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: formatNumber(mtdNorasmiyKirim, lang), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: formatNumber(mtdNorasmiyChiqim, lang), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_balance', { amount: formatNumber(mtdNorasmiyQoldiq, lang), delta: '' }) + `\n`;
    
    // MTD Rasmiy Block
    const mtdRasmiyKirim = parseFloat(mtdData.finance.income_rasmiy) || 0;
    const mtdRasmiyChiqim = parseFloat(mtdData.finance.expense_rasmiy) || 0;
    const mtdRasmiyQoldiq = mtdRasmiyKirim - mtdRasmiyChiqim;
    
    summary += `   ` + t(lang, 'fin_rasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: formatNumber(mtdRasmiyKirim, lang), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: formatNumber(mtdRasmiyChiqim, lang), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_balance', { amount: formatNumber(mtdRasmiyQoldiq, lang), delta: '' }) + `\n\n`;

    // Potential Income — use historical data for past weeks
    const todayYmd = storage.getTodayString();
    let weeklyPotential;
    if (endDateYmd < todayYmd) {
        weeklyPotential = await storage.calculatePotentialIncomeForDate(endDateYmd);
        if (!weeklyPotential) weeklyPotential = { totalPotential: 0, roomCount: 0, byBranch: {} };
    } else {
        weeklyPotential = await storage.calculatePotentialIncome();
    }
    if (weeklyPotential.roomCount > 0) {
        summary += t(lang, 'sec_potential_income') + '\n';
        summary += t(lang, 'potential_income_total', {
            amount: formatNumber(weeklyPotential.totalPotential, lang),
            count: weeklyPotential.roomCount
        }) + '\n';
        for (const [branch, data] of Object.entries(weeklyPotential.byBranch)) {
            summary += t(lang, 'potential_income_branch', {
                branch, rooms: data.rooms, amount: formatNumber(data.potential, lang)
            }) + '\n';
        }
        summary += '\n';
    } else {
        summary += t(lang, 'potential_income_zero') + '\n\n';
    }

    summary += t(lang, 'report_footer');


    return summary;
}

/**
 * Generate a monthly CEO report for the given month range.
 */
async function generateMonthlyReport(startDateYmd, endDateYmd, lang = 'uz') {
    const { t } = require('./i18n');
    const [y, m] = startDateYmd.split('-').map(Number);
    const uzMonthName = t('uz', `month_${m}`);
    const monthContext = normalizeMonthKey(`${uzMonthName} ${y}`);
    
    const monthData = await storage.fetchAllData(startDateYmd, endDateYmd, monthContext, true);
    
    let summary = t(lang, 'report_monthly_title', { month: monthContext.toUpperCase() }) + '\n\n';
    
    // Leads Section
    summary += t(lang, 'metric_leads_mtd', { count: monthData.leadsTotal }) + '\n';
    if (monthData.leads && Object.keys(monthData.leads).length > 0) {
        for (const [sub, count] of Object.entries(monthData.leads).sort((a, b) => b[1] - a[1])) {
            summary += `   🔹 ${sub}: ${count}\n`;
        }
    }
    
    // Rejections Section
    summary += t(lang, 'metric_rejections_mtd', { count: monthData.rejectionsTotal }) + '\n';
    if (monthData.rejections && Object.keys(monthData.rejections).length > 0) {
        for (const [sub, count] of Object.entries(monthData.rejections).sort((a, b) => b[1] - a[1])) {
            summary += `   🔸 ${sub}: ${count}\n`;
        }
    }
    
    // Debtors Section — cumulative balance for this month
    const allQarz = await storage.getQarzdorlarBalance();
    const monthQarz = allQarz[monthContext] || { amount: 0, count: 0 };
    summary += t(lang, 'metric_debtors_mtd', { count: monthQarz.count, amount: formatNumber(monthQarz.amount, lang) }) + '\n\n';

    // Moliya Section
    summary += t(lang, 'sec_finance') + '\n';
    
    // Build expense breakdowns by category
    const monthExpDetails = monthData.finance.expense_details || [];
    const nExpAgg = {}, rExpAgg = {};
    monthExpDetails.forEach(e => {
        const cat = (e.category || '').toLowerCase();
        if (cat === 'norasmiy') nExpAgg[e.type] = (nExpAgg[e.type] || 0) + e.amount;
        else if (cat === 'rasmiy') rExpAgg[e.type] = (rExpAgg[e.type] || 0) + e.amount;
    });

    // Norasmiy
    const nKirim = parseFloat(monthData.finance.income_norasmiy) || 0;
    const nChiqim = parseFloat(monthData.finance.expense_norasmiy) || 0;
    const nQoldiq = nKirim - nChiqim;
    summary += `   ` + t(lang, 'fin_norasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: nKirim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: nChiqim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
    Object.entries(nExpAgg).sort((a, b) => b[1] - a[1]).forEach(([type, amt]) => {
        summary += `         🔸 ${type}: ${amt.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU')} ` + t(lang, 'unit_som') + `\n`;
    });
    summary += `     ` + t(lang, 'fin_balance', { amount: nQoldiq.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;

    // Rasmiy
    const rKirim = parseFloat(monthData.finance.income_rasmiy) || 0;
    const rChiqim = parseFloat(monthData.finance.expense_rasmiy) || 0;
    const rQoldiq = rKirim - rChiqim;
    summary += `   ` + t(lang, 'fin_rasmiy') + `\n`;
    summary += `     ` + t(lang, 'fin_income', { amount: rKirim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
    summary += `     ` + t(lang, 'fin_expense', { amount: rChiqim.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n`;
    Object.entries(rExpAgg).sort((a, b) => b[1] - a[1]).forEach(([type, amt]) => {
        summary += `         🔸 ${type}: ${amt.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU')} ` + t(lang, 'unit_som') + `\n`;
    });
    summary += `     ` + t(lang, 'fin_balance', { amount: rQoldiq.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU'), delta: '' }) + `\n\n`;
    
    const davPerc = monthData.attendance.expected > 0 ? ((monthData.attendance.attended / monthData.attendance.expected) * 100).toFixed(1) : 0;
    summary += t(lang, 'metric_attendance_monthly', { percent: davPerc }) + '\n\n';

    // Potential Income — use historical data for past months
    const todayYmd = storage.getTodayString();
    let monthlyPotential;
    if (endDateYmd < todayYmd) {
        monthlyPotential = await storage.calculatePotentialIncomeForDate(endDateYmd);
        if (!monthlyPotential) monthlyPotential = { totalPotential: 0, roomCount: 0, byBranch: {} };
    } else {
        monthlyPotential = await storage.calculatePotentialIncome();
    }
    if (monthlyPotential.roomCount > 0) {
        summary += t(lang, 'sec_potential_income') + '\n';
        summary += t(lang, 'potential_income_total', {
            amount: formatNumber(monthlyPotential.totalPotential, lang),
            count: monthlyPotential.roomCount
        }) + '\n';
        for (const [branch, data] of Object.entries(monthlyPotential.byBranch)) {
            summary += t(lang, 'potential_income_branch', {
                branch, rooms: data.rooms, amount: formatNumber(data.potential, lang)
            }) + '\n';
        }
        summary += '\n';
    } else {
        summary += t(lang, 'potential_income_zero') + '\n\n';
    }

    summary += t(lang, 'report_footer');


    return summary;
}

/**
 * Generate a PDF for weekly report request.
 * Reuses the existing buildPdfData + generatePdfReport pipeline.
 * @returns {string} path to the generated PDF file
 */
async function generateWeeklyPdf(startDateYmd, endDateYmd, lang = 'uz') {
    const { t } = require('./i18n');
    const displayStart = formatDbDateStr(startDateYmd);
    const displayEnd = formatDbDateStr(endDateYmd);
    const titleStr = t(lang, 'rep_weekly') + `: ${displayStart} — ${displayEnd}`;
    const data = await buildPdfData(startDateYmd, endDateYmd, titleStr, lang);
    const safeName = `weekly_${startDateYmd}_${crypto.randomBytes(8).toString('hex')}`;
    const pdfPath = path.join('/tmp', `${safeName}.pdf`);
    await generatePdfReport(data, pdfPath, lang);
    return pdfPath;
}

/**
 * Generate a PDF for monthly report request.
 * Reuses the existing buildPdfData + generatePdfReport pipeline.
 * @returns {string} path to the generated PDF file
 */
async function generateMonthlyPdf(startDateYmd, endDateYmd, lang = 'uz') {
    const { t } = require('./i18n');
    const [y, m] = startDateYmd.split('-').map(Number);
    const monthName = t(lang, `month_${m}`);
    const titleStr = t(lang, 'rep_monthly') + `: ${monthName} ${y}`;
    const data = await buildPdfData(startDateYmd, endDateYmd, titleStr, lang);
    const safeName = `monthly_${startDateYmd}_${crypto.randomBytes(8).toString('hex')}`;
    const pdfPath = path.join('/tmp', `${safeName}.pdf`);
    await generatePdfReport(data, pdfPath, lang);
    return pdfPath;
}

module.exports = {
    generateDailyReport,
    generateWeeklyReport,
    generateMonthlyReport,
    generateFinancialOverview,
    generateUmumiyReport,
    buildPdfData,
    buildUmumiyPdfData,
    generateOnDemandPdf,
    generateUmumiyPdf,
    generateWeeklyPdf,
    generateMonthlyPdf
};
