const { Scenes, Markup } = require('telegraf');
const { WizardScene } = Scenes;
const storage = require('./storage');
const logger = require('./logger');
const { parseCronToHuman, generateCronFromHuman } = require('./utils');
const { reloadCrons } = require('./cron');

let _botRef = null;
function setBotRef(bot) { _botRef = bot; }

// Common time presets for quick selection
const TIME_PRESETS = [
    ['06:00', '07:00', '08:00'],
    ['09:00', '10:00', '11:00'],
    ['12:00', '13:00', '14:00'],
    ['15:00', '16:00', '17:00'],
    ['18:00', '19:00', '20:00'],
    ['21:00', '22:00', '23:00'],
];

// Built-in job inherent frequencies (these shouldn't change)
const BUILTIN_FREQUENCIES = {
    manager_reminder: 'daily',
    morning_summary: 'daily',
    lead_monitor: 'hourly',
    weekly_report: 'weekly',
    monthly_report: 'monthly',
    accountability: 'daily',
};

function buildTimePresetKeyboard(callbackPrefix, cancelCallback) {
    const rows = TIME_PRESETS.map(row =>
        row.map(t => Markup.button.callback(t, `${callbackPrefix}_${t}`))
    );
    rows.push([Markup.button.callback('✏️ Boshqa vaqt kiritish', `${callbackPrefix}_custom`)]);
    rows.push([Markup.button.callback('❌ Bekor qilish', cancelCallback)]);
    return Markup.inlineKeyboard(rows);
}

async function triggerReload() {
    if (_botRef) {
        try {
            await reloadCrons(_botRef);
        } catch (e) {
            logger.error('Failed to reload crons:', e.message);
        }
    }
}

function buildMainCronKeyboard(settings) {
    const rows = [];

    // Built-in cron jobs
    storage.CRON_JOB_DEFAULTS.forEach(job => {
        const s = settings[job.key] || { enabled: false, assignedUsers: [] };
        const on = s.enabled !== false;
        rows.push([Markup.button.callback(
            `${on ? '✅' : '❌'} ${job.label}`,
            `cron_detail_${job.key}`
        )]);
    });

    // Custom cron jobs
    const customKeys = Object.keys(settings).filter(k => k.startsWith('custom_'));
    if (customKeys.length > 0) {
        customKeys.forEach(key => {
            const s = settings[key];
            const on = s.enabled !== false;
            const label = s.label || key;
            rows.push([Markup.button.callback(
                `${on ? '✅' : '❌'} 🔧 ${label}`,
                `cron_detail_${key}`
            )]);
        });
    }

    rows.push([Markup.button.callback('➕ Yangi cron vazifa yaratish', 'cron_create_new')]);
    rows.push([Markup.button.callback('✅ Tayyor', 'cron_done')]);
    return Markup.inlineKeyboard(rows);
}

function buildCronDetailKeyboard(jobKey, settings, users) {
    const s = settings[jobKey] || { enabled: false, assignedUsers: [] };
    const on = s.enabled !== false;
    const isCustom = jobKey.startsWith('custom_');
    const rows = [];

    // Toggle on/off
    rows.push([Markup.button.callback(
        on ? '🔴 O\'chirish' : '🟢 Yoqish',
        `cron_toggle_${jobKey}`
    )]);

    // Assigned users section
    if (users.length > 0) {
        rows.push([Markup.button.callback('👥 Foydalanuvchilarni tayinlash', `cron_assign_${jobKey}`)]);
    }

    // Edit and test buttons for custom crons
    if (isCustom) {
        rows.push([
            Markup.button.callback('✏️ Tahrirlash', `cron_edit_${jobKey}`),
            Markup.button.callback('📨 Test', `cron_test_${jobKey}`),
        ]);
        rows.push([Markup.button.callback('🗑 O\'chirish', `cron_delete_${jobKey}`)]);
    } else {
        // Test button for built-in crons too
        rows.push([
            Markup.button.callback('⏰ Vaqtini o\'zgartirish', `cron_editf_schedule_${jobKey}`),
            Markup.button.callback('📨 Test xabar yuborish', `cron_test_${jobKey}`)
        ]);
    }

    rows.push([Markup.button.callback('⬅️ Orqaga', 'cron_back_main')]);
    return Markup.inlineKeyboard(rows);
}

