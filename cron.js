const cron = require('node-cron');
const storage = require('./storage');
const warningsDb = require('./warningsDb');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const db = require('./db');
const { getTashkentDateString, getTashkentNow, getWeekRange, getMonthRange } = require('./utils');
const { generateDailyReport, generateWeeklyReport, generateWeeklyPdf, generateMonthlyReport, generateMonthlyPdf } = require('./ceo_reports');
const crmSync = require('./crm-sync');

const LEAD_MONITOR_THRESHOLD = 15;

const builtInCronTasks = new Map();

// We need a way to store active manager chat IDs to send reminders.
// For now, we will store them dynamically when they interact, or rely on a generic broadcast.
// In a real app, you'd save this to a 'Users' Google Sheet.
const activeUsers = new Set();

// M-30: Track running state per job to prevent overlapping executions
const isRunning = {};

async function registerUser(ctx) {
    if (ctx.from && ctx.from.id) {
        // Cap in-memory set to prevent unbounded growth
        if (activeUsers.size > 10000) {
            const first = activeUsers.values().next().value;
            activeUsers.delete(first);
        }
        activeUsers.add(ctx.from.id);
        await storage.saveActiveUser(ctx.from.id);
    }
}

/**
 * Send message to all users with 'reports' section
 * sendFn receives (userId, lang) so cron handlers can generate per-language content
 */
async function sendToReportsUsers(bot, sendFn) {
    try {
        const allUsers = await storage.loadAuthorizedUsers();
        const targets = Object.values(allUsers).filter(u => u.sections && u.sections.includes('reports'));
        if (targets.length === 0) {
            logger.info('No reports users found. Skipping.');
            return;
        }
        for (let i = 0; i < targets.length; i++) {
            const user = targets[i];
            // M-08: Rate limit — pause every 25 messages to avoid Telegram 429 errors
            if (i > 0 && i % 25 === 0) await new Promise(r => setTimeout(r, 1000));
            else if (i > 0) await new Promise(r => setTimeout(r, 100));
            try {
                await sendFn(user.id, user.lang || 'uz');
            } catch (e) {
                if (e.description && (e.description.includes('forbidden') || e.description.includes('blocked') || e.description.includes('deactivated'))) {
                    logger.info(`Reports user ${user.id} (${user.name}) is unreachable. Skipping.`);
                } else {
                    logger.error(`Failed to send to reports user ${user.id}:`, e.message);
                }
            }
        }
    } catch (e) {
        logger.error('sendToReportsUsers error:', e.message);
    }
}

/**
 * Start background cron jobs
 * @param {import('telegraf').Telegraf} bot 
 */
