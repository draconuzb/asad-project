function getTashkentNow() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tashkent',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(now);
    const get = type => parts.find(p => p.type === type).value;
    return new Date(Date.UTC(+get('year'), +get('month') - 1, +get('day'), +get('hour'), +get('minute'), +get('second')));
}

// Safe YYYY-MM-DD formatter using UTC methods.
// IMPORTANT: This is designed for dates already shifted to Tashkent time via getTashkentNow().
function fmtYMD(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getTodayDisplay(lang = 'uz') {
    // Use raw Date with timeZone option to avoid double-offset
    return new Date().toLocaleDateString(lang === 'uz' ? 'uz-UZ' : 'ru-RU', {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tashkent'
    });
}

function getYesterdayDisplay(lang = 'uz') {
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return d.toLocaleDateString(lang === 'uz' ? 'uz-UZ' : 'ru-RU', {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tashkent'
    });
}

// Ensure d is a copy or we manipulate it safely
function toTashkent(date) {
    if (!date) return getTashkentNow();
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tashkent',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });
    const parts = {};
    for (const { type, value } of fmt.formatToParts(date)) {
        parts[type] = value;
    }
    return new Date(Date.UTC(
        +parts.year, +parts.month - 1, +parts.day,
        +parts.hour, +parts.minute, +parts.second
    ));
}

// Function to convert YYYY-MM-DD to DD.MM.YYYY
function formatDbDateStr(yyyyMmDd) {
    if (!yyyyMmDd) return '';
    const parts = yyyyMmDd.split('-');
    if (parts.length !== 3) return yyyyMmDd;
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

// Gets date string for Tashkent timezone YYYY-MM-DD.
// IMPORTANT: Pass a raw UTC Date object (e.g. new Date()), NOT a pre-adjusted Tashkent date.
// If no argument is given, returns today's date in Tashkent timezone.
function getTashkentDateString(dateObj) {
    // If a date is passed, use it directly (callers pass getTashkentNow() which is already Tashkent time).
    // If no argument, get current Tashkent time.
    const d = dateObj || getTashkentNow();
    return fmtYMD(d);
}

// Get the Monday of the current week
function getStartOfWeek() {
    const d = getTashkentNow();
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - (day === 0 ? 6 : day - 1);
    d.setUTCDate(diff);
    return fmtYMD(d);
}

// Get Monday of last week
function getStartOfLastWeek() {
    const d = getTashkentNow();
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - (day === 0 ? 6 : day - 1) - 7;
    d.setUTCDate(diff);
    return fmtYMD(d);
}

function getStartOfMonth() {
    const d = getTashkentNow();
    d.setUTCDate(1);
    return fmtYMD(d);
}

function getStartOfLastMonth() {
    const d = getTashkentNow();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return fmtYMD(d);
}

/**
 * Parses various date strings from the system.
 * Handles:
 * 1. "DD.MM.YYYY HH:mm:ss" (Uzbek default)
 * 2. "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss" (ISO/API default)
 * 3. "D.M.YYYY"
 * Returns a proper Date object.
 */
function parseUzDate(uzStr) {
    if (!uzStr) return new Date(0);
    if (uzStr instanceof Date) return uzStr;
    if (typeof uzStr !== 'string') return new Date(0);

    const str = uzStr.trim();
    if (!str) return new Date(0);

    // 1. Try ISO format first (YYYY-MM-DD...)
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(str)) {
        const isoParts = str.split(/[T\s]/);
        const [iY, iM, iD] = isoParts[0].split('-').map(Number);
        const iTime = isoParts[1] ? isoParts[1].split(':').map(Number) : [0, 0, 0];
        const d = new Date(Date.UTC(iY, iM - 1, iD, iTime[0] || 0, iTime[1] || 0, iTime[2] || 0));
        if (!isNaN(d.getTime())) return d;
    }

    // 2. Normalize and handle DD.MM.YYYY
    const normalized = str.replace(/[,/]/g, '.');
    const parts = normalized.split(/\s+/);
    const datePart = parts[0];
    const timePart = parts[1] || "00:00:00";

    const dParts = datePart.split('.').map(Number);
    const tParts = timePart.split(':').map(Number);

    if (dParts.length < 3) return new Date(0);

    // Common format DD.MM.YYYY
    let year = dParts[2];
    let month = dParts[1] - 1;
    let day = dParts[0];

    // Handle case where year is first (YYYY.MM.DD) if logic above missed it
    if (year < 1000 && dParts[0] > 1000) {
        year = dParts[0];
        day = dParts[2];
    }

    const result = new Date(Date.UTC(
        year,
        month,
        day,
        tParts[0] || 0,
        tParts[1] || 0,
        tParts[2] || 0
    ));
    if (result.getUTCMonth() !== month || result.getUTCDate() !== day) return new Date(0);
    return result;
}

/**
 * Normalizes a month name + year into a consistent internal key (Uzbek).
 * Used for language-agnostic filtering in reports.
 * Input: "Mart 2026" or "Март 2026" or "03.2026"
 * Output: "Mart 2026"
 */
function normalizeMonthKey(monthInput) {
    if (!monthInput) return '';
    const str = String(monthInput).trim();
    if (!str) return '';

    // If it's MM.YYYY or MM/YYYY
    const numericMatch = str.match(/^(\d{1,2})[./](\d{4})$/);
    if (numericMatch) {
        const mIdx = parseInt(numericMatch[1]);
        const year = numericMatch[2];
        const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
        if (mIdx >= 1 && mIdx <= 12) {
            return `${monthsUz[mIdx - 1]} ${year}`;
        }
    }

    // Identify month and year from string like "Mart 2026" or "Март 2026"
    const parts = str.split(/\s+/);
    if (parts.length < 2) return str;

    const monthPart = parts[0].toLowerCase();
    const year = parts[1];

    const uz = ['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentyabr','oktyabr','noyabr','dekabr'];
    const ru = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
    // Handle some Russian grammar cases (e.g. "Марта")
    const ruGenitive = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

    let mIdx = -1;
    for (let i = 0; i < 12; i++) {
        if (monthPart === uz[i] || monthPart === ru[i] || monthPart === ruGenitive[i]) {
            mIdx = i;
            break;
        }
    }

    if (mIdx !== -1) {
        const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
        return `${monthsUz[mIdx]} ${year}`;
    }

    // Reject unrecognized month formats (bare numbers, random strings)
    return '';
}

function getLast6Months(lang = 'uz') {
    const { t } = require('./i18n');
    const result = [];
    const d = getTashkentNow();
    d.setUTCDate(1); // Prevent month-rollover bugs on 29th-31st

    for (let i = 0; i < 6; i++) {
        const monthIndex = d.getUTCMonth() + 1; // 1-indexed for t()
        const year = d.getUTCFullYear();
        result.push(`${t(lang, `month_${monthIndex}`)} ${year}`);
        d.setUTCMonth(d.getUTCMonth() - 1);
    }
    return result;
}

function formatNumber(num, lang = 'uz') {
    if (typeof num !== 'number') num = parseInt(num) || 0;
    return num.toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU');
}

/**
 * Validates if a value is a realistic positive number
 */
function isValidNumber(val, max = 1000000000) {
    const num = Number(val);
    return !isNaN(num) && Number.isFinite(num) && num >= 0 && num <= max;
}

/**
 * Unified text sanitization: strips control characters, zero-width spaces, and trims.
 * @param {*} text - Input to sanitize
 * @param {number} maxLength - Maximum output length (default: 500)
 * @returns {string} Sanitized string
 */
function sanitizeText(text, maxLength = 500) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/[\u200B-\u200D\uFEFF\uFE0F]/g, '')
        .replace(/[\n\r\t]/g, ' ')
        .trim()
        .slice(0, maxLength);
}

