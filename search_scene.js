const { Scenes, Markup } = require('telegraf');
const { WizardScene } = Scenes;
const storage = require('./storage');
const logger = require('./logger');
const { getLast6Months, getTashkentNow } = require('./utils');
const { t, getLang } = require('./i18n');

const SEARCHABLE_SECTIONS = [
    { key: 'lead',           label: '📈 Lead' },
    { key: 'qarzdorlar',     label: '💸 Qarzdorlar' },
    { key: 'rad_etilganlar', label: '❌ Rad etilganlar' },
    { key: 'moliya',         label: '💰 Moliya' },
    { key: 'davomat',        label: '📋 Davomat' },
    { key: 'muammo',         label: '⚠️ Muammolar' },
];

async function buildSearchResult(sectionKey, monthLabel, allData) {
    const lines = [];

    if (sectionKey === 'lead' || sectionKey === 'all') {
        const leads = allData.leads || {};
        const total = allData.leadsTotal || 0;
        if (total > 0) {
            lines.push(`📈 *Lead bo'limi:*`);
            for (const [subj, cnt] of Object.entries(leads)) {
                lines.push(`  🔹 ${subj}: ${cnt} ta`);
            }
            lines.push(`  📊 Jami: *${total} ta*\n`);
        }
    }

    if (sectionKey === 'qarzdorlar' || sectionKey === 'all') {
        const d = allData.debtors || {};
        if (d.count > 0) {
            lines.push(`💸 *Qarzdorlar:*`);
            lines.push(`  👥 Soni: *${d.count} ta*`);
            lines.push(`  💰 Jami qarz: *${(d.amount || 0).toLocaleString('uz-UZ')} so'm*\n`);
        }
    }

    if (sectionKey === 'rad_etilganlar' || sectionKey === 'all') {
        const rejs = allData.rejections || {};
        const total = allData.rejectionsTotal || 0;
        if (total > 0) {
            lines.push(`❌ *Rad etilganlar:*`);
            for (const [subj, cnt] of Object.entries(rejs)) {
                lines.push(`  🔹 ${subj}: ${cnt} ta`);
            }
            lines.push(`  📊 Jami: *${total} ta*\n`);
        }
    }

    if (sectionKey === 'moliya' || sectionKey === 'all') {
        const f = allData.finance || {};
        if ((f.income || 0) > 0 || (f.expense || 0) > 0) {
            lines.push(`💰 *Moliya:*`);
            lines.push(`  📥 Kirim: *${(f.income || 0).toLocaleString('uz-UZ')} so'm*`);
            lines.push(`  📤 Chiqim: *${(f.expense || 0).toLocaleString('uz-UZ')} so'm*`);
            lines.push(`  💵 Qoldiq: *${((f.income || 0) - (f.expense || 0)).toLocaleString('uz-UZ')} so'm*\n`);
        }
    }

    if (sectionKey === 'davomat' || sectionKey === 'all') {
        const att = allData.attendance || {};
        if ((att.expected || 0) > 0) {
            const pct = att.expected > 0 ? Math.round((att.attended / att.expected) * 100) : 0;
            lines.push(`📋 *Davomat:*`);
            lines.push(`  👥 Kutilgan: ${att.expected}`);
            lines.push(`  ✅ Kelgan: ${att.attended}`);
            lines.push(`  📉 Davomat: *${pct}%*\n`);
        }
    }

    if (sectionKey === 'muammo' || sectionKey === 'all') {
        const problems = allData.problems || [];
        if (problems.length > 0) {
            lines.push(`⚠️ *Muammolar (${problems.length} ta):*`);
            problems.slice(0, 5).forEach((p, i) => {
                lines.push(`  ${i + 1}. [${p.branch}] ${p.type || ''} — ${(p.issue || '').substring(0, 40)}`);
            });
            if (problems.length > 5) lines.push(`  ...va yana ${problems.length - 5} ta\n`);
            else lines.push('');
        }
    }

    return lines.length > 0 ? lines.join('\n') : null;
}