function buildUserAssignKeyboard(jobKey, assignedUsers, allUsers) {
    const rows = [];
    // "All users" toggle
    const isAll = assignedUsers.length === 0;
    rows.push([Markup.button.callback(
        `${isAll ? '✅' : '☐'} Barcha foydalanuvchilar`,
        `cron_assign_all_${jobKey}`
    )]);

    for (const user of allUsers) {
        const isAssigned = isAll || assignedUsers.includes(user.id);
        rows.push([Markup.button.callback(
            `${isAssigned && !isAll ? '✅' : isAll ? '🔹' : '☐'} ${user.name}`,
            `cron_user__${jobKey}__${user.id}`
        )]);
    }

    rows.push([
        Markup.button.callback('💾 Saqlash', `cron_save_assign_${jobKey}`),
        Markup.button.callback('⬅️ Orqaga', `cron_detail_${jobKey}`)
    ]);
    return Markup.inlineKeyboard(rows);
}

function formatCronDetail(jobKey, settings, allUsers) {
    const isCustom = jobKey.startsWith('custom_');
    const s = settings[jobKey] || { enabled: false, assignedUsers: [] };
    const on = s.enabled !== false;

    let label, schedule;
    if (isCustom) {
        label = s.label || jobKey;
        schedule = s.cronExpression || 'Belgilanmagan';
    } else {
        const job = storage.CRON_JOB_DEFAULTS.find(j => j.key === jobKey);
        label = job ? job.label : jobKey;
        schedule = s.cronExpression || (job ? job.schedule : '');
    }

    const prs = parseCronToHuman(schedule);

    let txt = `⏰ *${label}*\n\n`;
    if (prs.freq === 'unknown') {
        txt += `📅 Jadval: \`${schedule}\`\n`;
    } else {
        txt += `📅 Jadval: ${prs.labelUz} soat ${prs.timeStr} da\n`;
    }
    txt += `📊 Holat: ${on ? '✅ Yoqilgan' : '❌ O\'chirilgan'}\n`;

    if (isCustom && s.message) {
        txt += `💬 Xabar: ${s.message}\n`;
    }

    txt += '\n';

    if (s.assignedUsers.length === 0) {
        txt += `👥 Tayinlangan: *Barcha foydalanuvchilar*\n`;
    } else {
        txt += `👥 Tayinlangan (${s.assignedUsers.length} ta):\n`;
        for (const uid of s.assignedUsers) {
            const u = allUsers.find(u => u.id === uid);
            txt += `   • ${u ? u.name : uid}\n`;
        }
    }

    return txt;
}

