const { Scenes, Markup } = require('telegraf');
const { WizardScene } = Scenes;
const storage = require('./storage');
const logger = require('./logger');
const { t, getLang } = require('./i18n');
const { USER_SECTION_KEYS } = require('./constants');
require('dotenv').config();

const CEO_ID = process.env.CEO_TELEGRAM_ID;

/**
 * Check if the current user is the CEO (admin).
 * Only the CEO can add, edit, or delete users and their permissions.
 */
function isCeo(ctx) {
    const tgId = ctx.from ? ctx.from.id.toString() : null;
    return tgId === CEO_ID;
}

async function rejectNonCeo(ctx) {
    const lang = getLang(ctx);
    const msg = t(lang, 'users_only_admin');
    if (ctx.callbackQuery) {
        await ctx.answerCbQuery(msg, { show_alert: true });
    } else {
        await ctx.reply(msg);
    }
    return ctx.scene.leave();
}

function getAllSections(lang) {
    return [
        { key: 'lead', label: t(lang, 'users_section_lead') },
        { key: 'qarzdorlar', label: t(lang, 'users_section_debtors') },
        { key: 'rad_etilganlar', label: t(lang, 'users_section_rejections') },
        { key: 'moliya', label: t(lang, 'users_section_finance') },
        { key: 'davomat', label: t(lang, 'users_section_attendance') },
        { key: 'muammo', label: t(lang, 'users_section_problems') },
        { key: 'bosh_xonalar', label: t(lang, 'users_section_rooms') },
        { key: 'reports', label: t(lang, 'users_section_reports') },
        { key: 'foydalanuvchilar', label: t(lang, 'users_section_users') },
        { key: 'cron', label: t(lang, 'users_section_cron') },
        { key: 'bosh', label: t(lang, 'users_section_dashboard') },
        { key: 'tahlil', label: t(lang, 'users_section_analytics') },
    ];
}


const SECTION_EMOJI = {
    lead: '📈', qarzdorlar: '💸', rad_etilganlar: '❌', moliya: '💰',
    davomat: '📋', muammo: '⚠️', bosh_xonalar: '🏫', reports: '📊',
    foydalanuvchilar: '👥', cron: '⏰', bosh: '🏠', tahlil: '📉'
};

const LANG_LABELS = { uz: '🇺🇿 O\'zbekcha', ru: '🇷🇺 Русский' };

function buildSectionToggleKeyboard(selectedSections, lang, opts = {}) {
    const sections = getAllSections(lang);
    const rows = [];
    // Select All / Deselect All row
    const allSelected = sections.every(s => selectedSections.includes(s.key));
    rows.push([
        Markup.button.callback(allSelected ? t(lang, 'users_btn_deselect_all') : t(lang, 'users_btn_select_all'), 'toggle_all'),
    ]);
    for (let i = 0; i < sections.length; i += 2) {
        const row = [];
        const s1 = sections[i];
        const checked1 = selectedSections.includes(s1.key);
        row.push(Markup.button.callback(`${checked1 ? '✅' : '☐'} ${s1.label}`, `toggle_${s1.key}`));
        if (sections[i + 1]) {
            const s2 = sections[i + 1];
            const checked2 = selectedSections.includes(s2.key);
            row.push(Markup.button.callback(`${checked2 ? '✅' : '☐'} ${s2.label}`, `toggle_${s2.key}`));
        }
        rows.push(row);
    }
    rows.push([
        Markup.button.callback(t(lang, 'users_btn_save'), 'save_sections'),
        Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um'),
    ]);
    return Markup.inlineKeyboard(rows);
}

function formatUserCard(user, lang) {
    const sections = getAllSections(lang);
    const sectionBadges = (user.sections || []).map(s => {
        const emoji = SECTION_EMOJI[s] || '🔹';
        const sec = sections.find(a => a.key === s);
        return `${emoji} ${sec ? sec.label : s}`;
    });
    const sectionsText = sectionBadges.length > 0 ? sectionBadges.join('\n   ') : t(lang, 'users_no_sections');
    const langLabel = LANG_LABELS[user.lang] || LANG_LABELS.uz;
    
    return t(lang, 'users_card_title', { name: user.name }) + '\n' +
           t(lang, 'users_card_id', { id: user.id }) + '\n' +
           t(lang, 'users_card_lang', { lang: langLabel }) + '\n' +
           t(lang, 'users_card_sections', { count: (user.sections || []).length }) + '\n   ' +
           sectionsText;
}