/**
 * Alias for sanitizeText — kept for backward compatibility.
 */
function cleanText(text) {
    return sanitizeText(text);
}

/**
 * Given any YYYY-MM-DD date string, return the Mon–Sun week range it falls into.
 * Uses UTC dates throughout to avoid timezone-related day shifts.
 * @returns {{ start: string, end: string }} both in YYYY-MM-DD
 */
function getWeekRange(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dayOfWeek = dt.getUTCDay(); // 0=Sun, 1=Mon, ...
    const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(dt);
    monday.setUTCDate(dt.getUTCDate() + diffToMon);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);

    const fmt = (d) => d.toISOString().split('T')[0];
    return { start: fmt(monday), end: fmt(sunday) };
}

/**
 * Given month (1-12) and year, return the first and last day of that month.
 * @returns {{ start: string, end: string }} both in YYYY-MM-DD
 */
function getMonthRange(month, year) {
    const firstDay = new Date(Date.UTC(year, month - 1, 1));
    const lastDay = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
    return {
        start: firstDay.toISOString().split('T')[0],
        end: lastDay.toISOString().split('T')[0]
    };
}

/**
 * Parses user input date (e.g., "25.02.2026", "25/02/26") into YYYY-MM-DD
 * @returns {string|null}
 */
function parseUserDate(text) {
    if (!text || typeof text !== 'string') return null;
    const normalizedText = text.replace(/[,\/\s]/g, '.');
    const parts = normalizedText.split('.').filter(p => p.length > 0);
    if (parts.length === 3) {
        let dd = parseInt(parts[0], 10);
        let mm = parseInt(parts[1], 10);
        let yyyy = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
        let year = parseInt(yyyy, 10);
        // Validate ranges
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || year < 2020 || year > 2099) return null;
        // Validate the actual date (e.g., reject Feb 31)
        const testDate = new Date(Date.UTC(year, mm - 1, dd));
        if (testDate.getUTCMonth() !== mm - 1 || testDate.getUTCDate() !== dd) return null;
        return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
    return null;
}

