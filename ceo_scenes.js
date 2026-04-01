const logger = require('./logger');
const { t, getLang } = require('./i18n');
const { generateDailyReport, generateWeeklyReport, generateMonthlyReport, generateUmumiyReport, generateOnDemandPdf, generateWeeklyPdf, generateMonthlyPdf, generateUmumiyPdf } = require('./ceo_reports');
const { Scenes: { WizardScene }, Markup } = require('telegraf');
const fs = require('fs');
const { getTashkentDateString, getWeekRange, parseUserDate, getTashkentNow, getMonthRange, parseUserMonth, formatDbDateStr } = require('./utils');
const storage = require('./storage');


/**
 * Detects if the user wants to jump to another report or escape to the main menu.
 * @param {Context} ctx 
 * @param {Function} [next] Optional Telegraf next() function to pass control out
 * @returns {Promise<boolean>} true if handled/switched, false otherwise
 */
async function handleMenuSwitch(ctx, next) {
    if (ctx.message && ctx.message.text) {
        const lang = getLang(ctx);
        const text = ctx.message.text.trim();

        // 1. Pass-through for /start and /help
        if (text.startsWith('/') && ['/start', '/help', '/myid'].includes(text.split(' ')[0])) {
            await ctx.scene.leave();
            if (next) { await next(); }
            return true;
        }

        // 2. Identify all possible main menu buttons
        const mainButtons = [
            'btn_add_lead', 'btn_debtors', 'btn_rejections', 'btn_finance',
            'btn_attendance', 'btn_problems', 'btn_rooms', 'btn_users',
            'btn_cron', 'btn_reports', 'btn_refresh', 'btn_uz', 'btn_ru'
        ];

        for (const key of mainButtons) {
            const uz = t('uz', key).trim();
            const ru = t('ru', key).trim();
            if (text === uz || text === ru || 
                (key === 'btn_uz' && text.includes(uz)) ||
                (key === 'btn_ru' && text.includes(ru))) {
                
                await ctx.scene.leave();
                if (next) { await next(); }
                return true;
            }
        }

        const CEO_MENU_MAP = {
            [t(lang, 'menu_general_reports')]: 'ceoUmumiyScene',
            [t(lang, 'menu_daily_reports')]: 'ceoDailyScene',
            [t(lang, 'menu_weekly_reports')]: 'ceoWeeklyScene',
            [t(lang, 'menu_monthly_reports')]: 'ceoMonthlyScene',
            [t(lang, 'menu_export')]: 'ceoExportScene'
        };

        const target = CEO_MENU_MAP[text];
        if (target) {
            await ctx.scene.leave();
            await ctx.scene.enter(target);
            return true;
        }
    }
    return false;
}

/**
 * Helper: Send PDF document to user then cleanup
 */
async function sendPdfToUser(ctx, pdfPath, startDate, endDate) {
    let stream = null;
    try {
        const lang = getLang(ctx);
        const displayStart = formatDbDateStr(startDate);
        const displayEnd = endDate !== startDate ? ` — ${formatDbDateStr(endDate)}` : '';
        const safeName = `${t(lang, 'ceo_filename_report')}_${startDate}${endDate !== startDate ? '_to_' + endDate : ''}.pdf`;

        stream = fs.createReadStream(pdfPath);
        await ctx.replyWithDocument({
            source: stream,
            filename: safeName
        }, {
            caption: t(lang, 'ceo_pdf_caption', { start: displayStart, end: displayEnd }),
            parse_mode: 'Markdown'
        });
        stream.destroy();
    } catch (e) {
        logger.error('PDF send error:', e);
        if (stream) { stream.destroy(); }
        const lang = getLang(ctx);
        await ctx.reply(t(lang, 'ceo_pdf_error'));
    } finally {
        try { fs.unlinkSync(pdfPath); } catch (_) { }
    }
}

/**
 * Helper to reply with long messages by splitting them safely
 */