async function startCronJobs(bot) {
    logger.info("⏰ Starting Cron Jobs...");

    // Initialize activeUsers from storage
    try {
        const savedUsers = await storage.loadActiveUsers();
        // Cap initial load to prevent unbounded memory usage
        const maxLoad = Math.min(savedUsers.length, 10000);
        for (let i = 0; i < maxLoad; i++) activeUsers.add(savedUsers[i]);
        logger.info(`✅ Loaded ${activeUsers.size} active users for reminders.`);
    } catch (e) {
        logger.error("Failed to load active users for cron:", e);
    }

    // Load full settings to get schedule overrides
    let fullSettings = {};
    try {
        fullSettings = await storage.loadCronSettings();
    } catch (e) {
        logger.error('Failed to load cron settings, using defaults:', e.message);
    }

    // Helper to register built-in crons dynamically
    function registerBuiltInProcess(key, defaultExpr, handler) {
        // Stop existing task if any
        if (builtInCronTasks.has(key)) {
            builtInCronTasks.get(key).stop();
        }

        const settings = fullSettings[key] || {};
        if (settings.enabled === false) {
            logger.info(`⏰ ${key} disabled, skipping.`);
            return;
        }

        const expr = settings.cronExpression || defaultExpr;
        const task = cron.schedule(expr, async () => {
            // M-07/M-30: Prevent overlapping executions.
            // In single-threaded Node.js the check-and-set below is atomic within
            // the same tick — no race condition is possible between the if-check
            // and the assignment because no other code can interleave synchronously.
            if (isRunning[key]) { logger.warn(`Skipping ${key} — still running`); return; }
            isRunning[key] = true;
            try {
                // Re-check enabled status at runtime
                try {
                    const currentSettings = await storage.loadCronSettingsSimple();
                    if (currentSettings[key] === false) {
                        logger.info(`⏰ ${key} disabled at runtime, skipping execution.`);
                        return;
                    }
                } catch (e) {
                    logger.error(`⏰ Failed to check settings for ${key}, running anyway:`, e.message);
                }
                await handler();
            } catch (e) {
                logger.error(`Cron job ${key} failed:`, e.message);
            } finally {
                isRunning[key] = false;
            }
        }, {
            scheduled: true,
            timezone: "Asia/Tashkent"
        });

        builtInCronTasks.set(key, task);
        logger.info(`⏰ Registered built-in cron: ${key} (${expr})`);
    }

    // 0. CRM Sync - Every hour at :05 (if configured)
    if (crmSync.isConfigured()) {
        registerBuiltInProcess('crm_sync', '5 * * * *', async () => {
            logger.info('⏰ Running CRM Sync...');
            const results = await crmSync.syncAll();
            logger.info('⏰ CRM Sync complete:', JSON.stringify(results));
        });
        logger.info('✅ CRM Sync enabled — running every hour');
    } else {
        logger.info('ℹ️ CRM Sync disabled — CRM_BASE_URL or CRM_PHONE not set');
    }

    // 1. Manager Reminder - Every day at 18:00
    registerBuiltInProcess('manager_reminder', '0 18 * * *', async () => {
        logger.info("⏰ Running 18:00 Manager Reminder...");
        const message = `⚠️ **Eslatma!**\n\nHurmatli menejer, soat 18:00 bo'ldi.\nIltimos, bugungi joriy hisobotlarni bot orqali topshirish esdan chiqmasin! /start`;

        let _sendIdx = 0;
        for (const userId of activeUsers) {
            // M-08: Rate limit — pause every 25 messages to avoid Telegram 429 errors
            if (_sendIdx > 0 && _sendIdx % 25 === 0) await new Promise(r => setTimeout(r, 1000));
            _sendIdx++;
            try {
                await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
            } catch (e) {
                if (e.description && (e.description.includes('forbidden') || e.description.includes('blocked'))) {
                    logger.info(`User ${userId} has blocked the bot. Removing from active users.`);
                    try {
                        await storage.removeActiveUser(userId);
                        activeUsers.delete(userId);
                    } catch (err) { logger.error('Failed to remove active user:', err.message); }
                } else if (e.description && e.description.includes('deactivated')) {
                    logger.info(`User ${userId} account deactivated. Removing from active users.`);
                    try {
                        await storage.removeActiveUser(userId);
                        activeUsers.delete(userId);
                    } catch (err) { logger.error('Failed to remove active user:', err.message); }
                } else {
                    logger.error(`Failed to send reminder to ${userId}: ${e.message}`);
                }
            }
        }
    });

    // 2. Reports Users Morning Summary - Every day at 09:00 AM (daily text only)
    registerBuiltInProcess('morning_summary', '0 9 * * *', async () => {
        logger.info("⏰ Running 09:00 Daily Report Summary...");
        try {
            const tashNow = getTashkentNow();
            tashNow.setUTCDate(tashNow.getUTCDate() - 1);
            const yesterdayYmd = getTashkentDateString(tashNow);

            // Cache reports per language to avoid regenerating
            const reportCache = {};
            await sendToReportsUsers(bot, async (userId, lang) => {
                if (!reportCache[lang]) {
                    reportCache[lang] = await generateDailyReport(yesterdayYmd, lang);
                }
                if (reportCache[lang]) await bot.telegram.sendMessage(userId, reportCache[lang], { parse_mode: 'Markdown' });
            });

            logger.info("✅ Completed morning daily report for all reports users.");
        } catch (e) {
            logger.error("Failed to generate morning summary:", e.message);
        }
    });

    // 3. Hourly Lead Threshold Monitor
    registerBuiltInProcess('lead_monitor', '0 * * * *', async () => {
        logger.info("⏰ Running Hourly Lead Monitor...");
        try {
            const leadsObj = await storage.getLeadStatus();
            for (const [subject, count] of Object.entries(leadsObj)) {
                if (count >= LEAD_MONITOR_THRESHOLD) {
                    const TWO_DAYS = 48 * 60 * 60 * 1000;
                    const lastWarning = await warningsDb.getLastWarningTime('lead_' + subject);
                    if (Date.now() - lastWarning > TWO_DAYS) {
                        const msg = `⚠️ **DIQQAT! Leadlar soni oshib ketdi!**\n\n🔹 **Fan:** ${subject}\n📈 **Joriy leadlar:** ${count} ta\n\n*${subject} fandan qiziqilganlar soni ${LEAD_MONITOR_THRESHOLD} tadan oshdi, lekin hali guruh ochilmadi. Iltimos e'tibor qarating!*`;
                        await sendToReportsUsers(bot, async (userId) => {
                            await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
                        });
                        logger.info(`✅ Sent lead warning for ${subject} to all reports users.`);
                        await warningsDb.setLastWarningTime('lead_' + subject, Date.now());
                    }
                }
            }
        } catch (e) {
            logger.error("Failed to run Hourly Lead Monitor:", e.message);
        }
    });

    // 4. Weekly Reports Summary - Every Monday at 09:15
    registerBuiltInProcess('weekly_report', '15 9 * * 1', async () => {
        logger.info("⏰ Running Monday 09:00 Weekly Summary...");
        const pdfCache = {};
        try {
            const tashNow = getTashkentNow();
            tashNow.setUTCDate(tashNow.getUTCDate() - 7);
            const lastWeekYmd = getTashkentDateString(tashNow);
            const range = getWeekRange(lastWeekYmd);
            logger.info(`  Generating weekly report: ${range.start} — ${range.end}`);

            // Cache reports and PDFs per language
            const textCache = {};
            await sendToReportsUsers(bot, async (userId, lang) => {
                if (!textCache[lang]) {
                    textCache[lang] = await generateWeeklyReport(range.start, range.end, lang);
                    pdfCache[lang] = await generateWeeklyPdf(range.start, range.end, lang);
                }
                await bot.telegram.sendMessage(userId, textCache[lang], { parse_mode: 'Markdown' });
                if (pdfCache[lang] && fs.existsSync(pdfCache[lang])) {
                    await bot.telegram.sendDocument(userId, {
                        source: fs.createReadStream(pdfCache[lang]),
                        filename: `NS_Weekly_${range.start}_to_${range.end}.pdf`
                    }, { caption: `📆 **Xaftalik Hisobot** (${range.start} — ${range.end})`, parse_mode: 'Markdown' });
                }
            });
            logger.info("  ✅ Weekly summary sent to all reports users.");
        } catch (e) {
            logger.error("  ❌ Failed to send weekly summary:", e.message);
        } finally {
            for (const p of Object.values(pdfCache)) {
                try { if (p) fs.unlinkSync(p); } catch (_) { }
            }
        }
    });

    // 5. Monthly Reports Summary - 1st of every month at 09:30
    registerBuiltInProcess('monthly_report', '30 9 1 * *', async () => {
        logger.info("⏰ Running Monthly Summary (1st of month)...");
        const pdfCache = {};
        try {
            const now = getTashkentNow();
            const prev = new Date(now);
            prev.setUTCMonth(prev.getUTCMonth() - 1);
            const prevMonth = prev.getUTCMonth() + 1;
            const prevYear = prev.getUTCFullYear();
            const range = getMonthRange(prevMonth, prevYear);
            const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
            logger.info(`  Generating monthly report: ${monthsUz[prevMonth - 1]} ${prevYear}`);

            // Cache reports and PDFs per language
            const textCache = {};
            await sendToReportsUsers(bot, async (userId, lang) => {
                if (!textCache[lang]) {
                    textCache[lang] = await generateMonthlyReport(range.start, range.end, lang);
                    pdfCache[lang] = await generateMonthlyPdf(range.start, range.end, lang);
                }
                await bot.telegram.sendMessage(userId, textCache[lang], { parse_mode: 'Markdown' });
                if (pdfCache[lang] && fs.existsSync(pdfCache[lang])) {
                    await bot.telegram.sendDocument(userId, {
                        source: fs.createReadStream(pdfCache[lang]),
                        filename: `NS_Monthly_${monthsUz[prevMonth - 1]}_${prevYear}.pdf`
                    }, { caption: `📊 **Oylik Hisobot** — ${monthsUz[prevMonth - 1]} ${prevYear}`, parse_mode: 'Markdown' });
                }
            });
            logger.info("  ✅ Monthly summary sent to all reports users.");
        } catch (e) {
            logger.error("  ❌ Failed to send monthly summary:", e.message);
        } finally {
            for (const p of Object.values(pdfCache)) {
                try { if (p) fs.unlinkSync(p); } catch (_) { }
            }
        }
    });

    // 6. Manager Accountability Escalation — 21:00 daily
    registerBuiltInProcess('accountability', '0 21 * * *', async () => {
        logger.info("⏰ Running 21:00 Manager Accountability Check...");

        try {
            const todayYmd = getTashkentDateString();

            // Load all authorized users to get manager list
            const allUsers = await storage.loadAuthorizedUsers();
            const managers = Object.values(allUsers).filter(u => u.sections && ['lead','qarzdorlar','rad_etilganlar','moliya','davomat','muammo','bosh_xonalar'].some(s => u.sections.includes(s)));
            if (managers.length === 0) return;

            // Query DB directly for distinct manager IDs who submitted data today across all tables
            const reportingIds = new Set();
            const ALLOWED_TABLES = new Set(['leads', 'debtors', 'rejections', 'finance', 'attendance', 'problems', 'empty_rooms']);
            const tables = ['leads', 'debtors', 'rejections', 'finance', 'attendance', 'problems', 'empty_rooms'];
            for (const table of tables) {
                if (!ALLOWED_TABLES.has(table)) continue;
                try {
                    const rows = db.prepare(`SELECT DISTINCT manager_id FROM ${table} WHERE date_ymd = ? AND manager_id IS NOT NULL`).all(todayYmd);
                    rows.forEach(r => { if (r.manager_id) reportingIds.add(String(r.manager_id).trim()); });
                } catch (_) { /* table may not have manager_id column */ }
            }

            const missingManagers = managers.filter(m => !reportingIds.has(String(m.id).trim()));

            if (missingManagers.length > 0) {
                const missingList = missingManagers.map(m => `   ❌ ${m.name}`).join('\n');
                const reporterList = managers
                    .filter(m => reportingIds.has(String(m.id).trim()))
                    .map(m => `   ✅ ${m.name}`)
                    .join('\n');

                let msg = `🚨 **Hisobot topshirish nazorati** (${todayYmd})\n\n`;
                msg += `❗️ **Hisobot topshirmaganlar:**\n${missingList}\n\n`;

                if (reporterList) {
                    msg += `✅ **Hisobot topshirganlar:**\n${reporterList}\n\n`;
                }

                msg += `*Iltimos, hisobotini kechiktirgan menejerlar bilan bog'laning.*`;
                await sendToReportsUsers(bot, async (userId) => {
                    await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
                });
                logger.info(`  ⚠️ Reports users notified: ${missingManagers.length} managers missing reports.`);
            } else {
                logger.info("  ✅ All authorized managers submitted reports today.");
            }
        } catch (e) {
            logger.error("  ❌ Failed to run accountability check:", e.message);
        }
    });

    // 7. CEO Analytics Digest — Every day at 09:30
    registerBuiltInProcess('ceo_analytics_digest', '30 9 * * *', async () => {
        logger.info("⏰ Running 09:30 CEO Analytics Digest...");
        try {
            const today = getTashkentDateString();
            const tashYesterday = getTashkentNow();
            tashYesterday.setUTCDate(tashYesterday.getUTCDate() - 1);
            const yesterday = getTashkentDateString(tashYesterday);
            const tashWeekAgo = getTashkentNow();
            tashWeekAgo.setUTCDate(tashWeekAgo.getUTCDate() - 7);
            const weekAgo = getTashkentDateString(tashWeekAgo);

            const safeQuery = (sql, ...params) => {
                try { return db.prepare(sql).get(...params); } catch (e) { logger.warn(`[analytics] query failed: ${e.message}`); return null; }
            };
            const safeQueryAll = (sql, ...params) => {
                try { return db.prepare(sql).all(...params); } catch (e) { logger.warn(`[analytics] query failed: ${e.message}`); return []; }
            };

            // Yesterday's data
            const yLeads = safeQuery('SELECT COALESCE(SUM(count),0) as t FROM leads WHERE date_ymd = ?', yesterday) || { t: 0 };
            const yFin = safeQuery('SELECT COALESCE(SUM(income),0) as inc, COALESCE(SUM(expense),0) as exp FROM finance WHERE date_ymd = ?', yesterday) || { inc: 0, exp: 0 };
            const yAtt = safeQuery('SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd = ?', yesterday) || { exp: 0, att: 0 };
            const yDebtors = safeQuery('SELECT COALESCE(SUM(count),0) as cnt FROM debtors WHERE date_ymd = ?', yesterday) || { cnt: 0 };
            const yRej = safeQuery('SELECT COALESCE(SUM(count),0) as t FROM rejections WHERE date_ymd = ?', yesterday) || { t: 0 };
            const attPct = yAtt.exp > 0 ? Math.round(yAtt.att / yAtt.exp * 100) : 0;

            // 30-day averages for anomaly detection
            const tashD30 = getTashkentNow();
            tashD30.setUTCDate(tashD30.getUTCDate() - 30);
            const d30 = getTashkentDateString(tashD30);
            const avgLeads = safeQuery('SELECT COALESCE(AVG(daily_total), 0) as avg FROM (SELECT date_ymd, SUM(count) as daily_total FROM leads WHERE date_ymd >= ? AND date_ymd < ? GROUP BY date_ymd)', d30, yesterday) || { avg: 0 };
            const avgIncome = safeQuery('SELECT COALESCE(AVG(daily_total), 0) as avg FROM (SELECT date_ymd, SUM(income) as daily_total FROM finance WHERE date_ymd >= ? AND date_ymd < ? GROUP BY date_ymd)', d30, yesterday) || { avg: 0 };
            const avgExpense = safeQuery('SELECT COALESCE(AVG(daily_total), 0) as avg FROM (SELECT date_ymd, SUM(expense) as daily_total FROM finance WHERE date_ymd >= ? AND date_ymd < ? GROUP BY date_ymd)', d30, yesterday) || { avg: 0 };

            // Top growing subject (this week vs last week)
            const thisWeekLeads = safeQueryAll('SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ? AND date_ymd <= ? GROUP BY subject ORDER BY total DESC', weekAgo, yesterday);
            const tash2Weeks = getTashkentNow();
            tash2Weeks.setUTCDate(tash2Weeks.getUTCDate() - 14);
            const twoWeeksAgo = getTashkentDateString(tash2Weeks);
            const lastWeekLeads = safeQueryAll('SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ? AND date_ymd < ? GROUP BY subject', twoWeeksAgo, weekAgo);
            const lastWeekMap = {};
            lastWeekLeads.forEach(r => { lastWeekMap[r.subject] = r.total; });

            let topGrower = null;
            let topGrowth = -Infinity;
            thisWeekLeads.forEach(r => {
                const prev = lastWeekMap[r.subject] || 0;
                const growth = prev > 0 ? ((r.total - prev) / prev * 100) : (r.total > 0 ? 100 : 0);
                if (growth > topGrowth && r.total > 0) { topGrower = r.subject; topGrowth = growth; }
            });

            // Build message
            const fmt = n => Number(n).toLocaleString('uz-UZ');
            const fmtM = n => { const a = Math.abs(n); if (a >= 1e6) return (n/1e6).toFixed(1) + ' mln'; if (a >= 1e3) return (n/1e3).toFixed(0) + 'k'; return fmt(n); };

            let msg = `📊 <b>Kunlik tahlil — ${yesterday}</b>\n\n`;
            msg += `📈 Leadlar: <b>${fmt(yLeads.t)}</b>`;
            if (avgLeads.avg > 0) {
                const diff = Math.round((yLeads.t - avgLeads.avg) / avgLeads.avg * 100);
                msg += ` (${diff >= 0 ? '↑' : '↓'}${Math.abs(diff)}% o'rtachadan)`;
            }
            msg += `\n💰 Kirim: <b>${fmtM(yFin.inc)} so'm</b>\n`;
            msg += `💸 Chiqim: <b>${fmtM(yFin.exp)} so'm</b>\n`;
            msg += `📋 Davomat: <b>${attPct}%</b> (${fmt(yAtt.att)}/${fmt(yAtt.exp)})\n`;
            if (yDebtors.cnt !== 0) msg += `🛡️ Yangi qarzdorlar: <b>${fmt(yDebtors.cnt)}</b>\n`;
            if (yRej.t > 0) msg += `❌ Rad etilgan: <b>${fmt(yRej.t)}</b>\n`;

            // Anomalies
            let anomalies = [];
            if (avgExpense.avg > 0 && yFin.exp > avgExpense.avg * 2) {
                anomalies.push(`⚠️ Chiqim odatdagidan <b>${Math.round(yFin.exp / avgExpense.avg)}x</b> ko'p!`);
            }
            if (avgLeads.avg > 0 && yLeads.t < avgLeads.avg * 0.3 && yLeads.t >= 0) {
                anomalies.push(`⚠️ Leadlar odatdagidan <b>${Math.round((1 - yLeads.t / avgLeads.avg) * 100)}%</b> kam`);
            }
            if (attPct > 0 && attPct < 60) {
                anomalies.push(`⚠️ Davomat juda past: <b>${attPct}%</b>`);
            }
            // Debtors growing faster than income this month
            const mStart = today.slice(0, 7) + '-01';
            const monthDebtAmt = safeQuery('SELECT COALESCE(SUM(amount),0) as amt FROM debtors WHERE date_ymd >= ? AND date_ymd <= ?', mStart, yesterday) || { amt: 0 };
            const monthIncome = safeQuery('SELECT COALESCE(SUM(income),0) as inc FROM finance WHERE date_ymd >= ? AND date_ymd <= ?', mStart, yesterday) || { inc: 0 };
            if (monthDebtAmt.amt > monthIncome.inc * 0.5 && monthDebtAmt.amt > 0) {
                anomalies.push(`⚠️ Qarzlar tushum ning <b>${Math.round(monthDebtAmt.amt / Math.max(monthIncome.inc, 1) * 100)}%</b> ini tashkil etadi`);
            }

            if (anomalies.length) {
                msg += `\n🚨 <b>Ogohlantirish:</b>\n` + anomalies.join('\n') + '\n';
            }

            // Top mover
            if (topGrower && topGrowth > 0) {
                msg += `\n🏆 Eng tez o'suvchi fan: <b>${topGrower}</b> (↑${Math.round(topGrowth)}% haftalik)`;
            }

            // KPI progress
            const UZ_MONTHS = {1:'Yanvar',2:'Fevral',3:'Mart',4:'Aprel',5:'May',6:'Iyun',7:'Iyul',8:'Avgust',9:'Sentyabr',10:'Oktyabr',11:'Noyabr',12:'Dekabr'};
            const now = getTashkentNow();
            const curMonth = UZ_MONTHS[now.getUTCMonth()+1] + ' ' + now.getUTCFullYear();
            const targets = safeQueryAll('SELECT * FROM kpi_targets WHERE month = ?', curMonth);
            if (targets.length > 0) {
                const dayOfMonth = now.getUTCDate();
                const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+1, 0)).getUTCDate();
                const mLeads = safeQuery('SELECT COALESCE(SUM(count),0) as t FROM leads WHERE date_ymd >= ?', mStart) || { t: 0 };
                const mInc = safeQuery('SELECT COALESCE(SUM(income),0) as t FROM finance WHERE date_ymd >= ?', mStart) || { t: 0 };
                msg += `\n\n🎯 <b>KPI — ${curMonth} (kun ${dayOfMonth}/${daysInMonth})</b>\n`;
                targets.forEach(kpi => {
                    let cur = 0;
                    if (kpi.metric === 'income') cur = mInc.t;
                    else if (kpi.metric === 'leads') cur = mLeads.t;
                    const pct = kpi.target_value > 0 ? Math.round(cur / kpi.target_value * 100) : 0;
                    const projected = Math.round(cur / dayOfMonth * daysInMonth);
                    const projPct = kpi.target_value > 0 ? Math.round(projected / kpi.target_value * 100) : 0;
                    const label = kpi.metric === 'income' ? 'Tushum' : kpi.metric === 'leads' ? 'Leadlar' : kpi.metric === 'expense' ? 'Xarajat' : 'Davomat';
                    msg += `  ${pct >= 70 ? '✅' : '⚠️'} ${label}: ${fmtM(cur)}/${fmtM(kpi.target_value)} (${pct}%) → prognoz: ${projPct}%\n`;
                });
            }

            const finalMsg = msg;
            const allUsers = await storage.loadAuthorizedUsers();
            const reportTargets = Object.values(allUsers).filter(u => u.sections && u.sections.includes('reports'));
            if (reportTargets.length > 0) {
                for (let _ri = 0; _ri < reportTargets.length; _ri++) {
                    const user = reportTargets[_ri];
                    // M-08: Rate limit — pause every 25 messages to avoid Telegram 429 errors
                    if (_ri > 0 && _ri % 25 === 0) await new Promise(r => setTimeout(r, 1000));
                    try {
                        await bot.telegram.sendMessage(user.id, finalMsg, { parse_mode: 'HTML' });
                    } catch (e) {
                        if (e.description && (e.description.includes('forbidden') || e.description.includes('blocked') || e.description.includes('deactivated'))) {
                            logger.info(`Reports user ${user.id} (${user.name}) is unreachable. Skipping.`);
                        } else {
                            logger.error(`Failed to send analytics digest to ${user.id}:`, e.message);
                        }
                    }
                }
                logger.info("✅ CEO analytics digest sent to all reports users.");
            } else {
                const ceoId = process.env.CEO_TELEGRAM_ID;
                if (ceoId) {
                    await bot.telegram.sendMessage(ceoId, finalMsg, { parse_mode: 'HTML' });
                    logger.info("✅ CEO analytics digest sent to CEO fallback.");
                }
            }
        } catch (e) {
            logger.error("❌ CEO analytics digest failed:", e.message);
        }
    });

    // 8. Empty Rooms Snapshot — Every day at 19:30 (before end of workday)
    registerBuiltInProcess('empty_rooms_snapshot', '30 19 * * *', async () => {
        logger.info("⏰ Running 19:30 Empty Rooms Snapshot...");
        try {
            const todayYmd = getTashkentDateString();
            const result = await storage.saveEmptyRoomsSnapshot(todayYmd);
            logger.info(`✅ Empty rooms snapshot saved: ${result.roomCount} rooms, potential: ${result.totalPotential}`);
        } catch (e) {
            logger.error("❌ Failed to save empty rooms snapshot:", e.message);
        }
    });

    // 8. Database Backup — Every day at 02:00 AM
    registerBuiltInProcess('db_backup', '0 2 * * *', async () => {
        logger.info("⏰ Running 02:00 Database Backup...");
        try {
            const dateStr = getTashkentDateString();
            const backupDir = path.join(__dirname, 'data', 'backups');
            await fs.promises.mkdir(backupDir, { recursive: true });
            const destPath = path.join(backupDir, `bot.db.bak-${dateStr}`);
            try {
                await db.backup(destPath);
                logger.info(`✅ Database backed up to ${destPath}`);
            } catch (backupErr) {
                logger.error('Database backup failed:', backupErr.message);
                return;
            }

            // Prune audit_log older than 6 months
            try {
                const auditPruned = db.prepare("DELETE FROM audit_log WHERE date_ymd < date('now', '-6 months')").run();
                if (auditPruned.changes > 0) logger.info(`🧹 Pruned ${auditPruned.changes} old audit_log entries`);
            } catch (e) {
                logger.warn('audit_log prune failed:', e.message);
            }

            // Prune active_users older than 30 days
            try {
                const pruned = db.prepare("DELETE FROM active_users WHERE last_active < datetime('now', '-30 days')").run();
                if (pruned.changes > 0) logger.info(`🧹 Pruned ${pruned.changes} stale active_users entries`);
            } catch (e) {
                logger.warn('active_users prune failed:', e.message);
            }

            // Keep only the last 7 backups (filenames use ISO date format YYYY-MM-DD, so lexicographic sort = chronological)
            const files = (await fs.promises.readdir(backupDir))
                .filter(f => f.startsWith('bot.db.bak-'))
                .sort()
                .reverse();
            for (let i = 7; i < files.length; i++) {
                await fs.promises.unlink(path.join(backupDir, files[i]));
                logger.info(`🗑 Deleted old backup: ${files[i]}`);
            }
        } catch (e) {
            logger.error("❌ Database backup failed:", e.message);
        }
    });

    // 9. Custom Cron Jobs — loaded from CronSozlamalari sheet
    await startCustomCronJobs(bot);

    // 10. Personal cron assignments (CEO→Manager→User)
    await startPersonalCrons(bot);
}