function parseUserMonth(text) {
    if (!text || typeof text !== 'string') return null;
    const normalizedText = text.replace(/[,\/\-\s]/g, '.');
    const parts = normalizedText.split('.').filter(p => p.length > 0);
    
    let mm, yyyy;
    if (parts.length === 2) {
        mm = parts[0].padStart(2, '0');
        yyyy = parts[1].length === 2 ? `20${parts[1]}` : parts[1];
    } else if (parts.length === 3) {
        // User probably entered DD.MM.YYYY, extract month and year
        mm = parts[1].padStart(2, '0');
        yyyy = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
    } else {
        return null;
    }

    // Validate
    const yearInt = parseInt(yyyy);
    const monthInt = parseInt(mm);
    if (isNaN(yearInt) || isNaN(monthInt) || monthInt < 1 || monthInt > 12) return null;

    const firstDay = new Date(Date.UTC(yearInt, monthInt - 1, 1));
    const lastDay = new Date(Date.UTC(yearInt, monthInt, 0));

    return {
        startStr: firstDay.toISOString().split('T')[0],
        endStr: lastDay.toISOString().split('T')[0]
    };
}

/**
 * Convert human choices into a cron expression
 * @param {string} timeStr - e.g. "09:30"
 * @param {string} freq - 'daily', 'weekdays', 'weekly', 'monthly'
 */
function generateCronFromHuman(timeStr, freq) {
    if (!timeStr || !timeStr.includes(':')) return null;
    const parts = timeStr.split(':');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;

    if (freq === 'daily') return `${m} ${h} * * *`;
    if (freq === 'weekdays') return `${m} ${h} * * 1-5`;
    if (freq === 'weekly') return `${m} ${h} * * 1`; // Mondays
    if (freq === 'monthly') return `${m} ${h} 1 * *`; // 1st of month
    
    return `${m} ${h} * * *`; // Default to daily
}

/**
 * Parses a basic cron expression back to human-readable format
 * Returns { timeStr: "09:30", freq: "daily", labelUz: "Har kuni" }
 */
function parseCronToHuman(cronExpr) {
    if (!cronExpr) return { timeStr: '—', freq: 'unknown', labelUz: 'Noma\'lum' };
    
    // Default to handling basic standard 5-part cron expressions
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return { timeStr: '—', freq: 'unknown', labelUz: cronExpr };

    const mStr = parts[0];
    const hStr = parts[1];
    const dom = parts[2];
    const mon = parts[3];
    const dow = parts[4];

    const m = parseInt(mStr, 10);
    const h = parseInt(hStr, 10);
    
    let timeStr = '—';
    if (!isNaN(h) && !isNaN(m)) {
        timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    } else if (hStr === '*' && !isNaN(m)) {
        // e.g., 0 * * * * (Every hour)
        return { timeStr: `Har soat ${String(m).padStart(2, '0')} da`, freq: 'hourly', labelUz: 'Har soat' };
    } else {
        return { timeStr: 'Murakkab', freq: 'custom', labelUz: cronExpr }; // Complex custom crons
    }

    let freq = 'custom';
    let labelUz = cronExpr;

    if (dom === '*' && mon === '*' && dow === '*') {
        freq = 'daily';
        labelUz = 'Har kuni';
    } else if (dom === '*' && mon === '*' && dow === '1-5') {
        freq = 'weekdays';
        labelUz = 'Ish kunlari';
    } else if (dom === '*' && mon === '*' && dow === '1') {
        freq = 'weekly';
        labelUz = 'Har dushanba';
    } else if (dom === '1' && mon === '*' && dow === '*') {
        freq = 'monthly';
        labelUz = 'Har oyning 1-sanasida';
    }

    return { timeStr, freq, labelUz };
}



/**
 * Send a long message by splitting into chunks if it exceeds Telegram's 4096 char limit.
 * @param {Object} ctx - Telegraf context
 * @param {string} text - The message text
 * @param {Object} opts - Message options (parse_mode, etc.)
 */
async function sendLongMessage(ctx, text, opts = {}) {
    const MAX_LEN = 4000; // leave some margin
    if (text.length <= MAX_LEN) {
        return await ctx.reply(text, opts);
    }
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= MAX_LEN) {
            chunks.push(remaining);
            break;
        }
        // Try to split at a newline
        let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
        if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt);
    }
    for (const chunk of chunks) {
        if (chunk.trim()) {
            await ctx.reply(chunk, opts);
        }
    }
}


// Shared Markdown v1 escape helper
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/([_*`\[\]])/g, '\\$1');
}

module.exports = {
    escapeMarkdown,
    sendLongMessage,
    getTashkentNow,
    getTodayDisplay,
    getYesterdayDisplay,
    getTashkentDateString,
    formatDbDateStr,
    getStartOfWeek,
    getStartOfLastWeek,
    getStartOfMonth,
    getStartOfLastMonth,
    parseUzDate,
    normalizeMonthKey,
    getLast6Months,
    formatNumber,
    isValidNumber,
    sanitizeText,
    getWeekRange,
    getMonthRange,
    parseUserDate,
    parseUserMonth,
    generateCronFromHuman,
    parseCronToHuman,
    cleanText
};