async function safeReply(ctx, text, extra = {}) {
    const CHUNK_SIZE = 4000;
    if (text.length <= CHUNK_SIZE) {
        return await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
    }

    // Try splitting on section dividers first
    const parts = text.split('\n━━━━');
    if (parts.length > 1) {
        let currentMsg = parts[0];
        for (let i = 1; i < parts.length; i++) {
            const nextPart = '\n━━━━' + parts[i];
            if (currentMsg.length + nextPart.length > CHUNK_SIZE) {
                await ctx.reply(currentMsg, { parse_mode: 'Markdown' });
                currentMsg = nextPart;
            } else {
                currentMsg += nextPart;
            }
        }
        return await ctx.reply(currentMsg, { parse_mode: 'Markdown', ...extra });
    }

    // Fallback: split on double newlines to respect paragraph boundaries
    const lines = text.split('\n\n');
    let currentMsg = '';
    for (let i = 0; i < lines.length; i++) {
        const segment = (i === 0 ? '' : '\n\n') + lines[i];
        if (currentMsg.length + segment.length > CHUNK_SIZE && currentMsg.length > 0) {
            await ctx.reply(currentMsg, { parse_mode: 'Markdown' });
            currentMsg = lines[i];
        } else {
            currentMsg += segment;
        }
    }
    if (currentMsg) {
        return await ctx.reply(currentMsg, { parse_mode: 'Markdown', ...extra });
    }
}