// Track active custom cron tasks so we can restart them when settings change
const customCronTasks = new Map();

async function startCustomCronJobs(bot) {
    try {
        const settings = await storage.loadCronSettings();
        const customKeys = Object.keys(settings).filter(k => k.startsWith('custom_'));

        if (customKeys.length === 0) {
            logger.info('⏰ No custom cron jobs found.');
            return;
        }

        for (const key of customKeys) {
            const s = settings[key];
            if (!s.cronExpression || !s.message) continue;

            // Stop existing task if re-loading
            if (customCronTasks.has(key)) {
                customCronTasks.get(key).stop();
            }

            if (!cron.validate(s.cronExpression)) {
                logger.warn(`⏰ Invalid cron expression for ${key}: ${s.cronExpression}`);
                continue;
            }
            // Safety: Reject expressions that fire too frequently
            const cronParts = s.cronExpression.trim().split(/\s+/);
            if (cronParts.length >= 6 && cronParts[0] !== '0' && cronParts[0] !== '*') {
                logger.warn(`⏰ Custom cron ${key} has seconds field — rejected for safety.`);
                continue;
            }
            if (cronParts[0] === '*' && cronParts[1] === '*') {
                logger.warn(`⏰ Custom cron ${key} fires every minute — rejected for safety.`);
                continue;
            }
            // M-29: Also reject if first field is */N where N < 5 (fires too frequently)
            if (/^\*\/[1-4]$/.test(cronParts[0])) {
                logger.warn(`⏰ Custom cron ${key} fires too frequently — rejected.`);
                continue;
            }

            const task = cron.schedule(s.cronExpression, async () => {
                // Re-check settings at runtime (they may have been toggled)
                let currentSettings;
                try {
                    currentSettings = await storage.loadCronSettings();
                } catch (e) {
                    logger.error(`⏰ Failed to load settings for ${key}:`, e.message);
                    return;
                }
                const current = currentSettings[key];
                if (!current || current.enabled === false) {
                    logger.info(`⏰ Custom cron ${key} disabled, skipping.`);
                    return;
                }

                logger.info(`⏰ Running custom cron: ${current.label || key}`);
                const message = current.message.slice(0, 4000);
                const assignedUsers = current.assignedUsers || [];

                try {
                    if (assignedUsers.length === 0) {
                        // Send to all active users
                        const allUsers = await storage.loadAuthorizedUsers();
                        const _allUsersList = Object.values(allUsers);
                        for (let _ci = 0; _ci < _allUsersList.length; _ci++) {
                            const user = _allUsersList[_ci];
                            // M-08: Rate limit — pause every 25 messages
                            if (_ci > 0 && _ci % 25 === 0) await new Promise(r => setTimeout(r, 1000));
                            try {
                                await bot.telegram.sendMessage(user.id, message, { parse_mode: 'Markdown' });
                            } catch (e) {
                                if (e.description && e.description.includes('forbidden')) {
                                    logger.info(`User ${user.id} has blocked the bot. Skipping.`);
                                } else {
                                    logger.error(`Failed to send custom cron to ${user.id}:`, e.message);
                                }
                            }
                        }
                    } else {
                        for (let _ai = 0; _ai < assignedUsers.length; _ai++) {
                            const userId = assignedUsers[_ai];
                            // M-08: Rate limit — pause every 25 messages
                            if (_ai > 0 && _ai % 25 === 0) await new Promise(r => setTimeout(r, 1000));
                            try {
                                await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
                            } catch (e) {
                                if (e.description && e.description.includes('forbidden')) {
                                    logger.info(`User ${userId} has blocked the bot. Skipping.`);
                                } else {
                                    logger.error(`Failed to send custom cron to ${userId}:`, e.message);
                                }
                            }
                        }
                    }
                } catch (e) {
                    logger.error(`Custom cron ${key} execution error:`, e.message);
                }
            }, {
                scheduled: true,
                timezone: "Asia/Tashkent"
            });

            customCronTasks.set(key, task);
            logger.info(`⏰ Registered custom cron: ${s.label || key} (${s.cronExpression})`);
        }

        logger.info(`✅ Loaded ${customKeys.length} custom cron job(s).`);
    } catch (e) {
        logger.error('Failed to load custom cron jobs:', e.message);
    }
}