const cronScene = new WizardScene('cron_settings',
    async (ctx) => {
        try {
            const settings = await storage.loadCronSettings();
            const users = await storage.loadAuthorizedUsers();
            ctx.wizard.state.settings = settings;
            ctx.wizard.state.allUsers = Object.values(users);

            let txt = '⏰ *Cron vazifalar boshqaruvi*\n\n';
            txt += 'Avtomatik vazifalarni yoqing/o\'chiring va foydalanuvchilarni tayinlang:\n\n';

            // Built-in jobs
            storage.CRON_JOB_DEFAULTS.forEach(job => {
                const s = settings[job.key] || { enabled: true, assignedUsers: [] };
                const on = s.enabled !== false;
                const userCount = s.assignedUsers.length;
                const userLabel = userCount > 0 ? `${userCount} ta foydalanuvchi` : 'barcha';
                txt += `${on ? '✅' : '❌'} *${job.label}*\n   📅 ${job.schedule} | 👥 ${userLabel}\n\n`;
            });

            // Custom jobs
            const customKeys = Object.keys(settings).filter(k => k.startsWith('custom_'));
            if (customKeys.length > 0) {
                txt += '🔧 *Maxsus vazifalar:*\n\n';
                customKeys.forEach(key => {
                    const s = settings[key];
                    const on = s.enabled !== false;
                    const userCount = s.assignedUsers.length;
                    const userLabel = userCount > 0 ? `${userCount} ta foydalanuvchi` : 'barcha';
                    const prs = parseCronToHuman(s.cronExpression);
                    txt += `${on ? '✅' : '❌'} *${s.label || key}*\n   📅 ${prs.labelUz} ${prs.timeStr} | 👥 ${userLabel}\n\n`;
                });
            }

            txt += '_Batafsil sozlash uchun vazifani tanlang:_';

            await ctx.reply(txt, { parse_mode: 'Markdown', ...buildMainCronKeyboard(settings) });
        } catch (e) {
            logger.error('cron_settings scene error:', e);
            await ctx.reply('❌ Sozlamalarni yuklashda xatolik yuz berdi.');
            return ctx.scene.leave();
        }
        return ctx.wizard.next();
    },
    async (ctx) => {
        // Handle text input for custom cron creation/editing wizard
        if (!ctx.message || !ctx.message.text) return;
        const text = ctx.message.text.trim();
        const step = ctx.wizard.state.createStep;
        const editStep = ctx.wizard.state.editFieldStep;

        // --- Edit existing custom cron field ---
        if (editStep) {
            const jobKey = ctx.wizard.state.editingCronKey;
            const settings = ctx.wizard.state.settings || {};
            const s = settings[jobKey];
            if (!s) {
                ctx.wizard.state.editFieldStep = null;
                return ctx.reply('❌ Vazifa topilmadi.');
            }

            if (editStep === 'edit_label') {
                if (text.length < 2) return ctx.reply('❌ Nom kamida 2 ta belgi bo\'lishi kerak.');
                s.label = text;
            } else if (editStep === 'edit_schedule') {
                const timeStr = text.trim();
                if (!/^\d{1,2}:\d{2}$/.test(timeStr)) {
                    return ctx.reply('❌ Noto\'g\'ri format. Iltimos, vaqtni `HH:mm` ko\'rinishida kiriting (masalan: 09:30).', { parse_mode: 'Markdown' });
                }

                const isBuiltin = !jobKey.startsWith('custom_');
                if (isBuiltin) {
                    // Built-in: use inherent frequency, save immediately
                    const freq = BUILTIN_FREQUENCIES[jobKey] || 'daily';
                    ctx.wizard.state.editFieldStep = null;
                    ctx.wizard.state.editingCronKey = null;
                    await saveScheduleChange(ctx, jobKey, timeStr, freq);
                    return;
                }

                // Custom: ask for frequency
                ctx.wizard.state.editingTempTime = timeStr;
                await ctx.reply(
                    '🗓 *Takrorlanish chastotasini tanlang:*\n\n' +
                    `Tanlangan vaqt: *${timeStr}*`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('📅 Har kuni', `cron_freq_edit_daily`)],
                            [Markup.button.callback('📅 Ish kunlari (Du-Ju)', `cron_freq_edit_weekdays`)],
                            [Markup.button.callback('📅 Haftalik (Dushanba)', `cron_freq_edit_weekly`)],
                            [Markup.button.callback('📅 Oylik (1-sana)', `cron_freq_edit_monthly`)],
                            [Markup.button.callback('❌ Bekor qilish', `cron_cancel_edit_${jobKey}`)]
                        ])
                    }
                );
                return; // Wait for inline button
            } else if (editStep === 'edit_message') {
                if (text.length < 2) return ctx.reply('❌ Xabar kamida 2 ta belgi bo\'lishi kerak.');
                s.message = text;
            }

            // Save to database
            try {
                await storage.updateCustomCron(jobKey, s.label, s.cronExpression, s.message);
                settings[jobKey] = s;
                ctx.wizard.state.settings = settings;
                await ctx.reply('✅ O\'zgarish saqlandi!');
            } catch (e) {
                logger.error('edit custom cron error:', e);
                await ctx.reply('❌ Saqlashda xatolik.');
            }

            ctx.wizard.state.editFieldStep = null;
            ctx.wizard.state.editingCronKey = null;

            // Show detail view again
            const allUsers = ctx.wizard.state.allUsers || [];
            const txt = formatCronDetail(jobKey, settings, allUsers);
            await ctx.reply(txt, {
                parse_mode: 'Markdown',
                ...buildCronDetailKeyboard(jobKey, settings, allUsers)
            });
            return;
        }

        // --- Create new cron wizard ---
        if (step === 'label') {
            if (text.length < 2) {
                return ctx.reply('❌ Nom kamida 2 ta belgi bo\'lishi kerak.');
            }
            ctx.wizard.state.newCron = { label: text };
            ctx.wizard.state.createStep = 'schedule';
            await ctx.reply(
                '⏰ *Soat nechada yuborilsin?*\n\nVaqtni tanlang:',
                {
                    parse_mode: 'Markdown',
                    ...buildTimePresetKeyboard('cron_newtime', 'cron_cancel_create')
                }
            );
        } else if (step === 'schedule_custom') {
            // Custom time input for new cron
            const timeStr = text.trim();
            if (!/^\d{1,2}:\d{2}$/.test(timeStr)) {
                return ctx.reply('❌ Noto\'g\'ri format. Iltimos, vaqtni `HH:mm` ko\'rinishida kiriting (masalan: 09:30).', { parse_mode: 'Markdown' });
            }
            ctx.wizard.state.newCron.timeStr = timeStr;
            ctx.wizard.state.createStep = 'frequency';
            await ctx.reply(
                 '🗓 *Takrorlanish chastotasini tanlang:*\n\n' +
                 `Tanlangan vaqt: *${timeStr}*`,
                 {
                     parse_mode: 'Markdown',
                     ...Markup.inlineKeyboard([
                            [Markup.button.callback('📅 Har kuni', `cron_freq_new_daily`)],
                            [Markup.button.callback('📅 Ish kunlari (Du-Ju)', `cron_freq_new_weekdays`)],
                            [Markup.button.callback('📅 Haftalik (Dushanba)', `cron_freq_new_weekly`)],
                            [Markup.button.callback('📅 Oylik (1-sana)', `cron_freq_new_monthly`)],
                            [Markup.button.callback('❌ Bekor qilish', `cron_cancel_create`)]
                     ])
                 }
            );
            return;
        } else if (step === 'message') {
            if (text.length < 2) {
                return ctx.reply('❌ Xabar kamida 2 ta belgi bo\'lishi kerak.');
            }
            ctx.wizard.state.newCron.message = text;

            // Show user assignment
            const allUsers = ctx.wizard.state.allUsers || [];
            ctx.wizard.state.newCronAssigned = [];
            ctx.wizard.state.createStep = 'assign';

            const nc = ctx.wizard.state.newCron;
            const prs = parseCronToHuman(nc.cronExpression);
            let txt = `📋 *Yangi vazifa:*\n\n`;
            txt += `📝 Nomi: *${nc.label}*\n`;
            txt += `📅 Jadval: ${prs.labelUz} soat ${prs.timeStr} da\n`;
            txt += `💬 Xabar: ${nc.message}\n\n`;
            txt += '_Foydalanuvchilarni tayinlang:_';

            const rows = [];
            rows.push([Markup.button.callback(
                '✅ Barcha foydalanuvchilar',
                'cron_new_assign_all'
            )]);
            for (const user of allUsers) {
                rows.push([Markup.button.callback(
                    `☐ ${user.name}`,
                    `cron_new_user_${user.id}`
                )]);
            }
            rows.push([
                Markup.button.callback('💾 Saqlash', 'cron_save_new'),
                Markup.button.callback('❌ Bekor qilish', 'cron_cancel_create')
            ]);

            await ctx.reply(txt, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
        }
    }
);

