const PDFDocument = require('pdfkit');
const fs = require('fs');
const { formatNumber, sanitizeText } = require('./utils');
const path = require('path');
const logger = require('./logger');
const { t } = require('./i18n');

/**
 * Generate a comprehensive PDF report and save to a file.
 * @param {Object} data - The aggregated report data
 * @param {string} fileName - Destination file path
 */
async function generatePdfReport(data, fileName, lang = 'uz') {
    return new Promise((resolve, reject) => {
        try {
            // Performance optimization: Using async non-blocking logger
            logger.dlog('pdf_debug.log', 'pdf_generator.js:generatePdfReport', 'entry finance', { 
                hypothesisId: 'A', 
                hasFinanceObj: !!data.financeObj, 
                hasQFinanceObj: !!data.qFinanceObj 
            });
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const stream = fs.createWriteStream(fileName);
            doc.pipe(stream);

            doc.registerFont('Roboto', path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'));
            doc.registerFont('Roboto-Bold', path.join(__dirname, 'fonts', 'Roboto-Bold.ttf'));

            // Global settings
            const primaryColor = '#1A365D';
            const secondaryColor = '#4A5568';
            const accentColor = '#E53E3E';
            const successColor = '#38A169';
            const lightBg = '#F7FAFC';

            // --- DIVIDER FUNCTION ---
            const drawDivider = () => {
                doc.moveDown(0.2);
                doc.moveTo(50, doc.y)
                    .lineTo(545, doc.y)
                    .strokeColor('#EDF2F7')
                    .lineWidth(1)
                    .stroke()
                    .moveDown(0.8);
            };

            // --- SECTION HEADER DECORATION ---
            const drawSectionHeader = (text, isAccent = false) => {
                if (doc.y > 700) doc.addPage();
                const bgColor = isAccent ? '#FFF5F5' : '#F7FAFC';
                const textColor = isAccent ? accentColor : primaryColor;

                const headerY = doc.y;
                doc.rect(50, headerY, 495, 25)
                    .fill(bgColor);

                doc.fillColor(textColor)
                    .font('Roboto-Bold')
                    .fontSize(14)
                    .text(text, 60, headerY + 7);

                doc.y = headerY + 30;
            };

            // --- PAGE HEADER (reusable) ---
            const drawPageHeader = () => {
                doc.font('Roboto-Bold')
                    .fontSize(22)
                    .fillColor(primaryColor)
                    .text(t(lang, 'pdf_header_title'), { align: 'center' });

                doc.fontSize(12)
                    .fillColor(secondaryColor)
                    .text(t(lang, 'pdf_header_subtitle'), { align: 'center' })
                    .moveDown(1.5);
            };

            drawPageHeader();

            // --- DATE / META ---
            doc.font('Roboto-Bold')
                .fontSize(12)
                .fillColor(primaryColor)
                .text(t(lang, 'pdf_label_date'), { continued: true })
                .font('Roboto')
                .fillColor('black')
                .text(` ${data.dateStr}`, { align: 'left' });

            const generatedAt = new Date().toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU', { timeZone: 'Asia/Tashkent' });
            doc.font('Roboto')
                .fontSize(10)
                .fillColor(secondaryColor)
                .text(t(lang, 'pdf_label_generated', { at: generatedAt }))
                .moveDown(1.5);

            // --- INTRODUCTION ---
            doc.font('Roboto')
                .fontSize(10)
                .fillColor(secondaryColor)
                .text(t(lang, 'pdf_intro_text'), { align: 'justify', lineGap: 2 })
                .moveDown(1.5);

            drawDivider();
            // ========================================
            // SECTION 1: DAVR KO'RSATKICHLARI (Period Activity)
            // ========================================
            drawSectionHeader(t(lang, 'pdf_section_period'));

            doc.font('Roboto')
                .fontSize(10)
                .fillColor(secondaryColor)
                .text(t(lang, 'pdf_period_desc', { date: data.dateStr }))
                .moveDown(0.5);

            // --- Period Leads ---
            doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_leads'), { continued: true });
            doc.fillColor(successColor).text(`+${data.periodLeadsBreakdown ? Object.values(data.periodLeadsBreakdown).reduce((a, b) => a + b, 0) : 0} ${t(lang, 'unit_ta')}`);
            if (data.periodLeadsBreakdown && Object.keys(data.periodLeadsBreakdown).length > 0) {
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor);
                for (const [s, c] of Object.entries(data.periodLeadsBreakdown).sort((a, b) => b[1] - a[1])) {
                    doc.text(`    - ${s}: ${c}`);
                }
            }

            // --- Period Rejections ---
            doc.moveDown(0.3);
            doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_rejections'), { continued: true });
            doc.fillColor(accentColor).text(`+${data.periodRadTotal || 0} ${t(lang, 'unit_ta')}`);
            if (data.periodRadObj && Object.keys(data.periodRadObj).length > 0) {
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor);
                for (const [s, c] of Object.entries(data.periodRadObj)) {
                    doc.text(`    - ${s}: ${c}`);
                }
            }

            // --- Period Debtors ---
            doc.moveDown(0.3);
            const pQarz = data.periodQarzObj || { count: 0, amount: 0 };
            doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_debtors_growth'), { continued: true });
            doc.font('Roboto').text(`${data.periodQarzObj ? data.periodQarzObj.count : 0} ${t(lang, 'unit_person')} (${formatNumber(pQarz.amount, lang)} ${t(lang, 'unit_som')})`);

            // --- Period Finance ---
            doc.moveDown(0.5);
            let finObj = data.financeObj || {};
            let income = finObj.income || 0;
            let expense = finObj.expense || 0;
            const periodAllZeros = (income === 0 && expense === 0 && (finObj.kassa_amount || 0) === 0);
            // Only fallback to cumulative finance for today/future dates (data may not be entered yet)
            // For past dates, showing 0 is correct — that day had no transactions
            if (periodAllZeros && !data.isPastDate && data.qFinanceObj && ((data.qFinanceObj.income || 0) + (data.qFinanceObj.expense || 0) > 0)) {
                finObj = data.qFinanceObj;
                income = finObj.income || 0;
                expense = finObj.expense || 0;
                doc.font('Roboto').fontSize(10).fillColor(secondaryColor).text(t(lang, 'pdf_fallback_finance'));
            }
            doc.font('Roboto-Bold').fontSize(12).fillColor(primaryColor).text(t(lang, 'pdf_label_finance'));
            const balance = income - expense;

            doc.font('Roboto').fontSize(11).fillColor('black').text(t(lang, 'pdf_label_income_official'), { continued: true });
            doc.fillColor(successColor).text(`+${formatNumber(finObj.income_rasmiy || 0)} UZS`);
            doc.fillColor('black').text(t(lang, 'pdf_label_income_unofficial'), { continued: true });
            doc.fillColor(successColor).text(`+${formatNumber(finObj.income_norasmiy || 0)} UZS`);

            // Separate Rasmiy and Norasmiy
            doc.fillColor('black').text(t(lang, 'pdf_label_expense_official'), { continued: true });
            doc.fillColor(accentColor).text(`-${formatNumber(finObj.expense_rasmiy || 0)} UZS`);
            if (finObj.expenses_by_type_rasmiy && Object.keys(finObj.expenses_by_type_rasmiy).length > 0) {
                doc.fontSize(10).fillColor(secondaryColor);
                for (const [eType, eAmt] of Object.entries(finObj.expenses_by_type_rasmiy)) {
                    doc.text(`        - ${sanitizeText(eType)}: ${formatNumber(eAmt)} UZS`);
                }
            }

            doc.fontSize(11).fillColor('black').text(t(lang, 'pdf_label_expense_unofficial'), { continued: true });
            doc.fillColor(accentColor).text(`-${formatNumber(finObj.expense_norasmiy || 0)} UZS`);
            if (finObj.expenses_by_type && Object.keys(finObj.expenses_by_type).length > 0) {
                doc.fontSize(10).fillColor(secondaryColor);
                for (const [eType, eAmt] of Object.entries(finObj.expenses_by_type)) {
                    doc.text(`        - ${sanitizeText(eType)}: ${formatNumber(eAmt)} UZS`);
                }
            }

            if (finObj.kassa_amount !== undefined && finObj.kassa_amount > 0) {
                doc.fontSize(11).fillColor('black').text(t(lang, 'pdf_label_kassa'), { continued: true });
                doc.font('Roboto-Bold').text(`${formatNumber(finObj.kassa_amount, lang)} ${t(lang, 'unit_som')} (${finObj.kassa_students || 0} ${t(lang, 'unit_ta')} o'quvchi)`);
                doc.font('Roboto');
            }
            doc.font('Roboto').fillColor(balance >= 0 ? successColor : accentColor).text(`${formatNumber(balance, lang)} ${t(lang, 'unit_som')}`);
            // Performance optimization: Using async non-blocking logger
            logger.dlog('pdf_debug.log', 'pdf_generator.js:afterMoliya', 'post-fix Period Moliya drawn', { 
                runId: 'post-fix', 
                income, 
                expense, 
                balance, 
                usedFallback: periodAllZeros 
            });

            // --- Period Problems & Attendance ---
            doc.moveDown(0.5);
            doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_problems_new'), { continued: true });
            doc.font('Roboto').fillColor(data.probTotal > 0 ? accentColor : successColor).text(`${data.probTotal || 0} ${t(lang, 'unit_ta')}`);

            if (data.davomatObj && data.davomatObj.expected > 0) {
                const davPerc = ((data.davomatObj.attended / data.davomatObj.expected) * 100).toFixed(1);
                doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_attendance'), { continued: true });
                doc.font('Roboto').text(`${data.davomatObj.attended}/${data.davomatObj.expected} (${davPerc}%)`);
            }

            doc.moveDown(1);
            drawDivider();

            // ========================================
            // SECTION 2: UMUMIY JORIY HOLAT (Cumulative)
            // ========================================
            if (doc.y > 600) doc.addPage();
            drawSectionHeader(t(lang, 'pdf_section_status'));

            // Total Leads
            doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_lead_base'), { continued: true });
            doc.font('Roboto').text(`${data.leadTotal} ${t(lang, 'unit_ta')}`);
            if (data.leadsBreakdown && Object.keys(data.leadsBreakdown).length > 0) {
                doc.fontSize(11).fillColor(secondaryColor);
                for (const [s, c] of Object.entries(data.leadsBreakdown).sort((a, b) => b[1] - a[1])) {
                    doc.text(`    - ${s}: ${c}`);
                }
            }

            // Total Rejections
            doc.moveDown(0.3);
            doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_rejection_base'), { continued: true });
            doc.font('Roboto').text(`${data.radTotal} ${t(lang, 'unit_ta')}`);
            if (data.radObj && Object.keys(data.radObj).length > 0) {
                doc.fontSize(11).fillColor(secondaryColor);
                for (const [s, c] of Object.entries(data.radObj).sort((a, b) => b[1] - a[1])) {
                    doc.text(`    - ${s}: ${c}`);
                }
            }

            // Total Debtors
            doc.moveDown(0.3);
            const tQarz = data.qarzObj || { count: 0, amount: 0 };
            doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_debtors_total'), { continued: true });
            doc.font('Roboto').text(`${tQarz.count} ${t(lang, 'unit_person')} (${t(lang, 'pdf_label_balance').trim()} ${formatNumber(tQarz.amount, lang)} ${t(lang, 'unit_som')})`);

            // Cumulative (Oylik) Moliya
            const qFin = data.qFinanceObj || {};
            const qIncome = qFin.income || 0;
            const qExpense = qFin.expense || 0;
            const qBalance = qIncome - qExpense;
            doc.moveDown(0.3);
            doc.font('Roboto').fontSize(11).fillColor('black').text(t(lang, 'pdf_label_income_official'), { continued: true });
            doc.fillColor(successColor).text(`+${formatNumber(qFin.income_rasmiy || 0)} UZS`);
            doc.fillColor('black').text(t(lang, 'pdf_label_income_unofficial'), { continued: true });
            doc.fillColor(successColor).text(`+${formatNumber(qFin.income_norasmiy || 0)} UZS`);

            doc.fillColor('black').text(t(lang, 'pdf_label_expense_official'), { continued: true });
            doc.fillColor(accentColor).text(`-${formatNumber(qFin.expense_rasmiy || 0)} UZS`);
            if (qFin.expenses_by_type_rasmiy && Object.keys(qFin.expenses_by_type_rasmiy).length > 0) {
                doc.fontSize(10).fillColor(secondaryColor);
                for (const [eType, eAmt] of Object.entries(qFin.expenses_by_type_rasmiy)) {
                    doc.text(`        - ${sanitizeText(eType)}: ${formatNumber(eAmt)} UZS`);
                }
            }

            doc.fontSize(11).fillColor('black').text(t(lang, 'pdf_label_expense_unofficial'), { continued: true });
            doc.fillColor(accentColor).text(`-${formatNumber(qFin.expense_norasmiy || 0)} UZS`);
            if (qFin.expenses_by_type && Object.keys(qFin.expenses_by_type).length > 0) {
                doc.fontSize(10).fillColor(secondaryColor);
                for (const [eType, eAmt] of Object.entries(qFin.expenses_by_type)) {
                    doc.text(`        - ${sanitizeText(eType)}: ${formatNumber(eAmt)} UZS`);
                }
            }

            doc.fontSize(11).font('Roboto-Bold').fillColor('black').text(t(lang, 'pdf_label_balance'), { continued: true });
            doc.font('Roboto').fillColor(qBalance >= 0 ? successColor : accentColor).text(`${formatNumber(qBalance)} UZS`);

            // Empty Rooms
            doc.moveDown(0.3);
            doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_rooms_free', { count: data.bxTotal || 0 }));

            if (data.isPastDate && !data.hasHistoricalSnapshot) {
                doc.font('Roboto').fontSize(9).fillColor(secondaryColor).text(t(lang, 'pdf_rooms_past_date'));
            } else if ((data.beforeLunchRooms && data.beforeLunchRooms.length > 0) ||
                (data.afterLunchRooms && data.afterLunchRooms.length > 0) ||
                (data.fullDayRooms && data.fullDayRooms.length > 0) ||
                (data.otherRooms && data.otherRooms.length > 0)) {
                doc.moveDown(0.2);
                const renderRoomsList = (titleKey, roomsArray) => {
                    if (!roomsArray || roomsArray.length === 0) return;
                    doc.font('Roboto-Bold')
                        .fontSize(10)
                        .fillColor(secondaryColor)
                        .text(`    * ${t(lang, titleKey)}: ${roomsArray.length} ${t(lang, 'unit_ta')}`);

                    doc.font('Roboto').fontSize(9).fillColor('#4A5568');
                    roomsArray.forEach((room) => {
                        doc.text(t(lang, 'pdf_label_room_item', {
                            branch: sanitizeText(room.branch),
                            room: sanitizeText(room.room),
                            days: sanitizeText(room.days),
                            time: sanitizeText(room.time)
                        }));
                    });
                };

                renderRoomsList('pdf_rooms_lunch_before', data.beforeLunchRooms);
                renderRoomsList('pdf_rooms_lunch_after', data.afterLunchRooms);
                renderRoomsList('pdf_rooms_full_day', data.fullDayRooms);
                renderRoomsList('pdf_rooms_other', data.otherRooms);
            }

            // --- POTENTIAL INCOME ---
            if (data.potentialIncome && data.potentialIncome.roomCount > 0) {
                doc.moveDown(0.5);
                if (doc.y > 680) doc.addPage();

                doc.font('Roboto-Bold')
                    .fontSize(12)
                    .fillColor(primaryColor)
                    .text(t(lang, 'pdf_potential_income_title'));

                doc.font('Roboto-Bold')
                    .fontSize(14)
                    .fillColor(accentColor)
                    .text(`${formatNumber(data.potentialIncome.totalPotential, lang)} UZS`)
                    .moveDown(0.3);

                doc.font('Roboto').fontSize(10);
                for (const [branch, info] of Object.entries(data.potentialIncome.byBranch)) {
                    doc.fillColor('black')
                        .text(`${sanitizeText(branch)}: ${info.rooms} xona`, { continued: true })
                        .fillColor(accentColor)
                        .text(`    ${formatNumber(info.potential, lang)} UZS`, { align: 'right' });
                }

                doc.moveDown(0.3);
                doc.font('Roboto').fontSize(8).fillColor(secondaryColor);
                for (const room of data.potentialIncome.rooms) {
                    doc.text(
                        `${sanitizeText(room.branch)}, ${sanitizeText(room.room)}-xona ` +
                        `(${sanitizeText(room.days)} ${sanitizeText(room.time)}): ` +
                        `${room.capacity} x ${formatNumber(room.price_per_student, lang)} = ` +
                        `${formatNumber(room.potential, lang)} UZS`
                    );
                }
            }

            doc.moveDown(1);
            drawDivider();

            // ========================================
            // SECTION 3: MUAMMOLAR (Details)
            // ========================================
            if (doc.y > 650) doc.addPage();
            const probTotal = data.probTotal || 0;
            drawSectionHeader(t(lang, 'pdf_section_problems', { count: probTotal }), probTotal > 0);

            if (probTotal > 0 && data.problemsObj) {
                data.problemsObj.forEach((prob, i) => {
                    if (doc.y > 720) doc.addPage();

                    const cleanType = (prob.type && !["Muammo qo'shish", "Yangi qo'shish", "Muammolar"].includes(prob.type)) ? prob.type : t(lang, 'label_muammo');

                    doc.font('Roboto-Bold')
                        .fontSize(11)
                        .fillColor('black')
                        .text(t(lang, 'pdf_label_problem_item', { i: i+1, branch: sanitizeText(prob.branch), type: sanitizeText(cleanType) }))
                        .font('Roboto')
                        .fontSize(10)
                        .fillColor(secondaryColor)
                        .text(t(lang, 'pdf_label_problem_note'), { continued: true })
                        .fillColor('#2D3748')
                        .text(`${sanitizeText(prob.issue) || t(lang, 'pdf_label_problem_empty')}`)
                        .moveDown(0.5);
                });
            } else {
                doc.font('Roboto')
                    .fontSize(12)
                    .fillColor(successColor)
                    .text(t(lang, 'pdf_problems_none'))
                    .moveDown(1);
            }


            drawDivider();
            // ========================================
            // SECTION 4: MOLIYA TAFSILI (Finance Details)
            // ========================================
            if (doc.y > 600) doc.addPage();
            drawSectionHeader(t(lang, 'pdf_section_finance_details'));

            const finMonths = Object.keys(data.financeByMonth || {});
            if (finMonths.length > 0) {
                // Sort months chronologically
                const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
                const monthsRu = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
                const selectedMonths = lang === 'uz' ? monthsUz : monthsRu;

                finMonths.sort((a, b) => {
                    const [mA, yA] = a.split(' ');
                    const [mB, yB] = b.split(' ');
                    const yearDiff = parseInt(yA) - parseInt(yB);
                    if (yearDiff !== 0) return yearDiff;
                    // Try to find index in either language list
                    const idxA = monthsUz.indexOf(mA) !== -1 ? monthsUz.indexOf(mA) : monthsRu.indexOf(mA);
                    const idxB = monthsUz.indexOf(mB) !== -1 ? monthsUz.indexOf(mB) : monthsRu.indexOf(mB);
                    return idxA - idxB;
                });

                doc.font('Roboto').fontSize(11);

                for (const month of finMonths) {
                    const fd = data.financeByMonth[month];
                    if (!fd || (fd.income === 0 && fd.expense === 0)) continue;

                    if (doc.y > 700) doc.addPage();

                    doc.font('Roboto-Bold').fontSize(11).fillColor(primaryColor).text(`${month}:`);

                    doc.font('Roboto').fontSize(10).fillColor('black')
                        .text(t(lang, 'pdf_label_income_official')).moveUp().fillColor(successColor).text(`+${formatNumber(fd.income_rasmiy || 0, lang)} ${t(lang, 'unit_som')}`, { align: 'right' });
                    doc.fillColor('black').text(t(lang, 'pdf_label_income_unofficial')).moveUp().fillColor(successColor).text(`+${formatNumber(fd.income_norasmiy || 0, lang)} ${t(lang, 'unit_som')}`, { align: 'right' });

                    doc.fillColor('black').text(t(lang, 'pdf_label_expense_official')).moveUp().fillColor(accentColor).text(`-${formatNumber(fd.expense_rasmiy || 0, lang)} ${t(lang, 'unit_som')}`, { align: 'right' });
                    doc.fillColor('black').text(t(lang, 'pdf_label_expense_unofficial')).moveUp().fillColor(accentColor).text(`-${formatNumber(fd.expense_norasmiy || 0, lang)} ${t(lang, 'unit_som')}`, { align: 'right' });

                    if (fd.kassa_amount && fd.kassa_amount > 0) {
                        doc.fillColor('black').text(t(lang, 'pdf_label_kassa')).moveUp().font('Roboto-Bold').text(`${formatNumber(fd.kassa_amount, lang)} ${t(lang, 'unit_som')} (${fd.kassa_students} ${t(lang, 'unit_ta')})`, { align: 'right' }).font('Roboto');
                    }

                    const bal = fd.income - fd.expense;
                    doc.font('Roboto-Bold').fillColor('black').text(t(lang, 'pdf_label_balance')).moveUp().fillColor(bal >= 0 ? successColor : accentColor).text(`${formatNumber(bal, lang)} ${t(lang, 'unit_som')}`, { align: 'right' });

                    doc.moveDown(0.5);
                }

                drawDivider();
            } else {
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor).text(t(lang, 'pdf_no_data')).moveDown(1);
                drawDivider();
            }


            // --- FOOTER ---
            doc.moveDown(1);
            doc.font('Roboto')
                .fontSize(9)
                .fillColor(secondaryColor)
                .text(t(lang, 'pdf_footer', { at: generatedAt }), { align: 'center' });

            stream.on('finish', () => resolve(fileName));
            stream.on('error', (err) => reject(err));
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Generate a comprehensive ALL-TIME PDF report for Umumiy Xisobot
 */
async function generateUmumiyPdfReport(data, fileName, lang = 'uz') {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const stream = fs.createWriteStream(fileName);
            doc.pipe(stream);

            doc.registerFont('Roboto', path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'));
            doc.registerFont('Roboto-Bold', path.join(__dirname, 'fonts', 'Roboto-Bold.ttf'));

            const primaryColor = '#1A365D';
            const secondaryColor = '#4A5568';
            const accentColor = '#E53E3E';
            const successColor = '#38A169';
            const lightColor = '#718096';

            const drawDivider = () => {
                doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E2E8F0').stroke().moveDown(0.8);
            };

            const checkPageSpace = (neededHeight = 100) => {
                if (doc.y + neededHeight > 750) doc.addPage();
            };

            // HEADER
            doc.font('Roboto-Bold').fontSize(22).fillColor(primaryColor).text(t(lang, 'pdf_umumiy_title'), { align: 'center' });
            doc.fontSize(12).fillColor(secondaryColor).text(t(lang, 'pdf_umumiy_subtitle'), { align: 'center' }).moveDown(1.5);

            // --- SECTION HEADER DECORATION (Umumiy) ---
            const drawSectionHeader = (text, isAccent = false) => {
                if (doc.y > 700) doc.addPage();
                const bgColor = isAccent ? '#FFF5F5' : '#F7FAFC';
                const textColor = isAccent ? accentColor : primaryColor;

                const headerY = doc.y;
                doc.rect(50, headerY, 495, 25)
                    .fill(bgColor);

                doc.fillColor(textColor)
                    .font('Roboto-Bold')
                    .fontSize(14)
                    .text(text, 60, headerY + 7);

                doc.y = headerY + 30;
            };

            const generatedAt = new Date().toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU', { timeZone: 'Asia/Tashkent' });
            doc.font('Roboto').fontSize(10).fillColor(lightColor).text(t(lang, 'pdf_label_generated', { at: generatedAt }), { align: 'right' }).moveDown(0.5);
            drawDivider();

            // 1. MOLIYA (Finance)
            checkPageSpace(150);
            drawSectionHeader(t(lang, 'pdf_section_finance_months'));

            const finMonths = Object.keys(data.financeByMonth || {});

            // Loop for months
            if (finMonths.length > 0) {
                // Sort months chronologically
                const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
                const monthsRu = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
                finMonths.sort((a, b) => {
                    const [mA, yA] = a.split(' ');
                    const [mB, yB] = b.split(' ');
                    const yearDiff = parseInt(yA) - parseInt(yB);
                    if (yearDiff !== 0) return yearDiff;
                    const idxA = monthsUz.indexOf(mA) !== -1 ? monthsUz.indexOf(mA) : monthsRu.indexOf(mA);
                    const idxB = monthsUz.indexOf(mB) !== -1 ? monthsUz.indexOf(mB) : monthsRu.indexOf(mB);
                    return idxA - idxB;
                });

                // Draw monthly breakdown
                for (const month of finMonths) {
                    const fd = data.financeByMonth[month];
                    if (fd.income === 0 && fd.expense === 0) continue;

                    checkPageSpace();
                    doc.font('Roboto-Bold').fontSize(12).fillColor('black').text(`${month}`);
                    doc.font('Roboto').fontSize(11).fillColor('black')
                        .text(t(lang, 'pdf_label_income_official')).moveUp().fillColor(successColor).text(`+${formatNumber(fd.income_rasmiy || 0, lang)} ${t(lang, 'unit_som')}`, { align: 'right' })
                        .fillColor('black').text(t(lang, 'pdf_label_income_unofficial')).moveUp().fillColor(successColor).text(`+${formatNumber(fd.income_norasmiy || 0, lang)} ${t(lang, 'unit_som')}`, { align: 'right' })
                        .fillColor('black').text(t(lang, 'pdf_label_expense_official')).moveUp().fillColor(accentColor).text(`-${formatNumber(fd.expense_rasmiy || 0, lang)} ${t(lang, 'unit_som')}`, { align: 'right' })
                        .fillColor('black').text(t(lang, 'pdf_label_expense_unofficial')).moveUp().fillColor(accentColor).text(`-${formatNumber(fd.expense_norasmiy || 0, lang)} ${t(lang, 'unit_som')}`, { align: 'right' });

                    if (fd.kassa_amount > 0) {
                        doc.fillColor('black').text(t(lang, 'pdf_label_kassa')).moveUp().font('Roboto-Bold').text(`${formatNumber(fd.kassa_amount, lang)} ${t(lang, 'unit_som')} (${fd.kassa_students} ${t(lang, 'unit_ta')})`, { align: 'right' }).font('Roboto');
                    }

                    const bal = fd.income - fd.expense;
                    doc.font('Roboto-Bold').fillColor('black').text(t(lang, 'pdf_label_balance')).moveUp().fillColor(bal >= 0 ? successColor : accentColor).text(`${formatNumber(bal, lang)} ${t(lang, 'unit_som')}`, { align: 'right' });
                    doc.moveDown(0.5);
                }
                drawDivider();
            } else {
                doc.font('Roboto').fontSize(11).fillColor(lightColor).text(t(lang, 'pdf_no_data')).moveDown();
                drawDivider();
            }

            // 2. QARZDORLAR
            checkPageSpace(120);
            drawSectionHeader(t(lang, 'pdf_section_debtors_months'));
            const qarzCount = data.qarzObj?.count || 0;
            const qarzAmount = data.qarzObj?.amount || 0;

            doc.font('Roboto').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_debtors_total'), { continued: true }).font('Roboto-Bold').text(`${qarzCount} ${t(lang, 'unit_person')} (${formatNumber(qarzAmount, lang)} ${t(lang, 'unit_som')})`).moveDown(0.5);

            const qarzMonths = Object.keys(data.qarzByMonth || {});
            if (qarzMonths.length > 0) {
                // Sort months chronologically
                const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
                const monthsRu = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
                qarzMonths.sort((a, b) => {
                    const [mA, yA] = a.split(' ');
                    const [mB, yB] = b.split(' ');
                    const yearDiff = parseInt(yA) - parseInt(yB);
                    if (yearDiff !== 0) return yearDiff;
                    const idxA = monthsUz.indexOf(mA) !== -1 ? monthsUz.indexOf(mA) : monthsRu.indexOf(mA);
                    const idxB = monthsUz.indexOf(mB) !== -1 ? monthsUz.indexOf(mB) : monthsRu.indexOf(mB);
                    return idxA - idxB;
                });

                doc.font('Roboto').fontSize(11);
                for (const month of qarzMonths) {
                    const qs = data.qarzByMonth[month];
                    if (qs.count === 0 && qs.amount === 0) continue;
                    checkPageSpace(30);
                    doc.fillColor('black').text(`  - ${month}: `).moveUp().fillColor(accentColor).text(`${qs.count} ${t(lang, 'unit_person')} — ${formatNumber(qs.amount, lang)} ${t(lang, 'unit_som')}`, { align: 'right' });
                }
                doc.moveDown();
            }
            drawDivider();

            // 3. LEADLAR VA RAD ETILGANLAR
            checkPageSpace(120);
            drawSectionHeader(t(lang, 'pdf_section_marketing'));
            doc.font('Roboto').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_lead_base'), { continued: true }).font('Roboto-Bold').text(`${formatNumber(data.leadTotal, lang)} ${t(lang, 'unit_ta')}`).moveDown(0.2);
            if (data.leadsObj && Object.keys(data.leadsObj).length > 0) {
                doc.font('Roboto').fontSize(11).fillColor(successColor);
                for (const [sub, cnt] of Object.entries(data.leadsObj).sort((a, b) => b[1] - a[1])) {
                    doc.text(`    + ${sub}: ${formatNumber(cnt, lang)} ${t(lang, 'unit_ta')}`);
                }
            }

            doc.moveDown(0.5);
            doc.font('Roboto').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_rejection_base'), { continued: true }).font('Roboto-Bold').text(`${formatNumber(data.radTotal, lang)} ${t(lang, 'unit_ta')}`).moveDown(0.2);
            if (data.radObj && Object.keys(data.radObj).length > 0) {
                doc.font('Roboto').fontSize(11).fillColor(accentColor);
                for (const [sub, cnt] of Object.entries(data.radObj).sort((a, b) => b[1] - a[1])) {
                    doc.text(`    - ${sub}: ${cnt} ${t(lang, 'unit_ta')}`);
                }
            }
            doc.moveDown();
            drawDivider();

            // 4. BOSH XONALAR VA DAVOMAT
            checkPageSpace(150);
            drawSectionHeader(t(lang, 'pdf_section_infra'));

            // Davomat
            const davomat = data.davomatObj || { expected: 0, attended: 0 };
            const davPerc = davomat.expected > 0 ? ((davomat.attended / davomat.expected) * 100).toFixed(1) : 0;
            doc.font('Roboto').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_attendance_rate'), { continued: true }).font('Roboto-Bold').text(`${davomat.attended}/${davomat.expected} (${davPerc}%)`).moveDown(0.5);

            // Bosh xonalar
            doc.font('Roboto').fontSize(12).fillColor('black').text(t(lang, 'pdf_label_rooms_free', { count: data.bxTotal || 0 })).moveDown(0.5);

            if (data.bxGrouped) {
                const renderRoomsList = (titleKey, roomsArray) => {
                    if (!roomsArray || roomsArray.length === 0) return;
                    checkPageSpace(40);
                    doc.font('Roboto-Bold').fontSize(11).fillColor(secondaryColor).text(` * ${t(lang, titleKey)}:`).font('Roboto').fillColor('black').fontSize(10);
                    roomsArray.forEach((room, i) => {
                        doc.text(`    ${i + 1}. ${t(lang, 'label_filial')}: ${sanitizeText(room.branch)} | ${t(lang, 'label_room')}: ${sanitizeText(room.room)} | ${t(lang, 'label_days')}: ${sanitizeText(room.days)} | ${t(lang, 'label_time')}: ${sanitizeText(room.time)}`);
                    });
                    doc.moveDown(0.3);
                };
                renderRoomsList('pdf_rooms_lunch_before', data.bxGrouped['Tushlikgacha']);
                renderRoomsList('pdf_rooms_lunch_after', data.bxGrouped['Tushlikdan keyin']);
                renderRoomsList('pdf_rooms_full_day', data.bxGrouped["To'liq kun"]);
                renderRoomsList('pdf_rooms_other', data.bxGrouped['Boshqa']);
            }

            // --- POTENTIAL INCOME (Umumiy PDF) ---
            if (data.potentialIncome && data.potentialIncome.roomCount > 0) {
                doc.moveDown(0.5);
                checkPageSpace(80);

                doc.font('Roboto-Bold')
                    .fontSize(12)
                    .fillColor(primaryColor)
                    .text(t(lang, 'pdf_potential_income_title'));

                doc.font('Roboto-Bold')
                    .fontSize(14)
                    .fillColor(accentColor)
                    .text(`${formatNumber(data.potentialIncome.totalPotential, lang)} UZS`)
                    .moveDown(0.3);

                doc.font('Roboto').fontSize(10);
                for (const [branch, info] of Object.entries(data.potentialIncome.byBranch)) {
                    doc.fillColor('black')
                        .text(`${sanitizeText(branch)}: ${info.rooms} xona`, { continued: true })
                        .fillColor(accentColor)
                        .text(`    ${formatNumber(info.potential, lang)} UZS`, { align: 'right' });
                }

                doc.moveDown(0.3);
                doc.font('Roboto').fontSize(8).fillColor(secondaryColor);
                for (const room of data.potentialIncome.rooms) {
                    doc.text(
                        `${sanitizeText(room.branch)}, ${sanitizeText(room.room)}-xona ` +
                        `(${sanitizeText(room.days)} ${sanitizeText(room.time)}): ` +
                        `${room.capacity} x ${formatNumber(room.price_per_student, lang)} = ` +
                        `${formatNumber(room.potential, lang)} UZS`
                    );
                }
            }

            doc.moveDown();
            drawDivider();

            // 5. MUAMMOLAR
            const probTotal = data.probTotal || 0;
            checkPageSpace(60);
            drawSectionHeader(t(lang, 'pdf_section_problems', { count: probTotal }), probTotal > 0);

            if (probTotal > 0 && data.problemsObj) {
                data.problemsObj.forEach((prob, i) => {
                    checkPageSpace(50);
                    const cleanType = (prob.type && !["Muammo qo'shish", "Yangi qo'shish", "Muammolar"].includes(prob.type)) ? prob.type : t(lang, 'label_muammo');
                    doc.font('Roboto-Bold').fontSize(11).fillColor('black').text(t(lang, 'pdf_label_problem_item', { i: i+1, branch: sanitizeText(prob.branch), type: sanitizeText(cleanType) }))
                        .font('Roboto').fontSize(10).fillColor(secondaryColor).text(t(lang, 'pdf_label_problem_note'), { continued: true })
                        .fillColor('#2D3748').text(`${sanitizeText(prob.issue) || t(lang, 'pdf_label_problem_empty')}`).moveDown(0.5);
                });
            } else {
                doc.font('Roboto').fontSize(12).fillColor(successColor).text(t(lang, 'pdf_problems_none')).moveDown(1);
            }

            // FOOTER
            doc.moveDown(1);
            doc.font('Roboto').fontSize(9).fillColor(lightColor).text(t(lang, 'pdf_footer', { at: generatedAt }), { align: 'center' });

            stream.on('finish', () => resolve(fileName));
            stream.on('error', (err) => reject(err));
            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Generate a section-specific PDF report.
 * @param {string} section - Section name (debtors, finance, leads, attendance, rejections, problems, rooms)
 * @param {Object} data - Section data from database
 * @param {string} fileName - Destination file path
 * @param {string} title - Report title
 */
async function generateSectionPdf(section, data, fileName, title) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const stream = fs.createWriteStream(fileName);
            stream.on('error', (err) => reject(err));
            doc.pipe(stream);

            doc.registerFont('Roboto', path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'));
            doc.registerFont('Roboto-Bold', path.join(__dirname, 'fonts', 'Roboto-Bold.ttf'));

            const primaryColor = '#1A365D';
            const secondaryColor = '#4A5568';
            const successColor = '#38A169';
            const accentColor = '#E53E3E';

            const fmtNum = (n) => Number(n || 0).toLocaleString('uz-UZ');
            const fmtMoney = (n) => fmtNum(n) + " so'm";

            const drawDivider = () => {
                doc.moveDown(0.2);
                doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#EDF2F7').lineWidth(1).stroke().moveDown(0.8);
            };

            const checkPage = () => { if (doc.y > 720) doc.addPage(); };

            // ── Title ──
            doc.rect(0, 0, 612, 80).fill(primaryColor);
            doc.font('Roboto-Bold').fontSize(18).fillColor('#FFFFFF').text('Nodir School', 50, 20);
            doc.font('Roboto').fontSize(11).fillColor('#CBD5E0').text(title, 50, 45);
            doc.moveDown(2); doc.y = 100;

            // ── Section Content ──
            if (section === 'debtors') {
                const { summary, byMonth } = data;
                doc.font('Roboto-Bold').fontSize(14).fillColor(primaryColor).text('Qarzdorlar');
                doc.moveDown(0.5);
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor);
                doc.text(`Jami qarzdorlar soni: ${fmtNum(summary?.total_count || 0)}`);
                doc.text(`Jami summa: ${fmtMoney(summary?.total_amount || 0)}`);
                drawDivider();

                if (byMonth && byMonth.length) {
                    doc.font('Roboto-Bold').fontSize(12).fillColor(primaryColor).text('Oylar bo\'yicha');
                    doc.moveDown(0.5);
                    // Table header
                    const tableTop = doc.y;
                    doc.rect(50, tableTop, 495, 22).fill('#EDF2F7');
                    doc.font('Roboto-Bold').fontSize(10).fillColor(primaryColor);
                    doc.text('Oy', 60, tableTop + 6, { width: 200 });
                    doc.text('Soni', 280, tableTop + 6, { width: 100, align: 'right' });
                    doc.text('Summa', 400, tableTop + 6, { width: 135, align: 'right' });
                    doc.y = tableTop + 26;

                    byMonth.forEach((r, i) => {
                        checkPage();
                        if (i % 2 === 0) doc.rect(50, doc.y - 2, 495, 20).fill('#F7FAFC');
                        doc.font('Roboto').fontSize(10).fillColor(secondaryColor);
                        const y = doc.y;
                        doc.text(r.month || '', 60, y, { width: 200 });
                        doc.text(fmtNum(r.total_count), 280, y, { width: 100, align: 'right' });
                        doc.text(fmtMoney(r.total_amount), 400, y, { width: 135, align: 'right' });
                        doc.y = y + 20;
                    });
                }

            } else if (section === 'finance') {
                const { rows, summary, from, to } = data;
                doc.font('Roboto-Bold').fontSize(14).fillColor(primaryColor).text('Moliya');
                doc.moveDown(0.5);
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor);
                doc.text(`Davr: ${from} — ${to}`);
                doc.text(`Kirim: ${fmtMoney(summary?.income || 0)}`);
                doc.text(`Chiqim: ${fmtMoney(summary?.expense || 0)}`);
                const profit = (summary?.income || 0) - (summary?.expense || 0);
                doc.font('Roboto-Bold').fillColor(profit >= 0 ? successColor : accentColor);
                doc.text(`Foyda: ${fmtMoney(profit)}`);
                drawDivider();

                if (rows && rows.length) {
                    doc.font('Roboto-Bold').fontSize(12).fillColor(primaryColor).text('Tranzaksiyalar');
                    doc.moveDown(0.5);
                    const tableTop = doc.y;
                    doc.rect(50, tableTop, 495, 22).fill('#EDF2F7');
                    doc.font('Roboto-Bold').fontSize(9).fillColor(primaryColor);
                    doc.text('Sana', 55, tableTop + 6, { width: 70 });
                    doc.text('Kat.', 128, tableTop + 6, { width: 55 });
                    doc.text('Turi', 186, tableTop + 6, { width: 80 });
                    doc.text('Kirim', 270, tableTop + 6, { width: 70, align: 'right' });
                    doc.text('Chiqim', 345, tableTop + 6, { width: 70, align: 'right' });
                    doc.text('Izoh', 420, tableTop + 6, { width: 125 });
                    doc.y = tableTop + 26;

                    rows.forEach((r, i) => {
                        checkPage();
                        if (i % 2 === 0) doc.rect(50, doc.y - 2, 495, 18).fill('#F7FAFC');
                        doc.font('Roboto').fontSize(8).fillColor(secondaryColor);
                        const y = doc.y;
                        doc.text(r.date_ymd || '', 55, y, { width: 70 });
                        doc.text(r.category || '', 128, y, { width: 55 });
                        doc.text((r.expense_type || '').slice(0, 15), 186, y, { width: 80 });
                        doc.text(r.income ? fmtNum(r.income) : '', 270, y, { width: 70, align: 'right' });
                        doc.text(r.expense ? fmtNum(r.expense) : '', 345, y, { width: 70, align: 'right' });
                        doc.text((r.comment || '').slice(0, 25), 420, y, { width: 125 });
                        doc.y = y + 18;
                    });
                }

            } else if (section === 'leads') {
                const { bySubject, total, rows } = data;
                doc.font('Roboto-Bold').fontSize(14).fillColor(primaryColor).text('Leadlar');
                doc.moveDown(0.5);
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor);
                doc.text(`Jami: ${fmtNum(total || 0)}`);
                drawDivider();

                if (bySubject && bySubject.length) {
                    doc.font('Roboto-Bold').fontSize(12).fillColor(primaryColor).text('Fanlar bo\'yicha');
                    doc.moveDown(0.5);
                    bySubject.forEach((r, i) => {
                        checkPage();
                        if (i % 2 === 0) doc.rect(50, doc.y - 2, 495, 20).fill('#F7FAFC');
                        doc.font('Roboto').fontSize(10).fillColor(secondaryColor);
                        const y = doc.y;
                        doc.text(r.subject || '', 60, y, { width: 300 });
                        doc.text(fmtNum(r.total), 380, y, { width: 155, align: 'right' });
                        doc.y = y + 20;
                    });
                }

                if (rows && rows.length) {
                    drawDivider();
                    doc.font('Roboto-Bold').fontSize(12).fillColor(primaryColor).text('Kunlik yozuvlar');
                    doc.moveDown(0.5);
                    const tableTop = doc.y;
                    doc.rect(50, tableTop, 495, 22).fill('#EDF2F7');
                    doc.font('Roboto-Bold').fontSize(9).fillColor(primaryColor);
                    doc.text('Sana', 60, tableTop + 6, { width: 100 });
                    doc.text('Fan', 170, tableTop + 6, { width: 200 });
                    doc.text('Soni', 400, tableTop + 6, { width: 135, align: 'right' });
                    doc.y = tableTop + 26;
                    rows.forEach((r, i) => {
                        checkPage();
                        if (i % 2 === 0) doc.rect(50, doc.y - 2, 495, 18).fill('#F7FAFC');
                        doc.font('Roboto').fontSize(9).fillColor(secondaryColor);
                        const y = doc.y;
                        doc.text(r.date_ymd || '', 60, y, { width: 100 });
                        doc.text(r.subject || '', 170, y, { width: 200 });
                        doc.text(fmtNum(r.count), 400, y, { width: 135, align: 'right' });
                        doc.y = y + 18;
                    });
                }

            } else if (section === 'attendance') {
                const { summary, rows } = data;
                const pct = summary?.expected > 0 ? Math.round(summary.attended / summary.expected * 100) : 0;
                doc.font('Roboto-Bold').fontSize(14).fillColor(primaryColor).text('Davomat');
                doc.moveDown(0.5);
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor);
                doc.text(`Kutilgan: ${fmtNum(summary?.expected || 0)}`);
                doc.text(`Kelgan: ${fmtNum(summary?.attended || 0)}`);
                doc.font('Roboto-Bold').fillColor(pct >= 80 ? successColor : accentColor);
                doc.text(`Davomat: ${pct}%`);
                drawDivider();

                if (rows && rows.length) {
                    doc.font('Roboto-Bold').fontSize(12).fillColor(primaryColor).text('Kunlik');
                    doc.moveDown(0.5);
                    const tableTop = doc.y;
                    doc.rect(50, tableTop, 495, 22).fill('#EDF2F7');
                    doc.font('Roboto-Bold').fontSize(10).fillColor(primaryColor);
                    doc.text('Sana', 60, tableTop + 6, { width: 150 });
                    doc.text('Kutilgan', 230, tableTop + 6, { width: 100, align: 'right' });
                    doc.text('Kelgan', 350, tableTop + 6, { width: 100, align: 'right' });
                    doc.text('%', 460, tableTop + 6, { width: 75, align: 'right' });
                    doc.y = tableTop + 26;
                    rows.forEach((r, i) => {
                        checkPage();
                        if (i % 2 === 0) doc.rect(50, doc.y - 2, 495, 20).fill('#F7FAFC');
                        doc.font('Roboto').fontSize(10).fillColor(secondaryColor);
                        const y = doc.y;
                        const rp = r.expected > 0 ? Math.round(r.attended / r.expected * 100) : 0;
                        doc.text(r.date_ymd || '', 60, y, { width: 150 });
                        doc.text(fmtNum(r.expected), 230, y, { width: 100, align: 'right' });
                        doc.text(fmtNum(r.attended), 350, y, { width: 100, align: 'right' });
                        doc.text(rp + '%', 460, y, { width: 75, align: 'right' });
                        doc.y = y + 20;
                    });
                }

            } else if (section === 'rejections') {
                const { bySubject, total } = data;
                doc.font('Roboto-Bold').fontSize(14).fillColor(primaryColor).text('Rad etilganlar');
                doc.moveDown(0.5);
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor);
                doc.text(`Jami: ${fmtNum(total || 0)}`);
                drawDivider();

                if (bySubject && bySubject.length) {
                    bySubject.forEach((r, i) => {
                        checkPage();
                        if (i % 2 === 0) doc.rect(50, doc.y - 2, 495, 20).fill('#F7FAFC');
                        doc.font('Roboto').fontSize(10).fillColor(secondaryColor);
                        const y = doc.y;
                        doc.text(r.subject || '', 60, y, { width: 300 });
                        doc.text(fmtNum(r.total), 380, y, { width: 155, align: 'right' });
                        doc.y = y + 20;
                    });
                }

            } else if (section === 'problems') {
                const { rows } = data;
                doc.font('Roboto-Bold').fontSize(14).fillColor(primaryColor).text('Muammolar');
                doc.moveDown(0.5);
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor);
                doc.text(`Jami: ${fmtNum(rows?.length || 0)}`);
                drawDivider();

                (rows || []).forEach((p, i) => {
                    checkPage();
                    doc.font('Roboto-Bold').fontSize(10).fillColor(accentColor).text(`${i + 1}. ${p.branch || ''} — ${p.type || ''}`);
                    doc.font('Roboto').fontSize(9).fillColor(secondaryColor).text(p.issue || '');
                    doc.font('Roboto').fontSize(8).fillColor('#A0AEC0').text(p.timestamp || p.date_ymd || '');
                    doc.moveDown(0.5);
                });

            } else if (section === 'rooms') {
                const { rooms, total, potential } = data;
                doc.font('Roboto-Bold').fontSize(14).fillColor(primaryColor).text('Bo\'sh xonalar');
                doc.moveDown(0.5);
                doc.font('Roboto').fontSize(11).fillColor(secondaryColor);
                doc.text(`Jami: ${fmtNum(total || 0)} ta xona`);
                doc.text(`Potensial daromad: ${fmtMoney(potential || 0)}`);
                drawDivider();

                if (rooms && rooms.length) {
                    const tableTop = doc.y;
                    doc.rect(50, tableTop, 495, 22).fill('#EDF2F7');
                    doc.font('Roboto-Bold').fontSize(8).fillColor(primaryColor);
                    doc.text('Filial', 55, tableTop + 6, { width: 80 });
                    doc.text('Xona', 138, tableTop + 6, { width: 50 });
                    doc.text('Kunlar', 191, tableTop + 6, { width: 70 });
                    doc.text('Vaqt', 264, tableTop + 6, { width: 70 });
                    doc.text('Sig\'im', 340, tableTop + 6, { width: 50, align: 'right' });
                    doc.text('Narx', 395, tableTop + 6, { width: 70, align: 'right' });
                    doc.text('Potensial', 470, tableTop + 6, { width: 70, align: 'right' });
                    doc.y = tableTop + 26;

                    rooms.forEach((r, i) => {
                        checkPage();
                        if (i % 2 === 0) doc.rect(50, doc.y - 2, 495, 18).fill('#F7FAFC');
                        doc.font('Roboto').fontSize(8).fillColor(secondaryColor);
                        const y = doc.y;
                        doc.text((r.branch || '').slice(0, 12), 55, y, { width: 80 });
                        doc.text(r.room || '', 138, y, { width: 50 });
                        doc.text((r.days || '').slice(0, 10), 191, y, { width: 70 });
                        doc.text(r.time || '', 264, y, { width: 70 });
                        doc.text(fmtNum(r.capacity), 340, y, { width: 50, align: 'right' });
                        doc.text(fmtNum(r.price_per_student), 395, y, { width: 70, align: 'right' });
                        doc.text(fmtNum((r.capacity || 0) * (r.price_per_student || 0)), 470, y, { width: 70, align: 'right' });
                        doc.y = y + 18;
                    });
                }
            }

            // ── Footer ──
            doc.moveDown(1);
            checkPage();
            const now = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
            doc.font('Roboto').fontSize(9).fillColor('#A0AEC0').text(`Yaratilgan: ${now}`, { align: 'center' });

            stream.on('finish', () => resolve(fileName));
            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

module.exports = { generatePdfReport, generateUmumiyPdfReport, generateSectionPdf };