// ─── Personal Cron Assignments (CEO→Manager→User) ─────────
const personalCronTasks = new Map();


// ── Generate personalized section-based report for a user ──
async function generateSectionReport(branchId, sections, lang) {
    const sectionList = sections.split(',').filter(Boolean);
    if (!sectionList.length) return null;
    
    const today = getTashkentDateString();
    const tashNow = getTashkentNow();
    tashNow.setUTCDate(tashNow.getUTCDate() - 1);
    const yesterday = getTashkentDateString(tashNow);
    
    const mStart = today.substring(0, 8) + '01';
    
    const brFilter = branchId ? ' AND branch_id = ?' : '';
    const brParams = branchId ? [branchId] : [];
    const brName = branchId ? (db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId)?.name || '') : 'Barcha filiallar';
    
    let msg = `📊 *${brName} — Hisobot*\n📅 ${today}\n\n`;
    
    if (sectionList.includes('lead')) {
        const leads = db.prepare('SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ? AND date_ymd <= ?' + brFilter + ' GROUP BY subject HAVING total > 0 ORDER BY total DESC').all(mStart, today, ...brParams);
        const total = leads.reduce((s, r) => s + r.total, 0);
        msg += `📈 *Leadlar:* ${total} ta\n`;
        leads.slice(0, 5).forEach(r => { msg += `   🔹 ${r.subject}: ${r.total}\n`; });
        if (leads.length > 5) msg += `   ... va yana ${leads.length - 5} ta fan\n`;
        msg += '\n';
    }
    
    if (sectionList.includes('rad_etilganlar')) {
        const rej = db.prepare('SELECT subject, SUM(count) as total FROM rejections WHERE date_ymd >= ? AND date_ymd <= ?' + brFilter + ' GROUP BY subject HAVING total > 0 ORDER BY total DESC').all(mStart, today, ...brParams);
        const total = rej.reduce((s, r) => s + r.total, 0);
        msg += `❌ *Rad etilganlar:* ${total} ta\n`;
        rej.slice(0, 5).forEach(r => { msg += `   🔸 ${r.subject}: ${r.total}\n`; });
        msg += '\n';
    }
    
    if (sectionList.includes('moliya')) {
        const fin = db.prepare('SELECT COALESCE(SUM(income),0) as inc, COALESCE(SUM(expense),0) as exp FROM finance WHERE date_ymd >= ? AND date_ymd <= ?' + brFilter).get(mStart, today, ...brParams);
        const fmtN = (n) => n.toLocaleString('uz-UZ');
        msg += `💰 *Moliya:*\n`;
        msg += `   Kirim: ${fmtN(fin.inc)} so'm\n`;
        msg += `   Chiqim: ${fmtN(fin.exp)} so'm\n`;
        msg += `   Qoldiq: ${fmtN(fin.inc - fin.exp)} so'm\n\n`;
    }
    
    if (sectionList.includes('qarzdorlar')) {
        const debt = db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE 1=1' + brFilter).get(...brParams);
        const fmtN = (n) => n.toLocaleString('uz-UZ');
        msg += `💸 *Qarzdorlar:* ${debt.cnt} ta — ${fmtN(debt.amt)} so'm\n\n`;
    }
    
    if (sectionList.includes('davomat')) {
        const att = db.prepare('SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd = ?' + brFilter).get(yesterday, ...brParams);
        const pct = att.exp > 0 ? Math.round(att.att / att.exp * 100) : 0;
        msg += `📋 *Davomat:* ${pct}% (${att.att}/${att.exp})\n\n`;
    }
    
    if (sectionList.includes('muammo')) {
        const probs = db.prepare("SELECT type, issue, branch FROM problems WHERE status != 'solved'" + brFilter + " ORDER BY id DESC LIMIT 5").all(...brParams);
        if (probs.length) {
            msg += `⚠️ *Ochiq muammolar:* ${probs.length} ta\n`;
            probs.forEach(p => { msg += `   • [${p.type}] ${(p.issue || '').substring(0, 40)}\n`; });
            msg += '\n';
        }
    }
    
    return msg.trim();
}