const searchScene = new WizardScene('search_scene',
    // Step 0: Choose section
    async (ctx) => {
        const lang = getLang(ctx);
        ctx.wizard.state.lang = lang;
        const userSections = ctx.state.user ? ctx.state.user.sections : [];

        const available = SEARCHABLE_SECTIONS.filter(s =>
            userSections.includes(s.key) || userSections.includes('reports')
        );

        const kb = available.map(s => [Markup.button.callback(s.label, `search_sec_${s.key}`)]);
        if (userSections.includes('reports')) {
            kb.unshift([Markup.button.callback(t(lang, 'search_all'), 'search_sec_all')]);
        }
        kb.push([Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_search')]);

        await ctx.reply(t(lang, 'search_section_prompt'), Markup.inlineKeyboard(kb));
        return ctx.wizard.next();
    },
    // Step 1: Choose month
    async (ctx) => {
        // Handled by action
    },
    // Step 2: Show results
    async (ctx) => {
        // Handled by action
    }
);

searchScene.action(/^search_sec_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const lang = ctx.wizard.state.lang || 'uz';
    ctx.wizard.state.sectionKey = ctx.match[1];
    ctx.wizard.selectStep(1);

    const months = getLast6Months(lang);
    const now = getTashkentNow();
    const kb = months.map((m, i) => {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
        return [Markup.button.callback(m, `search_month_${key}__${m.replace(/\s/g, '_')}`)];
    });
    kb.push([Markup.button.callback(t(lang, 'btn_cancel'), 'cancel_search')]);

    await ctx.editMessageText(t(lang, 'search_month_prompt'), Markup.inlineKeyboard(kb));
});

searchScene.action(/^search_month_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const lang = ctx.wizard.state.lang || 'uz';
    const raw = ctx.match[1];
    // New format: YYYY-MM__Label or legacy: Label
    let monthLabel, targetYear, targetMonth;
    const keyMatch = raw.match(/^(\d{4})-(\d{2})__(.+)$/);
    if (keyMatch) {
        targetYear = parseInt(keyMatch[1]);
        targetMonth = parseInt(keyMatch[2]);
        monthLabel = keyMatch[3].replace(/_/g, ' ');
    } else {
        monthLabel = raw.replace(/_/g, ' ');
    }
    const sectionKey = ctx.wizard.state.sectionKey;

    await ctx.editMessageText('⏳ Ma\'lumotlar yuklanmoqda...');

    try {
        // Convert month label (e.g. "2026-03") to date range
        const months = getLast6Months(lang);
        // month label is like "Mart 2026" — we need to find the corresponding YYYY-MM
        // getLast6Months returns display labels, we need to map them to dates
        // Let's use a simpler approach: fetch current month data
        // If we got YYYY-MM from callback, use it directly; otherwise fall back to label matching
        if (!targetYear || !targetMonth) {
            const now = getTashkentNow();
            const year = now.getUTCFullYear();
            const curMonth = now.getUTCMonth();
            const monthNamesUz = ['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentyabr','Oktyabr','Noyabr','Dekabr'];
            const monthNamesRu = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
            const monthNames = lang === 'ru' ? monthNamesRu : monthNamesUz;
            targetYear = year; targetMonth = curMonth + 1;
            for (let i = 0; i < 6; i++) {
                const d = new Date(Date.UTC(year, curMonth - i, 1));
                const label = `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
                if (label === monthLabel) {
                    targetYear = d.getUTCFullYear();
                    targetMonth = d.getUTCMonth() + 1;
                    break;
                }
            }
        }

        const startDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
        const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
        const endDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${lastDay}`;

        const allData = await storage.fetchAllData(startDate, endDate);
        const result = await buildSearchResult(sectionKey, monthLabel, allData);

        if (!result) {
            await ctx.editMessageText(`📭 *${monthLabel}* uchun ma'lumot topilmadi.`, { parse_mode: 'Markdown' });
        } else {
            await ctx.editMessageText(
                `🔍 *${monthLabel} — Natijalar:*\n\n${result}`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (e) {
        logger.error('search error:', e);
        await ctx.editMessageText(t(lang, 'error_sheets'));
    }

    return ctx.scene.leave();
});

searchScene.action('cancel_search', async (ctx) => {
    await ctx.answerCbQuery();
    const lang = ctx.wizard.state.lang || 'uz';
    await ctx.editMessageText(t(lang, 'cancelled'));
    return ctx.scene.leave();
});

module.exports = { searchScene };