// ─── Scene: List Users ───────────────────────────────────────────────────────
const usersListScene = new WizardScene('users_list',
    async (ctx) => {
        if (!isCeo(ctx)) return rejectNonCeo(ctx);
        const lang = getLang(ctx);
        ctx.wizard.state.lang = lang;
        try {
            const users = await storage.loadAuthorizedUsers();
            const list = Object.values(users);
            if (list.length === 0) {
                await ctx.reply(t(lang, 'users_empty'));
                return ctx.scene.leave();
            }

            let msg = t(lang, 'users_list_title', { count: list.length }) + '\n\n';
            const kb = [];

            list.forEach((u, i) => {
                const sectionCount = u.sections.length;
                const roleSummary = sectionCount > 0
                    ? u.sections.map(s => SECTION_EMOJI[s] || '🔹').join('')
                    : '—';
                const langFlag = u.lang === 'ru' ? '🇷🇺' : '🇺🇿';
                msg += `${i + 1}. *${u.name}*  ${langFlag} ${roleSummary}\n`;
                kb.push([Markup.button.callback(`👁 ${u.name}`, `view_user_${u.id}`)]);
            });

            msg += `\n` + t(lang, 'users_list_hint');
            kb.push([Markup.button.callback(t(lang, 'users_btn_close'), 'cancel_um')]);

            await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
            return ctx.wizard.next();
        } catch (e) {
            logger.error('users_list error:', e.stack);
            await ctx.reply(t(lang, 'error_sheets'));
            return ctx.scene.leave();
        }
    },
    async (ctx) => { /* handled by actions */ }
);

usersListScene.action(/^view_user_(.+)$/, async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const userId = ctx.match[1];
    try {
        const users = await storage.loadAuthorizedUsers();
        const user = users[userId];
        if (!user) {
            await ctx.editMessageText(t(lang, 'users_not_found'));
            return ctx.scene.leave();
        }
        const card = formatUserCard(user, lang);
        await ctx.editMessageText(card, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(t(lang, 'users_btn_edit'), `quick_edit_${userId}`),
                 Markup.button.callback(t(lang, 'users_btn_delete'), `quick_del_${userId}`)],
                [Markup.button.callback(t(lang, 'btn_back'), 'back_to_list')],
            ])
        });
    } catch (e) {
        logger.error('view_user error:', e);
        await ctx.editMessageText(t(lang, 'error_sheets'));
        return ctx.scene.leave();
    }
});

usersListScene.action(/^quick_edit_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    const userId = ctx.match[1];
    const users = await storage.loadAuthorizedUsers();
    const user = users[userId];
    if (!user) {
        await ctx.editMessageText(t(lang, 'users_not_found'));
        return ctx.scene.leave();
    }
    ctx.wizard.state.editUserId = userId;
    ctx.wizard.state.editUserName = user.name;
    ctx.wizard.state.selectedSections = [...user.sections];
    ctx.wizard.state.editLang = user.lang || 'uz';
    ctx.wizard.state.lang = lang;

    const langLabel = LANG_LABELS[user.lang] || LANG_LABELS.uz;
    await ctx.editMessageText(
        t(lang, 'users_edit_title', { name: user.name }),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(t(lang, 'users_btn_rename'), `rename_user_${userId}`)],
                [Markup.button.callback(t(lang, 'users_btn_change_sections'), `sections_user_${userId}`)],
                [Markup.button.callback(t(lang, 'users_btn_change_lang', { lang: langLabel }), `lang_user_${userId}`)],
                [Markup.button.callback(t(lang, 'btn_back'), `view_user_${userId}`)],
            ])
        }
    );
});