// Generate CEO report with per-branch breakdown
async function generateCeoReport(sections, lang) {
    const sectionList = sections.split(',').filter(Boolean);
    if (!sectionList.length) return null;
    
    const today = getTashkentDateString();
    const tashNow = getTashkentNow();
    tashNow.setUTCDate(tashNow.getUTCDate() - 1);
    const yesterday = getTashkentDateString(tashNow);
    const mStart = today.substring(0, 8) + '01';
    const branches = db.prepare('SELECT id, name FROM branches ORDER BY name').all();
    
    let msg = `📊 *Barcha filiallar — Hisobot*\n📅 ${today}\n\n`;
    
    for (const br of branches) {
        msg += `🏢 *${br.name}:*\n`;
        const parts = [];
        
        if (sectionList.includes('lead')) {
            const t = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM leads WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?').get(mStart, today, br.id).v;
            parts.push(`📈 Lead: ${t}`);
        }
        if (sectionList.includes('rad_etilganlar')) {
            const t = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?').get(mStart, today, br.id).v;
            parts.push(`❌ Rad: ${t}`);
        }
        if (sectionList.includes('moliya')) {
            const f = db.prepare('SELECT COALESCE(SUM(income),0) as inc, COALESCE(SUM(expense),0) as exp FROM finance WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?').get(mStart, today, br.id);
            const fmtN = (n) => n.toLocaleString('uz-UZ');
            parts.push(`💰 Kirim: ${fmtN(f.inc)} | Chiqim: ${fmtN(f.exp)}`);
        }
        if (sectionList.includes('qarzdorlar')) {
            const d = db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE branch_id = ?').get(br.id);
            parts.push(`💸 Qarzdor: ${d.cnt} ta`);
        }
        if (sectionList.includes('davomat')) {
            const a = db.prepare('SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd = ? AND branch_id = ?').get(yesterday, br.id);
            const pct = a.exp > 0 ? Math.round(a.att / a.exp * 100) : 0;
            parts.push(`📋 Davomat: ${pct}%`);
        }
        if (sectionList.includes('muammo')) {
            const cnt = db.prepare("SELECT COUNT(*) as c FROM problems WHERE status != 'solved' AND branch_id = ?").get(br.id).c;
            if (cnt > 0) parts.push(`⚠️ Muammo: ${cnt} ta`);
        }
        
        msg += parts.map(p => `   ${p}`).join('\n') + '\n\n';
    }
    
    // Lead threshold alerts
    if (sectionList.includes('lead')) {
        for (const br of branches) {
            const activeLeads = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM leads WHERE branch_id = ?').get(br.id).v;
            const activeRej = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE branch_id = ?').get(br.id).v;
            const net = activeLeads - activeRej;
            if (net > 12) {
                msg += `🔴 *DIQQAT:* ${br.name} da ${net} ta aktiv lead (12 dan oshdi!)\n`;
            }
        }
    }
    
    return msg.trim();
}