// Time preset selection for new cron
cronScene.action(/^cron_newtime_(\d{2}:\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.wizard.state.newCron) return;

    ctx.wizard.state.newCron.timeStr = ctx.match[1];
    ctx.wizard.state.createStep = 'frequency';

    await ctx.editMessageText(
        '🗓 *Takrorlanish chastotasini tanlang:*\n\n' +
        `Tanlangan vaqt: *${ctx.match[1]}*`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📅 Har kuni', 'cron_freq_new_daily')],
                [Markup.button.callback('📅 Ish kunlari (Du-Ju)', 'cron_freq_new_weekdays')],
                [Markup.button.callback('📅 Haftalik (Dushanba)', 'cron_freq_new_weekly')],
                [Markup.button.callback('📅 Oylik (1-sana)', 'cron_freq_new_monthly')],
                [Markup.button.callback('❌ Bekor qilish', 'cron_cancel_create')]
            ])
        }
    );
});

// Custom time input for new cron
cronScene.action('cron_newtime_custom', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.wizard.state.createStep = 'schedule_custom';
    await ctx.editMessageText(
        '⏰ *Vaqtni kiriting:*\n\n`HH:mm` formatida (masalan: `09:30` yoki `18:00`):',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'cron_cancel_create')]])
        }
    );
});

cronScene.action(/^cron_freq_new_(daily|weekdays|weekly|monthly)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const freq = ctx.match[1];

    if (!ctx.wizard.state.newCron) return;

    const timeStr = ctx.wizard.state.newCron.timeStr;
    const expr = generateCronFromHuman(timeStr, freq);

    ctx.wizard.state.newCron.cronExpression = expr;
    ctx.wizard.state.createStep = 'message';

    await ctx.editMessageText(
        '💬 *Xabar matnini kiriting:*\n\n' +
        'Bu xabar tayinlangan foydalanuvchilarga yuboriladi.',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'cron_cancel_create')]])
        }
    );
});