// Language toggle for user
usersListScene.action(/^lang_user_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    const userId = ctx.match[1];
    const users = await storage.loadAuthorizedUsers();
    const user = users[userId];
    if (!user) {
        await ctx.editMessageText(t(lang, 'users_not_found'));
        return ctx.scene.leave();
    }
    const currentLang = user.lang || 'uz';
    await ctx.editMessageText(
        t(lang, 'users_lang_title', { name: user.name, lang: LANG_LABELS[currentLang] }),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`${currentLang === 'uz' ? '🔘' : '⚪️'} 🇺🇿 O'zbekcha`, `set_user_lang_${userId}_uz`)],
                [Markup.button.callback(`${currentLang === 'ru' ? '🔘' : '⚪️'} 🇷🇺 Русский`, `set_user_lang_${userId}_ru`)],
                [Markup.button.callback(t(lang, 'btn_back'), `quick_edit_${userId}`)],
            ])
        }
    );
});

usersListScene.action(/^set_user_lang_(.+)_(uz|ru)$/, async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const userId = ctx.match[1];
    const newLang = ctx.match[2];
    try {
        await storage.updateUserLang(userId, newLang);
        if (ctx.refreshUsers) await ctx.refreshUsers();
        const users = await storage.loadAuthorizedUsers();
        const user = users[userId];
        if (user) {
            const card = formatUserCard(user, lang);
            const successNote = t(lang, 'users_lang_success', { lang: LANG_LABELS[newLang] });
            await ctx.editMessageText(successNote + '\n\n' + card, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(t(lang, 'users_btn_edit'), `quick_edit_${userId}`),
                     Markup.button.callback(t(lang, 'users_btn_delete'), `quick_del_${userId}`)],
                    [Markup.button.callback(t(lang, 'btn_back'), 'back_to_list')],
                ])
            });
        } else {
            await ctx.editMessageText(
                t(lang, 'users_lang_success', { lang: LANG_LABELS[newLang] }),
                { parse_mode: 'Markdown' }
            );
        }
    } catch (e) {
        logger.error('set_user_lang error:', e);
        await ctx.editMessageText(t(lang, 'error_sheets'));
    }
});

usersListScene.action(/^rename_user_(.+)$/, async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const userId = ctx.match[1];
    ctx.wizard.state.renameUserId = userId;
    ctx.wizard.state.awaitingRename = true;
    await ctx.editMessageText(
        t(lang, 'users_rename_prompt'),
        Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')]])
    );
});

usersListScene.action(/^sections_user_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    const userId = ctx.match[1];
    const users = await storage.loadAuthorizedUsers();
    const user = users[userId];
    if (!user) {
        const lang = getLang(ctx);
        await ctx.editMessageText(t(lang, 'users_not_found'));
        return ctx.scene.leave();
    }
    ctx.wizard.state.editUserId = userId;
    ctx.wizard.state.editUserName = user.name;
    ctx.wizard.state.selectedSections = [...user.sections];
    ctx.wizard.state.editLang = user.lang || 'uz';
    ctx.wizard.state.editMode = 'sections';
    const lang = ctx.wizard.state.lang || 'uz';
    await ctx.editMessageText(
        t(lang, 'users_sections_prompt', { name: user.name }),
        { parse_mode: 'Markdown', ...buildSectionToggleKeyboard(user.sections, lang) }
    );
});

usersListScene.action(/^quick_del_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    const userId = ctx.match[1];
    if (!/^\d+$/.test(userId)) {
        return ctx.scene.leave();
    }
    if (ctx.from && ctx.from.id.toString() === userId) {
        await ctx.editMessageText(t(lang, 'users_cannot_delete_self'));
        return ctx.scene.leave();
    }
    const users = await storage.loadAuthorizedUsers();
    const user = users[userId];
    if (!user) {
        await ctx.editMessageText(t(lang, 'users_not_found'));
        return ctx.scene.leave();
    }
    ctx.wizard.state.deleteUserId = userId;
    ctx.wizard.state.deleteUserName = user.name;
    await ctx.editMessageText(
        t(lang, 'users_delete_confirm', { name: user.name }),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(t(lang, 'users_btn_confirm_delete'), 'confirm_delete_user')],
                [Markup.button.callback(t(lang, 'btn_cancel'), `view_user_${userId}`)],
            ])
        }
    );
});

