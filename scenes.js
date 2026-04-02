const logger = require('./logger');
const { t, getLang } = require('./i18n');
const storage = require('./storage');
const notify = require('./notify');
const { getTodayDisplay, getLast6Months, formatNumber, escapeMarkdown } = require('./utils');
const { Scenes: { WizardScene }, Markup } = require('telegraf');
const { getSubjects, getAllSubjects, getExpenseTypes, saveDailyReport, getEmptyRooms, deleteEmptyRoom, addSubject, deleteSubject, deleteLeadsBySubject, deleteRejectionsBySubject, getLeadStatus, getRejectionByMonth, addExpenseType, deleteExpenseType } = require('./storage');


function resolveOptions(q) {
    if (q.dynamicOptions === 'last_6_months') return getLast6Months();
    if (q.dynamicOptions === 'expense_types') return ['Boshqa'];
    return q.options || [];
}



/**
 * Shared confirm+save logic for non-loop scenes.
 * Extracted so norasmiy warning flow can reuse it after user confirms.
 */
async function doConfirmSave(ctx, key, section, lang, userId, answers) {
    try {
        // Capture pre-save qarzdorlar balance for norasmiy deduction feedback
        let preBal = null;
        if (key === 'moliya_kirim_norasmiy' && answers.month) {
            preBal = await storage.getQarzdorlarBalance(answers.month);
        }

        const saveOk = await storage.saveDailyReport(key, answers, userId);
        if (!saveOk) {
            await ctx.editMessageText('❌ Ma\'lumotlarni saqlashda xatolik yuz berdi.');
            return ctx.scene.leave();
        }

        const userName = ctx.from ? (ctx.from.first_name || String(userId)) : String(userId);

        if (key === 'moliya_chiqim' || key === 'moliya_chiqim_rasmiy' || key === 'moliya_chiqim_norasmiy') {
            const amount = parseInt((answers.today_expense || '0').replace(/[^0-9]/g, '')) || 0;
            const cat = answers.financeCategory || answers.expense_category || answers.category || '';
            notify.notifyReportsUsers(
                `💸 *Yangi xarajat kiritildi*\n\n👤 ${escapeMarkdown(userName)}\n📅 ${escapeMarkdown(answers.month || '')}\n💰 ${amount.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU')} so'm\n📂 ${escapeMarkdown(cat)} — ${escapeMarkdown(answers.expense_type || '')}\n💬 ${escapeMarkdown(answers.comment || 'Izohsiz')}`
            ).catch(e => logger.warn('Notification failed:', e.message));
        } else if (key === 'moliya_kirim' || key === 'moliya_kirim_rasmiy' || key === 'moliya_kirim_norasmiy') {
            const amount = parseInt((answers.today_income || '0').replace(/[^0-9]/g, '')) || 0;
            const cat = answers.financeCategory || answers.expense_category || answers.category || '';
            notify.notifyReportsUsers(
                `💵 *Yangi tushum kiritildi*\n\n👤 ${escapeMarkdown(userName)}\n📅 ${escapeMarkdown(answers.month || '')}\n💰 ${amount.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU')} so'm${cat ? '\n📂 ' + escapeMarkdown(cat) : ''}`
            ).catch(e => logger.warn('Notification failed:', e.message));
        } else if (key === 'davomat') {
            const expected = parseInt(answers.expected) || 0;
            const attended = parseInt(answers.attended) || 0;
            const pct = expected > 0 ? Math.round((attended / expected) * 100) : 0;
            if (pct < 70) {
                notify.notifyReportsUsers(
                    `📋 *Past davomat\!*\n\n👤 ${escapeMarkdown(userName)}\n👥 Kelishi kerak: ${expected}\n✅ Keldi: ${attended}\n📉 Davomat: *${pct}%*`
                ).catch(e => logger.warn('Notification failed:', e.message));
            }
        }

        const translatedTitle = t(lang, section.titleKey || section.title);
        await ctx.editMessageText(t(lang, 'scene_save_success', { title: translatedTitle, date: getTodayDisplay() }), { parse_mode: 'Markdown' });

                // Ask about qarzdorlar deduction ONLY for norasmiy kirim
        if (key === 'moliya_kirim_norasmiy') {
            await ctx.reply("Qarzdorlardan ayirishni xohlaysizmi?", {
                ...Markup.inlineKeyboard([
                    [Markup.button.callback("✅ Ha, qarzdorlardan ayirish", 'opt_deduct_yes')],
                    [Markup.button.callback("❌ Yo'q, faqat kirimni qabul qilish", 'opt_deduct_no')]
                ])
            });
            return; // Keep scene active
        }

    } catch (saveErr) {
        logger.error('saveDailyReport error:', saveErr);
        await ctx.editMessageText(t(lang, 'scene_save_error'));
    }
    return ctx.scene.leave();
}