// Time preset selection for editing schedule
cronScene.action(/^cron_edittime_(\d{2}:\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery();
    const timeStr = ctx.match[1];
    const jobKey = ctx.wizard.state.editingCronKey;
    if (!jobKey) return;

    const isBuiltin = !jobKey.startsWith('custom_');
    if (isBuiltin) {
        // Built-in: use inherent frequency, save immediately
        const freq = BUILTIN_FREQUENCIES[jobKey] || 'daily';
        await saveScheduleChange(ctx, jobKey, timeStr, freq);
    } else {
        // Custom: ask for frequency
        ctx.wizard.state.editingTempTime = timeStr;
        await ctx.editMessageText(
            '🗓 *Takrorlanish chastotasini tanlang:*\n\n' +
            `Tanlangan vaqt: *${timeStr}*`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📅 Har kuni', 'cron_freq_edit_daily')],
                    [Markup.button.callback('📅 Ish kunlari (Du-Ju)', 'cron_freq_edit_weekdays')],
                    [Markup.button.callback('📅 Haftalik (Dushanba)', 'cron_freq_edit_weekly')],
                    [Markup.button.callback('📅 Oylik (1-sana)', 'cron_freq_edit_monthly')],
                    [Markup.button.callback('❌ Bekor qilish', `cron_cancel_edit_${jobKey}`)]
                ])
            }
        );
    }
});

// Custom time text input for editing schedule
cronScene.action('cron_edittime_custom', async (ctx) => {
    await ctx.answerCbQuery();
    const jobKey = ctx.wizard.state.editingCronKey;
    ctx.wizard.state.editFieldStep = 'edit_schedule';
    await ctx.editMessageText(
        '⏰ *Vaqtni kiriting:*\n\n`HH:mm` formatida (masalan: `09:30` yoki `18:00`):',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', `cron_cancel_edit_${jobKey}`)]])
        }
    );
});

// Helper to save schedule changes and show result
async function saveScheduleChange(ctx, jobKey, timeStr, freq) {
    const settings = ctx.wizard.state.settings || {};
    const s = settings[jobKey] || {};

    const expr = generateCronFromHuman(timeStr, freq);
    if (!expr) {
        await ctx.editMessageText('❌ Xatolik yuz berdi. Qayta urinib ko\'ring.');
        return;
    }

    s.cronExpression = expr;

    try {
        if (jobKey.startsWith('custom_')) {
            await storage.updateCustomCron(jobKey, s.label, s.cronExpression, s.message);
        } else {
            await storage.updateCronSettingOverride(jobKey, s.cronExpression);
        }
        settings[jobKey] = s;
        ctx.wizard.state.settings = settings;
        await ctx.reply('✅ Vaqt o\'zgartirildi!');
        await triggerReload();
    } catch (e) {
        logger.error('edit cron schedule error:', e);
        await ctx.reply('❌ Saqlashda xatolik.');
    }

    ctx.wizard.state.editFieldStep = null;
    ctx.wizard.state.editingCronKey = null;
    ctx.wizard.state.editingTempTime = null;

    const allUsers = ctx.wizard.state.allUsers || [];
    const txt = formatCronDetail(jobKey, settings, allUsers);
    await ctx.reply(txt, {
        parse_mode: 'Markdown', ...buildCronDetailKeyboard(jobKey, settings, allUsers)
    });
}

cronScene.action(/^cron_freq_edit_(daily|weekdays|weekly|monthly)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const freq = ctx.match[1];
    const jobKey = ctx.wizard.state.editingCronKey;
    const timeStr = ctx.wizard.state.editingTempTime;

    if (!jobKey || !timeStr) return;
    await saveScheduleChange(ctx, jobKey, timeStr, freq);
});

// --- Edit custom cron ---
cronScene.action(/^cron_edit_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const jobKey = ctx.match[1];
    if (!jobKey.startsWith('custom_')) return;
    const settings = ctx.wizard.state.settings || {};
    const s = settings[jobKey] || {};

    const prs = parseCronToHuman(s.cronExpression);
    await ctx.editMessageText(
        `✏️ *${s.label || jobKey}* — nima o'zgartirmoqchisiz?`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`📝 Nomi: ${s.label || '—'}`, `cron_editf_label_${jobKey}`)],
                [Markup.button.callback(`📅 Jadval: ${prs.timeStr} (${prs.labelUz})`, `cron_editf_schedule_${jobKey}`)],
                [Markup.button.callback(`💬 Xabar: ${(s.message || '—').substring(0, 30)}`, `cron_editf_message_${jobKey}`)],
                [Markup.button.callback('⬅️ Orqaga', `cron_detail_${jobKey}`)],
            ])
        }
    );
});