usersListScene.action('confirm_delete_user', async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const { deleteUserId, deleteUserName } = ctx.wizard.state;
    try {
        await storage.deleteUser(deleteUserId);
        await ctx.editMessageText(t(lang, 'users_delete_success', { name: deleteUserName }), { parse_mode: 'Markdown' });
        if (ctx.refreshUsers) await ctx.refreshUsers();
    } catch (e) {
        logger.error('user_delete error:', e);
        await ctx.editMessageText(t(lang, 'error_sheets'));
    }
    return ctx.scene.leave();
});

usersListScene.action('back_to_list', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.reenter();
});

// Select All / Deselect All
usersListScene.action('toggle_all', async (ctx) => {
    if (!isCeo(ctx)) { await ctx.answerCbQuery('Ruxsat yo\'q'); return; }
    await ctx.answerCbQuery();
    const lang = ctx.wizard.state.lang || 'uz';
    const sels = ctx.wizard.state.selectedSections || [];
    const allSelected = USER_SECTION_KEYS.every(s => sels.includes(s));
    ctx.wizard.state.selectedSections = allSelected ? [] : [...USER_SECTION_KEYS];
    await ctx.editMessageReplyMarkup(buildSectionToggleKeyboard(ctx.wizard.state.selectedSections, lang).reply_markup);
});

usersListScene.action(/^toggle_(.+)$/, async (ctx) => {
    if (!isCeo(ctx)) { await ctx.answerCbQuery('Ruxsat yo\'q'); return; }
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const lang = ctx.wizard.state.lang || 'uz';
    const sels = ctx.wizard.state.selectedSections || [];
    const idx = sels.indexOf(key);
    if (idx === -1) sels.push(key);
    else sels.splice(idx, 1);
    ctx.wizard.state.selectedSections = sels;
    await ctx.editMessageReplyMarkup(buildSectionToggleKeyboard(sels, lang).reply_markup);
});

usersListScene.action('save_sections', async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const { editUserId, editUserName, selectedSections, editLang } = ctx.wizard.state;
    try {
        await storage.updateUser(editUserId, editUserName, selectedSections || [], editLang || 'uz');
        await ctx.editMessageText(t(lang, 'users_updated_sections', { name: editUserName }), { parse_mode: 'Markdown' });
        if (ctx.refreshUsers) await ctx.refreshUsers();
    } catch (e) {
        logger.error('user_edit save error:', e);
        await ctx.editMessageText(t(lang, 'error_sheets'));
    }
    return ctx.scene.leave();
});

usersListScene.on('text', async (ctx) => {
    if (ctx.wizard.state.awaitingRename) {
        const lang = getLang(ctx);
        const newName = ctx.message.text.trim().substring(0, 50);
        if (!newName || newName.length < 2) {
            return ctx.reply(t(lang, 'users_rename_error_short'));
        }
        const userId = ctx.wizard.state.renameUserId;
        try {
            const users = await storage.loadAuthorizedUsers();
            const user = users[userId];
            if (!user) {
                await ctx.reply(t(lang, 'users_not_found'));
                return ctx.scene.leave();
            }
            await storage.updateUser(userId, newName, user.sections, user.lang || 'uz');
            await ctx.reply(t(lang, 'users_rename_success', { old: user.name, new: newName }), { parse_mode: 'Markdown' });
            if (ctx.refreshUsers) await ctx.refreshUsers();
        } catch (e) {
            logger.error('rename error:', e);
            await ctx.reply(t(lang, 'error_sheets'));
        }
        ctx.wizard.state.awaitingRename = false;
        return ctx.scene.leave();
    }
});

usersListScene.action('cancel_um', async (ctx) => {
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    await ctx.editMessageText(t(lang, 'cancelled'));
    return ctx.scene.leave();
});

