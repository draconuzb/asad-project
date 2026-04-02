const { Telegraf, session, Markup, Scenes } = require("telegraf");
require("dotenv").config();

// Comprehensive startup validation
const { validateStartup } = require('./config-validator');
if (!validateStartup()) {
    process.exit(1);
}

// Initialize graceful shutdown handler EARLY
const { initShutdownHandlers, onShutdown } = require('./shutdown-handler');
initShutdownHandlers();

// Load scene builder
const { buildScenes } = require("./scenes");
const { getTashkentDateString, getTashkentNow, cleanText, escapeMarkdown } = require("./utils");
const { buildUserManagementScenes } = require('./user_management_scenes');
const { searchScene } = require('./search_scene');
// const { cronScene, setBotRef } = require('./cron_scene'); // Removed — cron managed via webapp
const notify = require('./notify');
const { t, getLang } = require('./i18n');
const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const logger = require('./logger');
const { scheduleCleanupTask } = require('./cleanup-utils');

// HTML escape helper to prevent injection in parse_mode: 'HTML' messages
function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}




const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
// C-06: Sanitized token for safe logging (never log full token)
const _tokenSafe = process.env.TELEGRAM_BOT_TOKEN ?
    process.env.TELEGRAM_BOT_TOKEN.substring(0, 5) + '***' : 'MISSING';
// setBotRef(bot); // cron_scene removed

// Global state for settings and users
// TODO: Consider moving to proper state management (Redis, etc.)
let CURRENT_SECTIONS = {};
let AUTHORIZED_USERS = {};
let stage;

// Managed interval references for cleanup on shutdown
let authRefreshInterval = null;
let cleanupTaskInterval = null;
let rateLimitCleanupInterval = null;

const { startCronJobs, registerUser, stopCronJobs } = require('./cron');

// Register cleanup callbacks
onShutdown(async () => {
    logger.info('Cleaning up bot resources...');

    // Stop cron jobs
    if (stopCronJobs) {
        try {
            await stopCronJobs();
            logger.info('✅ Cron jobs stopped');
        } catch (e) {
            logger.error('Failed to stop cron jobs:', e.message);
        }
    }

    // Clear intervals
    if (authRefreshInterval) {
        clearInterval(authRefreshInterval);
        logger.info('✅ Auth refresh interval cleared');
    }
    if (cleanupTaskInterval) {
        clearInterval(cleanupTaskInterval);
        logger.info('✅ Cleanup task interval cleared');
    }
    if (rateLimitCleanupInterval) {
        clearInterval(rateLimitCleanupInterval);
    }
    // Clear session cleanup interval
    const sessionStore = require('./session_store');
    if (sessionStore._cleanupInterval) {
        clearInterval(sessionStore._cleanupInterval);
        logger.info('✅ Rate limit cleanup interval cleared');
    }

    // Close bot
    try {
        await bot.stop('SIGTERM');
        logger.info('✅ Bot connection closed');
    } catch (e) {
        logger.warn('Bot stop error (may be normal):', e.message);
    }
});

// Global error handler with severity classification and CEO notification
bot.catch(async (err, ctx) => {
    const isCritical = err.message?.includes('database') || err.message?.includes('SQLITE');
    logger.error(`[BOT ERROR${isCritical ? ' CRITICAL' : ''}] ${err.message}`, err.stack);
    logger.error(`[BOT ERROR] Update type: ${ctx.updateType}, cb: ${ctx.callbackQuery ? ctx.callbackQuery.data : 'none'}`);
    if (isCritical) {
        try {
            const adminId = process.env.CEO_TELEGRAM_ID;
            if (adminId) await bot.telegram.sendMessage(adminId, '\u{1F6A8} Bot xatolik: ' + err.message.substring(0, 200));
        } catch(_) {}
    }
    if (ctx.callbackQuery) {
        ctx.answerCbQuery('Xatolik yuz berdi').catch(() => {});
    }
});


// Rate limiter: max 30 messages per user per 60 seconds
const _rateLimitMap = new Map();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60000;
bot.use(async (ctx, next) => {
    const userId = ctx.from ? ctx.from.id : null;
    if (!userId) return next();
    const now = Date.now();
    let entry = _rateLimitMap.get(userId);
    if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
        entry = { start: now, count: 1 };
        _rateLimitMap.set(userId, entry);
    } else {
        entry.count++;
    }
    if (entry.count > RATE_LIMIT_MAX) {
        return;
    }
    return next();
});

// Periodic sweep of stale rate-limit entries (every 5 minutes)
rateLimitCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [userId, entry] of _rateLimitMap) {
        if (now - entry.start > RATE_LIMIT_WINDOW) {
            _rateLimitMap.delete(userId);
        }
    }
}, 5 * 60 * 1000);

// Middleware 1: Patch editMessageText to ignore "message is not modified" errors
bot.use(async (ctx, next) => {
    if (ctx.editMessageText) {
        const originalEdit = ctx.editMessageText.bind(ctx);
        ctx.editMessageText = async (...args) => {
            try {
                return await originalEdit(...args);
            } catch (e) {
                if (e.description && e.description.includes('message is not modified')) {
                    // Safe to ignore, message is already exactly what we want
                    return;
                }
                throw e; // Rethrow actual errors
            }
        };
    }
    return next();
});

if (process.env.DEBUG) {
    bot.use(async (ctx, next) => {
        const updateType = ctx.updateType;
        const fromId = ctx.from ? ctx.from.id : 'unknown';
        const text = ctx.message ? ctx.message.text : (ctx.callbackQuery ? ctx.callbackQuery.data : 'n/a');

        logger.dlog('bot_debug.log', 'bot.js:middleware', `Update: type=${updateType}`, {
            from: fromId,
            text: text
        });

        logger.info(`[LOCAL-DEBUG] Update: type=${updateType}, from=${fromId}, text/data=${text}`);
        return next();
    });
}

// Middleware 2: Session — persisted in SQLite to survive bot restarts
const sqliteSessionStore = require('./session_store');
bot.use(session({ store: sqliteSessionStore }));

// --- Global Escape Middleware ---
// Force-leaves any scene if a main menu button or command is pressed
bot.use(async (ctx, next) => {
    if (ctx.message && ctx.message.text) {
        const text = ctx.message.text.trim();
        const lang = getLang(ctx);

        // 1. Commands
        const isCommand = text.startsWith('/') && ['/start', '/help', '/myid'].includes(text.split(' ')[0]);

        // 2. Main Menu Buttons
        const mainButtons = [
            'btn_add_lead', 'btn_debtors', 'btn_rejections', 'btn_finance',
            'btn_attendance', 'btn_problems', 'btn_rooms', 'btn_users',
            'btn_cron', 'btn_reports', 'btn_refresh', 'btn_uz', 'btn_ru'
        ];

        let isMenuButton = false;
        const cleanedInput = cleanText(text);
        for (const key of mainButtons) {
            const uz = cleanText(t('uz', key));
            const ru = cleanText(t('ru', key));
            if (cleanedInput === uz || cleanedInput === ru ||
                (key === 'btn_uz' && cleanedInput.includes(cleanText(t('uz', 'btn_uz')))) ||
                (key === 'btn_ru' && cleanedInput.includes(cleanText(t('ru', 'btn_ru'))))) {
                isMenuButton = true;
                break;
            }
        }

        if (isCommand || isMenuButton) {
            if (ctx.scene) {
                try { await ctx.scene.leave(); } catch (e) { }
            }
            if (ctx.session && ctx.session.__scenes) {
                ctx.session.__scenes = {}; // Fallback: clear stuck scene state after leave
            }
        }
    }
    return next();
});

// Inject refreshUsers helper into ctx so scenes can refresh AUTHORIZED_USERS
bot.use((ctx, next) => {
    ctx.refreshUsers = async () => {
        const fresh = await storage.loadAuthorizedUsers();
        if (fresh && Object.keys(fresh).length > 0) {
            const newMap = Object.assign({}, fresh);
            AUTHORIZED_USERS = newMap;
        }
    };
    return next();
});