cronScene.action(/^cron_editf_(label|schedule|message)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const field = ctx.match[1];
    const jobKey = ctx.match[2];
    ctx.wizard.state.editingCronKey = jobKey;

    if (field === 'schedule') {
        // Show time preset buttons instead of asking for manual text input
        const isBuiltin = !jobKey.startsWith('custom_');
        let prompt = '⏰ *Yangi vaqtni tanlang:*';
        if (isBuiltin) {
            const builtinFreq = BUILTIN_FREQUENCIES[jobKey];
            const freqLabels = { daily: 'Har kuni', weekdays: 'Ish kunlari', weekly: 'Har dushanba', monthly: 'Har oy 1-sanasida', hourly: 'Har soat' };
            prompt += `\n\n📅 Chastota: *${freqLabels[builtinFreq] || builtinFreq}*`;
        }
        ctx.wizard.state.editFieldStep = 'edit_schedule';
        await ctx.editMessageText(prompt, {
            parse_mode: 'Markdown',
            ...buildTimePresetKeyboard('cron_edittime', `cron_cancel_edit_${jobKey}`)
        });
    } else {
        ctx.wizard.state.editFieldStep = `edit_${field}`;
        const prompts = {
            label: '📝 Yangi nomni kiriting:',
            message: '💬 Yangi xabar matnini kiriting:',
        };
        await ctx.editMessageText(prompts[field], {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', `cron_cancel_edit_${jobKey}`)]])
        });
    }
});

cronScene.action(/^cron_cancel_edit_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.wizard.state.editFieldStep = null;
    ctx.wizard.state.editingCronKey = null;
    const jobKey = ctx.match[1];
    const settings = ctx.wizard.state.settings || {};
    const allUsers = ctx.wizard.state.allUsers || [];
    const txt = formatCronDetail(jobKey, settings, allUsers);
    await ctx.editMessageText(txt, {
        parse_mode: 'Markdown',
        ...buildCronDetailKeyboard(jobKey, settings, allUsers)
    });
});

// --- Test/preview cron message ---
cronScene.action(/^cron_test_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('📨 Test xabar yuborilmoqda...');
    const jobKey = ctx.match[1];
    const settings = ctx.wizard.state.settings || {};
    const s = settings[jobKey] || {};
    const isCustom = jobKey.startsWith('custom_');

    let testMsg;
    if (isCustom && s.message) {
        testMsg = `📨 *Test xabar*\n\n🔧 Vazifa: *${s.label || jobKey}*\n📅 Jadval: \`${s.cronExpression || '—'}\`\n\n💬 Xabar:\n${s.message}`;
    } else {
        const job = storage.CRON_JOB_DEFAULTS.find(j => j.key === jobKey);
        const label = job ? job.label : jobKey;
        testMsg = `📨 *Test xabar*\n\n⏰ Vazifa: *${label}*\n📅 Jadval: ${job ? job.schedule : '—'}\n\n_Bu o'rnatilgan vazifa. Xabar tizim tomonidan avtomatik shakllantiriladi._`;
    }

    try {
        await ctx.reply(testMsg, { parse_mode: 'Markdown' });
    } catch (e) {
        logger.error('cron_test error:', e);
    }
});

// --- Create new custom cron ---
cronScene.action('cron_create_new', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.wizard.state.createStep = 'label';
    ctx.wizard.state.editFieldStep = null;
    await ctx.editMessageText(
        '➕ *Yangi cron vazifa yaratish*\n\n📝 Vazifa nomini kiriting:',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'cron_cancel_create')]])
        }
    );
});

cronScene.action('cron_cancel_create', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.wizard.state.createStep = null;
    ctx.wizard.state.newCron = null;
    await ctx.editMessageText('❌ Vazifa yaratish bekor qilindi.');
    await ctx.scene.reenter();
});

// Toggle user assignment for new cron
cronScene.action('cron_new_assign_all', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.wizard.state.newCronAssigned = [];
    const allUsers = ctx.wizard.state.allUsers || [];
    const rows = [];
    rows.push([Markup.button.callback('✅ Barcha foydalanuvchilar', 'cron_new_assign_all')]);
    for (const user of allUsers) {
        rows.push([Markup.button.callback(`🔹 ${user.name}`, `cron_new_user_${user.id}`)]);
    }
    rows.push([
        Markup.button.callback('💾 Saqlash', 'cron_save_new'),
        Markup.button.callback('❌ Bekor qilish', 'cron_cancel_create')
    ]);
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(rows).reply_markup);
});