// ─── Scene: Add User ─────────────────────────────────────────────────────────
const userAddScene = new WizardScene('user_add',
    async (ctx) => {
        if (!isCeo(ctx)) return rejectNonCeo(ctx);
        const lang = getLang(ctx);
        ctx.wizard.state.lang = lang;
        await ctx.reply(
            t(lang, 'users_add_id_prompt'),
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')]])
            }
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        const lang = ctx.wizard.state.lang || getLang(ctx);
        if (!ctx.message || !ctx.message.text) return;
        const input = ctx.message.text.trim();
        if (!/^\d+$/.test(input)) {
            return ctx.reply(t(lang, 'users_id_invalid'));
        }
        const existing = await storage.loadAuthorizedUsers();
        if (existing[input]) {
            return ctx.reply(t(lang, 'users_id_exists'));
        }
        ctx.wizard.state.telegramId = input;
        await ctx.reply(t(lang, 'users_add_name_prompt'), {
            ...Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')]])
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        const lang = ctx.wizard.state.lang || getLang(ctx);
        if (!ctx.message || !ctx.message.text) return;
        ctx.wizard.state.name = ctx.message.text.trim().substring(0, 50);
        if (ctx.wizard.state.name.length < 2) {
            return ctx.reply(t(lang, 'users_rename_error_short'));
        }
        // Ask for language
        ctx.wizard.state.newUserLang = 'uz';
        await ctx.reply(
            t(lang, 'users_add_lang_prompt', { name: ctx.wizard.state.name }),
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🇺🇿 O\'zbekcha', 'new_lang_uz'),
                    Markup.button.callback('🇷🇺 Русский', 'new_lang_ru')],
                    [Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')],
                ])
            }
        );
        return ctx.wizard.next();
    },
    async (ctx) => { /* handled by actions for lang selection */ }
);

// Language selection for new user
userAddScene.action(/^new_lang_(uz|ru)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const lang = ctx.wizard.state.lang || 'uz';
    ctx.wizard.state.newUserLang = ctx.match[1];
    ctx.wizard.state.selectedSections = [];
    await ctx.editMessageText(
        t(lang, 'users_sections_prompt', { name: ctx.wizard.state.name }),
        { parse_mode: 'Markdown', ...buildSectionToggleKeyboard([], lang) }
    );
});

userAddScene.action('toggle_all', async (ctx) => {
    if (!isCeo(ctx)) { await ctx.answerCbQuery('Ruxsat yo\'q'); return; }
    await ctx.answerCbQuery();
    const lang = ctx.wizard.state.lang || 'uz';
    const sels = ctx.wizard.state.selectedSections || [];
    const allSelected = USER_SECTION_KEYS.every(s => sels.includes(s));
    ctx.wizard.state.selectedSections = allSelected ? [] : [...USER_SECTION_KEYS];
    await ctx.editMessageReplyMarkup(buildSectionToggleKeyboard(ctx.wizard.state.selectedSections, lang).reply_markup);
});

userAddScene.action(/^toggle_(.+)$/, async (ctx) => {
    if (!isCeo(ctx)) { await ctx.answerCbQuery('Ruxsat yo\'q'); return; }
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const lang = ctx.wizard.state.lang || 'uz';
    const sels = ctx.wizard.state.selectedSections || [];
    const idx = sels.indexOf(key);
    if (idx === -1) sels.push(key);
    else sels.splice(idx, 1);
    ctx.wizard.state.selectedSections = sels;
    await ctx.editMessageReplyMarkup(buildSectionToggleKeyboard(sels, lang).reply_markup);
});

userAddScene.action('save_sections', async (ctx) => {
    if (!isCeo(ctx)) { await ctx.answerCbQuery('Ruxsat yo\'q'); return; }
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const { telegramId, name, selectedSections, newUserLang } = ctx.wizard.state;
    try {
        await storage.addUser(telegramId, name, selectedSections || [], newUserLang || 'uz');
        const langLabel = LANG_LABELS[newUserLang] || LANG_LABELS.uz;
        await ctx.editMessageText(
            t(lang, 'users_add_success', { name, id: telegramId, lang: langLabel, count: (selectedSections || []).length }),
            { parse_mode: 'Markdown' }
        );
        if (ctx.refreshUsers) await ctx.refreshUsers();
    } catch (e) {
        logger.error('user_add save error:', e);
        await ctx.editMessageText(t(lang, 'error_sheets'));
    }
    return ctx.scene.leave();
});