// Middleware 2: Authentication (RBAC) & Auto-Refresh
bot.use(async (ctx, next) => {
    // Always allow /myid command
    if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/myid')) {
        return next();
    }

    const tgId = ctx.from ? ctx.from.id.toString() : null;
    if (!tgId) return;

    // Check if user is in authorized list (already loaded in memory)
    const user = AUTHORIZED_USERS[tgId];
    const lang = getLang(ctx);
    if (!user) {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery(t(lang, 'no_access'), { show_alert: true }).catch(() => {});
        } else {
            await ctx.reply(t(lang, 'no_access_admin'));
        }
        return;
    }

    ctx.state.user = user;
    if (!user.sections.includes('reports') && !(ctx.session && ctx.session._registered)) {
        if (ctx.session) ctx.session._registered = true;
        registerUser(ctx).catch(e => logger.error("Register user error:", e));
    }

    await next();
});

if (process.env.DEBUG) {
    bot.use((ctx, next) => {
        if (ctx.callbackQuery) {
            const sceneId = ctx.session?.__scenes?.current || 'none';
            logger.info(`[CB_DEBUG] action="${ctx.callbackQuery.data}" user=${ctx.from?.id} scene=${sceneId}`);
        }
        return next();
    });
}


// Stage middleware MUST come after session + auth, and BEFORE all hears/on handlers
// so that ctx.scene is available everywhere (including Yangilash handler)
let cachedStageMw = null;
let cachedStageRef = null;
bot.use((ctx, next) => {
    if (stage) {
        // Cache the middleware; regenerate only when stage instance changes
        if (cachedStageRef !== stage) {
            cachedStageMw = stage.middleware();
            cachedStageRef = stage;
        }
        return cachedStageMw(ctx, next);
    }
    return next();
});


/**
 * Section-based access control middleware
 * @param {string} sectionKey
 */
function protect(sectionKey) {
    return async (ctx, next) => {
        const user = ctx.state.user;
        if (!user || !user.sections.includes(sectionKey)) {
            const lang = getLang(ctx);
            const message = t(lang, 'no_action_access');
            if (ctx.callbackQuery) {
                return await ctx.answerCbQuery(message, { show_alert: true }).catch(() => { });
            }
            return await ctx.reply(message);
        }
        return next();
    };
}

let _authRefreshing = false;

// Periodic background refresh for authorized users (non-blocking)
authRefreshInterval = setInterval(async () => {
    if (_authRefreshing) return;
    _authRefreshing = true;
    try {
        const freshUsers = await storage.loadAuthorizedUsers();
        if (freshUsers && Object.keys(freshUsers).length > 0) {
            AUTHORIZED_USERS = Object.assign({}, freshUsers);
        }
    } catch (e) {
        logger.error("Background auth refresh failed:", e.message);
    } finally {
        _authRefreshing = false;
    }
}, 300000); // 5 minutes

// --- Refresh Logic (🔄 Yangilash) ---
bot.hears([t('uz', 'btn_refresh'), t('ru', 'btn_refresh')], async (ctx) => {
    if (ctx.session) ctx.session.__scenes = {};
    if (ctx.scene) await ctx.scene.leave();
    const user = ctx.state.user;
    const lang = getLang(ctx);
    await ctx.reply(t(lang, 'loading'));
    try {
        const freshUsers = await storage.loadAuthorizedUsers();
        if (freshUsers && Object.keys(freshUsers).length > 0) {
            AUTHORIZED_USERS = Object.assign({}, freshUsers);
        }
        await initDynamicSettings();
        const tgId = ctx.from ? ctx.from.id.toString() : null;
        const updatedUser = AUTHORIZED_USERS[tgId] || user;
        await ctx.reply(t(lang, 'refreshed'), buildMenu(updatedUser, lang));
    } catch (e) {
        logger.error("Refresh failed:", e);
        await ctx.reply(t(lang, 'refresh_error'));
    }
});

// --- Dynamic Menu & Description Builders ---

function buildMenu(user, lang) {
    // Simplified menu — all data entry via webapp, bot only for notifications & settings
    const rows = [
        [t(lang, 'btn_uz') + ' / ' + t(lang, 'btn_ru'), t(lang, 'btn_refresh')]
    ];
    return Markup.keyboard(rows).resize();
}

const SECTION_KEYS = ['lead', 'qarzdorlar', 'rad_etilganlar', 'moliya', 'davomat', 'muammo', 'bosh_xonalar', 'foydalanuvchilar', 'cron', 'reports'];


const SECTION_BTN_MAP = {
    lead: 'btn_add_lead', qarzdorlar: 'btn_debtors', rad_etilganlar: 'btn_rejections',
    moliya: 'btn_finance', davomat: 'btn_attendance', muammo: 'btn_problems',
    bosh_xonalar: 'btn_rooms', foydalanuvchilar: 'btn_users',
    cron: 'btn_cron', reports: 'btn_reports'
};


function buildDescription(user, lang) {
    let desc = t(lang, 'start_desc') + "\n\n";
    desc += "📱 *Web ilovani ochish uchun pastdagi Web tugmasini bosing.*\n\n";
    desc += "Barcha bo'limlar — ma'lumot kiritish, hisobotlar, tahlil va boshqaruv — web ilova orqali boshqariladi.\n\n";
    desc += "🔔 Bot orqali eslatmalar va bildirishnomalar keladi.";
    return desc;
}

// --- /start ---
bot.start(async (ctx) => {
    if (ctx.scene) await ctx.scene.leave(); // Reset any active scene

    // Auth context (safe because of middleware)
    const user = ctx.state.user;
    const lang = getLang(ctx);
    const menuToUse = buildMenu(user, lang);
    const descToUse = buildDescription(user, lang);

    await ctx.reply(
        t(lang, 'greeting', { name: escapeMarkdown(user.name || 'User') }) + "\n\n" +
        descToUse + `\n\n` +
        t(lang, 'choose_action'),
        { parse_mode: "Markdown", ...menuToUse }
    );
});

// --- /help ---
bot.help(async (ctx) => {
    const user = ctx.state.user;
    const lang = getLang(ctx);
    const descToUse = buildDescription(user, lang);

    await ctx.reply(
        t(lang, 'help_title') + "\n\n" +
        descToUse + `\n\n` +
        t(lang, 'commands_header') + "\n" +
        t(lang, 'cmd_start') + "\n" +
        t(lang, 'cmd_help') + "\n" +
        t(lang, 'cmd_myid'),
        { parse_mode: "Markdown" }
    );
});

// --- /myid ---
bot.command("myid", async (ctx) => {
    if (!ctx.from) return;
    const lang = getLang(ctx);
    await ctx.reply(
        t(lang, 'my_id_msg', { id: ctx.from.id }),
        { parse_mode: "Markdown" }
    );
});