cronScene.action(/^cron_new_user_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.match[1];
    let assigned = ctx.wizard.state.newCronAssigned || [];

    if (assigned.length === 0) {
        const allUsers = ctx.wizard.state.allUsers || [];
        assigned = allUsers.map(u => u.id).filter(id => id !== userId);
    } else {
        const idx = assigned.indexOf(userId);
        if (idx === -1) assigned.push(userId);
        else assigned.splice(idx, 1);
    }
    ctx.wizard.state.newCronAssigned = assigned;

    const allUsers = ctx.wizard.state.allUsers || [];
    const isAll = assigned.length === 0;
    const rows = [];
    rows.push([Markup.button.callback(
        `${isAll ? '✅' : '☐'} Barcha foydalanuvchilar`,
        'cron_new_assign_all'
    )]);
    for (const user of allUsers) {
        const checked = isAll || assigned.includes(user.id);
        rows.push([Markup.button.callback(
            `${checked && !isAll ? '✅' : isAll ? '🔹' : '☐'} ${user.name}`,
            `cron_new_user_${user.id}`
        )]);
    }
    rows.push([
        Markup.button.callback('💾 Saqlash', 'cron_save_new'),
        Markup.button.callback('❌ Bekor qilish', 'cron_cancel_create')
    ]);
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(rows).reply_markup);
});

cronScene.action('cron_save_new', async (ctx) => {
    await ctx.answerCbQuery('💾 Saqlanmoqda...');
    const nc = ctx.wizard.state.newCron;
    const assigned = ctx.wizard.state.newCronAssigned || [];

    if (!nc || !nc.label || !nc.cronExpression || !nc.message) {
        await ctx.editMessageText('❌ Ma\'lumotlar to\'liq emas.');
        return ctx.scene.reenter();
    }

    try {
        await storage.addCustomCron(nc.label, nc.cronExpression, nc.message, assigned);
        await ctx.editMessageText(
            `✅ *Yangi cron vazifa yaratildi!*\n\n` +
            `📝 ${nc.label}\n` +
            `📅 \`${nc.cronExpression}\`\n` +
            `💬 ${nc.message}\n` +
            `👥 ${assigned.length === 0 ? 'Barcha foydalanuvchilar' : assigned.length + ' ta foydalanuvchi'}`,
            { parse_mode: 'Markdown' }
        );
        await triggerReload();
    } catch (e) {
        logger.error('cron_save_new error:', e);
        await ctx.editMessageText('❌ Vazifa yaratishda xatolik yuz berdi.');
    }

    ctx.wizard.state.createStep = null;
    ctx.wizard.state.newCron = null;
    return ctx.scene.leave();
});

// --- Delete custom cron ---
cronScene.action(/^cron_delete_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const jobKey = ctx.match[1];
    if (!jobKey.startsWith('custom_')) {
        await ctx.editMessageText('❌ Faqat maxsus vazifalarni o\'chirish mumkin.');
        return;
    }
    const settings = ctx.wizard.state.settings || {};
    const s = settings[jobKey] || {};
    const label = s.label || jobKey;

    await ctx.editMessageText(
        `⚠️ *${label}* vazifasini o'chirishga ishonchingiz komilmi?`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback("✅ Ha, o'chirish", `cron_confirm_del_${jobKey}`)],
                [Markup.button.callback('❌ Bekor qilish', `cron_detail_${jobKey}`)],
            ])
        }
    );
});

cronScene.action(/^cron_confirm_del_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const jobKey = ctx.match[1];
    try {
        await storage.deleteCustomCron(jobKey);
        const settings = ctx.wizard.state.settings || {};
        delete settings[jobKey];
        ctx.wizard.state.settings = settings;
        await ctx.editMessageText('✅ Vazifa muvaffaqiyatli o\'chirildi.');
        await triggerReload();
    } catch (e) {
        logger.error('cron_confirm_del error:', e);
        await ctx.editMessageText('❌ O\'chirishda xatolik yuz berdi.');
    }
    await ctx.scene.reenter();
});

// Show detail for a specific cron job
cronScene.action(/^cron_detail_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const jobKey = ctx.match[1];
    const settings = ctx.wizard.state.settings || {};
    const allUsers = ctx.wizard.state.allUsers || [];

    const txt = formatCronDetail(jobKey, settings, allUsers);
    await ctx.editMessageText(txt, {
        parse_mode: 'Markdown',
        ...buildCronDetailKeyboard(jobKey, settings, allUsers)
    });
});