userAddScene.action('cancel_um', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(t(ctx.wizard.state.lang || 'uz', 'cancelled'));
    return ctx.scene.leave();
});

// ─── Scene: Edit User ────────────────────────────────────────────────────────
const userEditScene = new WizardScene('user_edit',
    async (ctx) => {
        if (!isCeo(ctx)) return rejectNonCeo(ctx);
        const lang = getLang(ctx);
        ctx.wizard.state.lang = lang;
        try {
            const users = await storage.loadAuthorizedUsers();
            const list = Object.values(users);
            if (list.length === 0) {
                await ctx.reply(t(lang, 'users_empty'));
                return ctx.scene.leave();
            }
            const kb = list.map(u => {
                const langFlag = u.lang === 'ru' ? '🇷🇺' : '🇺🇿';
                return [Markup.button.callback(`✏️ ${u.name} ${langFlag}`, `edit_user_${u.id}`)];
            });
            kb.push([Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')]);
            await ctx.reply(t(lang, 'users_edit_list_title'), Markup.inlineKeyboard(kb));
            return ctx.wizard.next();
        } catch (e) {
            logger.error('user_edit list error:', e);
            await ctx.reply(t(lang, 'error_sheets'));
            return ctx.scene.leave();
        }
    },
    async (ctx) => { /* handled by actions */ }
);

userEditScene.action(/^edit_user_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    const lang = getLang(ctx);
    const userId = ctx.match[1];
    const users = await storage.loadAuthorizedUsers();
    const user = users[userId];
    if (!user) {
        await ctx.editMessageText(t(lang, 'users_not_found'));
        return ctx.scene.leave();
    }
    ctx.wizard.state.editUserId = userId;
    ctx.wizard.state.editUserName = user.name;
    ctx.wizard.state.selectedSections = [...user.sections];
    ctx.wizard.state.editLang = user.lang || 'uz';

    const langLabel = LANG_LABELS[user.lang] || LANG_LABELS.uz;
    await ctx.editMessageText(
        t(lang, 'users_edit_options_title', { name: user.name }),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(t(lang, 'users_btn_rename'), `ue_rename_${userId}`)],
                [Markup.button.callback(t(lang, 'users_btn_change_sections'), `ue_sections_${userId}`)],
                [Markup.button.callback(t(lang, 'users_btn_change_lang', { lang: langLabel }), `ue_lang_${userId}`)],
                [Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')],
            ])
        }
    );
});

userEditScene.action(/^ue_lang_(.+)$/, async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const userId = ctx.match[1];
    const users = await storage.loadAuthorizedUsers();
    const user = users[userId];
    if (!user) {
        await ctx.editMessageText(t(lang, 'users_not_found'));
        return ctx.scene.leave();
    }
    const currentLang = user.lang || 'uz';
    await ctx.editMessageText(
        t(lang, 'users_lang_title', { name: user.name, lang: LANG_LABELS[currentLang] }),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`${currentLang === 'uz' ? '🔘' : '⚪️'} 🇺🇿 O'zbekcha`, `ue_setlang_${userId}_uz`)],
                [Markup.button.callback(`${currentLang === 'ru' ? '🔘' : '⚪️'} 🇷🇺 Русский`, `ue_setlang_${userId}_ru`)],
                [Markup.button.callback(t(lang, 'btn_back'), `edit_user_${userId}`)],
            ])
        }
    );
});