bot.on('text', async (ctx, next) => {
    const text = ctx.message.text;
    const lang = getLang(ctx);

    // Helper for robust button matching (ignores variations like trailing spaces/metadata)
    const matches = (targetKey) => {
        const uz = cleanText(t('uz', targetKey));
        const ru = cleanText(t('ru', targetKey));
        const input = cleanText(text);
        const isMatch = input === uz || input === ru;
        if (isMatch) logger.info(`[MATCH] Text "${text}" matches key "${targetKey}"`);
        return isMatch;
    };

    // 1. Check for pass-through buttons that have dedicated handlers but need scene cleanup
    const passThroughKeys = [
        'rep_weekly', 'rep_monthly', 'btn_export',
        'btn_refresh', 'btn_uz', 'btn_ru'
    ];
    for (const key of passThroughKeys) {
        if (matches(key)) {
            if (ctx.scene) await ctx.scene.leave();
            return next();
        }
    }

    // 2. Direct Scene Shortcuts (for buttons that used to have separate bot.hears)
    if (matches('btn_cron')) {
        return await ctx.reply("📱 Cron sozlamalari endi Web ilova orqali boshqariladi.\n\nPastdagi *Web* tugmasini bosing.", { parse_mode: 'Markdown' });
    }
    if (matches('btn_search')) {
        return await ctx.reply("📱 Qidirish endi Web ilova orqali amalga oshiriladi.\n\nPastdagi *Web* tugmasini bosing.", { parse_mode: 'Markdown' });
    }
    if (matches('btn_reports')) {
        if (ctx.scene) await ctx.scene.leave();
        // Fall through to dedicated bot.hears handler for Reports menu
        return next();
    }

    // 3. Section Handling — Disabled, redirect to webapp
    const sectionKey = SECTION_KEYS.find(key => {
        const btnKey = SECTION_BTN_MAP[key] || `btn_${key}`;
        return matches(btnKey);
    });

    if (sectionKey) {
        if (ctx.scene) await ctx.scene.leave();
        return await ctx.reply("📱 Bu bo'lim endi Web ilova orqali boshqariladi.\n\nPastdagi *Web* tugmasini bosing.", { parse_mode: 'Markdown' });
    }

    // Legacy: keep these variables for any remaining code paths
    if (false) {
        const key = sectionKey;
        const sectionTitle = '';
        const section = {};
        const userSections = [];
        logger.info(`[SECTION] User ${ctx.from.id} accessing ${key}. Allowed: ${userSections.includes(key)}`);

        if (!userSections.includes(key)) {
            return await ctx.reply(t(lang, 'no_section_access'));
        }

        let holatiBtnText = t(lang, 'btn_status', { title: section.title });
        if (key === 'muammo') holatiBtnText = t(lang, 'btn_problems_list');
        else if (key === 'lead') holatiBtnText = t(lang, 'btn_leads_list');

        const kb = [
            [Markup.button.callback(holatiBtnText, `${key}_holati`)]
        ];

        if (key === 'lead') {
            kb.push([Markup.button.callback(t(lang, 'btn_add_new'), `lead_add`)]);
            kb.push([Markup.button.callback(t(lang, 'btn_remove_subtract'), `lead_del`)]);
            kb.push([
                Markup.button.callback(t(lang, 'btn_add_subject'), `lead_fan_qoshish`),
                Markup.button.callback(t(lang, 'btn_delete_subject'), `lead_fan_ochirish`)
            ]);
        } else if (key === 'rad_etilganlar') {
            kb.push([Markup.button.callback(t(lang, 'btn_add_new'), `${key}_add`)]);
            kb.push([Markup.button.callback(t(lang, 'btn_remove_subtract'), `${key}_del`)]);
            kb.push([
                Markup.button.callback(t(lang, 'btn_add_subject'), `lead_fan_qoshish`),
                Markup.button.callback(t(lang, 'btn_delete_subject'), `rad_fan_ochirish`)
            ]);
        } else if (key === 'moliya') {
            kb.push([Markup.button.callback('Norasmiy', `moliya_menu_norasmiy`)]);
            kb.push([Markup.button.callback('Rasmiy', `moliya_menu_rasmiy`)]);
        } else if (key === 'foydalanuvchilar') {
            kb.push([
                Markup.button.callback(t(lang, 'users_btn_add'), `user_menu_add`),
                Markup.button.callback(t(lang, 'users_btn_edit'), `user_menu_edit`)
            ]);
            kb.push([Markup.button.callback(t(lang, 'users_btn_delete'), `user_menu_delete`)]);
        } else {
            kb.push([Markup.button.callback(t(lang, 'btn_add_new'), `${key}_add`)]);
            if (key !== 'davomat') {
                kb.push([Markup.button.callback(t(lang, 'btn_remove_subtract'), `${key}_del`)]);
            }
        }

        return await ctx.reply(
            `📝 **${section.title}**\n\n` + t(lang, 'choose_action'),
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(kb)
            }
        );
    }

    await next();
});

// ─── Reports Section Handler ───
bot.hears([t('uz', 'btn_reports'), t('ru', 'btn_reports')], protect('reports'), async (ctx) => {
    if (ctx.scene) await ctx.scene.leave();
    const lang = getLang(ctx);
    await ctx.reply(
        t(lang, 'report_section_header'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(t(lang, 'rep_daily'), 'rep_daily'), Markup.button.callback(t(lang, 'rep_weekly'), 'rep_weekly')],
                [Markup.button.callback(t(lang, 'rep_monthly'), 'rep_monthly'), Markup.button.callback(t(lang, 'rep_umumiy'), 'rep_umumiy')],
                [Markup.button.callback(t(lang, 'rep_export'), 'rep_export'), Markup.button.callback('📊 Soliq', 'rep_tax')],
                [Markup.button.callback(t(lang, 'rep_back'), 'rep_back')]
            ])
        }
    );
});