// Toggle cron on/off
cronScene.action(/^cron_toggle_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const jobKey = ctx.match[1];
    const settings = ctx.wizard.state.settings || {};
    const s = settings[jobKey] || { enabled: true, assignedUsers: [] };
    const newEnabled = s.enabled === undefined ? false : !s.enabled;
    s.enabled = newEnabled;
    settings[jobKey] = s;
    ctx.wizard.state.settings = settings;

    try {
        await storage.updateCronSetting(jobKey, newEnabled);
        await triggerReload();
    } catch (e) {
        logger.error('cron_toggle error:', e);
    }

    const allUsers = ctx.wizard.state.allUsers || [];
    const txt = formatCronDetail(jobKey, settings, allUsers);
    await ctx.editMessageText(txt, {
        parse_mode: 'Markdown',
        ...buildCronDetailKeyboard(jobKey, settings, allUsers)
    });
});

// Show user assignment interface (exclude cron_assign_all_ prefix)
cronScene.action(/^cron_assign_(?!all_)(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const jobKey = ctx.match[1];
    const settings = ctx.wizard.state.settings || {};
    const s = settings[jobKey] || { enabled: true, assignedUsers: [] };
    const allUsers = ctx.wizard.state.allUsers || [];

    ctx.wizard.state.editingJob = jobKey;
    ctx.wizard.state.editingAssigned = [...s.assignedUsers];

    const isCustom = jobKey.startsWith('custom_');
    const label = isCustom ? (s.label || jobKey) : (storage.CRON_JOB_DEFAULTS.find(j => j.key === jobKey) || {}).label || jobKey;

    let txt = `👥 *${label}* — Foydalanuvchilarni tayinlash\n\n`;
    txt += '_Bildirishnoma olishi kerak bo\'lgan foydalanuvchilarni belgilang:_\n\n';
    if (s.assignedUsers.length === 0) {
        txt += '📌 Hozirda: *Barcha foydalanuvchilar*';
    } else {
        txt += `📌 Hozirda: *${s.assignedUsers.length} ta foydalanuvchi*`;
    }

    await ctx.editMessageText(txt, {
        parse_mode: 'Markdown',
        ...buildUserAssignKeyboard(jobKey, ctx.wizard.state.editingAssigned, allUsers)
    });
});

// Toggle "all users" for a cron job
cronScene.action(/^cron_assign_all_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const jobKey = ctx.match[1];
    ctx.wizard.state.editingAssigned = [];
    const allUsers = ctx.wizard.state.allUsers || [];
    await ctx.editMessageReplyMarkup(
        buildUserAssignKeyboard(jobKey, [], allUsers).reply_markup
    );
});

// Toggle individual user assignment
cronScene.action(/^cron_user__(.+)__(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const jobKey = ctx.match[1];
    const userId = ctx.match[2];
    // Validate that userId exists in wizard state users
    const allUsers = ctx.wizard.state.allUsers || [];
    if (!allUsers.some(u => String(u.id) === String(userId))) return;
    let assigned = ctx.wizard.state.editingAssigned || [];

    if (assigned.length === 0) {
        assigned = allUsers.map(u => u.id).filter(id => id !== userId);
    } else {
        const idx = assigned.indexOf(userId);
        if (idx === -1) assigned.push(userId);
        else assigned.splice(idx, 1);
    }

    ctx.wizard.state.editingAssigned = assigned;
    await ctx.editMessageReplyMarkup(
        buildUserAssignKeyboard(jobKey, assigned, allUsers).reply_markup
    );
});

// Save user assignments
cronScene.action(/^cron_save_assign_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('💾 Saqlanmoqda...');
    const jobKey = ctx.match[1];
    const assigned = ctx.wizard.state.editingAssigned || [];

    try {
        await storage.updateCronAssignedUsers(jobKey, assigned);
        const settings = ctx.wizard.state.settings || {};
        if (!settings[jobKey]) settings[jobKey] = { enabled: true, assignedUsers: [] };
        settings[jobKey].assignedUsers = assigned;
        ctx.wizard.state.settings = settings;
        await triggerReload();
    } catch (e) {
        logger.error('cron_save_assign error:', e);
    }

    const allUsers = ctx.wizard.state.allUsers || [];
    const settings = ctx.wizard.state.settings || {};
    const txt = formatCronDetail(jobKey, settings, allUsers);
    await ctx.editMessageText(txt, {
        parse_mode: 'Markdown',
        ...buildCronDetailKeyboard(jobKey, settings, allUsers)
    });
});

// Back to main cron list
cronScene.action('cron_back_main', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.reenter();
});

cronScene.action('cron_done', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('✅ Cron sozlamalari saqlandi.');
    return ctx.scene.leave();
});

module.exports = { cronScene, setBotRef };