async function startPersonalCrons(bot) {
    if (isRunning.personalCrons) {
        logger.warn('⏰ startPersonalCrons already running, skipping.');
        return;
    }
    isRunning.personalCrons = true;
    try {
        const rows = db.prepare('SELECT * FROM cron_assignments WHERE enabled = 1').all();
        if (rows.length === 0) {
            logger.info('⏰ No personal cron assignments found.');
            return;
        }

        for (const row of rows) {
            const taskKey = 'personal_' + row.id;

            // Stop existing if reloading
            if (personalCronTasks.has(taskKey)) {
                personalCronTasks.get(taskKey).stop();
            }

            if (!row.schedule || !cron.validate(row.schedule)) {
                logger.warn(`⏰ Invalid schedule for personal cron #${row.id}: ${row.schedule}`);
                continue;
            }

            // Safety: reject too-frequent schedules
            const parts = row.schedule.trim().split(/\s+/);
            if (parts[0] === '*' && parts[1] === '*') {
                logger.warn(`⏰ Personal cron #${row.id} fires every minute — rejected.`);
                continue;
            }
            if (/^\*\/[1-4]$/.test(parts[0])) {
                logger.warn(`⏰ Personal cron #${row.id} fires too frequently — rejected.`);
                continue;
            }

            const message = (row.message || '').slice(0, 4000);
            if (!message) continue;

            const task = cron.schedule(row.schedule, async () => {
                // Re-check enabled at runtime
                const current = db.prepare('SELECT * FROM cron_assignments WHERE id = ? AND enabled = 1').get(row.id);
                if (!current) return;

                logger.info(`⏰ Running personal cron #${row.id}: ${current.label || 'unnamed'}`);

                try {
                    let recipients = [];

                    if (current.assigned_to === 'branch') {
                        recipients = db.prepare('SELECT user_id FROM user_branches WHERE branch_id = ?').all(current.branch_id).map(r => r.user_id);
                    } else {
                        recipients = [current.assigned_to];
                    }

                    // Generate message based on type
                    let finalMessage = current.message;
                    if (current.type === 'report' && current.sections) {
                        // Check if recipient is CEO — send branch breakdown
                        const recipientUser = db.prepare('SELECT role FROM users WHERE telegram_id = ?').get(recipients[0]);
                        if (recipientUser && recipientUser.role === 'ceo' && !current.branch_id) {
                            finalMessage = await generateCeoReport(current.sections, 'uz');
                        } else {
                            finalMessage = await generateSectionReport(current.branch_id || 0, current.sections, 'uz');
                        }
                        if (!finalMessage) return;
                    }

                    for (let i = 0; i < recipients.length; i++) {
                        if (i > 0 && i % 25 === 0) await new Promise(r => setTimeout(r, 1000));
                        try {
                            const msgToSend = current.type === 'report' ? finalMessage : current.message;
                            await bot.telegram.sendMessage(recipients[i], msgToSend, { parse_mode: 'Markdown' });
                        } catch (e) {
                            if (e.description && (e.description.includes('forbidden') || e.description.includes('blocked') || e.description.includes('deactivated'))) {
                                logger.info(`Personal cron: user ${recipients[i]} unreachable.`);
                            } else {
                                logger.error(`Personal cron #${row.id} send to ${recipients[i]} failed:`, e.message);
                            }
                        }
                    }
                } catch (e) {
                    logger.error(`Personal cron #${row.id} execution error:`, e.message);
                }
            }, {
                scheduled: true,
                timezone: "Asia/Tashkent"
            });

            personalCronTasks.set(taskKey, task);
            logger.info(`⏰ Registered personal cron #${row.id}: ${row.label || 'unnamed'} (${row.schedule}) → ${row.assigned_to === 'branch' ? 'branch#' + row.branch_id : row.assigned_to}`);
        }

        logger.info(`✅ Loaded ${rows.length} personal cron assignment(s).`);
    } catch (e) {
        logger.error('Failed to start personal crons:', e.message);
    } finally {
        isRunning.personalCrons = false;
    }
}