// Reports sub-menu actions
bot.action('rep_daily', protect('reports'), async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('ceoDailyScene'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});
bot.action('rep_weekly', protect('reports'), async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('ceoWeeklyScene'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});
bot.action('rep_monthly', protect('reports'), async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('ceoMonthlyScene'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});
bot.action('rep_umumiy', protect('reports'), async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('ceoUmumiyScene'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});
bot.action('rep_export', protect('reports'), async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('ceoExportScene'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});
bot.action('rep_tax', protect('reports'), async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('ceoTaxScene'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('rep_back', protect('reports'), async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const lang = getLang(ctx);
    await ctx.editMessageText(t(lang, 'report_back_msg')).catch(e => logger.warn('editMessageText failed:', e.message));
});

// ─── User Management Action Handlers ───
bot.action(['user_menu_list', 'foydalanuvchilar_holati'], async (ctx) => {
    if (!checkSection(ctx, 'foydalanuvchilar')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('users_list'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});
bot.action('user_menu_add', async (ctx) => {
    if (!checkSection(ctx, 'foydalanuvchilar')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('user_add'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});
bot.action('user_menu_edit', async (ctx) => {
    if (!checkSection(ctx, 'foydalanuvchilar')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('user_edit'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});
bot.action('user_menu_delete', async (ctx) => {
    if (!checkSection(ctx, 'foydalanuvchilar')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('user_delete'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

// --- Section-based access control helper ---
function checkSection(ctx, sectionKey) {
    const user = ctx.state.user;
    const lang = getLang(ctx);
    if (!user || !user.sections.includes(sectionKey)) {
        const msg = t(lang, 'no_action_access');
        if (ctx.callbackQuery) {
            ctx.answerCbQuery(msg, { show_alert: true }).catch(() => { });
        } else {
            ctx.reply(msg).catch(e => logger.warn('checkSection reply failed:', e.message));
        }
        return false;
    }
    return true;
}

// --- Generic Action Handlers ---
// 1. Generic Add
bot.action('lead_fan_ochirish', async (ctx) => {
    if (!checkSection(ctx, 'lead')) return;
    await ctx.answerCbQuery().catch(() => {});
    try { await ctx.scene.enter('lead_fan_ochirish'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('rad_fan_ochirish', async (ctx) => {
    if (!checkSection(ctx, 'rad_etilganlar')) return;
    await ctx.answerCbQuery().catch(() => {});
    try { await ctx.scene.enter('rad_fan_ochirish'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('lead_fan_qoshish', async (ctx) => {
    const user = ctx.state.user;
    if (!user || (!user.sections.includes('lead') && !user.sections.includes('rad_etilganlar'))) {
        const lang = getLang(ctx);
        return ctx.answerCbQuery(t(lang, 'no_action_access'), { show_alert: true }).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
    try { await ctx.scene.enter('lead_fan_qoshish'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('xarajat_turi_qoshish', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => {});
    try { await ctx.scene.enter('xarajat_turi_qoshish'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('xarajat_turi_ochirish', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => {});
    try { await ctx.scene.enter('xarajat_turi_ochirish'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

// ─── Moliya Sub-menu Handlers ───
// NOTE (M-25): Known limitation — rasmiy/norasmiy sub-sections share the same 'moliya'
// permission key. There is no separate permission distinction for rasmiy vs norasmiy access.

// Helper: show main moliya menu inline message
async function showMoliyaMainMenu(ctx) {
    const lang = getLang(ctx);
    await ctx.editMessageText(
        t(lang, 'btn_finance') + "\n\n" + t(lang, 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Norasmiy', `moliya_menu_norasmiy`)],
                [Markup.button.callback('Rasmiy', `moliya_menu_rasmiy`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
}

// Norasmiy sub-menu
bot.action('moliya_menu_norasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(
        '**Norasmiy**\n\n' + t(lang, 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📥 Kirim', `moliya_nor_kirim`)],
                [Markup.button.callback('📤 Chiqim', `moliya_nor_chiqim`)],
                [Markup.button.callback('⚙️ Chiqim turlari', `moliya_nor_xarajat`)],
                [Markup.button.callback(t(lang, 'btn_back'), `moliya_back`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

bot.action('moliya_nor_kirim', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(
        '**Norasmiy — Kirim**\n\n' + t(lang, 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('+ Kirim qo\'shish', `moliya_kirim_norasmiy`)],
                [Markup.button.callback('Kirimni bekor qilish', `moliya_kirim_norasmiy_del`)],
                [Markup.button.callback(t(lang, 'btn_back'), `moliya_back_norasmiy`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

bot.action('moliya_nor_chiqim', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(
        '**Norasmiy — Chiqim**\n\n' + t(lang, 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Chiqim kiritish', `moliya_chiqim_norasmiy`)],
                [Markup.button.callback('Chiqimni bekor qilish', `moliya_chiqim_del_norasmiy`)],
                [Markup.button.callback(t(lang, 'btn_back'), `moliya_back_norasmiy`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

bot.action('moliya_nor_xarajat', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(
        '**Norasmiy — Chiqim turlari**\n\n' + t(lang, 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('+ Tur qo\'shish', `xarajat_turi_qoshish_norasmiy`)],
                [Markup.button.callback('Turni o\'chirish', `xarajat_turi_ochirish_norasmiy`)],
                [Markup.button.callback(t(lang, 'btn_back'), `moliya_back_norasmiy`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

bot.action('moliya_back_norasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    // Re-trigger the norasmiy sub-menu
    await ctx.editMessageText(
        '**Norasmiy**\n\n' + t(getLang(ctx), 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📥 Kirim', `moliya_nor_kirim`)],
                [Markup.button.callback('📤 Chiqim', `moliya_nor_chiqim`)],
                [Markup.button.callback('⚙️ Chiqim turlari', `moliya_nor_xarajat`)],
                [Markup.button.callback(t(getLang(ctx), 'btn_back'), `moliya_back`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

// Rasmiy sub-menu
bot.action('moliya_menu_rasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(
        '**Rasmiy**\n\n' + t(lang, 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📥 Kirim', `moliya_ras_kirim`)],
                [Markup.button.callback('📤 Chiqim', `moliya_ras_chiqim`)],
                [Markup.button.callback('⚙️ Chiqim turlari', `moliya_ras_xarajat`)],
                [Markup.button.callback(t(lang, 'btn_back'), `moliya_back`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

bot.action('moliya_ras_kirim', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(
        '**Rasmiy — Kirim**\n\n' + t(lang, 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('+ Kirim qo\'shish', `moliya_kirim_rasmiy`)],
                [Markup.button.callback('Kirimni bekor qilish', `moliya_kirim_rasmiy_del`)],
                [Markup.button.callback(t(lang, 'btn_back'), `moliya_back_rasmiy`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

bot.action('moliya_ras_chiqim', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(
        '**Rasmiy — Chiqim**\n\n' + t(lang, 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('Chiqim kiritish', `moliya_chiqim_rasmiy`)],
                [Markup.button.callback('Chiqimni bekor qilish', `moliya_chiqim_del_rasmiy`)],
                [Markup.button.callback(t(lang, 'btn_back'), `moliya_back_rasmiy`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

bot.action('moliya_ras_xarajat', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(
        '**Rasmiy — Chiqim turlari**\n\n' + t(lang, 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('+ Tur qo\'shish', `xarajat_turi_qoshish_rasmiy`)],
                [Markup.button.callback('Turni o\'chirish', `xarajat_turi_ochirish_rasmiy`)],
                [Markup.button.callback(t(lang, 'btn_back'), `moliya_back_rasmiy`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

bot.action('moliya_back_rasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(
        '**Rasmiy**\n\n' + t(getLang(ctx), 'choose_action'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📥 Kirim', `moliya_ras_kirim`)],
                [Markup.button.callback('📤 Chiqim', `moliya_ras_chiqim`)],
                [Markup.button.callback('⚙️ Chiqim turlari', `moliya_ras_xarajat`)],
                [Markup.button.callback(t(getLang(ctx), 'btn_back'), `moliya_back`)]
            ])
        }
    ).catch(e => logger.warn('editMessageText failed:', e.message));
});

bot.action('moliya_back', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    await showMoliyaMainMenu(ctx);
});

bot.action('moliya_kirim_rasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('moliya_kirim_rasmiy'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('moliya_kirim_norasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('moliya_kirim_norasmiy'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('moliya_kirim_rasmiy_del', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('moliya_kirim_rasmiy_del'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('moliya_kirim_norasmiy_del', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('moliya_kirim_norasmiy_del'); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('moliya_chiqim_rasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('moliya_chiqim_rasmiy', { financeCategory: 'cat_2' }); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('moliya_chiqim_norasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('moliya_chiqim_norasmiy', { financeCategory: 'cat_1' }); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

// Category-specific chiqim cancel (enters same scene but with category pre-set)
bot.action('moliya_chiqim_del_norasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('moliya_chiqim_del', { financeCategory: 'cat_1' }); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('moliya_chiqim_del_rasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('moliya_chiqim_del', { financeCategory: 'cat_2' }); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

// Category-specific expense type scenes (skip the category question)
bot.action('xarajat_turi_qoshish_norasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('xarajat_turi_qoshish', { presetCategory: 'cat_1' }); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('xarajat_turi_qoshish_rasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('xarajat_turi_qoshish', { presetCategory: 'cat_2' }); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('xarajat_turi_ochirish_norasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('xarajat_turi_ochirish', { presetCategory: 'cat_1' }); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action('xarajat_turi_ochirish_rasmiy', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    await ctx.answerCbQuery().catch(() => { });
    try { await ctx.scene.enter('xarajat_turi_ochirish', { presetCategory: 'cat_2' }); } catch(e) {
        logger.error('Scene enter failed:', e.message);
        await ctx.reply('Xatolik yuz berdi').catch(() => {});
    }
});

bot.action(/^(lead|qarzdorlar|rad_etilganlar|davomat|muammo|bosh_xonalar)_add$/, async (ctx, next) => {
    const key = ctx.match[1];
    if (!CURRENT_SECTIONS[key]) {
        await ctx.answerCbQuery('Section not configured').catch(() => {});
        return;
    }
    if (!checkSection(ctx, key)) return;
    await ctx.answerCbQuery().catch(() => { });
    try {
        await ctx.scene.enter(key);
    } catch (e) {
        logger.error(`Failed to enter scene "${key}":`, e.message);
        const lang = getLang(ctx);
        await ctx.reply(t(lang, 'error_general')).catch(() => {});
    }
});

// 2. Generic Delete
bot.action(/^(lead|qarzdorlar|rad_etilganlar|davomat|muammo|bosh_xonalar)_del$/, async (ctx, next) => {
    const key = ctx.match[1];
    const lang = getLang(ctx);
    if (!checkSection(ctx, key)) return;

    // Check mapping for delete scenes
    if (key === 'qarzdorlar') {
        await ctx.answerCbQuery().catch(() => { });
        try { await ctx.scene.enter('qarzdorlar_remove'); } catch(e) {
            logger.error('Scene enter failed:', e.message);
            await ctx.reply('Xatolik yuz berdi').catch(() => {});
        }
    } else if (key === 'rad_etilganlar') {
        await ctx.answerCbQuery().catch(() => { });
        try { await ctx.scene.enter('rad_remove'); } catch(e) {
            logger.error('Scene enter failed:', e.message);
            await ctx.reply('Xatolik yuz berdi').catch(() => {});
        }
    } else if (key === 'lead') {
        await ctx.answerCbQuery().catch(() => { });
        try { await ctx.scene.enter('lead_remove'); } catch(e) {
            logger.error('Scene enter failed:', e.message);
            await ctx.reply('Xatolik yuz berdi').catch(() => {});
        }
    } else if (key === 'bosh_xonalar') {
        await ctx.answerCbQuery().catch(() => { });
        try { await ctx.scene.enter('bosh_xonalar_delete'); } catch(e) {
            logger.error('Scene enter failed:', e.message);
            await ctx.reply('Xatolik yuz berdi').catch(() => {});
        }
    } else if (key === 'davomat') {
        await ctx.answerCbQuery().catch(() => { });
        try {
            const db = require('./db');
            const todayStr = getTashkentDateString();
            const userId = String(ctx.from.id);
            const row = db.prepare("SELECT id, timestamp, expected, attended FROM attendance WHERE date_ymd = ? AND manager_id = ?").get(todayStr, userId);
            if (!row) {
                return await ctx.editMessageText(t(lang, 'error_not_found') || "Bugungi davomat topilmadi.");
            }
            await ctx.editMessageText(
                `🗑 <b>Davomatni o'chirish</b>\n\n📅 ${todayStr}\n👥 Kelishi kerak: ${row.expected}\n✅ Keldi: ${row.attended}\n\nO'chirishni tasdiqlaysizmi?`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Ha, o\'chirish', `confirm_davomat_del_${row.id}`)],
                        [Markup.button.callback(t(lang, 'btn_cancel') || 'Bekor qilish', 'cancel_generic')]
                    ])
                }
            );
        } catch (e) {
            logger.error('davomat_del error:', e.message);
            await ctx.editMessageText(t(lang, 'error_general')).catch(e2 => logger.warn('editMessageText failed:', e2.message));
        }
    } else if (key === 'muammo') {
        await ctx.answerCbQuery().catch(() => { });
        // Show all problems with delete buttons
        try {
            const problems = await storage.getAllProblems('open');
            if (problems.length === 0) {
                return await ctx.editMessageText(t(lang, 'users_empty'));
            }
            let txt = `🗑 <b>` + t(lang, 'users_delete_btn').replace(/[🗑➕✏️]/g, '').trim() + `</b>\n` + t(lang, 'users_select_delete') + `\n\n`;
            const buttons = [];
            problems.forEach((p, i) => {
                const sectionTitles = ["Muammo qo'shish", "Yangi qo'shish", "Muammolar"];
                const cleanType = (p.type && !sectionTitles.includes(p.type)) ? p.type : 'Muammo';
                const shortIssue = p.issue ? (p.issue.length > 30 ? p.issue.substring(0, 30) + '...' : p.issue) : '';

                txt += `<b>${i + 1}.</b> [${escapeHtml(p.branch)}] ${escapeHtml(cleanType)}\n`;
                if (p.issue) txt += `   <i>${escapeHtml(p.issue)}</i>\n`;
                txt += `\n`;
                const btnLabel = shortIssue ? `🗑 ${i + 1}. ${p.branch} - ${shortIssue}` : `🗑 ${i + 1}. ${p.branch} - ${cleanType}`;
                buttons.push([Markup.button.callback(btnLabel, `delete_problem_${p.rowIndex}`)]);
            });
            buttons.push([Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_generic')]);
            await ctx.editMessageText(txt, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard(buttons)
            });
        } catch (e) {
            logger.error('Failed to display problem deletion menu:', e.message);
            await ctx.editMessageText(t(lang, 'error_general')).catch(e2 => logger.warn('editMessageText failed:', e2.message));
        }
    } else {
        await ctx.answerCbQuery(t(lang, 'no_action_access')).catch(() => { });
    }
});

// noop — used for visual section header buttons in menus
bot.action('noop', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
});

// 3. Generic Cancel
bot.action('cancel_generic', async (ctx) => {
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(t(lang, 'cancelled'));
});

// 4. Custom Holati Handlers
// We need to keep these explicit because they format different data structures
bot.action('lead_holati', async (ctx) => {
    if (!checkSection(ctx, 'lead')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(t(lang, 'syncing'));
    try {
        const allData = await storage.fetchAllData(null, null);
        const totals = allData.leads;
        const subjects = await storage.getAllSubjects();

        // Merge: ensure all Fanlar subjects appear, even with 0 leads
        const merged = {};
        for (const subj of subjects) {
            merged[subj] = totals[subj] || 0;
        }
        // Also include any subjects from Lead sheet that aren't in Fanlar
        for (const [subj, count] of Object.entries(totals)) {
            if (!(subj in merged)) {
                merged[subj] = count;
            }
        }

        if (Object.keys(merged).length === 0) {
            return await ctx.editMessageText(t(lang, 'error_not_found'));
        }

        let txt = t(lang, 'btn_leads_list') + `:\n\n`;
        let totalSum = 0;
        for (const [subject, count] of Object.entries(merged)) {
            const emoji = count > 0 ? '🔹' : '⚪️';
            txt += `${emoji} **${escapeMarkdown(subject)}**: ${count} ${t(lang, 'unit_ta')}\n`;
            totalSum += count;
        }
        txt += `\n` + t(lang, 'metric_leads_total', { count: totalSum });
        await ctx.editMessageText(txt, { parse_mode: 'Markdown' });
    } catch (e) {
        logger.error('Failed to load leads status:', e.message);
        await ctx.editMessageText(t(lang, 'error_general')).catch(e2 => logger.warn('editMessageText failed:', e2.message));
    }
});

bot.action('qarzdorlar_holati', async (ctx) => {
    if (!checkSection(ctx, 'qarzdorlar')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(t(lang, 'syncing'));
    try {
        const statsByMonth = await storage.getDebtorByMonth();
        const months = Object.keys(statsByMonth);

        if (months.length === 0) {
            return await ctx.editMessageText(t(lang, 'error_not_found'), { parse_mode: 'Markdown' });
        }

        let txt = t(lang, 'btn_debtors') + `:\n\n`;
        let totalDebtAmt = 0;
        let totalDebtCount = 0;

        for (const month of months) {
            const stats = statsByMonth[month];
            if (stats.count === 0 && stats.amount === 0) continue;

            txt += `📅 **${escapeMarkdown(month)}:**\n`;
            txt += `👥 ` + t(lang, 'users_list_title', { count: stats.count }) + `\n`;
            txt += `💸 ` + t(lang, 'metric_debtors_mtd', { count: stats.count, amount: stats.amount.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU') }) + `\n\n`;

            totalDebtCount += stats.count;
            totalDebtAmt += stats.amount;
        }

        if (totalDebtCount === 0) {
            return await ctx.editMessageText(t(lang, 'error_not_found'), { parse_mode: 'Markdown' });
        }

        txt += `\n` + t(lang, 'metric_debtors_total', { count: totalDebtCount, amount: totalDebtAmt.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU') });
        await ctx.editMessageText(txt, { parse_mode: 'Markdown' });
    } catch (e) {
        await ctx.editMessageText(t(lang, 'error_general')).catch(e2 => logger.warn('editMessageText failed:', e2.message));
    }
});

bot.action('bosh_xonalar_holati', async (ctx) => {
    if (!checkSection(ctx, 'bosh_xonalar')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(t(lang, 'syncing'));
    try {
        const rooms = await storage.getEmptyRooms();
        if (rooms.length === 0) {
            return await ctx.editMessageText(t(lang, 'error_not_found'));
        }

        // Group rooms by period
        const grouped = {
            'Tushlikgacha': [],
            'Tushlikdan keyin': [],
            "To'liq kun": [],
            "Boshqa": []
        };

        rooms.forEach(r => {
            if (grouped[r.period]) grouped[r.period].push(r);
            else grouped["Boshqa"].push(r);
        });

        let txt = t(lang, 'btn_status', { title: t(lang, 'btn_rooms') }) + `:\n\n`;

        const renderSection = (titleKey, list) => {
            if (list.length === 0) return '';
            let s = `📌 **${t(lang, titleKey)}**\n`;
            list.forEach((r, i) => {
                s += `${i + 1}. **${escapeMarkdown(r.branch)} ${t(lang, 'label_filial')}**, ${escapeMarkdown(r.room)}-${t(lang, 'label_room')} (${escapeMarkdown(r.days)} ${escapeMarkdown(r.time)})\n`;
            });
            return s + '\n';
        };

        txt += renderSection("label_period_morning", grouped["Tushlikgacha"]);
        txt += renderSection("label_period_afternoon", grouped["Tushlikdan keyin"]);
        txt += renderSection("label_period_full", grouped["To'liq kun"]);
        txt += renderSection("label_period_other", grouped["Boshqa"]);

        await ctx.editMessageText(txt, { parse_mode: 'Markdown' });
    } catch (e) {
        await ctx.editMessageText(t(lang, 'error_general')).catch(e2 => logger.warn('editMessageText failed:', e2.message));
    }
});

bot.action('rad_etilganlar_holati', async (ctx) => {
    if (!checkSection(ctx, 'rad_etilganlar')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(t(lang, 'syncing'));
    try {
        const totalsByMonth = await storage.getRejectionByMonth();
        const subjects = await storage.getAllSubjects();
        const months = Object.keys(totalsByMonth);

        // Merge subjects globally to ensure all subjects appear even if no data exists
        let txt = t(lang, 'btn_rejections') + `:\n\n`;
        let grandTotal = 0;

        if (months.length === 0) {
            // No data in sheet at all, just print subjects with 0
            if (subjects.length === 0) {
                return await ctx.editMessageText(t(lang, 'error_not_found'));
            }
            for (const subj of subjects) {
                txt += `⚪️ **${escapeMarkdown(subj)}**: 0 ${t(lang, 'unit_ta')}\n`;
            }
            txt += `\n` + t(lang, 'metric_rejections_total', { count: 0 });
            return await ctx.editMessageText(txt, { parse_mode: 'Markdown' });
        }

        txt = t(lang, 'btn_rejections') + `:\n\n`;

        for (const month of months) {
            const data = totalsByMonth[month];

            // Ensure all known subjects exist in this month's data
            for (const subj of subjects) {
                if (!(subj in data)) data[subj] = 0;
            }

            let monthlyTotal = 0;
            let monthTxt = `📅 **${escapeMarkdown(month)}:**\n`;
            for (const [subject, count] of Object.entries(data)) {
                const emoji = count > 0 ? '🔹' : '⚪️';
                monthTxt += `${emoji} **${escapeMarkdown(subject)}**: ${count} ${t(lang, 'unit_ta')}\n`;
                monthlyTotal += count;
                grandTotal += count;
            }
            txt += monthTxt + `❌ ` + t(lang, 'metric_rejections_mtd', { count: monthlyTotal }).replace(/📉\s*/, '') + ` (${escapeMarkdown(month)})\n\n`;
        }

        txt += t(lang, 'metric_rejections_total', { count: grandTotal });
        await ctx.editMessageText(txt, { parse_mode: 'Markdown' });
    } catch (e) {
        logger.error('Action handler error:', e);
        await ctx.editMessageText(t(lang, 'error_general'));
    }
});

bot.action('davomat_holati', async (ctx) => {
    if (!checkSection(ctx, 'davomat')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(t(lang, 'syncing'));
    try {
        const allData = await storage.fetchAllData(null, null);
        const stats = allData.attendance;

        let txt = t(lang, 'btn_status', { title: t(lang, 'btn_attendance') }) + `:\n\n`;

        const percent = stats.expected > 0 ? ((stats.attended / stats.expected) * 100).toFixed(1) : 0;
        txt += t(lang, 'metric_attendance_total', { percent: percent });

        await ctx.editMessageText(txt, { parse_mode: 'Markdown' });
    } catch (e) {
        logger.error('Action handler error:', e);
        await ctx.editMessageText(t(lang, 'error_general'));
    }
});

bot.action('moliya_holati', async (ctx) => {
    if (!checkSection(ctx, 'moliya')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(t(lang, 'syncing'));
    try {
        const { generateFinancialOverview } = require('./ceo_reports');
        const txt = await generateFinancialOverview(lang);
        await ctx.editMessageText(txt, { parse_mode: 'Markdown' });
    } catch (e) {
        logger.error('moliya_holati error:', e);
        await ctx.editMessageText(t(lang, 'error_general'));
    }
});

bot.action('muammo_holati', async (ctx) => {
    if (!checkSection(ctx, 'muammo')) return;
    const lang = getLang(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await ctx.editMessageText(t(lang, 'syncing'));
    try {
        const problems = await storage.getAllProblems('open');
        if (!problems || problems.length === 0) {
            return await ctx.editMessageText("✅ <b>" + t(lang, 'pdf_no_problems') + "</b>", { parse_mode: 'HTML' });
        }

        // Group problems by branch
        const byBranch = {};
        problems.forEach(p => {
            if (!byBranch[p.branch]) byBranch[p.branch] = [];
            byBranch[p.branch].push(p);
        });

        let txt = t(lang, 'btn_problems_list') + ` (Jami: ${problems.length})\n\n`;

        for (const [branch, branchProblems] of Object.entries(byBranch)) {
            txt += `🏢 <b>${escapeHtml(branch)} ` + t(lang, 'label_filial') + `</b> (${branchProblems.length} ${t(lang, 'unit_ta')}):\n`;
            branchProblems.forEach((p, i) => {
                // Extract date from timestamp (e.g., "28/02/2026, 23:12:34" -> "28/02")
                const dateShort = p.timestamp ? p.timestamp.split(',')[0].split('/').slice(0, 2).join('/') : '';
                // Sanitize type: if it equals a section title or is empty, use a generic label
                const sectionTitles = ["Muammo qo'shish", "Yangi qo'shish", "Muammolar"];
                const cleanType = (p.type && !sectionTitles.includes(p.type)) ? p.type : '';

                if (cleanType) {
                    txt += `  ${i + 1}. <b>${escapeHtml(cleanType)}</b>`;
                } else {
                    txt += `  ${i + 1}. <b>Muammo</b>`;
                }
                if (dateShort) txt += ` <i>(${dateShort})</i>`;
                txt += `\n`;
                if (p.issue) txt += `     💬 ${escapeHtml(p.issue)}\n`;
            });
            txt += `\n`;
        }

        await ctx.editMessageText(txt, { parse_mode: 'HTML' });
    } catch (e) {
        logger.error('Action handler error:', e);
        await ctx.editMessageText(t(lang, 'error_general'));
    }
});

// Handle davomat deletion confirmation
bot.action(/^confirm_davomat_del_(\d+)$/, async (ctx) => {
    if (!checkSection(ctx, 'davomat')) return;
    const lang = getLang(ctx);
    const rowId = parseInt(ctx.match[1]);
    if (isNaN(rowId) || rowId < 1) {
        return ctx.answerCbQuery('Invalid ID').catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
    try {
        const db = require('./db');
        const result = db.prepare('DELETE FROM attendance WHERE id = ? AND manager_id = ?').run(rowId, String(ctx.from.id));
        if (result.changes === 0) {
            return await ctx.editMessageText(t(lang, 'error_not_found') || 'Davomat topilmadi yoki sizga tegishli emas.');
        }
        await ctx.editMessageText('✅ Davomat muvaffaqiyatli o\'chirildi.').catch(e => logger.warn('Reply failed after successful write:', e.message));
    } catch (e) {
        logger.error('confirm_davomat_del error:', e.message);
        await ctx.editMessageText(t(lang, 'error_general')).catch(e2 => logger.warn('editMessageText failed:', e2.message));
    }
});

// Handle individual problem deletion
bot.action(/^delete_problem_(\d+)$/, async (ctx) => {
    if (!checkSection(ctx, 'muammo')) return;
    const lang = getLang(ctx);
    const rowIndex = parseInt(ctx.match[1]);
    if (isNaN(rowIndex) || rowIndex < 1) {
        return ctx.answerCbQuery('Invalid index').catch(() => {});
    }
    await ctx.answerCbQuery(t(lang, 'deleting')).catch(() => {});
    try {
        const success = await storage.deleteProblem(rowIndex);
        if (success) {
            await ctx.editMessageText(t(lang, 'users_deleted', { name: 'Muammo' })).catch(e => logger.warn('Reply failed after successful write:', e.message));
        } else {
            await ctx.editMessageText(t(lang, 'error_general'));
        }
    } catch (e) {
        logger.error('Action handler error:', e);
        await ctx.editMessageText(t(lang, 'error_general'));
    }
});



// --- Refresh Command ---
bot.command('refresh', protect('reports'), async (ctx) => {
    const lang = getLang(ctx);
    await ctx.reply(t(lang, 'loading'));
    try {
        await initDynamicSettings();
        const freshUsers = await storage.loadAuthorizedUsers();
        if (freshUsers && Object.keys(freshUsers).length > 0) {
            AUTHORIZED_USERS = Object.assign({}, freshUsers);
        }
        await ctx.reply(t(lang, 'refreshed') + "\n" + t(lang, 'cmd_start'));
    } catch (e) {
        logger.error("Refresh command error:", e);
        await ctx.reply(t(lang, 'refresh_error'));
    }
});

// --- CEO PDF Test Command ---
bot.command('sendpdf', protect('reports'), async (ctx) => {
    const lang = getLang(ctx);
    await ctx.reply(t(lang, 'loading'));

    let pdfPath = null;
    try {
        const { buildPdfData } = require('./ceo_reports');
        const { getYesterdayDisplay, getTashkentDateString } = require('./utils');
        const { generatePdfReport } = require('./pdf_generator');

        const tashkentNow = getTashkentNow();
        tashkentNow.setUTCDate(tashkentNow.getUTCDate() - 1);
        const yesterdayYmd = tashkentNow.getUTCFullYear() + '-' +
            String(tashkentNow.getUTCMonth() + 1).padStart(2, '0') + '-' +
            String(tashkentNow.getUTCDate()).padStart(2, '0');

        const yesterdayDate = getYesterdayDisplay();
        const reportData = await buildPdfData(yesterdayYmd, yesterdayYmd, yesterdayDate, lang);

        const safeDateStr = yesterdayYmd.replace(/[^a-zA-Z0-9-]/g, '_');
        pdfPath = path.join('/tmp', `report_${safeDateStr}_${Date.now()}.pdf`);
        await generatePdfReport(reportData, pdfPath, lang);

        const caption = t(lang, 'report_daily_title').replace(/\*/g, '') + ` (Test)\n📅 ` + t(lang, 'report_date_label', { date: yesterdayDate }) + `\n\nUshbu PDF test sifatida yuborilmoqda.`;
        const stream = fs.createReadStream(pdfPath);
        stream.on('error', () => {
            if (pdfPath) try { fs.unlinkSync(pdfPath); } catch (_) { }
        });
        await ctx.replyWithDocument({
            source: stream,
            filename: `NS_Report_${safeDateStr}.pdf`
        }, {
            caption: caption,
            parse_mode: 'Markdown'
        });

        try { fs.unlinkSync(pdfPath); } catch (_) { }
    } catch (e) {
        logger.error("SendPDF command error:", e);
        if (pdfPath) try { fs.unlinkSync(pdfPath); } catch (_) { }
        await ctx.reply(t(lang, 'error_general'));
    }
});

// --- Admin: Add Manager ---
bot.command('addmanager', protect('reports'), async (ctx) => {
    const lang = getLang(ctx);
    // Command format: /addmanager <ID> <Name>
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
        return await ctx.reply(t(lang, 'help_title') + ":\n`/addmanager 123456789 Ism` - " + t(lang, 'users_ask_id_short'), { parse_mode: 'Markdown' });
    }

    const newId = parts[1].trim();
    if (!/^\d{5,15}$/.test(newId)) {
        return await ctx.reply('Invalid ID. Telegram ID must be 5-15 digits.');
    }
    const name = parts.slice(2).join(' ').trim() || 'Manager';
    const existingUser = require('./db').prepare('SELECT telegram_id, name FROM users WHERE telegram_id = ?').get(newId);
    if (existingUser) {
        return await ctx.reply(`⚠️ Bu ID allaqachon mavjud: ${existingUser.name} (${newId})`);
    }
    const defaultSections = ['lead', 'qarzdorlar', 'rad_etilganlar', 'moliya', 'davomat', 'muammo', 'bosh_xonalar'];
    try {
        await storage.addUser(newId, name, defaultSections, 'uz');
        // Refresh in-memory users
        const freshUsers = await storage.loadAuthorizedUsers();
        if (freshUsers && Object.keys(freshUsers).length > 0) {
            AUTHORIZED_USERS = Object.assign({}, freshUsers);
        }
        await ctx.reply(`✅ Foydalanuvchi qo'shildi!\n\n🆔 ID: \`${newId}\`\n👤 Ism: ${escapeMarkdown(name)}\n📋 Bo'limlar: ${defaultSections.join(', ')}\n\nBo'limlarni o'zgartirish uchun 👥 Foydalanuvchilar bo'limiga kiring.`, { parse_mode: 'Markdown' }).catch(e => logger.warn('Reply failed after successful write:', e.message));
    } catch (e) {
        logger.error('addmanager error:', e.message);
        await ctx.reply(t(lang, 'error_general'));
    }
});


// --- Language Toggle ---
bot.hears([t('uz', 'btn_uz') + ' / ' + t('uz', 'btn_ru'), t('ru', 'btn_uz') + ' / ' + t('ru', 'btn_ru')], async (ctx) => {
    if (ctx.scene) await ctx.scene.leave();
    const lang = getLang(ctx);
    await ctx.reply(t(lang, 'lang_choose'), Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn_uz'), 'set_lang_uz'), Markup.button.callback(t(lang, 'btn_ru'), 'set_lang_ru')]
    ]));
});

bot.command('language', async (ctx) => {
    const lang = getLang(ctx);
    await ctx.reply(t(lang, 'lang_choose'), Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn_uz'), 'set_lang_uz'), Markup.button.callback(t(lang, 'btn_ru'), 'set_lang_ru')]
    ]));
});

bot.action('set_lang_uz', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = ctx.state.user;
    try {
        await storage.updateUserLang(user.id, 'uz');
        user.lang = 'uz';
    } catch (e) {
        logger.error('Storage op failed:', e.message);
    }
    await ctx.editMessageText(t('uz', 'lang_changed')).catch(e => logger.warn('Reply failed after successful write:', e.message));
});

bot.action('set_lang_ru', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = ctx.state.user;
    try {
        await storage.updateUserLang(user.id, 'ru');
        user.lang = 'ru';
    } catch (e) {
        logger.error('Storage op failed:', e.message);
    }
    await ctx.editMessageText(t('ru', 'lang_changed')).catch(e => logger.warn('Reply failed after successful write:', e.message));
});

bot.hears([t('uz', 'btn_back'), t('ru', 'btn_back')], async (ctx) => {
    const user = ctx.state.user;
    const lang = getLang(ctx);
    await ctx.reply(t(lang, 'choose_action'), buildMenu(user, lang));
});



// --- Startup ---
async function initDynamicSettings() {
    logger.info("Fetching dynamic settings from SQLite...");
    const sections = await storage.loadDynamicSettings();
    if (!sections) {
        throw new Error("Could not load settings! Is the settings table empty?");
    }

    // Merge hardcoded scenes from questions.js that are missing from dynamic settings.
    // 'moliya' is kept so the text handler recognises "💰 Moliya bo'limi" and shows the
    // kirim/chiqim sub-menu. The individual moliya_kirim/chiqim scenes are added so that
    // ctx.scene.enter('moliya_kirim') etc. actually work.
    const { SECTIONS: HARDCODED } = require('./questions');
    const MERGE_KEYS = ['moliya_kirim', 'moliya_kirim_rasmiy', 'moliya_kirim_norasmiy', 'moliya_kirim_del', 'moliya_kirim_rasmiy_del', 'moliya_kirim_norasmiy_del', 'moliya_chiqim', 'moliya_chiqim_rasmiy', 'moliya_chiqim_norasmiy', 'moliya_chiqim_del', 'davomat', 'bosh_xonalar'];
    for (const key of MERGE_KEYS) {
        if (HARDCODED[key]) sections[key] = HARDCODED[key];
    }

    CURRENT_SECTIONS = sections;
    logger.info("Settings loaded. Generating scenes...");

    // Build scenes from settings
    const scenes = buildScenes(CURRENT_SECTIONS);

    // Build CEO scenes
    const { buildCeoScenes } = require('./ceo_scenes');
    const ceoScenes = buildCeoScenes();

    const userMgmtScenes = buildUserManagementScenes();
    const allScenes = [...scenes, ...ceoScenes, ...userMgmtScenes, searchScene];

    // We must re-create the stage
    stage = new Scenes.Stage(allScenes);
}

async function start() {
    logger.info("🚀 NS Manager Bot starting...");

    // Check essential ENV variables
    const requiredEnv = ['TELEGRAM_BOT_TOKEN', 'CEO_TELEGRAM_ID'];
    const missingEnv = requiredEnv.filter(k => !process.env[k]);
    if (missingEnv.length > 0) {
        logger.error("❌ CRITICAL ERROR: Missing environment variables:", missingEnv.join(', '));
        process.exit(1);
    }

    try {
        const freshUsers = await storage.loadAuthorizedUsers();
        // H-08: Seed CEO from env if no users exist (first-run bootstrap)
        if (!freshUsers || Object.keys(freshUsers).length === 0) {
            const ceoId = process.env.CEO_TELEGRAM_ID;
            if (ceoId) {
                logger.warn('No users found — seeding CEO from CEO_TELEGRAM_ID');
                const db = require('./db');
                db.prepare("INSERT OR IGNORE INTO users (telegram_id, name, role, sec_lead, sec_qarzdorlar, sec_rad_etilganlar, sec_moliya, sec_davomat, sec_muammo, sec_bosh_xonalar, sec_reports, sec_foydalanuvchilar, sec_cron, sec_bosh, sec_tahlil) VALUES (?, 'CEO', 'ceo', 1,1,1,1,1,1,1,1,1,1,1,1)").run(ceoId);
                const seeded = await storage.loadAuthorizedUsers();
                if (seeded && Object.keys(seeded).length > 0) {
                    AUTHORIZED_USERS = Object.assign({}, seeded);
                } else {
                    logger.error('CRITICAL: Failed to seed CEO user. Exiting.');
                    process.exit(1);
                }
            } else {
                logger.error('CRITICAL: No authorized users and no CEO_TELEGRAM_ID set. Exiting.');
                process.exit(1);
            }
        } else {
            AUTHORIZED_USERS = Object.assign({}, freshUsers);
        }
        await initDynamicSettings();

        // Init notification system
        notify.init(bot, () => AUTHORIZED_USERS);

        startCronJobs(bot);
        cleanupTaskInterval = scheduleCleanupTask();



        // --- Daily DB backup at 3 AM Tashkent time ---
        const cronSync = require('node-cron');
        const dbBackupDir = path.join(__dirname, 'data', 'backups');
        cronSync.schedule('0 3 * * *', () => {
            try {
                if (!fs.existsSync(dbBackupDir)) fs.mkdirSync(dbBackupDir, { recursive: true });
                const dateStr = getTashkentDateString();
                const backupPath = path.join(dbBackupDir, `bot_${dateStr}.db`);
                const srcDb = require('./db');
                srcDb.backup(backupPath).then(() => {
                    logger.info(`[BACKUP] DB backed up to ${backupPath}`);
                    // Remove backups older than 7 days
                    const files = fs.readdirSync(dbBackupDir).filter(f => f.endsWith('.db'));
                    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
                    for (const f of files) {
                        try {
                            const fp = path.join(dbBackupDir, f);
                            if (fs.statSync(fp).mtimeMs < cutoff) {
                                fs.unlinkSync(fp);
                                logger.info(`[BACKUP] Removed old backup: ${f}`);
                            }
                        } catch (unlinkErr) {
                            logger.error(`[BACKUP] Failed to remove ${f}:`, unlinkErr.message);
                        }
                    }
                }).catch(e => logger.error('[BACKUP] Failed:', e.message));
            } catch (e) {
                logger.error('[BACKUP] Error:', e.message);
            }
        }, { scheduled: true, timezone: 'Asia/Tashkent' });
        logger.info('Daily DB backup cron registered (3 AM Tashkent).');

        // --- TWA Express API Server ---
        try {
            const { createTwaApi } = require('./twa_api');
            const twaApp = createTwaApi(bot, process.env.TELEGRAM_BOT_TOKEN, () => AUTHORIZED_USERS, (newUsers) => { AUTHORIZED_USERS = newUsers; });

            // Listen on $IP:$PORT for alwaysdata's user_program proxy
            if (process.env.IP && process.env.PORT) {
                const tcpServer = twaApp.listen(parseInt(process.env.PORT), process.env.IP, () => {
                    logger.info(`🌐 TWA API listening on ${process.env.IP}:${process.env.PORT}`);
                });
                tcpServer.on('error', (err) => { logger.error('TWA API TCP error:', err.message); });
                onShutdown(async () => { tcpServer.close(); logger.info('TWA API TCP server closed'); });
            }

            // Also listen on Unix socket as fallback
            const TWA_SOCKET = require('os').homedir() + '/www/twa/twa_api.sock';
            try { fs.unlinkSync(TWA_SOCKET); } catch {}
            const sockServer = twaApp.listen(TWA_SOCKET, () => {
                fs.chmodSync(TWA_SOCKET, 0o660);
                logger.info(`🌐 TWA API socket at ${TWA_SOCKET}`);
            });
            sockServer.on('error', (err) => {
                logger.error('TWA API socket error:', err.message);
            });
            onShutdown(async () => { sockServer.close(); logger.info('TWA API socket server closed'); });
        } catch (e) {
            logger.error('TWA API server failed to start:', e.message);
        }

        // Retry bot.launch() on 409 conflict (stale polling session)
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await bot.launch();
                logger.info("🤖 Bot is running! (Polling started)");
                break;
            } catch (launchErr) {
                if (launchErr.response?.error_code === 409 && attempt < 5) {
                    logger.warn(`⚠️ Telegram 409 conflict (attempt ${attempt}/5), retrying in 10s...`);
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    throw launchErr;
                }
            }
        }

        // Set the bot's menu button to open the WebApp
        const webAppUrl = process.env.WEB_APP_URL || 'https://edup.alwaysdata.net/twa/';
        try {
            await bot.telegram.setChatMenuButton({
                menu_button: {
                    type: 'web_app',
                    text: '📊 Dashboard',
                    web_app: { url: webAppUrl }
                }
            });
            logger.info(`📱 Menu button set to WebApp: ${webAppUrl}`);
        } catch (e) {
            logger.warn('Failed to set menu button:', e.message);
        }
    } catch (e) {
        logger.error("Critical Start Error:", e);
        process.exit(1);
    }
}

start();