function buildScenes(SECTIONS) {
    const generatedScenes = [];

    for (const [key, section] of Object.entries(SECTIONS)) {
        const steps = [];

        // --- Step 0: Ask Question 1 ---
        steps.push(async (ctx, next) => {
            const sectionCheck = key.startsWith('moliya') ? 'moliya' :
                                 key.startsWith('rad_') ? 'rad_etilganlar' : key;
            if (ctx.state && ctx.state.user && ctx.state.user.sections &&
                !ctx.state.user.sections.includes(sectionCheck)) {
                const lang = getLang(ctx);
                await ctx.reply(t(lang, 'no_access') || "Sizda bu bo'limga ruxsat yo'q.");
                return ctx.scene.leave();
            }

            const lang = getLang(ctx);
            if (section.loop) {
                ctx.wizard.state.entries = [];
                ctx.wizard.state.currentEntry = {};
            } else {
                ctx.wizard.state.answers = {};
            }

            const q = section.questions[0];
            let opts = resolveOptions(q);

            if (q.dynamicOptions === 'subjects') {
                try {
                    opts = await storage.getAllSubjects();
                } catch (e) {
                    logger.error(`Error fetching subjects for ${key}:`, e.message);
                }
            } else if (q.dynamicOptions === 'expense_types') {
                try {
                    opts = await storage.getExpenseTypes(ctx.wizard.state?.category || ctx.scene.state?.financeCategory);
                    if (opts.length === 0) opts = ['Boshqa'];
                } catch (e) {
                    logger.error("Error fetching expense types:", e);
                    opts = ['Boshqa'];
                }
            }

            let kb = [];
            if (opts && Array.isArray(opts)) {
                for (let oi = 0; oi < opts.length; oi++) {
                    const o = opts[oi];
                    if (o) {
                        kb.push([Markup.button.callback(o.toString(), `opt_0_${oi}`)]);
                    }
                }
            }

            kb.push([Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]);

            const translatedTitle = t(lang, section.titleKey || section.title); 
            const itemLabel = section.itemLabelKey ? t(lang, section.itemLabelKey) : section.itemLabel;

            const prefix = section.loop
                ? `📝 **${translatedTitle}**\n\n📚 **1-${itemLabel}:**\n❓ `
                : `📝 **${translatedTitle}**\n\n❓ 1/${section.questions.length}: `;

            const questionText = q.questionKey ? t(lang, q.questionKey) : q.question;

            await ctx.reply(prefix + questionText, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(kb)
            });
            return ctx.wizard.next();
        });

        // --- Steps 1 to N: Process Answer & Ask Next ---
        for (let i = 0; i < section.questions.length; i++) {
            const currentQ = section.questions[i];
            const isLast = i === section.questions.length - 1;

            steps.push(async (ctx, next) => {
                const lang = getLang(ctx);
                let answerStr;
                let fromCallback = false;

                let opts = resolveOptions(currentQ);

                // Special handling for dynamic options - fetch dynamically
                if (currentQ.dynamicOptions === 'subjects') {
                    opts = await storage.getAllSubjects();
                } else if (currentQ.dynamicOptions === 'expense_types') {
                    opts = await storage.getExpenseTypes(ctx.wizard.state?.category || ctx.scene.state?.financeCategory);
                    if (opts.length === 0) opts = ['Boshqa'];
                }

                if (opts && ctx.callbackQuery) {
                    const cbData = ctx.callbackQuery.data;
                    logger.debug(`Processing callback: ${cbData} for step ${i}`);

                    if (cbData.startsWith(`opt_${i}_`)) {
                        const idx = parseInt(cbData.replace(`opt_${i}_`, ''), 10);
                        // Look up option by index
                        answerStr = (opts && idx >= 0 && idx < opts.length) ? opts[idx] : String(idx);
                        fromCallback = true;
                        await ctx.answerCbQuery();
                    } else if (cbData === 'back' || cbData === 'cancel' || cbData === 'undo_last') {
                        return; // Global action handlers will process these
                    }
                } else if (ctx.message && ctx.message.text) {
                    const text = ctx.message.text.trim();

                    // 1. Detect Escape Commands / Menu Buttons
                    if (text.startsWith('/') && ['/start', '/help', '/myid'].includes(text.split(' ')[0])) {
                        await ctx.scene.leave();
                        return next();
                    }

                    const mainButtons = [
                        'btn_add_lead', 'btn_debtors', 'btn_rejections', 'btn_finance',
                        'btn_attendance', 'btn_problems', 'btn_rooms', 'btn_users',
                        'btn_cron', 'btn_reports', 'btn_refresh', 'btn_uz', 'btn_ru'
                    ];

                    for (const bKey of mainButtons) {
                        if (text === t('uz', bKey).trim() || text === t('ru', bKey).trim() ||
                            (bKey === 'btn_uz' && text.includes(t('uz', 'btn_uz'))) ||
                            (bKey === 'btn_ru' && text.includes(t('ru', 'btn_ru')))) {
                            await ctx.scene.leave();
                            return next();
                        }
                    }

                    // 2. Validate numeric input for specific fields
                    const numericKeys = ['count', 'amount', 'today_income', 'today_expense', 'today_kassa_amount', 'today_kassa_students', 'capacity', 'price_per_student', 'expected', 'attended'];
                    if (numericKeys.includes(currentQ.key)) {
                        const cleanNum = text.replace(/[.,\s]/g, '');
                        if (isNaN(cleanNum) || cleanNum === '') {
                            await ctx.reply(t(lang, 'scene_error_numeric'));
                            return;
                        }

                        const numVal = parseInt(cleanNum, 10);
                        if (numVal < 0) {
                            await ctx.reply(t(lang, 'scene_error_negative'));
                            return;
                        }

                        if (currentQ.key === 'count' || currentQ.key === 'today_kassa_students') {
                            if (numVal > 100000) {
                                await ctx.reply(t(lang, 'scene_error_too_large', { max: '100,000' }));
                                return;
                            }
                        } else {
                            if (numVal > 100000000000) { 
                                await ctx.reply(t(lang, 'scene_error_too_large_amount', { max: '100 mlrd' }));
                                return;
                            }
                        }

                        answerStr = text; 
                    } else if (currentQ.key === 'time') {
                        const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9](\s*-\s*([0-1]?[0-9]|2[0-3]):[0-5][0-9])?$/;
                        if (!timeRegex.test(text.trim())) {
                            await ctx.reply(t(lang, 'scene_error_time_format'), { parse_mode: 'Markdown' });
                            return;
                        }
                        answerStr = text.trim();

                    } else {
                        // Enforce text length limits
                        const maxLen = ['issue', 'comment'].includes(currentQ.key) ? 500 : 100;
                        if (text.length > maxLen) {
                            await ctx.reply(t(lang, 'scene_error_too_long') || `⚠️ Matn juda uzun! Maksimum ${maxLen} belgi.`);
                            return;
                        }
                        answerStr = text;
                        if (opts && opts.length > 0 && !opts.includes(answerStr)) {
                            await ctx.reply(t(lang, 'scene_error_select_option', { options: opts.join(', ') }));
                            return;
                        }
                    }
                } else if (ctx.callbackQuery) {
                    return;
                }

                if (!answerStr) return; // Ignore invalid input

                // Store the answer
                if (section.loop) {
                    ctx.wizard.state.currentEntry[currentQ.key] = answerStr;
                } else {
                    ctx.wizard.state.answers[currentQ.key] = answerStr;
                }

                // Remove inline keyboard from the previous message if user clicked a button
                if (fromCallback && ctx.callbackQuery.message) {
                    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(e => logger.warn('editMessageReplyMarkup failed:', e.message));
                }

                if (isLast) {
                    if (section.loop) {
                        ctx.wizard.state.entries.push({ ...ctx.wizard.state.currentEntry });
                        const count = ctx.wizard.state.entries.length;
                        const itemLabel = section.itemLabelKey ? t(lang, section.itemLabelKey) : section.itemLabel;
                        await ctx.reply(t(lang, 'scene_loop_saved', { count, item: itemLabel }), {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback(t(lang, 'scene_add_more_btn'), 'add_more')],
                                [Markup.button.callback(t(lang, 'scene_finish_loop_btn'), 'finish_loop')]
                            ])
                        });
                    } else {
                        const summary = section.questions
                            .map(q => {
                                const qText = q.questionKey ? t(lang, q.questionKey) : q.question;
                                return `• **${qText}**\n  → _${ctx.wizard.state.answers[q.key]}_`;
                            })
                            .join('\n');
                        await ctx.reply(t(lang, 'scene_confirm_prompt', { summary }), {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback(t(lang, 'scene_confirm_btn'), 'confirm')],
                                [Markup.button.callback(t(lang, 'scene_back_btn'), 'back'), Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
                            ])
                        });
                    }
                    return ctx.wizard.next();
                } else {
                    const nextQ = section.questions[i + 1];
                    let nextOpts = resolveOptions(nextQ);
                    if (nextQ.dynamicOptions === 'subjects') {
                        nextOpts = await storage.getAllSubjects();
                    } else if (nextQ.dynamicOptions === 'expense_types') {
                        nextOpts = await storage.getExpenseTypes(ctx.wizard.state?.category || ctx.scene.state?.financeCategory);
                        if (nextOpts.length === 0) nextOpts = ['Boshqa'];
                    }
                    let kb = nextOpts ? nextOpts.map((o, oi) => [Markup.button.callback(o, `opt_${i + 1}_${oi}`)]) : [];
                    kb.push([Markup.button.callback(t(lang, 'scene_back_btn'), 'back'), Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]);

                    const prefix = section.loop ? `❓ ` : `❓ ${i + 2}/${section.questions.length}: `;
                    const nextQText = nextQ.questionKey ? t(lang, nextQ.questionKey) : nextQ.question;
                    await ctx.reply(prefix + nextQText, {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard(kb)
                    });
                    return ctx.wizard.next();
                }
            });
        }

        // --- Final Step: Trap until confirmation buttons are pressed ---
        steps.push(async (ctx) => {
            const lang = getLang(ctx);
            if (ctx.message) {
                const btnMsg = section.loop ? `${t(lang, 'scene_add_more_btn')} yoki ${t(lang, 'scene_finish_loop_btn')}` : `${t(lang, 'scene_confirm_btn')} yoki ${t(lang, 'scene_back_btn')}`;
                await ctx.reply(t(lang, 'scene_trap_msg', { buttons: btnMsg }));
            }
        });

        const scene = new WizardScene(key, ...steps);

        // --- Global Scene Actions ---
        scene.action('cancel', async (ctx) => {
            const lang = getLang(ctx);
            await ctx.answerCbQuery();
            await ctx.editMessageText(t(lang, 'scene_cancelled'));
            return ctx.scene.leave();
        });

        scene.action('back', async (ctx) => {
            const lang = getLang(ctx);
            await ctx.answerCbQuery();
            if (ctx.wizard.cursor > 1) {
                ctx.wizard.back();
                const newCursor = ctx.wizard.cursor;
                const qIndex = newCursor - 1;
                const prevQ = section.questions[qIndex];

                if (section.loop) {
                    delete ctx.wizard.state.currentEntry[prevQ.key];
                } else {
                    delete ctx.wizard.state.answers[prevQ.key];
                }

                const prevOptsRaw = resolveOptions(prevQ);
                let prevOpts = prevOptsRaw;
                if (prevQ.dynamicOptions === 'subjects') {
                    prevOpts = await storage.getAllSubjects();
                } else if (prevQ.dynamicOptions === 'expense_types') {
                    prevOpts = await storage.getExpenseTypes(ctx.wizard.state?.category || ctx.scene.state?.financeCategory);
                }

                let kb = prevOpts ? prevOpts.map((o, oi) => [Markup.button.callback(o, `opt_${qIndex}_${oi}`)]) : [];
                let navKb;

                const itemLabel = section.itemLabelKey ? t(lang, section.itemLabelKey) : section.itemLabel;

                if (newCursor === 1) {
                    if (section.loop) {
                        const count = ctx.wizard.state.entries.length + 1;
                        navKb = count > 1
                            ? [Markup.button.callback(t(lang, 'scene_undo_last_btn', { item: itemLabel }), 'undo_last'), Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
                            : [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')];
                    } else {
                        navKb = [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')];
                    }
                } else {
                    navKb = [Markup.button.callback(t(lang, 'scene_back_btn'), 'back'), Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')];
                }
                kb.push(navKb);

                const qText = prevQ.questionKey ? t(lang, prevQ.questionKey) : prevQ.question;
                const prefixText = section.loop
                    ? `${t(lang, 'scene_back_msg')}\n\n📚 **${ctx.wizard.state.entries.length + 1}-${itemLabel}:**\n❓ `
                    : `${t(lang, 'scene_back_msg')}\n\n❓ ${qIndex + 1}/${section.questions.length}: `;

                await ctx.editMessageText(prefixText + qText, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard(kb)
                });
            }
        });

        // --- Loop-specific Actions ---
        if (section.loop) {
            scene.action('add_more', async (ctx) => {
                const lang = getLang(ctx);
                if (ctx.wizard.cursor < 1) {
                    await ctx.answerCbQuery('Iltimos, qayta urinib ko\'ring').catch(() => {});
                    return;
                }
                await ctx.answerCbQuery();
                const MAX_LOOP_ENTRIES = 50;
                if (ctx.wizard.state.entries.length >= MAX_LOOP_ENTRIES) {
                    await ctx.editMessageText(`⚠️ Maksimal ${MAX_LOOP_ENTRIES} ta yozuv kiritish mumkin. Saqlash uchun "Saqlash" tugmasini bosing.`, {
                        ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'scene_finish_loop_btn'), 'finish_loop')]])
                    });
                    return;
                }
                ctx.wizard.state.currentEntry = {};
                ctx.wizard.selectStep(1);
                const count = ctx.wizard.state.entries.length + 1;

                const q = section.questions[0];
                let opts2Raw = resolveOptions(q);
                let opts2 = opts2Raw;
                if (q.dynamicOptions === 'subjects') {
                    opts2 = await storage.getAllSubjects();
                } else if (q.dynamicOptions === 'expense_types') {
                    opts2 = await storage.getExpenseTypes(ctx.wizard.state?.category || ctx.scene.state?.financeCategory);
                    if (opts2.length === 0) opts2 = ['Boshqa'];
                }
                let kb = opts2 ? opts2.map((o, oi) => [Markup.button.callback(o, `opt_0_${oi}`)]) : [];
                
                const itemLabel = section.itemLabelKey ? t(lang, section.itemLabelKey) : section.itemLabel;
                const navKb = count > 1
                    ? [Markup.button.callback(t(lang, 'scene_undo_last_btn', { item: itemLabel }), 'undo_last'), Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
                    : [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')];
                kb.push(navKb);

                const qText = q.questionKey ? t(lang, q.questionKey) : q.question;
                await ctx.editMessageText(`📚 **${count}-${itemLabel}:**\n❓ ${qText}`, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard(kb)
                });
            });

            scene.action('undo_last', async (ctx) => {
                const lang = getLang(ctx);
                await ctx.answerCbQuery();
                if (ctx.wizard.state.entries.length > 0) {
                    ctx.wizard.state.entries.pop();
                    const count = ctx.wizard.state.entries.length;
                    const itemLabel = section.itemLabelKey ? t(lang, section.itemLabelKey) : section.itemLabel;

                    const buttons = [
                        [Markup.button.callback(t(lang, 'scene_add_more_btn'), 'add_more')]
                    ];
                    if (count > 0) {
                        buttons.push([Markup.button.callback(t(lang, 'scene_finish_loop_btn'), 'finish_loop')]);
                    }
                    await ctx.editMessageText(t(lang, 'scene_undo_last_msg', { item: itemLabel, count }), {
                        ...Markup.inlineKeyboard(buttons)
                    });
                    ctx.wizard.selectStep(section.questions.length + 1);
                }
            });

            scene.action('finish_loop', async (ctx) => {
                const lang = getLang(ctx);
                await ctx.answerCbQuery();
                if (ctx.wizard.state.entries.length === 0) {
                    await ctx.editMessageText(t(lang, 'scene_no_data'));
                    return ctx.scene.leave();
                }
                const userId = ctx.from ? ctx.from.id : null;
                if (!userId) {
                    logger.error('saveDailyReport: no user ID available, aborting save');
                    await ctx.editMessageText(t(lang, 'scene_save_error'));
                    return ctx.scene.leave();
                }
                try {
                    await storage.saveDailyReport(key, { entries: ctx.wizard.state.entries }, userId);
                } catch (saveErr) {
                    logger.error('saveDailyReport error:', saveErr);
                    await ctx.editMessageText(t(lang, 'scene_save_error'));
                    return ctx.scene.leave();
                }

                // Notify reports users about muammo entries
                if (key === 'muammo') {
                    const userName = ctx.from ? (ctx.from.first_name || userId) : String(userId);
                    for (const entry of ctx.wizard.state.entries) {
                        notify.notifyReportsUsers(
                            `⚠️ *Yangi muammo qo'shildi*\n\n👤 ${userName}\n📌 ${entry.branch || ''} — ${entry.type || ''}\n📝 ${entry.issue || ''}`
                        ).catch(e => logger.warn('Notification failed:', e.message));
                    }
                }

                let summary = '';
                ctx.wizard.state.entries.forEach((e, i) => {
                    const values = Object.values(e).join(' - ');
                    summary += `${i + 1}. ${values}\n`;
                });

                const translatedTitle = t(lang, section.titleKey || section.title);
                const itemLabel = section.itemLabelKey ? t(lang, section.itemLabelKey) : section.itemLabel;

                await ctx.editMessageText(t(lang, 'scene_save_success', { title: translatedTitle, date: getTodayDisplay() }) + `\n\n📋 **Kiritildi (${ctx.wizard.state.entries.length} ta ${itemLabel}):**\n${summary}`, { parse_mode: 'Markdown' });

                // Show potential income feedback for bosh_xonalar
                if (key === 'bosh_xonalar') {
                    let potentialMsg = '';
                    for (const entry of ctx.wizard.state.entries) {
                        const cap = parseInt(entry.capacity) || 20;
                        const price = parseInt(String(entry.price_per_student).replace(/[.,\s]/g, '')) || 350000;
                        const potential = cap * price;
                        potentialMsg += t(lang, 'potential_income_room_feedback', {
                            amount: formatNumber(potential, lang),
                            capacity: cap,
                            price: formatNumber(price, lang)
                        }) + '\n';
                    }
                    if (potentialMsg) {
                        await ctx.reply(potentialMsg.trim(), { parse_mode: 'Markdown' });
                    }
                }

                return ctx.scene.leave();
            });
        }

        // --- Non-Loop Actions ---
        if (!section.loop) {
            scene.action('confirm', async (ctx) => {
                const lang = getLang(ctx);
                await ctx.answerCbQuery();
                const userId = ctx.from ? ctx.from.id : null;
                if (!userId) {
                    logger.error('saveDailyReport: no user ID available, aborting save');
                    await ctx.editMessageText(t(lang, 'scene_save_error'));
                    return ctx.scene.leave();
                }
                const answers = ctx.wizard.state.answers;

                // Pass financeCategory from wizard state (or scene state fallback) into answers
                const _finCat = ctx.wizard.state?.category || ctx.scene.state?.financeCategory;
                if (_finCat) answers.financeCategory = _finCat;
                // Proceed with save
                await doConfirmSave(ctx, key, section, lang, userId, answers);
            });

            // --- Norasmiy Kirim Optional Deduction ---
            if (key === 'moliya_kirim_norasmiy') {
                scene.action('opt_deduct_no', async (ctx) => {
                    await ctx.answerCbQuery();
                    await ctx.editMessageText("Moliya: Norasmiy tushum kiritildi. Qarzdorlarga tegilmadi.");
                    return ctx.scene.leave();
                });

                scene.action('opt_deduct_yes', async (ctx) => {
                    const lang = getLang(ctx);
                    await ctx.answerCbQuery();
                    try {
                        const balances = await storage.getQarzdorlarBalance();
                        const months = Object.keys(balances);
                        if (months.length === 0) {
                            await ctx.editMessageText("Bazada qarzdorlar yo'q. Faqat kirim sifatida qabul qilindi.");
                            return ctx.scene.leave();
                        }
                        const kb = months.map(m => {
                            const b = balances[m];
                            const fmtNum = (n) => n.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU');
                            return [Markup.button.callback(`📅 ${m} - ${fmtNum(b.amount)} so'm`, `docdeduct_${m.replace(/ /g, '_')}`)];
                        });
                        kb.push([Markup.button.callback("❌ Bekor qilish", 'opt_deduct_no')]);
                        await ctx.editMessageText("Qaysi oydan ayirishni xohlaysiz?", {
                            ...Markup.inlineKeyboard(kb)
                        });
                    } catch(e) {
                        logger.error(e);
                        await ctx.reply("Xatolik");
                        return ctx.scene.leave();
                    }
                });

                scene.action(/^docdeduct_(.+)$/, async (ctx) => {
                    const lang = getLang(ctx);
                    await ctx.answerCbQuery();
                    const monthSlug = ctx.match[1].replace(/_/g, ' ');

                    const answers = ctx.wizard.state.answers;
                    const amount = parseInt(String(answers.today_kassa_amount || answers.today_income || '0').replace(/[.,\s]/g, '')) || 0;
                    const count = parseInt(answers.today_kassa_students || '0') || 0;
                    const userId = ctx.from ? ctx.from.id : 'unknown';

                    try {
                        const fmtNum = (n) => n.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU');
                        // Validate sufficient qarzdorlar balance before deducting
                        const balance = await storage.getQarzdorlarBalance(monthSlug);
                        if (balance && typeof balance.amount === 'number' && balance.amount < amount) {
                            await ctx.editMessageText('⚠️ Yetarli mablag\' yo\'q. Joriy balans: ' + fmtNum(balance.amount) + ' so\'m');
                            return ctx.scene.leave();
                        }
                        await storage.deductFromQarzdorlar(monthSlug, amount, count, userId);
                        await ctx.editMessageText(`✅ ${monthSlug} oyining qarzdorlaridan ${fmtNum(amount)} so'm (${count} ta o'quvchi) ayirib tashlandi.`);
                    } catch (e) {
                        logger.error('deduct error:', e);
                        await ctx.editMessageText("Xatolik yuz berdi.");
                    }
                    return ctx.scene.leave();
                });
            }
        }

        generatedScenes.push(scene);
    }

    // --- Custom Scene for Deleting Empty Rooms (Marking Occupied) ---
    const deleteBxScene = new WizardScene('bosh_xonalar_delete',
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.state?.user?.sections?.includes('bosh_xonalar')) {
                await ctx.reply(t(lang, 'no_section_access'));
                return ctx.scene.leave();
            }
            const loadingMsg = await ctx.reply(t(lang, 'scene_loading'));
            try {
                const rooms = await storage.getEmptyRooms();
                if (rooms.length === 0) {
                    await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, t(lang, 'notify_no_empty_rooms'));
                    return ctx.scene.leave();
                }

                // Store rooms in state
                ctx.wizard.state.rooms = rooms;

                const kb = [];
                rooms.forEach(room => {
                    const label = `${room.branch} ${t(lang, 'label_filial')} | ${t(lang, 'label_room')}: ${room.room} | ${room.days} ${room.time}`;
                    kb.push([Markup.button.callback(label, `del_bx_${room.rowIndex}`)]);
                });
                kb.push([Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel_bx_del')]);

                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    loadingMsg.message_id,
                    undefined,
                    t(lang, 'scene_select_room_occupied'),
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard(kb)
                    }
                );
                return ctx.wizard.next();
            } catch (e) {
                await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, t(lang, 'notify_error_fetching'));
                return ctx.scene.leave();
            }
        },
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.callbackQuery) return;
            const cbData = ctx.callbackQuery.data;

            if (cbData === 'cancel_bx_del') {
                await ctx.answerCbQuery();
                await ctx.editMessageText(t(lang, 'scene_cancelled'));
                return ctx.scene.leave();
            }

            if (cbData.startsWith('del_bx_')) {
                const rowIndex = parseInt(cbData.replace('del_bx_', ''));
                const room = ctx.wizard.state.rooms.find(r => r.rowIndex === rowIndex);

                if (!room) {
                    await ctx.answerCbQuery(t(lang, 'scene_error_room_not_found'));
                    return ctx.scene.leave();
                }

                await ctx.answerCbQuery();
                await ctx.editMessageText(t(lang, 'scene_room_occupied_loading'));

                try {
                    const success = await storage.deleteEmptyRoom(rowIndex);
                    if (success) {
                        await ctx.editMessageText(t(lang, 'notify_room_deleted', { branch: room.branch, room: room.room }), { parse_mode: 'Markdown' });
                    } else {
                        await ctx.editMessageText(t(lang, 'scene_save_error'));
                    }
                } catch (e) {
                    logger.error('deleteEmptyRoom error:', e);
                    await ctx.editMessageText(t(lang, 'scene_save_error'));
                }
                return ctx.scene.leave();
            }
        }
    );

    generatedScenes.push(deleteBxScene);

    // --- Add Subject Scene (Lead section) ---
    const leadFanQoshishScene = new WizardScene(
        'lead_fan_qoshish',
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.state?.user?.sections?.includes('lead')) {
                await ctx.reply(t(lang, 'no_section_access'));
                return ctx.scene.leave();
            }
            await ctx.reply(t(lang, 'scene_subject_add_prompt'), Markup.inlineKeyboard([
                [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
            ]));
            return ctx.wizard.next();
        },
        async (ctx) => {
            const lang = getLang(ctx);
            if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel') {
                await ctx.answerCbQuery();
                await ctx.reply(t(lang, 'scene_cancelled'));
                return ctx.scene.leave();
            }
            if (!ctx.message || !ctx.message.text) {
                await ctx.reply(t(lang, 'scene_subject_add_prompt'));
                return;
            }
            const fanName = ctx.message.text.trim();
            try {
                await storage.addSubject(fanName);
                await ctx.reply(t(lang, 'scene_subject_add_success', { name: fanName }));
            } catch (e) {
                logger.error("Error adding subject:", e);
                await ctx.reply(t(lang, 'scene_save_error'));
            }
            return ctx.scene.leave();
        }
    );

    leadFanQoshishScene.action('cancel', async (ctx) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery();
        await ctx.reply(t(lang, 'scene_cancelled'));
        return ctx.scene.leave();
    });

    const leadFanOchirishScene = new WizardScene(
        'lead_fan_ochirish',
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.state?.user?.sections?.includes('lead')) {
                await ctx.reply(t(lang, 'no_section_access'));
                return ctx.scene.leave();
            }
            const subjects = await storage.getAllSubjects();
            const leadTotals = await storage.getLeadStatus();

            // Merge
            const allSubjects = new Set(subjects);
            for (const subj of Object.keys(leadTotals)) {
                allSubjects.add(subj);
            }

            if (allSubjects.size === 0) {
                await ctx.reply(t(lang, 'search_no_data'));
                return ctx.scene.leave();
            }

            const kb = [];
            for (const s of allSubjects) {
                const count = leadTotals[s] || 0;
                const label = count > 0 ? `${s} (${count} ${t(lang, 'unit_ta')})` : s;
                kb.push([Markup.button.callback(label, `del_lfan_${Buffer.from(s).toString('base64')}`)]);
            }
            kb.push([Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]);

            await ctx.reply(t(lang, 'scene_subject_delete_prompt'), Markup.inlineKeyboard(kb));
            return ctx.wizard.next();
        },
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.callbackQuery) return;
            const cbData = ctx.callbackQuery.data;

            if (cbData === 'cancel') {
                await ctx.answerCbQuery();
                await ctx.reply(t(lang, 'scene_cancelled'));
                return ctx.scene.leave();
            }

            if (cbData.startsWith('del_lfan_')) {
                const slug = cbData.replace('del_lfan_', '');
                const fanName = Buffer.from(slug, 'base64').toString();

                if (!fanName) {
                    await ctx.answerCbQuery(t(lang, 'scene_error_room_not_found'));
                    return ctx.scene.leave();
                }

                await ctx.answerCbQuery();
                ctx.wizard.state.pendingDeleteFan = fanName;
                const leadTotals = await storage.getLeadStatus();
                const leadCount = leadTotals[fanName] || 0;
                const confirmText = leadCount > 0
                    ? t(lang, 'scene_subject_delete_confirm_prompt', { name: fanName }) || `"${fanName}" fanini o'chirmoqchimisiz? (${leadCount} ta lead ham o'chiriladi)`
                    : t(lang, 'scene_subject_delete_confirm_prompt', { name: fanName }) || `"${fanName}" fanini o'chirmoqchimisiz?`;
                await ctx.reply(confirmText, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback(t(lang, 'btn_confirm') || 'Tasdiqlash', 'confirm_del_lfan')],
                        [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
                    ])
                });
                return;
            }
        }
    );

    leadFanOchirishScene.action('confirm_del_lfan', async (ctx) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery();
        const fanName = ctx.wizard.state.pendingDeleteFan;
        if (!fanName) {
            await ctx.reply(t(lang, 'scene_cancelled'));
            return ctx.scene.leave();
        }
        await ctx.reply(t(lang, 'scene_deleting', { item: fanName }));
        await storage.deleteSubject(fanName);
        await storage.deleteLeadsBySubject(fanName);
        await ctx.reply(t(lang, 'scene_subject_delete_confirm', { name: fanName }));
        return ctx.scene.leave();
    });

    leadFanOchirishScene.action('cancel', async (ctx) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery();
        await ctx.reply(t(lang, 'scene_cancelled'));
        return ctx.scene.leave();
    });

    const radFanOchirishScene = new WizardScene(
        'rad_fan_ochirish',
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.state?.user?.sections?.includes('rad_etilganlar')) {
                await ctx.reply(t(lang, 'no_section_access'));
                return ctx.scene.leave();
            }
            const subjects = await storage.getAllSubjects();
            const radTotalsByMonth = await storage.getRejectionByMonth();

            const radTotals = {};
            for (const monthData of Object.values(radTotalsByMonth)) {
                for (const [subj, count] of Object.entries(monthData)) {
                    radTotals[subj] = (radTotals[subj] || 0) + count;
                }
            }

            const allSubjects = new Set(subjects);
            for (const subj of Object.keys(radTotals)) {
                allSubjects.add(subj);
            }

            if (allSubjects.size === 0) {
                await ctx.reply(t(lang, 'search_no_data'));
                return ctx.scene.leave();
            }

            const kb = [];
            for (const s of allSubjects) {
                const count = radTotals[s] || 0;
                const label = count > 0 ? `${s} (${count} ${t(lang, 'unit_ta')})` : s;
                kb.push([Markup.button.callback(label, `del_rfan_${Buffer.from(s).toString('base64')}`)]);
            }
            kb.push([Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]);

            await ctx.reply(t(lang, 'scene_subject_delete_prompt'), Markup.inlineKeyboard(kb));
            return ctx.wizard.next();
        },
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.callbackQuery || !ctx.callbackQuery.data) return;
            const cbData = ctx.callbackQuery.data;

            if (cbData === 'cancel') {
                await ctx.answerCbQuery();
                await ctx.reply(t(lang, 'scene_cancelled'));
                return ctx.scene.leave();
            }

            if (cbData.startsWith('del_rfan_')) {
                const slug = cbData.replace('del_rfan_', '');
                const fanName = Buffer.from(slug, 'base64').toString();

                if (!fanName) {
                    await ctx.answerCbQuery(t(lang, 'scene_error_room_not_found'));
                    return ctx.scene.leave();
                }

                await ctx.answerCbQuery();
                ctx.wizard.state.pendingDeleteFan = fanName;
                const radTotalsByMonth = await storage.getRejectionByMonth();
                const totalCount = Object.values(radTotalsByMonth).reduce((sum, md) => sum + (md[fanName] || 0), 0);
                const confirmText = totalCount > 0
                    ? t(lang, 'scene_subject_delete_confirm_prompt', { name: fanName }) || `"${fanName}" fanini o'chirmoqchimisiz? (${totalCount} ta rad etilgan ham o'chiriladi)`
                    : t(lang, 'scene_subject_delete_confirm_prompt', { name: fanName }) || `"${fanName}" fanini o'chirmoqchimisiz?`;
                await ctx.reply(confirmText, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback(t(lang, 'btn_confirm') || 'Tasdiqlash', 'confirm_del_rfan')],
                        [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
                    ])
                });
                return;
            }
        }
    );

    radFanOchirishScene.action('confirm_del_rfan', async (ctx) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery();
        const fanName = ctx.wizard.state.pendingDeleteFan;
        if (!fanName) {
            await ctx.reply(t(lang, 'scene_cancelled'));
            return ctx.scene.leave();
        }
        await ctx.reply(t(lang, 'scene_deleting', { item: fanName }));
        await storage.deleteSubject(fanName);
        await storage.deleteRejectionsBySubject(fanName);
        await ctx.reply(t(lang, 'scene_subject_delete_confirm', { name: fanName }));
        return ctx.scene.leave();
    });

    radFanOchirishScene.action('cancel', async (ctx) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery();
        await ctx.reply(t(lang, 'scene_cancelled'));
        return ctx.scene.leave();
    });

    generatedScenes.push(leadFanQoshishScene);
    generatedScenes.push(leadFanOchirishScene);
    generatedScenes.push(radFanOchirishScene);

    // --- Expense Type Scenes ---
    const xarajatTuriQoshishScene = new WizardScene(
        'xarajat_turi_qoshish',
        // Step 0: Ask category (or skip if preset)
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.state?.user?.sections?.includes('moliya')) {
                await ctx.reply(t(lang, 'no_section_access'));
                return ctx.scene.leave();
            }
            if (ctx.scene.state?.presetCategory) {
                ctx.wizard.state.category = ctx.scene.state.presetCategory;
                await ctx.reply(t(lang, 'scene_expense_type_add_prompt'), Markup.inlineKeyboard([
                    [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
                ]));
                ctx.wizard.selectStep(2); // skip to name input step
                return;
            }
            await ctx.reply('Qaysi toifaga tur qo\'shmoqchisiz?', Markup.inlineKeyboard([
                [Markup.button.callback('cat_1', 'cat_Norasmiy'), Markup.button.callback('cat_2', 'cat_Rasmiy')],
                [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
            ]));
            return ctx.wizard.next();
        },
        // Step 1: Receive category, ask name
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.callbackQuery) return;
            const cbData = ctx.callbackQuery.data;
            await ctx.answerCbQuery();
            if (cbData === 'cancel') {
                await ctx.reply(t(lang, 'scene_cancelled'));
                return ctx.scene.leave();
            }
            if (cbData === 'cat_Norasmiy' || cbData === 'cat_Rasmiy') {
                ctx.wizard.state.category = 'cat_2';
                await ctx.reply(t(lang, 'scene_expense_type_add_prompt'), Markup.inlineKeyboard([
                    [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
                ]));
                return ctx.wizard.next();
            }
        },
        // Step 2: Receive name, save
        async (ctx) => {
            const lang = getLang(ctx);
            if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel') {
                await ctx.answerCbQuery();
                await ctx.reply(t(lang, 'scene_cancelled'));
                return ctx.scene.leave();
            }
            if (!ctx.message || !ctx.message.text) {
                await ctx.reply(t(lang, 'scene_expense_type_add_prompt'));
                return;
            }
            const typeName = ctx.message.text.trim();
            const category = 'cat_1';
            try {
                await storage.addExpenseType(typeName, category);
                await ctx.reply(t(lang, 'scene_expense_type_add_success', { name: `${typeName} (${category})` }));
            } catch (e) {
                logger.error("Error adding expense type:", e);
                await ctx.reply(t(lang, 'scene_save_error'));
            }
            return ctx.scene.leave();
        }
    );

    xarajatTuriQoshishScene.action('cancel', async (ctx) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery();
        await ctx.reply(t(lang, 'scene_cancelled'));
        return ctx.scene.leave();
    });

    const xarajatTuriOchirishScene = new WizardScene(
        'xarajat_turi_ochirish',
        // Step 0: Ask category (or skip if preset)
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.state?.user?.sections?.includes('moliya')) {
                await ctx.reply(t(lang, 'no_section_access'));
                return ctx.scene.leave();
            }
            if (ctx.scene.state?.presetCategory) {
                const category = ctx.scene.state.presetCategory;
                ctx.wizard.state.category = category;
                const types = await storage.getExpenseTypes(category);
                if (types.length === 0) {
                    await ctx.reply(t(lang, 'search_no_data'));
                    return ctx.scene.leave();
                }
                const kb = types.map(t2 => [Markup.button.callback(t2, `del_type_${Buffer.from(t2).toString('base64')}`)]);
                kb.push([Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]);
                await ctx.reply(t(lang, 'scene_expense_type_delete_prompt'), Markup.inlineKeyboard(kb));
                ctx.wizard.selectStep(2); // skip to delete step
                return;
            }
            await ctx.reply('Qaysi toifadan turni olib tashlaysiz?', Markup.inlineKeyboard([
                [Markup.button.callback('cat_1', 'cat_Norasmiy'), Markup.button.callback('cat_2', 'cat_Rasmiy')],
                [Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]
            ]));
            return ctx.wizard.next();
        },
        // Step 1: Receive category, show list
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.callbackQuery) return;
            const cbData = ctx.callbackQuery.data;
            await ctx.answerCbQuery();
            if (cbData === 'cancel') {
                await ctx.reply(t(lang, 'scene_cancelled'));
                return ctx.scene.leave();
            }
            if (cbData === 'cat_Norasmiy' || cbData === 'cat_Rasmiy') {
                const category = 'cat_2';
                ctx.wizard.state.category = category;
                const types = await storage.getExpenseTypes(category);
                if (types.length === 0) {
                    await ctx.reply(t(lang, 'search_no_data'));
                    return ctx.scene.leave();
                }
                const kb = types.map(t2 => [Markup.button.callback(t2, `del_type_${Buffer.from(t2).toString('base64')}`)]);
                kb.push([Markup.button.callback(t(lang, 'scene_cancel_btn'), 'cancel')]);
                await ctx.reply(t(lang, 'scene_expense_type_delete_prompt'), Markup.inlineKeyboard(kb));
                return ctx.wizard.next();
            }
        },
        // Step 2: Delete selected type
        async (ctx) => {
            const lang = getLang(ctx);
            if (!ctx.callbackQuery) return;
            const cbData = ctx.callbackQuery.data;

            if (cbData === 'cancel') {
                await ctx.answerCbQuery();
                await ctx.reply(t(lang, 'scene_cancelled'));
                return ctx.scene.leave();
            }

            if (cbData.startsWith('del_type_')) {
                const slug = cbData.replace('del_type_', '');
                const category = ctx.wizard.state.category;
                const types = await storage.getExpenseTypes(category);
                const typeName = types.find(t2 => Buffer.from(t2).toString('base64') === slug);

                if (!typeName) {
                    await ctx.answerCbQuery(t(lang, 'scene_error_room_not_found'));
                    return ctx.scene.leave();
                }

                await ctx.answerCbQuery();
                await ctx.reply(t(lang, 'scene_deleting', { item: typeName }));
                await storage.deleteExpenseType(typeName, category);
                await ctx.reply(t(lang, 'scene_expense_type_delete_success', { name: typeName }));
                return ctx.scene.leave();
            }
        }
    );

    xarajatTuriOchirishScene.action('cancel', async (ctx) => {
        const lang = getLang(ctx);
        await ctx.answerCbQuery();
        await ctx.reply(t(lang, 'scene_cancelled'));
        return ctx.scene.leave();
    });

    generatedScenes.push(xarajatTuriQoshishScene);
    generatedScenes.push(xarajatTuriOchirishScene);


    return generatedScenes;
}

module.exports = { buildScenes };