function buildCeoScenes() {
    const scenes = [];

    // --- Daily Scene ---
    const dailyScene = new WizardScene('ceoDailyScene',
        async (ctx, next) => {
            if (!ctx.state.user || !ctx.state.user.sections || !ctx.state.user.sections.includes('reports')) {
                await ctx.reply(t(getLang(ctx), 'no_section_access'));
                return ctx.scene.leave();
            }
            const lang = getLang(ctx);
            const kb = [
                [Markup.button.callback(t(lang, 'ceo_btn_today'), 'daily_today')],
                [Markup.button.callback(t(lang, 'ceo_btn_custom_date'), 'daily_custom')]
            ];
            await ctx.reply(t(lang, 'ceo_ask_date'), {
                ...Markup.inlineKeyboard(kb)
            });
            return ctx.wizard.next();
        },
        async (ctx, next) => {
            const lang = getLang(ctx);
            if (await handleMenuSwitch(ctx, next)) return;
            if (ctx.callbackQuery) {
                const cb = ctx.callbackQuery.data;
                await ctx.answerCbQuery();
                if (cb === 'daily_today') {
                    const dateStr = getTashkentDateString(new Date());
                    ctx.wizard.state.targetDate = dateStr;
                    await ctx.editMessageText(t(lang, 'ceo_loading_data'));
                    try {
                        const text = await generateDailyReport(dateStr, lang);
                        await safeReply(ctx, text, Markup.inlineKeyboard([
                            [Markup.button.callback(t(lang, 'ceo_btn_download_pdf'), 'daily_pdf')]
                        ]));
                        return ctx.wizard.next();
                    } catch (e) {
                        logger.error("❌ Error in dailyScene today:", e);
                        await ctx.reply(t(lang, 'ceo_error_invalid_date', { date: dateStr }));
                        return ctx.scene.leave();
                    }
                } else if (cb === 'daily_custom') {
                    await ctx.editMessageText(t(lang, 'ceo_prompt_custom_date'), { parse_mode: 'Markdown' });
                    return;
                }
            } else if (ctx.message && ctx.message.text) {
                const text = ctx.message.text.trim();
                const dateStr = parseUserDate(text);

                if (dateStr) {
                    ctx.wizard.state.targetDate = dateStr;
                    await ctx.reply(t(lang, 'ceo_loading_data'));
                    try {
                        const report = await generateDailyReport(dateStr, lang);
                        await safeReply(ctx, report, Markup.inlineKeyboard([
                            [Markup.button.callback(t(lang, 'ceo_btn_download_pdf'), 'daily_pdf')]
                        ]));
                        return ctx.wizard.next();
                    } catch (e) {
                        logger.error("❌ Error in dailyScene custom date:", e);
                        await ctx.reply(t(lang, 'ceo_error_invalid_date', { date: dateStr }));
                    }
                } else {
                    await ctx.reply(t(lang, 'ceo_error_invalid_format'), { parse_mode: 'Markdown' });
                }
            }
        },
        async (ctx, next) => {
            if (await handleMenuSwitch(ctx, next)) return;
        }
    );

    // PDF download action for daily
    dailyScene.action('daily_pdf', async (ctx, next) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery(t(lang, 'ceo_generating_pdf'));
        const dateStr = ctx.wizard.state.targetDate;
        if (!dateStr) {
            await ctx.reply(t(lang, 'ceo_error_no_date_pdf'));
            return ctx.scene.leave();
        }
        const pdfPath = await generateOnDemandPdf(dateStr, dateStr, formatDbDateStr(dateStr), lang);
        await sendPdfToUser(ctx, pdfPath, dateStr, dateStr);
        return ctx.scene.leave();
    });

    // --- Umumiy Scene ---
    const umumiyScene = new WizardScene('ceoUmumiyScene',
        async (ctx, next) => {
            if (!ctx.state.user || !ctx.state.user.sections || !ctx.state.user.sections.includes('reports')) {
                await ctx.reply(t(getLang(ctx), 'no_section_access'));
                return ctx.scene.leave();
            }
            const lang = getLang(ctx);
            await ctx.reply(t(lang, 'ceo_loading_data'));
            try {
                const report = await generateUmumiyReport(lang);

                await safeReply(ctx, report, Markup.inlineKeyboard([
                    [Markup.button.callback(t(lang, 'ceo_btn_download_pdf'), 'umumiy_pdf')]
                ]));

                return ctx.wizard.next();
            } catch (e) {
                logger.error("❌ Error in umumiyScene:", e);
                await ctx.reply(t(lang, 'ceo_umumiy_error'));
                return ctx.scene.leave();
            }
        },
        async (ctx, next) => {
            if (await handleMenuSwitch(ctx, next)) return;
        }
    );

    // PDF download action for umumiy
    umumiyScene.action('umumiy_pdf', async (ctx, next) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery(t(lang, 'ceo_generating_pdf'));
        try {
            const pdfPath = await generateUmumiyPdf(lang);

            const now = getTashkentNow();
            const dateStr = now.toLocaleDateString(lang === 'uz' ? 'uz-UZ' : 'ru-RU', { timeZone: 'Asia/Tashkent' });

            const umumiyStream = fs.createReadStream(pdfPath);
            try {
                await ctx.replyWithDocument({
                    source: umumiyStream,
                    filename: `${t(lang, 'ceo_filename_general')}_${Date.now()}.pdf`
                }, {
                    caption: t(lang, 'ceo_umumiy_pdf_caption', { date: dateStr }),
                    parse_mode: 'Markdown'
                });
            } finally {
                umumiyStream.destroy();
            }

            try { fs.unlinkSync(pdfPath); } catch (_) { }
        } catch (e) {
            logger.error(e);
            await ctx.reply(t(lang, 'ceo_pdf_error'));
        }
        return ctx.scene.leave();
    });

    // --- Weekly Scene ---
    const weeklyScene = new WizardScene('ceoWeeklyScene',
        async (ctx, next) => {
            if (!ctx.state.user || !ctx.state.user.sections || !ctx.state.user.sections.includes('reports')) {
                await ctx.reply(t(getLang(ctx), 'no_section_access'));
                return ctx.scene.leave();
            }
            const lang = getLang(ctx);
            const kb = [
                [Markup.button.callback(t(lang, 'ceo_btn_this_week'), 'weekly_this')],
                [Markup.button.callback(t(lang, 'ceo_btn_custom_date'), 'weekly_custom')]
            ];
            await ctx.reply(t(lang, 'ceo_weekly_ask'), {
                ...Markup.inlineKeyboard(kb)
            });
            return ctx.wizard.next();
        },
        async (ctx, next) => {
            const lang = getLang(ctx);
            if (await handleMenuSwitch(ctx, next)) return;
            if (ctx.callbackQuery) {
                const cb = ctx.callbackQuery.data;
                await ctx.answerCbQuery();

                if (cb === 'weekly_this') {
                    const today = getTashkentDateString(new Date());
                    const range = getWeekRange(today);
                    ctx.wizard.state.startDate = range.start;
                    ctx.wizard.state.endDate = range.end;
                    await ctx.editMessageText(t(lang, 'ceo_weekly_loading'));
                    try {
                        const text = await generateWeeklyReport(range.start, range.end, lang);
                        await safeReply(ctx, text, Markup.inlineKeyboard([
                            [Markup.button.callback(t(lang, 'ceo_btn_download_pdf'), 'weekly_pdf')]
                        ]));
                        return ctx.wizard.next();
                    } catch (e) {
                        logger.error('❌ Weekly report error:', e);
                        await ctx.reply(t(lang, 'ceo_umumiy_error'));
                        return ctx.scene.leave();
                    }
                } else if (cb === 'weekly_custom') {
                    await ctx.editMessageText(t(lang, 'ceo_weekly_prompt_custom'), { parse_mode: 'Markdown' });
                    return;
                }
            } else if (ctx.message && ctx.message.text) {
                const dateStr = parseUserDate(ctx.message.text.trim());
                if (dateStr) {
                    const range = getWeekRange(dateStr);
                    ctx.wizard.state.startDate = range.start;
                    ctx.wizard.state.endDate = range.end;
                    await ctx.reply(t(lang, 'ceo_weekly_loading'));
                    try {
                        const report = await generateWeeklyReport(range.start, range.end, lang);
                        await safeReply(ctx, report, Markup.inlineKeyboard([
                            [Markup.button.callback(t(lang, 'ceo_btn_download_pdf'), 'weekly_pdf')]
                        ]));
                        return ctx.wizard.next();
                    } catch (e) {
                        logger.error('❌ Weekly report error:', e);
                        await ctx.reply(t(lang, 'ceo_umumiy_error'));
                    }
                } else {
                    await ctx.reply(t(lang, 'ceo_error_invalid_format'), { parse_mode: 'Markdown' });
                }
            }
        },
        async (ctx, next) => {
            if (await handleMenuSwitch(ctx, next)) return;
        }
    );

    weeklyScene.action('weekly_pdf', async (ctx, next) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery(t(lang, 'ceo_generating_pdf'));
        const { startDate, endDate } = ctx.wizard.state;
        if (!startDate || !endDate) {
            await ctx.reply(t(lang, 'ceo_error_no_date_pdf'));
            return ctx.scene.leave();
        }
        try {
            const pdfPath = await generateWeeklyPdf(startDate, endDate, lang);
            await sendPdfToUser(ctx, pdfPath, startDate, endDate);
        } catch (e) {
            logger.error('Weekly PDF error:', e);
            await ctx.reply(t(lang, 'ceo_pdf_error'));
        }
        return ctx.scene.leave();
    });

    // --- Monthly Scene ---
    const monthlyScene = new WizardScene('ceoMonthlyScene',
        async (ctx, next) => {
            if (!ctx.state.user || !ctx.state.user.sections || !ctx.state.user.sections.includes('reports')) {
                await ctx.reply(t(getLang(ctx), 'no_section_access'));
                return ctx.scene.leave();
            }
            const lang = getLang(ctx);
            const kb = [
                [Markup.button.callback(t(lang, 'ceo_btn_this_month'), 'monthly_this')],
                [Markup.button.callback(t(lang, 'ceo_btn_custom_month'), 'monthly_custom')]
            ];
            await ctx.reply(t(lang, 'ceo_monthly_ask'), {
                ...Markup.inlineKeyboard(kb)
            });
            return ctx.wizard.next();
        },
        async (ctx, next) => {
            const lang = getLang(ctx);
            if (await handleMenuSwitch(ctx, next)) return;
            if (ctx.callbackQuery) {
                const cb = ctx.callbackQuery.data;
                await ctx.answerCbQuery();

                if (cb === 'monthly_this') {
                    const now = getTashkentNow();
                    const tashkentParts = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }).split('-');
                    const year = parseInt(tashkentParts[0], 10);
                    const month = parseInt(tashkentParts[1], 10);
                    const range = getMonthRange(month, year);
                    ctx.wizard.state.startDate = range.start;
                    ctx.wizard.state.endDate = range.end;
                    await ctx.editMessageText(t(lang, 'ceo_monthly_loading'));
                    try {
                        const text = await generateMonthlyReport(range.start, range.end, lang);
                        await safeReply(ctx, text, Markup.inlineKeyboard([
                            [Markup.button.callback(t(lang, 'ceo_btn_download_pdf'), 'monthly_pdf')]
                        ]));
                        return ctx.wizard.next();
                    } catch (e) {
                        logger.error('❌ Monthly report error:', e);
                        await ctx.reply(t(lang, 'ceo_umumiy_error'));
                        return ctx.scene.leave();
                    }
                } else if (cb === 'monthly_custom') {
                    await ctx.editMessageText(t(lang, 'ceo_monthly_prompt_custom'), { parse_mode: 'Markdown' });
                    return;
                }
            } else if (ctx.message && ctx.message.text) {
                const parsed = parseUserMonth(ctx.message.text.trim());
                if (parsed) {
                    ctx.wizard.state.startDate = parsed.startStr;
                    ctx.wizard.state.endDate = parsed.endStr;
                    await ctx.reply(t(lang, 'ceo_monthly_loading'));
                    try {
                        const report = await generateMonthlyReport(parsed.startStr, parsed.endStr, lang);
                        await safeReply(ctx, report, Markup.inlineKeyboard([
                            [Markup.button.callback(t(lang, 'ceo_btn_download_pdf'), 'monthly_pdf')]
                        ]));
                        return ctx.wizard.next();
                    } catch (e) {
                        logger.error('❌ Monthly report error:', e);
                        await ctx.reply(t(lang, 'ceo_umumiy_error'));
                    }
                } else {
                    await ctx.reply(t(lang, 'ceo_error_invalid_format'), { parse_mode: 'Markdown' });
                }
            }
        },
        async (ctx, next) => {
            if (await handleMenuSwitch(ctx, next)) return;
        }
    );

    monthlyScene.action('monthly_pdf', async (ctx, next) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery(t(lang, 'ceo_generating_pdf'));
        const { startDate, endDate } = ctx.wizard.state;
        if (!startDate || !endDate) {
            await ctx.reply(t(lang, 'ceo_error_no_date_pdf'));
            return ctx.scene.leave();
        }
        try {
            const pdfPath = await generateMonthlyPdf(startDate, endDate, lang);
            await sendPdfToUser(ctx, pdfPath, startDate, endDate);
        } catch (e) {
            logger.error('Monthly PDF error:', e);
            await ctx.reply(t(lang, 'ceo_pdf_error'));
        }
        return ctx.scene.leave();
    });

    // --- Export Scene ---
    const exportScene = new WizardScene('ceoExportScene',
        async (ctx, next) => {
            if (!ctx.state.user || !ctx.state.user.sections || !ctx.state.user.sections.includes('reports')) {
                await ctx.reply(t(getLang(ctx), 'no_section_access'));
                return ctx.scene.leave();
            }
            const lang = getLang(ctx);
            await ctx.reply(t(lang, 'ceo_export_prompt'), { parse_mode: 'Markdown' });
            return ctx.wizard.next();
        },
        async (ctx, next) => {
            const lang = getLang(ctx);
            if (await handleMenuSwitch(ctx, next)) return;
            if (!ctx.message || !ctx.message.text) return;

            const parsed = parseUserMonth(ctx.message.text.trim());
            if (!parsed) {
                await ctx.reply(t(lang, 'ceo_error_invalid_format'), { parse_mode: 'Markdown' });
                return;
            }

            const parts = parsed.startStr.split('-').map(Number);
            const startY = parts[0];
            const startM = parts[1];

            if (!startY || !startM || startM < 1 || startM > 12 || startY < 2000 || startY > 2100) {
                await ctx.reply(t(lang, 'ceo_error_invalid_format'), { parse_mode: 'Markdown' });
                return;
            }

            await ctx.reply(t(lang, 'ceo_export_loading'));

            try {
                const { generateCsvExport } = require('./export');
                const csvPath = await generateCsvExport(startM, startY);
                const csvStream = fs.createReadStream(csvPath);
                try {
                    await ctx.replyWithDocument({
                        source: csvStream,
                        filename: `${t(lang, 'ceo_filename_export')}_${startM}_${startY}.csv`
                    }, {
                        caption: t(lang, 'ceo_export_caption', { month: startM, year: startY }),
                        parse_mode: 'Markdown'
                    });
                } finally {
                    csvStream.destroy();
                }

                try { fs.unlinkSync(csvPath); } catch (_) { }
                await ctx.reply(t(lang, 'ceo_export_success'));
            } catch (e) {
                logger.error('CSV export error:', e);
                await ctx.reply(t(lang, 'ceo_export_error'));
            }
            return ctx.scene.leave();
        }
    );

    // --- Tax Report Scene ---
    const taxScene = new WizardScene('ceoTaxScene',
        // Step 0: Choose month
        async (ctx, next) => {
            if (!ctx.state.user || !ctx.state.user.sections || !ctx.state.user.sections.includes('reports')) {
                await ctx.reply(t(getLang(ctx), 'no_section_access'));
                return ctx.scene.leave();
            }
            const lang = getLang(ctx);
            await ctx.reply(t(lang, 'ceo_tax_title'), { parse_mode: 'Markdown' });
            return ctx.wizard.next();
        },
        // Step 1: Parse month, choose report type
        async (ctx, next) => {
            const lang = getLang(ctx);
            if (await handleMenuSwitch(ctx, next)) return;
            if (!ctx.message || !ctx.message.text) return;

            const parsed = parseUserMonth(ctx.message.text.trim());
            if (!parsed) {
                await ctx.reply(t(lang, 'ceo_error_invalid_format'), { parse_mode: 'Markdown' });
                return;
            }

            ctx.wizard.state.monthData = parsed;

            await ctx.reply(
                t(lang, 'ceo_tax_type_prompt', { month: parsed.startStr }),
                Markup.inlineKeyboard([
                    [Markup.button.callback(t(lang, 'ceo_tax_btn_foyda'), 'tax_foyda')],
                    [Markup.button.callback(t(lang, 'ceo_tax_btn_daromad'), 'tax_daromad')],
                    [Markup.button.callback(t(lang, 'ceo_tax_btn_both'), 'tax_both')],
                    [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'tax_cancel')]
                ])
            );
            return ctx.wizard.next();
        },
        // Step 2: Generate chosen report
        async (ctx, next) => {
            const lang = getLang(ctx);
            if (!ctx.callbackQuery) return;
            const cb = ctx.callbackQuery.data;
            await ctx.answerCbQuery();

            if (cb === 'tax_cancel') {
                await ctx.editMessageText(t(lang, 'scene_cancelled'));
                return ctx.scene.leave();
            }

            const { startStr } = ctx.wizard.state.monthData;
            const [year, month] = startStr.split('-').map(Number);

            await ctx.editMessageText(t(lang, 'ceo_tax_loading'));

            try {
                const { generateFoydaSoligi, generateDaromadSoligi } = require('./tax_reports');
                if (cb === 'tax_foyda' || cb === 'tax_both') {
                    const report = await generateFoydaSoligi(month, year, lang);
                    await ctx.reply(report, { parse_mode: 'Markdown' });
                }

                if (cb === 'tax_daromad' || cb === 'tax_both') {
                    const report = await generateDaromadSoligi(month, year, lang);
                    await ctx.reply(report, { parse_mode: 'Markdown' });
                }

                await ctx.reply(t(lang, 'ceo_tax_success'));
            } catch (e) {
                logger.error('Tax report error:', e);
                await ctx.reply(t(lang, 'ceo_tax_error'));
            }
            return ctx.scene.leave();
        }
    );

    scenes.push(umumiyScene, dailyScene, weeklyScene, monthlyScene, exportScene, taxScene);
    return scenes;
}

module.exports = { buildCeoScenes };