userEditScene.action(/^ue_setlang_(.+)_(uz|ru)$/, async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const userId = ctx.match[1];
    const newLang = ctx.match[2];
    try {
        await storage.updateUserLang(userId, newLang);
        if (ctx.refreshUsers) await ctx.refreshUsers();
        const users = await storage.loadAuthorizedUsers();
        const user = users[userId];
        if (user) {
            const langLabel = LANG_LABELS[user.lang] || LANG_LABELS.uz;
            await ctx.editMessageText(
                t(lang, 'users_lang_success', { lang: LANG_LABELS[newLang] }) + '\n\n' +
                t(lang, 'users_edit_options_title', { name: user.name }),
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback(t(lang, 'users_btn_rename'), `ue_rename_${userId}`)],
                        [Markup.button.callback(t(lang, 'users_btn_change_sections'), `ue_sections_${userId}`)],
                        [Markup.button.callback(t(lang, 'users_btn_change_lang', { lang: langLabel }), `ue_lang_${userId}`)],
                        [Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')],
                    ])
                }
            );
        } else {
            await ctx.editMessageText(t(lang, 'users_lang_success', { lang: LANG_LABELS[newLang] }), { parse_mode: 'Markdown' });
        }
    } catch (e) {
        logger.error('ue_setlang error:', e);
        await ctx.editMessageText(t(lang, 'error_sheets'));
    }
});

userEditScene.action(/^ue_rename_(.+)$/, async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    ctx.wizard.state.awaitingRename = true;
    ctx.wizard.state.renameUserId = ctx.match[1];
    await ctx.editMessageText(
        t(lang, 'users_rename_prompt'),
        Markup.inlineKeyboard([[Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')]])
    );
});

userEditScene.action(/^ue_sections_(.+)$/, async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const userId = ctx.match[1];
    const users = await storage.loadAuthorizedUsers();
    const user = users[userId];
    if (!user) {
        const lang = getLang(ctx);
        await ctx.editMessageText(t(lang, 'users_not_found'));
        return ctx.scene.leave();
    }
    ctx.wizard.state.editUserId = userId;
    ctx.wizard.state.editUserName = user.name;
    ctx.wizard.state.selectedSections = [...user.sections];
    const lang = ctx.wizard.state.lang || 'uz';
    await ctx.editMessageText(
        t(lang, 'users_sections_prompt', { name: user.name }),
        { parse_mode: 'Markdown', ...buildSectionToggleKeyboard(user.sections, lang) }
    );
});

userEditScene.action('toggle_all', async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = ctx.wizard.state.lang || 'uz';
    const sels = ctx.wizard.state.selectedSections || [];
    const allSelected = USER_SECTION_KEYS.every(s => sels.includes(s));
    ctx.wizard.state.selectedSections = allSelected ? [] : [...USER_SECTION_KEYS];
    await ctx.editMessageReplyMarkup(buildSectionToggleKeyboard(ctx.wizard.state.selectedSections, lang).reply_markup);
});

userEditScene.action(/^toggle_(.+)$/, async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const key = ctx.match[1];
    const lang = ctx.wizard.state.lang || 'uz';
    const sels = ctx.wizard.state.selectedSections || [];
    const idx = sels.indexOf(key);
    if (idx === -1) sels.push(key);
    else sels.splice(idx, 1);
    ctx.wizard.state.selectedSections = sels;
    await ctx.editMessageReplyMarkup(buildSectionToggleKeyboard(sels, lang).reply_markup);
});

userEditScene.action('save_sections', async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = ctx.wizard.state.lang || 'uz';
    const { editUserId, editUserName, selectedSections, editLang } = ctx.wizard.state;
    try {
        await storage.updateUser(editUserId, editUserName, selectedSections || [], editLang || 'uz');
        await ctx.editMessageText(t(lang, 'users_updated_sections', { name: editUserName }), { parse_mode: 'Markdown' });
        if (ctx.refreshUsers) await ctx.refreshUsers();
    } catch (e) {
        logger.error('user_edit save error:', e);
        await ctx.editMessageText(t(lang, 'error_sheets'));
    }
    return ctx.scene.leave();
});