/**
 * Utility to manually reload crons after a setting update
 */
async function reloadCrons(bot) {
    logger.info("⏰ Reloading crons (settings changed)...");
    // Ensure all tasks are fully stopped before starting new ones
    await stopCronJobs();
    await startCronJobs(bot);
}

/**
 * Stop all active cron jobs
 */
async function stopCronJobs() {
    logger.info("⏰ Stopping all cron jobs...");

    // Stop built-in crons
    if (builtInCronTasks) {
        for (const [key, task] of builtInCronTasks) {
            try {
                task.stop();
                logger.info(`⏹ Stopped built-in cron: ${key}`);
            } catch (e) {
                logger.error(`Error stopping cron ${key}:`, e);
            }
        }
        builtInCronTasks.clear();
    }

    // Stop custom crons
    if (customCronTasks) {
        for (const [key, task] of customCronTasks) {
            try {
                task.stop();
                logger.info(`⏹ Stopped custom cron: ${key}`);
            } catch (e) {
                logger.error(`Error stopping custom cron ${key}:`, e);
            }
        }
        customCronTasks.clear();
    }

    // Stop personal cron assignments
    if (personalCronTasks) {
        for (const [key, task] of personalCronTasks) {
            try {
                task.stop();
            } catch (e) {
                logger.error(`Error stopping personal cron ${key}:`, e);
            }
        }
        personalCronTasks.clear();
        logger.info(`⏹ Stopped all personal crons.`);
    }

    // Reset running flags so restarted jobs don't think they're still active
    for (const key of Object.keys(isRunning)) {
        isRunning[key] = false;
    }
    logger.info("⏰ All cron jobs stopped and running flags reset.");
}

module.exports = { startCronJobs, registerUser, reloadCrons, stopCronJobs };