userEditScene.on('text', async (ctx) => {
    if (ctx.wizard.state.awaitingRename) {
        const lang = getLang(ctx);
        const newName = ctx.message.text.trim().substring(0, 50);
        if (!newName || newName.length < 2) {
            return ctx.reply(t(lang, 'users_rename_error_length'));
        }
        const userId = ctx.wizard.state.renameUserId;
        try {
            const users = await storage.loadAuthorizedUsers();
            const user = users[userId];
            if (!user) {
                await ctx.reply(t(lang, 'users_not_found'));
                return ctx.scene.leave();
            }
            await storage.updateUser(userId, newName, user.sections, user.lang || 'uz');
            await ctx.reply(t(lang, 'users_rename_success', { old: user.name, new: newName }), { parse_mode: 'Markdown' });
            if (ctx.refreshUsers) await ctx.refreshUsers();
        } catch (e) {
            logger.error('rename error:', e);
            await ctx.reply(t(lang, 'users_error_general'));
        }
        ctx.wizard.state.awaitingRename = false;
        return ctx.scene.leave();
    }
});

userEditScene.action('cancel_um', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(t(ctx.wizard.state.lang || 'uz', 'cancelled'));
    return ctx.scene.leave();
});

// ─── Scene: Delete User ───────────────────────────────────────────────────────
const userDeleteScene = new WizardScene('user_delete',
    async (ctx) => {
        if (!isCeo(ctx)) return rejectNonCeo(ctx);
        const lang = getLang(ctx);
        ctx.wizard.state.lang = lang;
        try {
            const users = await storage.loadAuthorizedUsers();
            const list = Object.values(users);
            if (list.length === 0) {
                await ctx.reply(t(lang, 'users_empty'));
                return ctx.scene.leave();
            }
            const kb = list.map(u => [Markup.button.callback(
                `🗑 ${u.name} (${u.id})`, `del_user_${u.id}`
            )]);
            kb.push([Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')]);
            await ctx.reply(t(lang, 'users_select_delete'), Markup.inlineKeyboard(kb));
            return ctx.wizard.next();
        } catch (e) {
            logger.error('user_delete list error:', e);
            await ctx.reply(t(lang, 'error_sheets'));
            return ctx.scene.leave();
        }
    },
    async (ctx) => { /* handled by actions */ }
);

userDeleteScene.action(/^del_user_(.+)$/, async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const userId = ctx.match[1];

    if (ctx.from && ctx.from.id.toString() === userId) {
        await ctx.editMessageText(t(lang, 'users_cannot_delete_self'));
        return ctx.scene.leave();
    }

    const users = await storage.loadAuthorizedUsers();
    const user = users[userId];
    if (!user) {
        await ctx.editMessageText(t(lang, 'users_not_found'));
        return ctx.scene.leave();
    }
    ctx.wizard.state.deleteUserId = userId;
    ctx.wizard.state.deleteUserName = user.name;

    await ctx.editMessageText(
        t(lang, 'users_delete_confirm_extra', { name: user.name, id: userId, count: user.sections.length }),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(t(lang, 'users_btn_confirm_delete'), 'confirm_delete_user')],
                [Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_um')]
            ])
        }
    );
});

userDeleteScene.action('confirm_delete_user', async (ctx) => {
    if (!isCeo(ctx)) return rejectNonCeo(ctx);
    await ctx.answerCbQuery();
    const lang = getLang(ctx);
    const { deleteUserId, deleteUserName } = ctx.wizard.state;
    try {
        await storage.deleteUser(deleteUserId);
        await ctx.editMessageText(t(lang, 'users_delete_success', { name: deleteUserName }), { parse_mode: 'Markdown' });
        if (ctx.refreshUsers) await ctx.refreshUsers();
    } catch (e) {
        logger.error('user_delete error:', e);
        await ctx.editMessageText(t(lang, 'error_sheets'));
    }
    return ctx.scene.leave();
});

userDeleteScene.action('cancel_um', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(t(ctx.wizard.state.lang || 'uz', 'cancelled'));
    return ctx.scene.leave();
});

function buildUserManagementScenes() {
    return [usersListScene, userAddScene, userEditScene, userDeleteScene];
}

module.exports = { buildUserManagementScenes };
