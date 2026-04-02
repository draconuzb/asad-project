/**
 * TWA Dashboard API — Express server (replaces PHP api.php)
 * Runs inside the bot process so only one SQLite version (better-sqlite3) touches the DB.
 */
const crypto = require('crypto');
const db = require('./db');

const ALLOWED_ORIGINS = ['https://web.telegram.org', 'https://edup.alwaysdata.net', 'https://k.tgdev.org', 'https://freelans.uz'];
const UZ_MONTHS = {1:'Yanvar',2:'Fevral',3:'Mart',4:'Aprel',5:'May',6:'Iyun',7:'Iyul',8:'Avgust',9:'Sentyabr',10:'Oktyabr',11:'Noyabr',12:'Dekabr'};
const MONTH_NUMS = Object.fromEntries(Object.entries(UZ_MONTHS).map(([k,v]) => [v, parseInt(k)]));


// ─── HTML escape for Telegram messages ───────────────────
function escTg(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── Audit Logging Helper ────────────────────────────────
function logAudit(req, action, section, details, recordId) {
    try {
        const ts = nowTs();
        const ymd = todayYmd();
        const uid = req.perms?.telegram_id || '';
        const uname = req.perms?.name || '';
        db.prepare('INSERT INTO audit_log (timestamp, date_ymd, user_id, user_name, action, section, details, record_id) VALUES (?,?,?,?,?,?,?,?)')
          .run(ts, ymd, String(uid), uname, action, section, typeof details === 'object' ? JSON.stringify(details) : String(details), String(recordId || ''));
    } catch(e) { console.error('Audit log failed:', e.message); }
}

// ─── Helpers ──────────────────────────────────────────────
// NOTE (M-09 Timezone): All application-level dates use Asia/Tashkent.
// SQLite DEFAULT (datetime('now')) uses UTC — all INSERT statements should
// explicitly set created_at via nowTs() rather than relying on the SQLite default.
function nowTs() {
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tashkent' }).replace(',', '');
}
function todayYmd() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tashkent' });
}
function monthStartYmd(monthName) {
    if (monthName) {
        const mp = monthName.trim().split(/\s+/);
        if (mp.length === 2) {
            const mNum = MONTH_NUMS[mp[0]];
            const year = parseInt(mp[1]);
            if (mNum && year) return `${year}-${String(mNum).padStart(2,'0')}-01`;
        }
    }
    const d = new Date();
    const dp = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit' }).formatToParts(d);
    const y = dp.find(p => p.type === 'year').value;
    const m = dp.find(p => p.type === 'month').value;
    return `${y}-${m}-01`;
}
function monthEndYmd(monthName) {
    if (monthName) {
        const parts = monthName.trim().split(/\s+/);
        if (parts.length === 2) {
            const mNum = MONTH_NUMS[parts[0]];
            const year = parseInt(parts[1]);
            if (mNum && year) {
                const lastDay = new Date(Date.UTC(year, mNum, 0)).getUTCDate();
                return `${year}-${String(mNum).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
            }
        }
    }
    // Default: end of current month
    const d = new Date();
    const p = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit' }).formatToParts(d);
    const y = parseInt(p.find(pp => pp.type === 'year').value);
    const m = parseInt(p.find(pp => pp.type === 'month').value);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
}
function safeInt(v) {
    const n = parseInt(String(v || '0').replace(/[.,\s]/g, ''), 10);
    if (isNaN(n)) return 0;
    return Math.max(-999999999999, Math.min(999999999999, n));
}
function normSubject(s) {
    s = (s || '').trim();
    if (!s || /^\d+$/.test(s)) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}
function getLast6Months() {
    const out = [];
    const tp = tashkentDateParts();
    for (let i = 0; i < 6; i++) {
        const d = new Date(Date.UTC(tp.year, tp.month - 1 - i, 1));
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth() + 1;
        out.push(UZ_MONTHS[m] + ' ' + y);
    }
    return out;
}
function tashkentDateParts() {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const y = parseInt(parts.find(p => p.type === 'year').value);
    const m = parseInt(parts.find(p => p.type === 'month').value);
    const d = parseInt(parts.find(p => p.type === 'day').value);
    return { year: y, month: m, day: d };
}
function tashkentDaysAgo(n) {
    const d = new Date(Date.now() - n * 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tashkent' });
}
function isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

// Normalize month string to consistent "MonthName Year" format (e.g. "Mart 2026")
function normalizeMonth(monthInput) {
    if (!monthInput) return '';
    const str = String(monthInput).trim();
    if (!str) return '';
    // Handle numeric formats like 03.2026 or 03/2026
    const numericMatch = str.match(/^(\d{1,2})[./](\d{4})$/);
    if (numericMatch) {
        const mIdx = parseInt(numericMatch[1]);
        const year = numericMatch[2];
        if (mIdx >= 1 && mIdx <= 12) return `${UZ_MONTHS[mIdx]} ${year}`;
    }
    // Already in "MonthName Year" format — capitalize first letter consistently
    const parts = str.match(/^(\S+)\s+(\d{4})$/);
    if (parts) {
        const name = parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase();
        // Validate known month names
        if (Object.values(UZ_MONTHS).map(m => m.toLowerCase()).includes(name.toLowerCase())) {
            return name + ' ' + parts[2];
        }
    }
    return ''; // Return empty string for unrecognized month formats
}

function sortByUzMonth(rows) {
    return rows.sort((a, b) => {
        const ma = a.month.match(/^(\S+)\s+(\d+)/);
        const mb = b.month.match(/^(\S+)\s+(\d+)/);
        if (!ma || !mb) return 0;
        const ya = parseInt(ma[2]), yb = parseInt(mb[2]);
        if (ya !== yb) return yb - ya;
        return (MONTH_NUMS[mb[1]] || 0) - (MONTH_NUMS[ma[1]] || 0);
    });
}

// ─── Telegram initData Validation ─────────────────────────
function validateInitData(initData, botToken) {
    if (!initData) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(hash, 'hex'))) return null;
    const authDate = params.get('auth_date');
    if (authDate && (Math.floor(Date.now() / 1000) - parseInt(authDate)) > 86400) return null; // 24h expiry
    const userStr = params.get('user');
    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            if (user && user.id) return String(Math.floor(user.id));
        } catch {}
    }
    return null;
}

function getUserPerms(tid) {
    if (!tid) return null;
    const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tid);
    if (!row) return null;
    const role = row.role || 'user';
    const isSuper = role === 'super';
    const ceo = role === 'ceo' || isSuper;
    const manager = role === 'manager';
    const allowed_branches = ceo
        ? db.prepare('SELECT id FROM branches').all().map(b => b.id)
        : db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ?').all(tid).map(b => b.branch_id);
    return {
        telegram_id: row.telegram_id, name: row.name, role,
        is_ceo: ceo, is_manager: manager,
        is_super: isSuper,
        is_super_ceo: (isSuper || (ceo && String(tid) === String(process.env.CEO_TELEGRAM_ID))),
        allowed_branches,
        sections: {
            leads: ceo || manager || row.sec_lead === 1,
            debtors: ceo || manager || row.sec_qarzdorlar === 1,
            rejections: ceo || manager || row.sec_rad_etilganlar === 1,
            finance: ceo || manager || row.sec_moliya === 1,
            attendance: ceo || manager || row.sec_davomat === 1,
            problems: ceo || manager || row.sec_muammo === 1,
            rooms: ceo || manager || row.sec_bosh_xonalar === 1,
            reports: ceo || manager,
            users: ceo || manager,
            cron: ceo,
            dashboard: true,
            analytics: true,
            hr: ceo || manager, // HR tab only for ceo/manager until fully implemented
        },
        // Simple users cannot edit/delete records
        can_edit: ceo || manager,
        can_delete: ceo || manager,
    };
}

// ─── Create Express App ───────────────────────────────────
const _downloadTokens = new Map();

function createTwaApi(bot, botToken, getAuthorizedUsers, setAuthorizedUsers) {
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    // Truncate all string fields to 1000 chars to prevent oversized data
    app.use((req, res, next) => {
        if (req.body && typeof req.body === 'object') {
            for (const [k, v] of Object.entries(req.body)) {
                if (typeof v === 'string' && v.length > 1000) req.body[k] = v.slice(0, 1000);
            }
        }
        next();
    });
    // Assumes alwaysdata's single reverse proxy (one hop)
    app.set("trust proxy", 1);

    // Security headers
    app.use((req, res, next) => {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('X-Frame-Options', 'DENY');
        res.set('X-XSS-Protection', '1; mode=block');
        res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.set('Content-Security-Policy', "default-src 'self'");
        next();
    });

    // Rate limiting (IP-based)
    const rateLimit = require('express-rate-limit');
    const generalLimiter = rateLimit({ windowMs: 60000, max: 100, message: { error: 'Too many requests' } });
    const writeLimiter = rateLimit({ windowMs: 60000, max: 30, message: { error: 'Too many write requests' } });
    app.use(generalLimiter);

    // User-ID-based rate limiting (applied after auth extracts tid)
    const userRateLimits = new Map();
    // Prune stale entries every 5 minutes to prevent unbounded Map growth
    const _twaRateLimitInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of userRateLimits) {
            if (now - entry.windowStart > 120000) userRateLimits.delete(key);
        }
    }, 5 * 60 * 1000);
    app._rateLimitInterval = _twaRateLimitInterval;
    function userRateLimit(req, res, next) {
        if (!req.tid) return next();
        const now = Date.now();
        let entry = userRateLimits.get(req.tid);
        if (!entry || now - entry.windowStart > 60000) {
            entry = { windowStart: now, count: 0 };
            userRateLimits.set(req.tid, entry);
        }
        entry.count++;
        if (entry.count > 120) {
            return res.status(429).json({ error: 'Too many requests for this user' });
        }
        next();
    }

    // CORS
    app.use((req, res, next) => {
        const origin = req.headers.origin || '';
        if (ALLOWED_ORIGINS.includes(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
        }
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    // Auth middleware — Telegram initData HMAC validation serves as CSRF protection
    // since requests must include a valid signed initData header
    app.use((req, res, next) => {
        let initData = req.headers['x-telegram-init-data'] || '';
        // Fallback: query param for download links (tg.openLink can't send headers)
        if (!initData && req.query.initData) initData = req.query.initData;
        req.tid = validateInitData(initData, botToken);
        req.perms = getUserPerms(req.tid);
        req.sections = req.perms ? req.perms.sections : {};
        next();
    });

    // Apply user-based rate limiting after auth
    app.use(userRateLimit);

    function requirePerm(req, res, sec) {
        if (!req.perms) { res.status(403).json({ error: 'Avtorizatsiya talab qilinadi' }); return false; }
        if (!req.perms.is_ceo && !req.perms.sections[sec]) { res.status(403).json({ error: "Ruxsat yo'q" }); return false; }
        return true;
    }

    // Branch access enforcement for POST actions
    function requireBranch(req, res, branchId) {
        if (!branchId) return true; // 0 = unscoped, handled separately
        if (req.perms.is_ceo) return true;
        if (!req.perms.allowed_branches.includes(branchId)) {
            res.status(403).json({ error: "Siz bu filialda ishlash huquqiga ega emassiz" });
            return false;
        }
        return true;
    }

    // Resolve branch_id for POST: enforce or auto-assign for non-CEO
    function resolveBranchId(req, res, bid) {
        if (req.perms.is_ceo) return bid;
        if (!bid) {
            if (req.perms.allowed_branches.length === 1) return req.perms.allowed_branches[0];
            res.status(400).json({ error: 'Filialni tanlang' });
            return null;
        }
        if (!req.perms.allowed_branches.includes(bid)) {
            res.status(403).json({ error: "Siz bu filialda ishlash huquqiga ega emassiz" });
            return null;
        }
        return bid;
    }

    // Build SQL branch scope filter for GET queries
    function branchScope(req, branchIdParam) {
        if (req.perms.is_ceo) {
            if (branchIdParam) return { sql: ' AND branch_id = ?', params: [branchIdParam] };
            return { sql: '', params: [] };
        }
        const ab = req.perms.allowed_branches;
        if (!ab.length) return { sql: ' AND 1=0', params: [] };
        if (branchIdParam && ab.includes(branchIdParam)) {
            return { sql: ' AND branch_id = ?', params: [branchIdParam] };
        }
        return { sql: ' AND branch_id IN (' + ab.map(() => '?').join(',') + ')', params: [...ab] };
    }


    // Per-branch breakdown helper — returns array of {id, name, ...data} for each branch
    function getUserBranches(req) {
        if (req.perms.is_ceo) return db.prepare('SELECT id, name FROM branches ORDER BY name').all();
        return db.prepare('SELECT b.id, b.name FROM branches b INNER JOIN user_branches ub ON b.id = ub.branch_id WHERE ub.user_id = ? ORDER BY b.name').all(req.tid);
    }


    // Problem type → section permission mapping for notifications
    // Problem type → section permission mapping (1:1 with section names)
    const PROBLEM_TYPE_MAP = {
        'Lead': ['lead'],
        'Qarzdorlar': ['qarzdorlar'],
        'Rad etilganlar': ['rad_etilganlar'],
        'Moliya': ['moliya'],
        'Davomat': ['davomat'],
        'Bosh xonalar': ['bosh_xonalar'],
        'Boshqa': null    // everyone sees "Boshqa" problems
    };


    // ── Finance Category Helper ──
    let _finCatCache = null;
    let _finCatCacheTime = 0;
    function getFinCats() {
        if (_finCatCache && Date.now() - _finCatCacheTime < 60000) return _finCatCache;
        _finCatCache = db.prepare("SELECT key, label, color, sort_order FROM finance_categories ORDER BY sort_order").all();
        _finCatCacheTime = Date.now();
        return _finCatCache;
    }
    function finCatLabel(key) {
        const cats = getFinCats();
        const cat = cats.find(c => c.key === key);
        return cat ? cat.label : key;
    }
    function finCatByLabel(label) {
        const cats = getFinCats();
        const cat = cats.find(c => c.label.toLowerCase() === label.toLowerCase());
        return cat ? cat.key : label;
    }

    // Notify reports users via Telegram
    function notifyReportsUsers(text) {
        try {
            const users = db.prepare("SELECT telegram_id FROM users WHERE sec_reports = 1 OR role = 'ceo'").all();
            for (const u of users) {
                bot.telegram.sendMessage(u.telegram_id, text, { parse_mode: 'Markdown' }).catch(() => {});
            }
        } catch(e) { console.error('notifyReportsUsers failed:', e.message); }
    }

    // Refresh bot's in-memory authorized users cache
    function refreshBotUsers() {
        try {
            const storage = require('./storage');
            storage.loadAuthorizedUsers().then(users => {
                if (users && Object.keys(users).length > 0) {
                    if (setAuthorizedUsers) {
                        setAuthorizedUsers(Object.assign({}, users));
                    } else {
                        const au = getAuthorizedUsers();
                        Object.keys(au).forEach(k => delete au[k]);
                        Object.assign(au, users);
                    }
                }
            }).catch(e => { console.error('refreshBotUsers async failed:', e.message); });
        } catch(e) { console.error('refreshBotUsers failed:', e.message); }
    }

    // ─── CEO Notification Helper ─────────────────────────────
    async function notifyCEO(message) {
        try {
            const ceoId = process.env.CEO_TELEGRAM_ID;
            if (!ceoId || !bot) return;
            await bot.telegram.sendMessage(ceoId, message, {parse_mode: 'HTML'});
        } catch(e) { /* silent */ }
    }

    // ════════════════════ READ ENDPOINTS ═════════════════════

    app.get(['/', '/api', '/twa/api', '/twa/api/'], async (req, res) => {
        const endpoint = req.query.endpoint || 'dashboard';
        const today = todayYmd();
        const mStart = monthStartYmd();
        let from = req.query.from || mStart;
        let to = req.query.to || today;
        if (!isValidDate(from)) from = mStart;
        if (!isValidDate(to)) to = today;
        // Branch filter — 0 means all branches
        const branchId = safeInt(req.query.branch_id);

        try {
            switch (endpoint) {

            case 'auth':
                return res.json({ authenticated: !!req.perms, permissions: req.perms });

            case 'health':
                return res.json({ status: 'ok', time: new Date().toISOString() });

            case 'branches':
                if (!req.perms) return res.status(403).json({ error: 'Avtorizatsiya talab qilinadi' });
                if (req.perms.is_ceo) return res.json(db.prepare('SELECT id, name FROM branches ORDER BY name').all());
                return res.json(db.prepare('SELECT b.id, b.name FROM branches b INNER JOIN user_branches ub ON b.id = ub.branch_id WHERE ub.user_id = ? ORDER BY b.name').all(req.tid));

            case 'subjects':
                if (!req.perms) return res.status(403).json({ error: 'Avtorizatsiya talab qilinadi' });
                return res.json(db.prepare('SELECT id, name FROM subjects ORDER BY name').all());

            case 'finance_categories':
                if (!req.perms) return res.status(403).json({ error: 'Avtorizatsiya talab qilinadi' });
                return res.json(getFinCats());

            case 'expense_types': {
                if (!req.perms) return res.status(403).json({ error: 'Avtorizatsiya talab qilinadi' });
                const cat = (req.query.category || '').trim();
                if (cat) return res.json(db.prepare('SELECT id, name FROM expense_types WHERE category = ? ORDER BY id').all(cat));
                return res.json(db.prepare('SELECT id, name FROM expense_types ORDER BY id').all());
            }

            case 'months':
                if (!req.perms) return res.status(403).json({ error: 'Avtorizatsiya talab qilinadi' });
                return res.json(getLast6Months());

            case 'dashboard': {
                if (!requirePerm(req, res, 'dashboard')) return;
                const bs = branchScope(req, branchId);
                const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tashkent', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
                const curMonth = UZ_MONTHS[parseInt(parts.find(p => p.type === 'month').value)] + ' ' + parts.find(p => p.type === 'year').value;

                // Time filter: month, quarter, range, or year
                const qMonth = (req.query.month || '').trim();
                const qQuarter = (req.query.quarter || '').trim();
                const qRange = (req.query.range || '').trim();
                const qYear = (req.query.year || '').trim();
                let filterStart, filterEnd, filterMonths;
                if (qQuarter) {
                    // Quarter: "Q1 2026" → Jan-Mar 2026
                    const qp = qQuarter.split(' ');
                    const qNum = parseInt((qp[0]||'').replace('Q',''));
                    const qYr = parseInt(qp[1]);
                    if (qNum >= 1 && qNum <= 4 && qYr) {
                        const fm = (qNum - 1) * 3 + 1;
                        filterStart = `${qYr}-${String(fm).padStart(2,'0')}-01`;
                        const lm = fm + 2;
                        const ld = new Date(Date.UTC(qYr, lm, 0)).getUTCDate();
                        filterEnd = `${qYr}-${String(lm).padStart(2,'0')}-${String(ld).padStart(2,'0')}`;
                        filterMonths = [UZ_MONTHS[fm]+' '+qYr, UZ_MONTHS[fm+1]+' '+qYr, UZ_MONTHS[fm+2]+' '+qYr];
                    }
                } else if (qRange) {
                    // Range: "last3", "last6", "last12" — rolling months from today
                    const rangeMap = { last3: 3, last6: 6, last12: 12 };
                    const n = rangeMap[qRange] || 6;
                    const tParts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tashkent', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
                    const tYear = parseInt(tParts.find(p => p.type === 'year').value);
                    const tMonth = parseInt(tParts.find(p => p.type === 'month').value);
                    const endDate = new Date(Date.UTC(tYear, tMonth, 0));
                    filterEnd = `${tYear}-${String(tMonth).padStart(2,'0')}-${String(endDate.getUTCDate()).padStart(2,'0')}`;
                    const startDate = new Date(Date.UTC(tYear, tMonth - n, 1));
                    filterStart = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2,'0')}-01`;
                    filterMonths = [];
                    for (let i = 0; i < n; i++) {
                        const d = new Date(Date.UTC(tYear, tMonth - 1 - i, 1));
                        filterMonths.push(UZ_MONTHS[d.getUTCMonth() + 1] + ' ' + d.getUTCFullYear());
                    }
                } else if (qYear) {
                    // Year: "2025" → full year
                    const yr = parseInt(qYear);
                    if (yr >= 2020 && yr <= 2100) {
                        filterStart = `${yr}-01-01`;
                        filterEnd = `${yr}-12-31`;
                        filterMonths = [];
                        for (let m = 1; m <= 12; m++) filterMonths.push(UZ_MONTHS[m] + ' ' + yr);
                    }
                } else if (qMonth) {
                    filterStart = monthStartYmd(qMonth);
                    filterEnd = monthEndYmd(qMonth);
                    filterMonths = [qMonth];
                }
                // Defaults if no filter
                if (!filterStart) { filterStart = mStart; filterEnd = today; filterMonths = [curMonth]; }
                console.log(`[DASH] qMonth="${qMonth}" qQuarter="${qQuarter}" → filterStart=${filterStart} filterEnd=${filterEnd} filterMonths=[${filterMonths.join(',')}]`);
                const dateFilter = ' AND date_ymd >= ? AND date_ymd <= ?';
                const dfParams = [filterStart, filterEnd];
                const monthFilter = filterMonths.length > 0 ? " AND month IN (" + filterMonths.map(() => '?').join(',') + ")" : '';
                const mfParams = filterMonths;

                const o = {};
                const s = req.sections;

                if (s.leads) {
                    const agg = db.prepare('SELECT COALESCE(SUM(count),0) as total_t FROM leads WHERE 1=1' + dateFilter + bs.sql).get(...dfParams, ...bs.params);
                    // Current active leads = all-time leads - all-time rejections - all-time enrolled
                    const allLeadsD = db.prepare('SELECT subject, SUM(count) as total FROM leads WHERE 1=1' + bs.sql + ' GROUP BY subject HAVING total > 0').all(...bs.params);
                    const allRejD = db.prepare('SELECT subject, SUM(count) as total FROM rejections WHERE 1=1' + bs.sql + ' GROUP BY subject').all(...bs.params);
                    const allEnrolledD = db.prepare('SELECT subject, SUM(count) as total FROM lead_enrolled WHERE 1=1' + bs.sql + ' GROUP BY subject').all(...bs.params);
                    const rejMapD = {}; allRejD.forEach(r => { rejMapD[r.subject] = r.total || 0; });
                    const enrollMapD = {}; allEnrolledD.forEach(r => { enrollMapD[r.subject] = r.total || 0; });
                    const currentBySubjectD = allLeadsD.map(r => ({ subject: r.subject, total: Math.max(0, (r.total || 0) - (rejMapD[r.subject] || 0) - (enrollMapD[r.subject] || 0)) })).filter(r => r.total > 0).sort((a, b) => b.total - a.total);
                    const currentTotalD = currentBySubjectD.reduce((s, r) => s + r.total, 0);
                    o.leads = {
                        total: agg.total_t,
                        bySubject: db.prepare('SELECT subject, SUM(count) as total FROM leads WHERE 1=1' + dateFilter + bs.sql + ' GROUP BY subject HAVING total > 0 ORDER BY total DESC').all(...dfParams, ...bs.params),
                        currentBySubject: currentBySubjectD,
                        currentTotal: currentTotalD,
                    };
                }
                if (s.debtors) {
                    const agg = db.prepare("SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE month != ''" + monthFilter + bs.sql).get(...mfParams, ...bs.params);
                    o.debtors = {
                        totalCount: agg.cnt, totalAmount: agg.amt,
                        byMonth: sortByUzMonth(db.prepare("SELECT month, SUM(count) as total_count, SUM(amount) as total_amount FROM debtors WHERE month != ''" + monthFilter + bs.sql + " GROUP BY month").all(...mfParams, ...bs.params)),
                    };
                }
                if (s.finance) {
                    const finRows = db.prepare(`SELECT month, COALESCE(SUM(CASE WHEN category='cat_2' THEN income ELSE 0 END),0) as cat_2_tushum, COALESCE(SUM(CASE WHEN category='cat_1' THEN income ELSE 0 END),0) as cat_1_tushum, COALESCE(SUM(CASE WHEN category='cat_2' THEN expense ELSE 0 END),0) as cat_2_xarajat, COALESCE(SUM(CASE WHEN category='cat_1' THEN expense ELSE 0 END),0) as cat_1_xarajat, COALESCE(SUM(income),0) as total_income, COALESCE(SUM(expense),0) as total_expense FROM finance WHERE month != '' AND month != '-'` + monthFilter + bs.sql + ` GROUP BY month`).all(...mfParams, ...bs.params);
                    o.finance = { byMonth: sortByUzMonth(finRows) };
                }
                if (s.attendance) {
                    const at = db.prepare("SELECT COALESCE(SUM(expected),0) as expected, COALESCE(SUM(attended),0) as attended FROM attendance WHERE 1=1" + dateFilter + bs.sql).get(...dfParams, ...bs.params);
                    o.attendance = {
                        total: at,
                        allDays: db.prepare('SELECT date_ymd as day, SUM(expected) as expected, SUM(attended) as attended FROM attendance WHERE 1=1' + dateFilter + bs.sql + ' GROUP BY day ORDER BY day DESC').all(...dfParams, ...bs.params),
                    };
                }
                if (s.rejections) {
                    const rejAgg = db.prepare('SELECT COALESCE(SUM(count),0) as total_t FROM rejections WHERE 1=1' + dateFilter + bs.sql).get(...dfParams, ...bs.params);
                    o.rejections = { total: rejAgg.total_t, bySubject: db.prepare('SELECT subject, SUM(count) as total FROM rejections WHERE 1=1' + dateFilter + bs.sql + ' GROUP BY subject HAVING total > 0 ORDER BY total DESC').all(...dfParams, ...bs.params) };
                }
                if (s.problems) o.problems = db.prepare("SELECT * FROM problems WHERE status != 'solved'" + bs.sql + " ORDER BY id DESC").all(...bs.params);
                if (s.rooms) {
                    const rooms = db.prepare('SELECT branch, room, days, time, period, capacity, price_per_student FROM empty_rooms WHERE 1=1' + bs.sql + ' ORDER BY branch, room, days').all(...bs.params);
                    rooms.forEach(r => { r.potential = r.capacity * r.price_per_student; });
                    o.rooms = { list: rooms, total_potential: rooms.reduce((s, r) => s + r.potential, 0), count: rooms.length };
                }
                if (s.users) o.users = db.prepare('SELECT telegram_id, name FROM users').all();

                // ── Per-branch breakdown (only when viewing all branches) ──
                if (!branchId) {
                    const userBranches = req.perms.is_ceo
                        ? db.prepare('SELECT id, name FROM branches ORDER BY name').all()
                        : db.prepare('SELECT b.id, b.name FROM branches b INNER JOIN user_branches ub ON b.id = ub.branch_id WHERE ub.user_id = ? ORDER BY b.name').all(req.tid);

                    if (userBranches.length > 1) {
                        o.byBranch = userBranches.map(br => {
                            const bSql = ' AND branch_id = ?';
                            const bP = [br.id];
                            const row = { id: br.id, name: br.name };

                            if (s.finance) {
                                const f = db.prepare("SELECT COALESCE(SUM(income),0) as income, COALESCE(SUM(expense),0) as expense FROM finance WHERE month != '' AND month != '-'" + monthFilter + bSql).get(...mfParams, ...bP);
                                row.finance = { income: f.income, expense: f.expense, profit: f.income - f.expense };
                            }
                            if (s.leads) {
                                row.leads = db.prepare('SELECT COALESCE(SUM(count),0) as total FROM leads WHERE 1=1' + dateFilter + bSql).get(...dfParams, ...bP).total;
                            }
                            if (s.rejections) {
                                row.rejections = db.prepare('SELECT COALESCE(SUM(count),0) as total FROM rejections WHERE 1=1' + dateFilter + bSql).get(...dfParams, ...bP).total;
                            }
                            if (s.debtors) {
                                const d2 = db.prepare("SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE month != ''" + monthFilter + bSql).get(...mfParams, ...bP);
                                row.debtors = { count: d2.cnt, amount: d2.amt };
                            }
                            if (s.attendance) {
                                const a = db.prepare('SELECT COALESCE(SUM(expected),0) as expected, COALESCE(SUM(attended),0) as attended FROM attendance WHERE 1=1' + dateFilter + bSql).get(...dfParams, ...bP);
                                row.attendance = { expected: a.expected, attended: a.attended, pct: a.expected > 0 ? Math.round(a.attended / a.expected * 100) : 0 };
                            }
                            if (s.problems) {
                                row.problems = db.prepare("SELECT COUNT(*) as cnt FROM problems WHERE status != 'solved'" + bSql).get(...bP).cnt;
                            }
                            if (s.rooms) {
                                const rms = db.prepare('SELECT capacity, price_per_student FROM empty_rooms WHERE 1=1' + bSql).all(...bP);
                                row.rooms = { count: rms.length, potential: rms.reduce((s2, r) => s2 + r.capacity * r.price_per_student, 0) };
                            }
                            return row;
                        });
                    }
                }

                o.filterMonths = filterMonths;
                o.finCategories = getFinCats(); return res.json({ timestamp: new Date().toISOString(), today, currentMonth: curMonth, permissions: req.perms, overview: o });
            }

            case 'leads':
                if (!requirePerm(req, res, 'leads')) return;
                { const bs = branchScope(req, branchId);
                const rejBySubject = db.prepare("SELECT subject, SUM(count) as total FROM rejections WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql + " GROUP BY subject HAVING total > 0 ORDER BY total DESC").all(from, to, ...bs.params);
                const rejTotal = rejBySubject.reduce((s, r) => s + (r.total || 0), 0);
                const allLeads = db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE 1=1" + bs.sql + " GROUP BY subject HAVING total > 0").all(...bs.params);
                const allRej = db.prepare("SELECT subject, SUM(count) as total FROM rejections WHERE 1=1" + bs.sql + " GROUP BY subject").all(...bs.params);
                const rejMap = {}; allRej.forEach(r => { rejMap[r.subject] = r.total || 0; });
                const allEnrolled = db.prepare("SELECT subject, SUM(count) as total FROM lead_enrolled WHERE 1=1" + bs.sql + " GROUP BY subject").all(...bs.params);
                const enrollMap = {}; allEnrolled.forEach(r => { enrollMap[r.subject] = r.total || 0; });
                const currentBySubject = allLeads.map(r => ({ subject: r.subject, total: Math.max(0, (r.total || 0) - (rejMap[r.subject] || 0) - (enrollMap[r.subject] || 0)) })).filter(r => r.total > 0).sort((a, b) => b.total - a.total);
                const currentTotal = currentBySubject.reduce((s, r) => s + r.total, 0);
                return res.json({
                    from, to, branch_id: branchId, finCategories: getFinCats(),
                    rows: db.prepare("SELECT l.*, b.name as branch_name FROM leads l LEFT JOIN branches b ON l.branch_id = b.id WHERE l.date_ymd >= ? AND l.date_ymd <= ?" + bs.sql.replace(/branch_id/g, 'l.branch_id') + " ORDER BY l.id DESC").all(from, to, ...bs.params),
                    bySubject: db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql + " GROUP BY subject HAVING total > 0 ORDER BY total DESC").all(from, to, ...bs.params),
                    rejBySubject, rejTotal, currentBySubject, currentTotal,
                    byBranch: !branchId ? getUserBranches(req).map(br => ({
                        name: br.name,
                        total: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(from, to, br.id).v,
                    })) : undefined,
                }); }

            case 'debtors':
                if (!requirePerm(req, res, 'debtors')) return;
                { const bs = branchScope(req, branchId);
                const where1 = bs.sql ? ' WHERE 1=1' + bs.sql : '';
                return res.json({
                    branch_id: branchId,
                    summary: db.prepare('SELECT SUM(count) as total_count, SUM(amount) as total_amount FROM debtors' + where1).get(...bs.params),
                    byMonth: sortByUzMonth(db.prepare("SELECT month, SUM(count) as total_count, SUM(amount) as total_amount FROM debtors WHERE month != ''" + bs.sql + " GROUP BY month").all(...bs.params)),
                    byBranch: !branchId ? getUserBranches(req).map(br => ({
                        name: br.name,
                        count: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM debtors WHERE branch_id = ?").get(br.id).v,
                        amount: db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM debtors WHERE branch_id = ?").get(br.id).v,
                    })) : undefined,
                }); }

            case 'finance':
                if (!requirePerm(req, res, 'finance')) return;
                { const bs = branchScope(req, branchId);
                const bsF = { sql: bs.sql.replace(/branch_id/g, 'f.branch_id'), params: bs.params };
                const bsQ = { sql: bs.sql.replace(/branch_id/g, 'q.branch_id'), params: bs.params };
                const where1 = bs.sql ? ' WHERE 1=1' + bsF.sql : '';
                const whereQ = bs.sql ? ' WHERE 1=1' + bsQ.sql : '';
                const result = {
                    from, to, branch_id: branchId,
                    rows: db.prepare("SELECT f.*, b.name as branch_name FROM finance f LEFT JOIN branches b ON f.branch_id = b.id WHERE f.date_ymd >= ? AND f.date_ymd <= ?" + bsF.sql + " ORDER BY f.created_at DESC").all(from, to, ...bs.params),
                    summary: db.prepare("SELECT SUM(income) as income, SUM(expense) as expense FROM finance WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(from, to, ...bs.params),
                    byCategory: db.prepare("SELECT category, SUM(income) as income, SUM(expense) as expense FROM finance WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql + " GROUP BY category").all(from, to, ...bs.params),
                    byType: db.prepare("SELECT expense_type as type, COALESCE(SUM(expense),0) as amount, category FROM finance WHERE date_ymd >= ? AND date_ymd <= ? AND expense > 0 AND expense_type != ''" + bs.sql + " GROUP BY expense_type, category ORDER BY amount DESC").all(from, to, ...bs.params),
                    recent: db.prepare("SELECT f.*, u.name as user_name, b.name as branch_name FROM finance f LEFT JOIN users u ON CAST(f.manager_id AS INTEGER) = CAST(u.telegram_id AS INTEGER) LEFT JOIN branches b ON f.branch_id = b.id" + where1 + " ORDER BY f.created_at DESC LIMIT 20").all(...bs.params),
                    recentDebtors: db.prepare("SELECT q.*, u.name as user_name FROM qarzdorlar_log q LEFT JOIN users u ON CAST(q.manager_id AS INTEGER) = CAST(u.telegram_id AS INTEGER)" + whereQ + " ORDER BY q.created_at DESC LIMIT 20").all(...bs.params),
                };
                if (!branchId) {
                    result.byBranch = getUserBranches(req).map(br => ({
                        name: br.name,
                        income: db.prepare("SELECT COALESCE(SUM(income),0) as v FROM finance WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(from, to, br.id).v,
                        expense: db.prepare("SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(from, to, br.id).v,
                    }));
                }
                return res.json(result); }

            case 'attendance':
                if (!requirePerm(req, res, 'attendance')) return;
                { const bs = branchScope(req, branchId);
                return res.json({
                    from, to, branch_id: branchId,
                    rows: db.prepare("SELECT a.*, b.name as branch_name FROM attendance a LEFT JOIN branches b ON a.branch_id = b.id WHERE a.date_ymd >= ? AND a.date_ymd <= ?" + bs.sql.replace(/branch_id/g, 'a.branch_id') + " ORDER BY a.id DESC").all(from, to, ...bs.params),
                    summary: db.prepare("SELECT SUM(expected) as expected, SUM(attended) as attended FROM attendance WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(from, to, ...bs.params),
                    byBranch: !branchId ? getUserBranches(req).map(br => {
                        const a = db.prepare("SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(from, to, br.id);
                        return { name: br.name, expected: a.exp, attended: a.att };
                    }) : undefined,
                }); }

            case 'problems':
                if (!requirePerm(req, res, 'problems')) return;
                { const isSolved = (req.query.status || 'open') === 'solved';
                const bs = branchScope(req, branchId);
                const bsP = bs.sql.replace(/branch_id/g, 'p.branch_id');
                if (isSolved) {
                    return res.json(db.prepare("SELECT p.*, b.name as branch_name FROM problems p LEFT JOIN branches b ON p.branch_id = b.id WHERE p.status = 'solved'" + bsP + " ORDER BY p.id DESC LIMIT 50").all(...bs.params));
                } else {
                    return res.json(db.prepare("SELECT p.*, b.name as branch_name FROM problems p LEFT JOIN branches b ON p.branch_id = b.id WHERE p.status != 'solved'" + bsP + " ORDER BY p.id DESC LIMIT 50").all(...bs.params));
                } }

            case 'rooms':
                if (!requirePerm(req, res, 'rooms')) return;
                { const bs = branchScope(req, branchId);
                const where1 = bs.sql ? ' WHERE 1=1' + bs.sql.replace(/branch_id/g, 'r.branch_id') : '';
                return res.json(db.prepare("SELECT r.*, b.name as branch_name FROM empty_rooms r LEFT JOIN branches b ON r.branch_id = b.id" + where1 + " ORDER BY r.id DESC").all(...bs.params)); }

            case 'rejections':
                if (!requirePerm(req, res, 'rejections')) return;
                { const bs = branchScope(req, branchId);
                const rows = db.prepare("SELECT r.*, b.name as branch_name FROM rejections r LEFT JOIN branches b ON r.branch_id = b.id WHERE r.date_ymd >= ? AND r.date_ymd <= ?" + bs.sql.replace(/branch_id/g, 'r.branch_id') + " ORDER BY r.id DESC").all(from, to, ...bs.params);
                const bySub = db.prepare("SELECT subject, SUM(count) as total FROM rejections WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql + " GROUP BY subject HAVING total > 0 ORDER BY total DESC").all(from, to, ...bs.params);
                const total = bySub.reduce((s, r) => s + r.total, 0);
                return res.json({
                    from, to, branch_id: branchId, rows, bySubject: bySub, total,
                    byBranch: !branchId ? getUserBranches(req).map(br => ({
                        name: br.name,
                        total: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(from, to, br.id).v,
                    })) : undefined,
                }); }

            case 'report': {
                if (!requirePerm(req, res, 'reports')) return;
                const bs = branchScope(req, branchId);
                let rFrom = (req.query.from || '').trim();
                let rTo = (req.query.to || '').trim();
                if (!rFrom) return res.status(400).json({ error: 'Sana kiritilmadi' });
                if (!rTo) rTo = rFrom;
                if (rFrom && !/^\d{4}-\d{2}-\d{2}$/.test(rFrom)) return res.status(400).json({error:'Noto\'g\'ri sana formati'});
                if (rTo && !/^\d{4}-\d{2}-\d{2}$/.test(rTo)) return res.status(400).json({error:'Noto\'g\'ri sana formati'});
                const allSubjects = db.prepare('SELECT name FROM subjects ORDER BY id').all().map(r => r.name);
                const _repLeadsRaw = db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql + " GROUP BY subject").all(rFrom, rTo, ...bs.params);
                const _repRejRaw = db.prepare("SELECT subject, SUM(count) as total FROM rejections WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql + " GROUP BY subject").all(rFrom, rTo, ...bs.params);
                const _leadMap = {}; _repLeadsRaw.forEach(r => { _leadMap[r.subject] = r.total || 0; });
                const _rejMap = {}; _repRejRaw.forEach(r => { _rejMap[r.subject] = r.total || 0; });
                const repLeads = allSubjects.map(name => ({ subject: name, total: _leadMap[name] || 0 }));
                const repRej = allSubjects.map(name => ({ subject: name, total: _rejMap[name] || 0 }));
                _repLeadsRaw.forEach(r => { if (!allSubjects.includes(r.subject)) repLeads.push({ subject: r.subject, total: r.total || 0 }); });
                _repRejRaw.forEach(r => { if (!allSubjects.includes(r.subject)) repRej.push({ subject: r.subject, total: r.total || 0 }); });
                const repDebtors = db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE date_ymd >= ? AND date_ymd <= ?' + bs.sql).get(rFrom, rTo, ...bs.params);
                const repDebtorsByMonth = db.prepare("SELECT month, SUM(count) as total_count, SUM(amount) as total_amount FROM debtors WHERE month != ''" + bs.sql + " GROUP BY month ORDER BY month DESC").all(...bs.params);
                const repFin = db.prepare("SELECT COALESCE(SUM(income),0) as income, COALESCE(SUM(expense),0) as expense FROM finance WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(rFrom, rTo, ...bs.params);
                const repFinByCat = db.prepare("SELECT category, COALESCE(SUM(income),0) as income, COALESCE(SUM(expense),0) as expense FROM finance WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql + " GROUP BY category").all(rFrom, rTo, ...bs.params);
                const repExpByType = db.prepare("SELECT expense_type as type, COALESCE(SUM(expense),0) as amount, category FROM finance WHERE date_ymd >= ? AND date_ymd <= ? AND expense > 0 AND expense_type != ''" + bs.sql + " GROUP BY expense_type, category ORDER BY amount DESC").all(rFrom, rTo, ...bs.params);
                // All registered expense types (show as 0 if not used in this period)
                const allExpTypesCat1 = db.prepare("SELECT name FROM expense_types WHERE category = 'cat_1' ORDER BY id").all().map(r => r.name);
                const allExpTypesCat2 = db.prepare("SELECT name FROM expense_types WHERE category = 'cat_2' ORDER BY id").all().map(r => r.name);
                const cat1Map = {}; repExpByType.filter(e => e.category === 'cat_1').forEach(e => { cat1Map[e.type] = e.amount; });
                const cat2Map = {}; repExpByType.filter(e => e.category === 'cat_2').forEach(e => { cat2Map[e.type] = e.amount; });
                const expensesCat1 = allExpTypesCat1.map(name => ({ name, amount: cat1Map[name] || 0 }));
                const expensesCat2 = allExpTypesCat2.map(name => ({ name, amount: cat2Map[name] || 0 }));
                repExpByType.filter(e => e.category === 'cat_1').forEach(e => { if (!allExpTypesCat1.includes(e.type)) expensesCat1.push({ name: e.type, amount: e.amount }); });
                repExpByType.filter(e => e.category === 'cat_2').forEach(e => { if (!allExpTypesCat2.includes(e.type)) expensesCat2.push({ name: e.type, amount: e.amount }); });
                const repAtt = db.prepare("SELECT COALESCE(SUM(expected),0) as expected, COALESCE(SUM(attended),0) as attended FROM attendance WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(rFrom, rTo, ...bs.params);
                const repProblems = db.prepare("SELECT branch, type, issue, timestamp FROM problems WHERE date_ymd >= ? AND date_ymd <= ?" + bs.sql + " ORDER BY id DESC").all(rFrom, rTo, ...bs.params);
                // Use historical rooms data for daily/weekly/monthly reports; current snapshot for 'umumiy'
                let repRooms;
                const repType = req.query.type || 'daily';
                if (repType !== 'umumiy') {
                    repRooms = db.prepare('SELECT branch, room, days, time, period, capacity, price_per_student, potential FROM empty_rooms_history WHERE date_ymd >= ? AND date_ymd <= ? AND date_ymd = (SELECT MAX(date_ymd) FROM empty_rooms_history WHERE date_ymd >= ? AND date_ymd <= ?)' + bs.sql + ' ORDER BY branch, room').all(rFrom, rTo, rFrom, rTo, ...bs.params);
                    if (!repRooms || repRooms.length === 0) {
                        repRooms = db.prepare('SELECT branch, room, days, time, period, capacity, price_per_student FROM empty_rooms WHERE 1=1' + bs.sql + ' ORDER BY branch, room').all(...bs.params);
                        repRooms.forEach(r => { r.potential = (r.capacity || 0) * (r.price_per_student || 0); });
                    }
                } else {
                    repRooms = db.prepare('SELECT branch, room, days, time, period, capacity, price_per_student FROM empty_rooms WHERE 1=1' + bs.sql + ' ORDER BY branch, room').all(...bs.params);
                    repRooms.forEach(r => { r.potential = (r.capacity || 0) * (r.price_per_student || 0); });
                }
                const repPotential = repRooms.reduce((s, r) => s + (r.potential || (r.capacity || 0) * (r.price_per_student || 0)), 0);
                // Per-branch breakdown for monthly/weekly reports
                let repByBranch = null;
                if (!branchId && (repType === 'monthly' || repType === 'weekly')) {
                    repByBranch = getUserBranches(req).map(br => {
                        const bInc = db.prepare("SELECT COALESCE(SUM(income),0) as v FROM finance WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(rFrom, rTo, br.id).v;
                        const bExp = db.prepare("SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(rFrom, rTo, br.id).v;
                        const bLeads = db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(rFrom, rTo, br.id).v;
                        const bRej = db.prepare("SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(rFrom, rTo, br.id).v;
                        const bAtt = db.prepare("SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?").get(rFrom, rTo, br.id);
                        const bProb = db.prepare("SELECT COUNT(*) as c FROM problems WHERE status != 'solved' AND branch_id = ?").get(br.id).c;
                        return { name: br.name, income: bInc, expense: bExp, leads: bLeads, rejections: bRej, attendance: bAtt, problems: bProb };
                    });
                }
                return res.json({
                    type: req.query.type || 'daily', from: rFrom, to: rTo, byBranch: repByBranch, finCategories: getFinCats(),
                    leads: { bySubject: repLeads, total: repLeads.reduce((s, r) => s + r.total, 0) },
                    rejections: { bySubject: repRej, total: repRej.reduce((s, r) => s + r.total, 0) },
                    debtors: { total_count: repDebtors.cnt, total_amount: repDebtors.amt, byMonth: repDebtorsByMonth },
                    finance: { income: repFin.income, expense: repFin.expense, byCategory: repFinByCat, expensesByType: repExpByType, expensesCat1, expensesCat2 },
                    attendance: { expected: repAtt.expected, attended: repAtt.attended },
                    problems: repProblems,
                    rooms: { total: repRooms.length, potential: repPotential, list: repRooms },
                });
            }

            case 'users_list': {
                if (!requirePerm(req, res, 'users')) return;
                let users = db.prepare('SELECT telegram_id, name, role, sec_lead, sec_qarzdorlar, sec_rad_etilganlar, sec_moliya, sec_davomat, sec_muammo, sec_bosh_xonalar, sec_reports, sec_foydalanuvchilar, sec_cron, sec_bosh, sec_tahlil, lang FROM users ORDER BY name').all();
                const allAssignments = db.prepare('SELECT ub.user_id, b.id, b.name FROM user_branches ub JOIN branches b ON ub.branch_id = b.id').all();
                users.forEach(u => {
                    u.assigned_branches = allAssignments.filter(a => a.user_id === u.telegram_id).map(a => ({ id: a.id, name: a.name }));
                });
                // Managers can only see simple users in their branches
                if (req.perms.is_manager) {
                    const myBranches = req.perms.allowed_branches;
                    users = users.filter(u => {
                        if (u.role === 'super' || u.role === 'ceo' || u.role === 'manager') return false;
                        return u.assigned_branches.some(b => myBranches.includes(b.id));
                    });
                }
                return res.json(users);
            }

            case 'pdf_report': {
                if (!requirePerm(req, res, 'reports')) return;
                const { generateOnDemandPdf } = require('./ceo_reports');
                const fs = require('fs');
                let rFrom = (req.query.from || '').trim();
                let rTo = (req.query.to || '').trim();
                if (!rFrom) return res.status(400).json({ error: 'Sana kiritilmadi' });
                if (!rTo) rTo = rFrom;
                if (rFrom && !/^\d{4}-\d{2}-\d{2}$/.test(rFrom)) return res.status(400).json({error:'Noto\'g\'ri sana formati'});
                if (rTo && !/^\d{4}-\d{2}-\d{2}$/.test(rTo)) return res.status(400).json({error:'Noto\'g\'ri sana formati'});
                const safeName = 'report_' + (rFrom||'').replace(/[^0-9-]/g,'') + '_' + (rTo||'').replace(/[^0-9-]/g,'') + '.pdf';
                const titleStr = `Hisobot: ${rFrom} — ${rTo}`;

                (async () => {
                    const pdfPath = await generateOnDemandPdf(rFrom, rTo, titleStr, 'uz');
                    res.download(pdfPath, safeName, (err) => {
                        if (err) {
                            console.error('[TWA PDF]', err);
                            if (!res.headersSent) {
                                res.status(500).json({ error: 'PDF yuklashda xatolik' });
                            }
                        }
                        setTimeout(() => fs.unlink(pdfPath, () => {}), 5000);
                    });
                })().catch(e => {
                    console.error('[TWA PDF]', e);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'PDF yaratishda xatolik' });
                    }
                });
                return; // Return immediately, headers sent asynchronously
            }

            case 'tax_report': {
                if (!requirePerm(req, res, 'reports')) return;
                const { generateFoydaSoligi, generateDaromadSoligi } = require('./tax_reports');
                const tp = tashkentDateParts();
                const year = parseInt(req.query.year) || tp.year;
                const month = parseInt(req.query.month) || tp.month;
                const type = req.query.type || 'foyda'; // or 'daromad'
                
                (async () => {
                    let text = '';
                    if (type === 'daromad') {
                        text = await generateDaromadSoligi(month, year, 'uz');
                    } else {
                        text = await generateFoydaSoligi(month, year, 'uz');
                    }
                    res.json({ text });
                })().catch(e => {
                    console.error('[TWA TAX]', e);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Soliq hisobotida xatolik' });
                    }
                });
                return;
            }

            case 'cron_list': {
                if (!requirePerm(req, res, 'cron')) return;
                // Built-in cron jobs with their default schedules
                const BUILTIN_CRONS = [
                    { key: 'manager_reminder', defaultSchedule: '0 18 * * *', description: 'Menejer eslatmasi (18:00)' },
                    { key: 'morning_summary', defaultSchedule: '0 9 * * *', description: 'Kunlik xisobot (09:00)' },
                    { key: 'lead_monitor', defaultSchedule: '0 * * * *', description: 'Lead monitor (har soat)' },
                    { key: 'weekly_report', defaultSchedule: '0 9 * * 1', description: 'Xaftalik xisobot (Dushanba 09:00)' },
                    { key: 'monthly_report', defaultSchedule: '5 9 1 * *', description: 'Oylik xisobot (1-kunda 09:05)' },
                    { key: 'accountability', defaultSchedule: '0 21 * * *', description: 'Hisobot nazorati (21:00)' },
                    { key: 'empty_rooms_snapshot', defaultSchedule: '30 19 * * *', description: 'Bo\'sh xonalar snapshot (19:30)' },
                    { key: 'db_backup', defaultSchedule: '0 2 * * *', description: 'Ma\'lumotlar bazasi backup (02:00)' },
                ];
                const dbRows = db.prepare('SELECT * FROM cron_settings').all();
                const dbMap = {};
                dbRows.forEach(r => { dbMap[r.job_key] = r; });
                const result = BUILTIN_CRONS.map(c => {
                    const dbRow = dbMap[c.key];
                    return {
                        key: c.key,
                        label: dbRow ? dbRow.label : c.description,
                        enabled: dbRow ? dbRow.enabled : 1,
                        schedule: (dbRow && dbRow.schedule) ? dbRow.schedule : c.defaultSchedule,
                        defaultSchedule: c.defaultSchedule,
                        type: 'builtin',
                    };
                });
                // Add custom cron jobs
                dbRows.filter(r => r.job_key.startsWith('custom_')).forEach(r => {
                    result.push({
                        key: r.job_key,
                        label: r.label || r.job_key,
                        enabled: r.enabled,
                        schedule: r.schedule || '',
                        defaultSchedule: '',
                        type: 'custom',
                        message: r.message || '',
                        assigned_users: r.assigned_users || '',
                    });
                });
                return res.json(result);
            }

            case 'cron_settings': {
                if (!requirePerm(req, res, 'cron')) return;
                return res.json(db.prepare('SELECT * FROM cron_settings').all());
            }

            case 'my_crons': {
                if (!req.perms) return res.status(403).json({ error: 'Avtorizatsiya talab qilinadi' });
                // Crons assigned TO current user (all roles can see)
                const tid = req.perms.telegram_id;
                // Direct assignments
                let rows = db.prepare('SELECT ca.*, u.name as assigned_by_name FROM cron_assignments ca LEFT JOIN users u ON ca.assigned_by = u.telegram_id WHERE ca.assigned_to = ? AND ca.enabled = 1 ORDER BY ca.created_at DESC').all(tid);
                // Branch broadcast assignments — find branches this user belongs to
                const myBranches = db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ?').all(tid).map(b => b.branch_id);
                if (myBranches.length > 0) {
                    const branchRows = db.prepare("SELECT ca.*, u.name as assigned_by_name FROM cron_assignments ca LEFT JOIN users u ON ca.assigned_by = u.telegram_id WHERE ca.assigned_to = 'branch' AND ca.enabled = 1 AND ca.branch_id IN (" + myBranches.map(() => '?').join(',') + ') ORDER BY ca.created_at DESC').all(...myBranches);
                    rows = rows.concat(branchRows);
                }
                return res.json(rows);
            }

            case 'assigned_crons': {
                // Crons assigned BY current user (CEO/Manager)
                if (!req.perms.is_ceo && !req.perms.is_manager) return res.status(403).json({ error: "Ruxsat yo'q" });
                const tid = req.perms.telegram_id;
                const rows = db.prepare('SELECT ca.*, u.name as user_name FROM cron_assignments ca LEFT JOIN users u ON ca.assigned_to = u.telegram_id WHERE ca.assigned_by = ? ORDER BY ca.created_at DESC').all(tid);
                // For branch assignments, resolve branch name
                const branchMap = {};
                db.prepare('SELECT id, name FROM branches').all().forEach(b => { branchMap[b.id] = b.name; });
                rows.forEach(r => {
                    if (r.assigned_to === 'branch') {
                        r.user_name = branchMap[r.branch_id] || 'Filial #' + r.branch_id;
                    }
                });
                return res.json(rows);
            }

            case 'trends': {
                if (!requirePerm(req, res, 'analytics')) return;
                const bs = branchScope(req, branchId);
                const period = Math.min(parseInt(req.query.days) || 180, 730);
                const startDate = tashkentDaysAgo(period);

                const dailyLeads = db.prepare('SELECT date_ymd as day, SUM(count) as total FROM leads WHERE date_ymd >= ?' + bs.sql + ' GROUP BY date_ymd ORDER BY date_ymd').all(startDate, ...bs.params);
                const dailyIncome = db.prepare('SELECT date_ymd as day, SUM(income) as income, SUM(expense) as expense FROM finance WHERE date_ymd >= ?' + bs.sql + ' GROUP BY date_ymd ORDER BY date_ymd').all(startDate, ...bs.params);
                const dailyDebtors = db.prepare('SELECT date_ymd as day, SUM(count) as cnt, SUM(amount) as amt FROM debtors WHERE date_ymd >= ?' + bs.sql + ' GROUP BY date_ymd ORDER BY date_ymd').all(startDate, ...bs.params);
                const dailyAttendance = db.prepare('SELECT date_ymd as day, SUM(expected) as expected, SUM(attended) as attended FROM attendance WHERE date_ymd >= ?' + bs.sql + ' GROUP BY date_ymd ORDER BY date_ymd').all(startDate, ...bs.params);
                const dailyRejections = db.prepare('SELECT date_ymd as day, SUM(count) as total FROM rejections WHERE date_ymd >= ?' + bs.sql + ' GROUP BY date_ymd ORDER BY date_ymd').all(startDate, ...bs.params);

                const monthlyLeads = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(count) as total FROM leads WHERE date_ymd >= ?" + bs.sql + " GROUP BY substr(date_ymd,1,7) ORDER BY ym").all(startDate, ...bs.params);
                const monthlyIncome = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(income) as income, SUM(expense) as expense FROM finance WHERE date_ymd >= ?" + bs.sql + " GROUP BY substr(date_ymd,1,7) ORDER BY ym").all(startDate, ...bs.params);
                const monthlyDebtors = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(count) as cnt, SUM(amount) as amt FROM debtors WHERE date_ymd >= ?" + bs.sql + " GROUP BY substr(date_ymd,1,7) ORDER BY ym").all(startDate, ...bs.params);
                const monthlyAttendance = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(expected) as expected, SUM(attended) as attended FROM attendance WHERE date_ymd >= ?" + bs.sql + " GROUP BY substr(date_ymd,1,7) ORDER BY ym").all(startDate, ...bs.params);
                const monthlyRejections = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(count) as total FROM rejections WHERE date_ymd >= ?" + bs.sql + " GROUP BY substr(date_ymd,1,7) ORDER BY ym").all(startDate, ...bs.params);

                const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tashkent', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
                const curMonth = UZ_MONTHS[parseInt(parts.find(p => p.type === 'month').value)] + ' ' + parts.find(p => p.type === 'year').value;
                const targets = db.prepare('SELECT * FROM kpi_targets WHERE month = ?').all(curMonth);

                const mStart = monthStartYmd();
                const curLeads = db.prepare('SELECT COALESCE(SUM(count),0) as total FROM leads WHERE date_ymd >= ?' + bs.sql).get(mStart, ...bs.params);
                const curIncome = db.prepare('SELECT COALESCE(SUM(income),0) as income, COALESCE(SUM(expense),0) as expense FROM finance WHERE date_ymd >= ?' + bs.sql).get(mStart, ...bs.params);
                const curDebtors = db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE 1=1' + bs.sql).get(...bs.params);
                const curAttendance = db.prepare('SELECT COALESCE(SUM(expected),0) as expected, COALESCE(SUM(attended),0) as attended FROM attendance WHERE date_ymd >= ?' + bs.sql).get(mStart, ...bs.params);
                const curRejections = db.prepare('SELECT COALESCE(SUM(count),0) as total FROM rejections WHERE date_ymd >= ?' + bs.sql).get(mStart, ...bs.params);

                const tParts = tashkentDateParts();
                const dayOfMonth = tParts.day;
                const daysInMonth = new Date(Date.UTC(tParts.year, tParts.month, 0)).getUTCDate();

                return res.json({
                    period, startDate, currentMonth: curMonth,
                    dayOfMonth, daysInMonth,
                    daily: { leads: dailyLeads, income: dailyIncome, debtors: dailyDebtors, attendance: dailyAttendance, rejections: dailyRejections },
                    monthly: { leads: monthlyLeads, income: monthlyIncome, debtors: monthlyDebtors, attendance: monthlyAttendance, rejections: monthlyRejections },
                    current: {
                        leads: curLeads.total, income: curIncome.income, expense: curIncome.expense,
                        debtors_count: curDebtors.cnt, debtors_amount: curDebtors.amt,
                        attendance_expected: curAttendance.expected, attendance_attended: curAttendance.attended,
                        rejections: curRejections.total,
                    },
                    targets,
                });
            }

            case 'funnel': {
                if (!requirePerm(req, res, 'analytics')) return;
                const bs = branchScope(req, branchId);
                const allLeads = db.prepare('SELECT subject, SUM(count) as total FROM leads WHERE 1=1' + bs.sql + ' GROUP BY subject HAVING total > 0 ORDER BY total DESC').all(...bs.params);
                const allRej = db.prepare('SELECT subject, SUM(count) as total FROM rejections WHERE 1=1' + bs.sql + ' GROUP BY subject HAVING total > 0').all(...bs.params);
                const rejMap = {};
                allRej.forEach(r => { rejMap[r.subject] = r.total; });

                // Leads and rejections are independent metrics (rejections are NOT subtracted from leads)
                const bySubject = allLeads.map(l => {
                    const rej = rejMap[l.subject] || 0;
                    return { subject: l.subject, leads: l.total, rejections: rej };
                });
                // Add subjects that only appear in rejections
                allRej.forEach(r => {
                    if (!bySubject.find(b => b.subject === r.subject)) {
                        bySubject.push({ subject: r.subject, leads: 0, rejections: r.total });
                    }
                });

                const d180 = tashkentDaysAgo(180);
                const monthlyLeadsData = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(count) as total FROM leads WHERE date_ymd >= ?" + bs.sql + " GROUP BY substr(date_ymd,1,7) ORDER BY ym").all(d180, ...bs.params);
                const monthlyRej = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(count) as total FROM rejections WHERE date_ymd >= ?" + bs.sql + " GROUP BY substr(date_ymd,1,7) ORDER BY ym").all(d180, ...bs.params);
                const rejByMonth = {};
                monthlyRej.forEach(r => { rejByMonth[r.ym] = r.total; });
                const monthlyData = monthlyLeadsData.map(r => {
                    const rej = rejByMonth[r.ym] || 0;
                    return { ym: r.ym, leads: r.total, rejections: rej };
                });

                const totalLeads = allLeads.reduce((s, r) => s + r.total, 0);
                const totalRej = allRej.reduce((s, r) => s + r.total, 0);

                return res.json({
                    bySubject,
                    monthly: monthlyData,
                    totals: { leads: totalLeads, rejections: totalRej }
                });
            }

            case 'insights': {
                if (!requirePerm(req, res, 'analytics')) return;
                const bs = branchScope(req, branchId);
                const yesterday = tashkentDaysAgo(1);
                const d30 = tashkentDaysAgo(30);
                const weekAgo = tashkentDaysAgo(7);
                const insMStart = monthStartYmd();

                const yLeads = db.prepare('SELECT COALESCE(SUM(count),0) as t FROM leads WHERE date_ymd = ?' + bs.sql).get(yesterday, ...bs.params);
                const yFin = db.prepare('SELECT COALESCE(SUM(income),0) as inc, COALESCE(SUM(expense),0) as exp FROM finance WHERE date_ymd = ?' + bs.sql).get(yesterday, ...bs.params);
                const yAtt = db.prepare('SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd = ?' + bs.sql).get(yesterday, ...bs.params);

                const avgLeads = db.prepare('SELECT COALESCE(AVG(dt), 0) as avg FROM (SELECT SUM(count) as dt FROM leads WHERE date_ymd >= ? AND date_ymd < ?' + bs.sql + ' GROUP BY date_ymd)').get(d30, yesterday, ...bs.params);
                const avgIncome = db.prepare('SELECT COALESCE(AVG(dt), 0) as avg FROM (SELECT SUM(income) as dt FROM finance WHERE date_ymd >= ? AND date_ymd < ?' + bs.sql + ' GROUP BY date_ymd)').get(d30, yesterday, ...bs.params);
                const avgExpense = db.prepare('SELECT COALESCE(AVG(dt), 0) as avg FROM (SELECT SUM(expense) as dt FROM finance WHERE date_ymd >= ? AND date_ymd < ?' + bs.sql + ' GROUP BY date_ymd)').get(d30, yesterday, ...bs.params);

                const thisWeek = db.prepare('SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ?' + bs.sql + ' GROUP BY subject ORDER BY total DESC').all(weekAgo, ...bs.params);
                const twoWeeksAgo = tashkentDaysAgo(14);
                const lastWeek = db.prepare('SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ? AND date_ymd < ?' + bs.sql + ' GROUP BY subject').all(twoWeeksAgo, weekAgo, ...bs.params);
                const lwMap = {};
                lastWeek.forEach(r => { lwMap[r.subject] = r.total; });
                let topGrower = null, topGrowth = -Infinity;
                thisWeek.forEach(r => {
                    const prev = lwMap[r.subject] || 0;
                    const g = prev > 0 ? (r.total - prev) / prev * 100 : (r.total > 0 ? 100 : 0);
                    if (g > topGrowth && r.total > 0) { topGrower = r.subject; topGrowth = Math.round(g); }
                });

                const anomalies = [];
                if (avgExpense.avg > 0 && yFin.exp > avgExpense.avg * 2) anomalies.push({ type: 'warning', text: "Kecha chiqim odatdagidan " + Math.round(yFin.exp/avgExpense.avg) + "x ko'p" });
                if (avgLeads.avg > 0 && yLeads.t < avgLeads.avg * 0.3) anomalies.push({ type: 'warning', text: "Kecha leadlar odatdagidan " + Math.round((1-yLeads.t/avgLeads.avg)*100) + "% kam" });
                const attPct = yAtt.exp > 0 ? Math.round(yAtt.att / yAtt.exp * 100) : 0;
                if (attPct > 0 && attPct < 60) anomalies.push({ type: 'danger', text: "Kechagi davomat juda past: " + attPct + "%" });
                const mDebt = db.prepare('SELECT COALESCE(SUM(amount),0) as a FROM debtors WHERE date_ymd >= ?' + bs.sql).get(insMStart, ...bs.params);
                const mInc = db.prepare('SELECT COALESCE(SUM(income),0) as i FROM finance WHERE date_ymd >= ?' + bs.sql).get(insMStart, ...bs.params);
                if (mDebt.a > mInc.i * 0.5 && mDebt.a > 0) anomalies.push({ type: 'danger', text: "Qarzlar tushum ning " + Math.round(mDebt.a/Math.max(mInc.i,1)*100) + "% ini tashkil etadi" });
                if (avgIncome.avg > 0 && yFin.inc > avgIncome.avg * 2.5) anomalies.push({ type: 'positive', text: "Kecha kirim odatdagidan " + Math.round(yFin.inc/avgIncome.avg) + "x ko'p!" });

                return res.json({
                    yesterday: { leads: yLeads.t, income: yFin.inc, expense: yFin.exp, attPct, leadsAvg: Math.round(avgLeads.avg), incomeAvg: Math.round(avgIncome.avg), expenseAvg: Math.round(avgExpense.avg) },
                    topGrower: topGrower ? { subject: topGrower, growth: topGrowth } : null,
                    anomalies,
                });
            }

            case 'financial_intelligence': {
                if (!requirePerm(req, res, 'analytics')) return;
                const bs = branchScope(req, branchId);

                // 1. Cash flow — monthly income/expense/net with running cumulative
                const cfRows = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(income) as income, SUM(expense) as expense FROM finance WHERE 1=1" + bs.sql + " GROUP BY substr(date_ymd,1,7) ORDER BY ym").all(...bs.params);
                let cumulative = 0;
                const cashFlow = cfRows.map(r => {
                    const net = (r.income || 0) - (r.expense || 0);
                    cumulative += net;
                    return { ym: r.ym, income: r.income || 0, expense: r.expense || 0, net, cumulative };
                });

                // 2. Seasonality — average by calendar month (1-12)
                const seasonRows = db.prepare("SELECT CAST(substr(date_ymd,6,2) AS INTEGER) as m, SUM(income) as income, SUM(expense) as expense, COUNT(DISTINCT substr(date_ymd,1,7)) as months FROM finance WHERE 1=1" + bs.sql + " GROUP BY CAST(substr(date_ymd,6,2) AS INTEGER) ORDER BY m").all(...bs.params);
                const seasonLeads = db.prepare("SELECT CAST(substr(date_ymd,6,2) AS INTEGER) as m, SUM(count) as total, COUNT(DISTINCT substr(date_ymd,1,7)) as months FROM leads WHERE 1=1" + bs.sql + " GROUP BY CAST(substr(date_ymd,6,2) AS INTEGER) ORDER BY m").all(...bs.params);
                const slMap = {};
                seasonLeads.forEach(r => { slMap[r.m] = { avgLeads: r.months > 0 ? Math.round(r.total / r.months) : 0 }; });
                const seasonality = seasonRows.map(r => ({
                    month: r.m,
                    avgIncome: r.months > 0 ? Math.round(r.income / r.months) : 0,
                    avgExpense: r.months > 0 ? Math.round(r.expense / r.months) : 0,
                    avgLeads: (slMap[r.m] || {}).avgLeads || 0,
                }));

                // 3. Expense breakdown by type and category
                const expByType = db.prepare("SELECT expense_type as type, SUM(expense) as amount FROM finance WHERE expense > 0 AND expense_type != ''" + bs.sql + " GROUP BY expense_type ORDER BY amount DESC").all(...bs.params);
                const expTotal = expByType.reduce((s, r) => s + r.amount, 0);
                const expenseBreakdown = expByType.map(r => ({ type: r.type, amount: r.amount, pct: expTotal > 0 ? Math.round(r.amount / expTotal * 100) : 0 }));

                const expByCat = db.prepare("SELECT category, SUM(expense) as amount FROM finance WHERE expense > 0" + bs.sql + " GROUP BY category ORDER BY amount DESC").all(...bs.params);
                const catTotal = expByCat.reduce((s, r) => s + r.amount, 0);
                const expenseByCategory = expByCat.map(r => ({ category: r.category || 'Noma\'lum', amount: r.amount, pct: catTotal > 0 ? Math.round(r.amount / catTotal * 100) : 0 }));

                // 4. Debtor aging
                const nowDate = todayYmd();
                const d30ago = tashkentDaysAgo(30);
                const d60ago = tashkentDaysAgo(60);
                const d90ago = tashkentDaysAgo(90);
                const agCurrent = db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE date_ymd >= ?' + bs.sql).get(d30ago, ...bs.params);
                const ag30 = db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE date_ymd >= ? AND date_ymd < ?' + bs.sql).get(d60ago, d30ago, ...bs.params);
                const ag60 = db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE date_ymd >= ? AND date_ymd < ?' + bs.sql).get(d90ago, d60ago, ...bs.params);
                const ag90 = db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE date_ymd < ?' + bs.sql).get(d90ago, ...bs.params);
                const debtorAging = { current: agCurrent, d30: ag30, d60: ag60, d90plus: ag90 };

                // 5. Room revenue potential
                const rooms = db.prepare('SELECT branch, room, capacity, price_per_student, days, time, period FROM empty_rooms WHERE 1=1' + bs.sql + ' ORDER BY branch, room').all(...bs.params);
                const totalPotential = rooms.reduce((s, r) => s + (r.capacity || 0) * (r.price_per_student || 0), 0);
                const roomRevenue = { rooms: rooms.map(r => ({ ...r, potential: (r.capacity || 0) * (r.price_per_student || 0) })), totalPotential };

                // 6. Break-even estimate
                const last3mExpense = db.prepare("SELECT COALESCE(SUM(expense),0) as total FROM finance WHERE date_ymd >= ?" + bs.sql).get(tashkentDaysAgo(90), ...bs.params);
                const monthlyAvgExpense = Math.round(last3mExpense.total / 3);
                const totalStudents = db.prepare('SELECT COALESCE(SUM(count),0) as t FROM leads WHERE 1=1' + bs.sql).get(...bs.params).t;
                const totalIncome = db.prepare('SELECT COALESCE(SUM(income),0) as t FROM finance WHERE 1=1' + bs.sql).get(...bs.params).t;
                const avgIncomePerStudent = totalStudents > 0 ? Math.round(totalIncome / totalStudents) : 0;
                const breakEvenStudents = avgIncomePerStudent > 0 ? Math.ceil(monthlyAvgExpense / avgIncomePerStudent) : 0;

                return res.json({ cashFlow, seasonality, expenseBreakdown, expenseByCategory, debtorAging, roomRevenue, breakEven: { monthlyAvgExpense, avgIncomePerStudent, breakEvenStudents, totalStudents } });
            }

            case 'comparisons': {
                if (!requirePerm(req, res, 'analytics')) return;
                const bs = branchScope(req, branchId);

                // 1. Period comparison — this month vs last month
                const cmpParts = tashkentDateParts();
                const curYm = `${cmpParts.year}-${String(cmpParts.month).padStart(2,'0')}`;
                const prevMonth = cmpParts.month === 1 ? 12 : cmpParts.month - 1;
                const prevYear = cmpParts.month === 1 ? cmpParts.year - 1 : cmpParts.year;
                const prevYm = `${prevYear}-${String(prevMonth).padStart(2,'0')}`;

                const periodCur = {
                    income: db.prepare("SELECT COALESCE(SUM(income),0) as v FROM finance WHERE substr(date_ymd,1,7)=?" + bs.sql).get(curYm, ...bs.params).v,
                    expense: db.prepare("SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE substr(date_ymd,1,7)=?" + bs.sql).get(curYm, ...bs.params).v,
                    leads: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE substr(date_ymd,1,7)=?" + bs.sql).get(curYm, ...bs.params).v,
                    rejections: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE substr(date_ymd,1,7)=?" + bs.sql).get(curYm, ...bs.params).v,
                    debtors: db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM debtors WHERE substr(date_ymd,1,7)=?" + bs.sql).get(curYm, ...bs.params).v,
                };
                const periodPrev = {
                    income: db.prepare("SELECT COALESCE(SUM(income),0) as v FROM finance WHERE substr(date_ymd,1,7)=?" + bs.sql).get(prevYm, ...bs.params).v,
                    expense: db.prepare("SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE substr(date_ymd,1,7)=?" + bs.sql).get(prevYm, ...bs.params).v,
                    leads: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE substr(date_ymd,1,7)=?" + bs.sql).get(prevYm, ...bs.params).v,
                    rejections: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE substr(date_ymd,1,7)=?" + bs.sql).get(prevYm, ...bs.params).v,
                    debtors: db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM debtors WHERE substr(date_ymd,1,7)=?" + bs.sql).get(prevYm, ...bs.params).v,
                };

                // 2. Subject ranking — by lead count with trend
                const subjCur = db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE substr(date_ymd,1,7)=?" + bs.sql + " GROUP BY subject ORDER BY total DESC").all(curYm, ...bs.params);
                const subjPrev = db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE substr(date_ymd,1,7)=?" + bs.sql + " GROUP BY subject").all(prevYm, ...bs.params);
                const spMap = {};
                subjPrev.forEach(r => { spMap[r.subject] = r.total; });
                const subjectRanking = subjCur.map((r, i) => {
                    const prev = spMap[r.subject] || 0;
                    const growth = prev > 0 ? Math.round((r.total - prev) / prev * 100) : (r.total > 0 ? 100 : 0);
                    return { rank: i + 1, subject: r.subject, current: r.total, previous: prev, growth };
                });

                // 3. Manager scores — by actions logged
                const managerActions = db.prepare("SELECT user_name, user_id, COUNT(*) as actions, COUNT(DISTINCT date_ymd) as activeDays FROM audit_log WHERE date_ymd >= ? GROUP BY user_id ORDER BY actions DESC").all(prevYm + '-01');
                const managerLeads = db.prepare("SELECT manager_id, SUM(count) as total FROM leads WHERE substr(date_ymd,1,7) IN (?,?) GROUP BY manager_id").all(curYm, prevYm);
                const mlMap = {};
                managerLeads.forEach(r => { mlMap[r.manager_id] = r.total; });
                const managerScores = managerActions.map(r => ({
                    name: r.user_name || 'Noma\'lum',
                    actions: r.actions,
                    activeDays: r.activeDays,
                    leadsAdded: mlMap[r.user_id] || 0,
                }));

                // 4. Year-over-year (if data exists)
                const curYear = cmpParts.year;
                const yoyCur = db.prepare("SELECT COALESCE(SUM(income),0) as income, COALESCE(SUM(expense),0) as expense FROM finance WHERE substr(date_ymd,1,4)=?" + bs.sql).get(String(curYear), ...bs.params);
                const yoyPrev = db.prepare("SELECT COALESCE(SUM(income),0) as income, COALESCE(SUM(expense),0) as expense FROM finance WHERE substr(date_ymd,1,4)=?" + bs.sql).get(String(curYear - 1), ...bs.params);
                const yoyCurLeads = db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE substr(date_ymd,1,4)=?" + bs.sql).get(String(curYear), ...bs.params);
                const yoyPrevLeads = db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE substr(date_ymd,1,4)=?" + bs.sql).get(String(curYear - 1), ...bs.params);

                return res.json({
                    period: { current: periodCur, previous: periodPrev, curYm, prevYm },
                    subjectRanking,
                    managerScores,
                    yoy: {
                        current: { year: curYear, income: yoyCur.income, expense: yoyCur.expense, leads: yoyCurLeads.v },
                        previous: { year: curYear - 1, income: yoyPrev.income, expense: yoyPrev.expense, leads: yoyPrevLeads.v },
                    }
                });
            }

            case 'heatmap': {
                if (!requirePerm(req, res, 'analytics')) return;
                const bs = branchScope(req, branchId);
                const metric = (req.query.metric || 'leads').trim();
                const d90ago = tashkentDaysAgo(90);

                let rows;
                switch (metric) {
                    case 'income':
                        rows = db.prepare("SELECT date_ymd as day, SUM(income) as val FROM finance WHERE date_ymd >= ?" + bs.sql + " GROUP BY date_ymd ORDER BY date_ymd").all(d90ago, ...bs.params);
                        break;
                    case 'expense':
                        rows = db.prepare("SELECT date_ymd as day, SUM(expense) as val FROM finance WHERE date_ymd >= ?" + bs.sql + " GROUP BY date_ymd ORDER BY date_ymd").all(d90ago, ...bs.params);
                        break;
                    case 'attendance':
                        rows = db.prepare("SELECT date_ymd as day, CASE WHEN SUM(expected)>0 THEN ROUND(SUM(attended)*100.0/SUM(expected)) ELSE 0 END as val FROM attendance WHERE date_ymd >= ?" + bs.sql + " GROUP BY date_ymd ORDER BY date_ymd").all(d90ago, ...bs.params);
                        break;
                    case 'leads':
                        rows = db.prepare("SELECT date_ymd as day, SUM(count) as val FROM leads WHERE date_ymd >= ?" + bs.sql + " GROUP BY date_ymd ORDER BY date_ymd").all(d90ago, ...bs.params);
                        break;
                    default:
                        return res.status(400).json({ error: "Noto'g'ri metric qiymati: " + metric });
                }

                const tdYmd = todayYmd();
                const todayLeads = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM leads WHERE date_ymd = ?' + bs.sql).get(tdYmd, ...bs.params).v;
                const todayIncome = db.prepare('SELECT COALESCE(SUM(income),0) as v FROM finance WHERE date_ymd = ?' + bs.sql).get(tdYmd, ...bs.params).v;
                const todayExpense = db.prepare('SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE date_ymd = ?' + bs.sql).get(tdYmd, ...bs.params).v;

                const d14ago = tashkentDaysAgo(14);
                const sparkLeads = db.prepare("SELECT date_ymd as day, SUM(count) as val FROM leads WHERE date_ymd >= ?" + bs.sql + " GROUP BY date_ymd ORDER BY date_ymd").all(d14ago, ...bs.params);
                const sparkIncome = db.prepare("SELECT date_ymd as day, SUM(income) as val FROM finance WHERE date_ymd >= ?" + bs.sql + " GROUP BY date_ymd ORDER BY date_ymd").all(d14ago, ...bs.params);

                return res.json({
                    heatmap: rows,
                    metric,
                    today: { leads: todayLeads, income: todayIncome, expense: todayExpense, date: tdYmd },
                    sparklines: { leads: sparkLeads, income: sparkIncome }
                });
            }

            case 'kpi_targets': {
                if (!requirePerm(req, res, 'analytics')) return;
                const month = (req.query.month || '').trim();
                if (month) return res.json(db.prepare('SELECT * FROM kpi_targets WHERE month = ?').all(month));
                return res.json(db.prepare('SELECT * FROM kpi_targets ORDER BY month DESC').all());
            }

            // ─── KPI Chain Endpoints ─────────────────────────────
            case 'kpi_my': {
                // Get KPIs assigned TO current user
                const month = (req.query.month || '').trim();
                const tid = req.perms.telegram_id;
                let assignments;
                if (month) {
                    assignments = db.prepare('SELECT ka.*, u.name as assigned_by_name FROM kpi_assignments ka LEFT JOIN users u ON ka.assigned_by = u.telegram_id WHERE ka.assigned_to = ? AND ka.month = ? ORDER BY ka.metric').all(tid, month);
                } else {
                    assignments = db.prepare('SELECT ka.*, u.name as assigned_by_name FROM kpi_assignments ka LEFT JOIN users u ON ka.assigned_by = u.telegram_id WHERE ka.assigned_to = ? ORDER BY ka.month DESC, ka.metric').all(tid);
                }
                return res.json(assignments);
            }

            case 'kpi_subordinates': {
                // Get KPIs assigned BY current user (CEO sees managers, manager sees users)
                if (!req.perms.is_ceo && !req.perms.is_manager) return res.status(403).json({ error: "Ruxsat yo'q" });
                const month = (req.query.month || '').trim();
                const tid = req.perms.telegram_id;
                let rows;
                if (req.perms.is_ceo) {
                    // CEO sees all KPI assignments they created
                    rows = month
                        ? db.prepare('SELECT ka.*, u.name as user_name FROM kpi_assignments ka LEFT JOIN users u ON ka.assigned_to = u.telegram_id WHERE ka.assigned_by = ? AND ka.month = ? ORDER BY u.name, ka.metric').all(tid, month)
                        : db.prepare('SELECT ka.*, u.name as user_name FROM kpi_assignments ka LEFT JOIN users u ON ka.assigned_to = u.telegram_id WHERE ka.assigned_by = ? ORDER BY ka.month DESC, u.name, ka.metric').all(tid);
                } else {
                    // Manager sees KPIs they assigned to simple users
                    rows = month
                        ? db.prepare('SELECT ka.*, u.name as user_name FROM kpi_assignments ka LEFT JOIN users u ON ka.assigned_to = u.telegram_id WHERE ka.assigned_by = ? AND ka.month = ? ORDER BY u.name, ka.metric').all(tid, month)
                        : db.prepare('SELECT ka.*, u.name as user_name FROM kpi_assignments ka LEFT JOIN users u ON ka.assigned_to = u.telegram_id WHERE ka.assigned_by = ? ORDER BY ka.month DESC, u.name, ka.metric').all(tid);
                }
                return res.json(rows);
            }

            case 'kpi_progress': {
                // Calculate actual vs target for a user in a given month
                const month = (req.query.month || '').trim();
                const targetUser = (req.query.user_id || req.perms.telegram_id).trim();
                // Permission check: can only view own, or subordinates'
                if (targetUser !== req.perms.telegram_id && !req.perms.is_ceo && !req.perms.is_manager) {
                    return res.status(403).json({ error: "Ruxsat yo'q" });
                }
                if (!month) return res.status(400).json({ error: 'Oy kiriting' });

                const assignments = db.prepare('SELECT * FROM kpi_assignments WHERE assigned_to = ? AND month = ?').all(targetUser, month);
                if (!assignments.length) return res.json({ user_id: targetUser, month, metrics: [], score: 0 });

                // Calculate date range for the month
                const mStart = monthStartYmd(month);
                const mEnd = monthEndYmd(month);

                const metrics = assignments.map(a => {
                    let actual = 0;
                    const bid = a.branch_id;
                    const bFilter = bid > 0 ? ' AND branch_id = ?' : '';
                    const bParams = bid > 0 ? [bid] : [];
                    const uFilter = ' AND manager_id = ?';

                    switch (a.metric) {
                        case 'leads':
                            actual = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM leads WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, targetUser, ...bParams)?.v || 0;
                            break;
                        case 'income':
                            actual = db.prepare('SELECT COALESCE(SUM(income),0) as v FROM finance WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, targetUser, ...bParams)?.v || 0;
                            break;
                        case 'expense':
                            actual = db.prepare('SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, targetUser, ...bParams)?.v || 0;
                            break;
                        case 'attendance':
                            const att = db.prepare('SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, targetUser, ...bParams);
                            actual = att && att.exp > 0 ? Math.round(att.att / att.exp * 100) : 0;
                            break;
                        case 'debtors':
                            actual = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM debtors WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, targetUser, ...bParams)?.v || 0;
                            break;
                        case 'rejections':
                            actual = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, targetUser, ...bParams)?.v || 0;
                            break;
                        case 'problems_solved':
                            actual = db.prepare("SELECT COUNT(*) as v FROM problems WHERE status = 'solved' AND date_ymd >= ? AND date_ymd <= ?" + uFilter + bFilter).get(mStart, mEnd, targetUser, ...bParams)?.v || 0;
                            break;
                    }

                    const pct = a.target_value > 0 ? Math.round(actual / a.target_value * 100) : 0;
                    // For 'down' direction, invert: lower actual = better score
                    const score = a.direction === 'down'
                        ? (a.target_value > 0 ? Math.max(0, Math.round((2 * a.target_value - actual) / a.target_value * 100)) : 0)
                        : pct;

                    return { metric: a.metric, target: a.target_value, actual, pct, score, direction: a.direction, branch_id: a.branch_id };
                });

                const avgScore = metrics.length > 0 ? Math.round(metrics.reduce((s, m) => s + m.score, 0) / metrics.length) : 0;

                return res.json({ user_id: targetUser, month, metrics, score: avgScore });
            }

            case 'kpi_leaderboard': {
                // Leaderboard: ranked list of subordinates by KPI score (or auto-rank fallback)
                if (!req.perms.is_ceo && !req.perms.is_manager) return res.status(403).json({ error: "Ruxsat yo'q" });
                const month = (req.query.month || '').trim();
                if (!month) return res.status(400).json({ error: 'Oy kiriting' });

                const tid = req.perms.telegram_id;
                const mStart = monthStartYmd(month);
                const mEnd = monthEndYmd(month);

                // Find users who have KPIs assigned by current user
                const assignedUsers = db.prepare('SELECT DISTINCT ka.assigned_to, u.name, u.role FROM kpi_assignments ka LEFT JOIN users u ON ka.assigned_to = u.telegram_id WHERE ka.assigned_by = ? AND ka.month = ?').all(tid, month);

                let board = [];
                let mode = 'kpi'; // 'kpi' or 'auto'

                if (assignedUsers.length > 0) {
                    // KPI mode: rank by assigned KPI scores
                    board = assignedUsers.map(u => {
                        const assignments = db.prepare('SELECT * FROM kpi_assignments WHERE assigned_to = ? AND month = ? AND assigned_by = ?').all(u.assigned_to, month, tid);
                        const metrics = assignments.map(a => {
                            let actual = 0;
                            const bid = a.branch_id;
                            const bFilter = bid > 0 ? ' AND branch_id = ?' : '';
                            const bParams = bid > 0 ? [bid] : [];
                            const uFilter = ' AND manager_id = ?';
                            switch (a.metric) {
                                case 'leads': actual = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM leads WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, u.assigned_to, ...bParams)?.v || 0; break;
                                case 'income': actual = db.prepare('SELECT COALESCE(SUM(income),0) as v FROM finance WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, u.assigned_to, ...bParams)?.v || 0; break;
                                case 'expense': actual = db.prepare('SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, u.assigned_to, ...bParams)?.v || 0; break;
                                case 'attendance': { const at2 = db.prepare('SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, u.assigned_to, ...bParams); actual = at2 && at2.exp > 0 ? Math.round(at2.att / at2.exp * 100) : 0; break; }
                                case 'debtors': actual = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM debtors WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, u.assigned_to, ...bParams)?.v || 0; break;
                                case 'rejections': actual = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE date_ymd >= ? AND date_ymd <= ?' + uFilter + bFilter).get(mStart, mEnd, u.assigned_to, ...bParams)?.v || 0; break;
                                case 'problems_solved': actual = db.prepare("SELECT COUNT(*) as v FROM problems WHERE status = 'solved' AND date_ymd >= ? AND date_ymd <= ?" + uFilter + bFilter).get(mStart, mEnd, u.assigned_to, ...bParams)?.v || 0; break;
                            }
                            const pct = a.target_value > 0 ? Math.round(actual / a.target_value * 100) : 0;
                            const score = a.direction === 'down'
                                ? (a.target_value > 0 ? Math.max(0, Math.round((2 * a.target_value - actual) / a.target_value * 100)) : 0)
                                : pct;
                            return { metric: a.metric, target: a.target_value, actual, pct, score, direction: a.direction };
                        });
                        const avgScore = metrics.length > 0 ? Math.round(metrics.reduce((s, m) => s + m.score, 0) / metrics.length) : 0;
                        return { user_id: u.assigned_to, name: u.name || '', role: u.role || 'user', score: avgScore, metrics };
                    });
                } else {
                    // Auto-rank fallback: rank subordinates by activity when no KPIs set
                    mode = 'auto';
                    // Get subordinate users
                    let subUsers;
                    if (req.perms.is_ceo) {
                        subUsers = db.prepare("SELECT telegram_id, name, role FROM users WHERE role IN ('manager','user')").all();
                    } else {
                        // Manager: get simple users in their branches
                        const myBranches = req.perms.allowed_branches;
                        if (myBranches.length === 0) return res.json({ month, mode, leaderboard: [] });
                        subUsers = db.prepare("SELECT DISTINCT u.telegram_id, u.name, u.role FROM users u INNER JOIN user_branches ub ON u.telegram_id = ub.user_id WHERE u.role = 'user' AND ub.branch_id IN (" + myBranches.map(() => '?').join(',') + ")").all(...myBranches);
                    }

                    board = subUsers.map(u => {
                        const uid = u.telegram_id;
                        // Leads (30% weight)
                        const leads = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM leads WHERE date_ymd >= ? AND date_ymd <= ? AND manager_id = ?').get(mStart, mEnd, uid)?.v || 0;
                        // Income (25% weight)
                        const income = db.prepare('SELECT COALESCE(SUM(income),0) as v FROM finance WHERE date_ymd >= ? AND date_ymd <= ? AND manager_id = ?').get(mStart, mEnd, uid)?.v || 0;
                        // Attendance % (20% weight)
                        const attRow = db.prepare('SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd >= ? AND date_ymd <= ? AND manager_id = ?').get(mStart, mEnd, uid);
                        const attPct = attRow && attRow.exp > 0 ? Math.round(attRow.att / attRow.exp * 100) : 0;
                        // Problems solved (15% weight)
                        const solved = db.prepare("SELECT COUNT(*) as v FROM problems WHERE status = 'solved' AND date_ymd >= ? AND date_ymd <= ? AND manager_id = ?").get(mStart, mEnd, uid)?.v || 0;
                        // Active days (10% weight)
                        const activeDays = db.prepare('SELECT COUNT(DISTINCT date_ymd) as v FROM audit_log WHERE date_ymd >= ? AND date_ymd <= ? AND user_id = ?').get(mStart, mEnd, uid)?.v || 0;

                        // Normalize to 0-100 scale (will be relative after sorting)
                        const metrics = [
                            { metric: 'leads', actual: leads, weight: 30 },
                            { metric: 'income', actual: income, weight: 25 },
                            { metric: 'attendance', actual: attPct, weight: 20 },
                            { metric: 'problems_solved', actual: solved, weight: 15 },
                            { metric: 'active_days', actual: activeDays, weight: 10 },
                        ];

                        return { user_id: uid, name: u.name || '', role: u.role || 'user', score: 0, metrics };
                    });

                    // Normalize scores relative to max in each metric
                    const metricKeys = ['leads', 'income', 'attendance', 'problems_solved', 'active_days'];
                    const weights = [30, 25, 20, 15, 10];
                    metricKeys.forEach((key, idx) => {
                        const maxVal = Math.max(...board.map(u => u.metrics[idx].actual), 1);
                        board.forEach(u => {
                            u.metrics[idx].normalized = Math.round(u.metrics[idx].actual / maxVal * 100);
                        });
                    });
                    board.forEach(u => {
                        u.score = Math.round(u.metrics.reduce((s, m, i) => s + m.normalized * weights[i] / 100, 0));
                    });
                }

                board.sort((a, b) => b.score - a.score);
                board.forEach((u, i) => { u.rank = i + 1; });

                return res.json({ month, mode, leaderboard: board });
            }

            case 'audit_log': {
                if (!req.perms || !req.perms.is_ceo) return res.status(403).json({ error: "Ruxsat yo'q" });
                const section = (req.query.section || '').trim();
                let rows;
                if (section) {
                    rows = db.prepare('SELECT * FROM audit_log WHERE section = ? ORDER BY id DESC LIMIT 100').all(section);
                } else {
                    rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all();
                }
                return res.json(rows);
            }

            // ─── CSV Download Endpoints ───────────────────────────
            case 'csv_debtors': {
                if (!requirePerm(req, res, 'debtors')) return;
                const bs = branchScope(req, branchId);
                const rows = db.prepare("SELECT month, SUM(count) as total_count, SUM(amount) as total_amount FROM debtors WHERE month != ''" + bs.sql + " GROUP BY month").all(...bs.params);
                const BOM = '\uFEFF';
                const safeC = (v) => { const s = String(v ?? ''); return /^[=+@\-\t\r]/.test(s) ? "'" + s : s; };
                const csv = BOM + 'Oy,Soni,Summa\n' + rows.map(r =>
                    '"' + safeC(r.month) + '",' + (r.total_count || 0) + ',' + (r.total_amount || 0)
                ).join('\n');
                res.set('Content-Type', 'text/csv; charset=utf-8');
                res.set('Content-Disposition', 'attachment; filename="qarzdorlar_' + today + '.csv"');
                return res.send(csv);
            }

            case 'csv_finance': {
                if (!requirePerm(req, res, 'finance')) return;
                const bsCsvFin = branchScope(req, branchId);
                const bsCsvFinF = { sql: bsCsvFin.sql.replace(/branch_id/g, 'f.branch_id'), params: bsCsvFin.params };
                const fRows = db.prepare("SELECT f.date_ymd, f.category, f.expense_type, f.income, f.expense, f.comment, u.name as user_name FROM finance f LEFT JOIN users u ON CAST(f.manager_id AS INTEGER) = CAST(u.telegram_id AS INTEGER) WHERE f.date_ymd >= ? AND f.date_ymd <= ?" + bsCsvFinF.sql + " ORDER BY f.created_at DESC").all(from, to, ...bsCsvFinF.params);
                const BOM = '\uFEFF';
                const safeCell = (v) => { const s = String(v ?? ''); return /^[=+@\-\t\r]/.test(s) ? "'" + s : s; };
                const csv = BOM + 'Sana,Kategoriya,Turi,Kirim,Chiqim,Izoh,Menejer\n' + fRows.map(r =>
                    [r.date_ymd, r.category, r.expense_type || '', r.income || '', r.expense || '', safeCell(r.comment || ''), r.user_name || ''].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')
                ).join('\n');
                res.set('Content-Type', 'text/csv; charset=utf-8');
                res.set('Content-Disposition', 'attachment; filename="moliya_' + from + '_' + to + '.csv"');
                return res.send(csv);
            }

            case 'csv_report': {
                if (!requirePerm(req, res, 'reports')) return;
                const bsCsvRep = branchScope(req, branchId);
                let rFrom = (req.query.from || '').trim();
                let rTo = (req.query.to || '').trim();
                if (!rFrom) return res.status(400).json({ error: 'Sana kiritilmadi' });
                if (!rTo) rTo = rFrom;
                if (!/^\d{4}-\d{2}-\d{2}$/.test(rFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(rTo)) return res.status(400).json({ error: "Noto'g'ri sana formati" });
                const cLeads = db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ? AND date_ymd <= ?" + bsCsvRep.sql + " GROUP BY subject HAVING total > 0 ORDER BY total DESC").all(rFrom, rTo, ...bsCsvRep.params);
                const cRej = db.prepare("SELECT subject, SUM(count) as total FROM rejections WHERE date_ymd >= ? AND date_ymd <= ?" + bsCsvRep.sql + " GROUP BY subject HAVING total > 0 ORDER BY total DESC").all(rFrom, rTo, ...bsCsvRep.params);
                const cDebt = db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE date_ymd >= ? AND date_ymd <= ?' + bsCsvRep.sql).get(rFrom, rTo, ...bsCsvRep.params);
                const cFin = db.prepare("SELECT COALESCE(SUM(income),0) as income, COALESCE(SUM(expense),0) as expense FROM finance WHERE date_ymd >= ? AND date_ymd <= ?" + bsCsvRep.sql).get(rFrom, rTo, ...bsCsvRep.params);
                const cAtt = db.prepare("SELECT COALESCE(SUM(expected),0) as expected, COALESCE(SUM(attended),0) as attended FROM attendance WHERE date_ymd >= ? AND date_ymd <= ?" + bsCsvRep.sql).get(rFrom, rTo, ...bsCsvRep.params);
                const csvRows = [];
                const safeCR = (v) => { const s = String(v ?? ''); return /^[=+@\-\t\r]/.test(s) ? "'" + s : s; };
                csvRows.push(['Leadlar (jami)', cLeads.reduce((s, r) => s + r.total, 0)]);
                cLeads.forEach(r => csvRows.push(['  ' + safeCR(r.subject), r.total]));
                csvRows.push(['Rad etilganlar (jami)', cRej.reduce((s, r) => s + r.total, 0)]);
                cRej.forEach(r => csvRows.push(['  ' + safeCR(r.subject), r.total]));
                csvRows.push(['Qarzdorlar soni', cDebt.cnt]);
                csvRows.push(['Qarzdorlar summasi', cDebt.amt]);
                csvRows.push(['Kirim', cFin.income]);
                csvRows.push(['Chiqim', cFin.expense]);
                csvRows.push(['Foyda', cFin.income - cFin.expense]);
                csvRows.push(['Davomat kutilgan', cAtt.expected]);
                csvRows.push(['Davomat kelgan', cAtt.attended]);
                const attPct = cAtt.expected > 0 ? Math.round(cAtt.attended / cAtt.expected * 100) : 0;
                csvRows.push(['Davomat %', attPct + '%']);
                const BOM = '\uFEFF';
                const csv = BOM + "Ko'rsatkich,Qiymat\n" + csvRows.map(r => '"' + String(r[0]).replace(/"/g, '""') + '",' + r[1]).join('\n');
                res.set('Content-Type', 'text/csv; charset=utf-8');
                res.set('Content-Disposition', 'attachment; filename="hisobot_' + rFrom + '_' + rTo + '.csv"');
                return res.send(csv);
            }

            // ─── Section PDF Download Endpoints ──────────────────
            case 'pdf_debtors': {
                if (!requirePerm(req, res, 'debtors')) return;
                const { generateSectionPdf } = require('./pdf_generator');
                const fs = require('fs');
                const pdfData = {
                    summary: db.prepare('SELECT SUM(count) as total_count, SUM(amount) as total_amount FROM debtors' + (branchId ? ' WHERE branch_id = ?' : '')).get(...(branchId ? [branchId] : [])),
                    byMonth: db.prepare("SELECT month, SUM(count) as total_count, SUM(amount) as total_amount FROM debtors WHERE month != ''" + (branchId ? ' AND branch_id = ?' : '') + ' GROUP BY month').all(...(branchId ? [branchId] : [])),
                };
                const pdfPath = '/tmp/qarzdorlar_' + require('crypto').randomBytes(8).toString('hex') + '.pdf';
                generateSectionPdf('debtors', pdfData, pdfPath, 'Qarzdorlar hisoboti').then(() => {
                    res.download(pdfPath, 'qarzdorlar_' + today + '.pdf', () => { setTimeout(() => fs.unlink(pdfPath, () => {}), 5000); });
                }).catch(e => { console.error('[TWA PDF debtors]', e); if (!res.headersSent) res.status(500).json({ error: 'PDF xatolik' }); });
                return;
            }

            case 'pdf_finance': {
                if (!requirePerm(req, res, 'finance')) return;
                const { generateSectionPdf } = require('./pdf_generator');
                const fs = require('fs');
                const fRows = db.prepare("SELECT f.date_ymd, f.category, f.expense_type, f.income, f.expense, f.comment, u.name as user_name FROM finance f LEFT JOIN users u ON CAST(f.manager_id AS INTEGER) = CAST(u.telegram_id AS INTEGER) WHERE f.date_ymd >= ? AND f.date_ymd <= ? ORDER BY f.created_at DESC").all(from, to);
                const fSummary = db.prepare("SELECT SUM(income) as income, SUM(expense) as expense FROM finance WHERE date_ymd >= ? AND date_ymd <= ?").get(from, to);
                const pdfPath = '/tmp/moliya_' + require('crypto').randomBytes(8).toString('hex') + '.pdf';
                generateSectionPdf('finance', { rows: fRows, summary: fSummary, from, to }, pdfPath, `Moliya hisoboti: ${from} — ${to}`).then(() => {
                    res.download(pdfPath, 'moliya_' + from + '_' + to + '.pdf', () => { setTimeout(() => fs.unlink(pdfPath, () => {}), 5000); });
                }).catch(e => { console.error('[TWA PDF finance]', e); if (!res.headersSent) res.status(500).json({ error: 'PDF xatolik' }); });
                return;
            }

            case 'pdf_leads': {
                if (!requirePerm(req, res, 'leads')) return;
                const { generateSectionPdf } = require('./pdf_generator');
                const fs = require('fs');
                const lBySubject = db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ? AND date_ymd <= ? GROUP BY subject HAVING total > 0 ORDER BY total DESC").all(from, to);
                const lRows = db.prepare("SELECT date_ymd, subject, count FROM leads WHERE date_ymd >= ? AND date_ymd <= ? ORDER BY date_ymd DESC").all(from, to);
                const pdfPath = '/tmp/leadlar_' + require('crypto').randomBytes(8).toString('hex') + '.pdf';
                generateSectionPdf('leads', { bySubject: lBySubject, total: lBySubject.reduce((s, r) => s + r.total, 0), rows: lRows }, pdfPath, `Leadlar hisoboti: ${from} — ${to}`).then(() => {
                    res.download(pdfPath, 'leadlar_' + from + '_' + to + '.pdf', () => { setTimeout(() => fs.unlink(pdfPath, () => {}), 5000); });
                }).catch(e => { console.error('[TWA PDF leads]', e); if (!res.headersSent) res.status(500).json({ error: 'PDF xatolik' }); });
                return;
            }

            case 'pdf_attendance': {
                if (!requirePerm(req, res, 'attendance')) return;
                const { generateSectionPdf } = require('./pdf_generator');
                const fs = require('fs');
                const aSummary = db.prepare("SELECT SUM(expected) as expected, SUM(attended) as attended FROM attendance WHERE date_ymd >= ? AND date_ymd <= ?").get(from, to);
                const aRows = db.prepare("SELECT date_ymd, SUM(expected) as expected, SUM(attended) as attended FROM attendance WHERE date_ymd >= ? AND date_ymd <= ? GROUP BY date_ymd ORDER BY date_ymd DESC").all(from, to);
                const pdfPath = '/tmp/davomat_' + require('crypto').randomBytes(8).toString('hex') + '.pdf';
                generateSectionPdf('attendance', { summary: aSummary, rows: aRows }, pdfPath, `Davomat hisoboti: ${from} — ${to}`).then(() => {
                    res.download(pdfPath, 'davomat_' + from + '_' + to + '.pdf', () => { setTimeout(() => fs.unlink(pdfPath, () => {}), 5000); });
                }).catch(e => { console.error('[TWA PDF attendance]', e); if (!res.headersSent) res.status(500).json({ error: 'PDF xatolik' }); });
                return;
            }

            case 'pdf_rejections': {
                if (!requirePerm(req, res, 'rejections')) return;
                const { generateSectionPdf } = require('./pdf_generator');
                const fs = require('fs');
                const rBySubject = db.prepare("SELECT subject, SUM(count) as total FROM rejections WHERE date_ymd >= ? AND date_ymd <= ? GROUP BY subject HAVING total > 0 ORDER BY total DESC").all(from, to);
                const pdfPath = '/tmp/rad_etilgan_' + require('crypto').randomBytes(8).toString('hex') + '.pdf';
                generateSectionPdf('rejections', { bySubject: rBySubject, total: rBySubject.reduce((s, r) => s + r.total, 0) }, pdfPath, `Rad etilganlar: ${from} — ${to}`).then(() => {
                    res.download(pdfPath, 'rad_etilganlar_' + from + '_' + to + '.pdf', () => { setTimeout(() => fs.unlink(pdfPath, () => {}), 5000); });
                }).catch(e => { console.error('[TWA PDF rejections]', e); if (!res.headersSent) res.status(500).json({ error: 'PDF xatolik' }); });
                return;
            }

            case 'pdf_problems': {
                if (!requirePerm(req, res, 'problems')) return;
                const { generateSectionPdf } = require('./pdf_generator');
                const fs = require('fs');
                const pRows = db.prepare("SELECT branch, type, issue, timestamp, date_ymd FROM problems WHERE status != 'solved' ORDER BY id DESC").all();
                const pdfPath = '/tmp/muammolar_' + require('crypto').randomBytes(8).toString('hex') + '.pdf';
                generateSectionPdf('problems', { rows: pRows }, pdfPath, 'Ochiq muammolar').then(() => {
                    res.download(pdfPath, 'muammolar_' + today + '.pdf', () => { setTimeout(() => fs.unlink(pdfPath, () => {}), 5000); });
                }).catch(e => { console.error('[TWA PDF problems]', e); if (!res.headersSent) res.status(500).json({ error: 'PDF xatolik' }); });
                return;
            }

            case 'pdf_rooms': {
                if (!requirePerm(req, res, 'rooms')) return;
                const { generateSectionPdf } = require('./pdf_generator');
                const fs = require('fs');
                const rRooms = db.prepare('SELECT branch, room, days, time, period, capacity, price_per_student FROM empty_rooms ORDER BY branch, room').all();
                const rPotential = rRooms.reduce((s, r) => s + (r.capacity || 0) * (r.price_per_student || 0), 0);
                const pdfPath = '/tmp/bosh_xonalar_' + require('crypto').randomBytes(8).toString('hex') + '.pdf';
                generateSectionPdf('rooms', { rooms: rRooms, total: rRooms.length, potential: rPotential }, pdfPath, "Bo'sh xonalar hisoboti").then(() => {
                    res.download(pdfPath, 'bosh_xonalar_' + today + '.pdf', () => { setTimeout(() => fs.unlink(pdfPath, () => {}), 5000); });
                }).catch(e => { console.error('[TWA PDF rooms]', e); if (!res.headersSent) res.status(500).json({ error: 'PDF xatolik' }); });
                return;
            }


            case 'branch_trends': {
                if (!requirePerm(req, res, 'analytics')) return;
                const bs = branchScope(req, branchId);

                // Parse period filter (same logic as dashboard)
                const qMonth = (req.query.month || '').trim();
                const qQuarter = (req.query.quarter || '').trim();
                const qRange = (req.query.range || '').trim();
                const qYear = (req.query.year || '').trim();
                let btFilterStart, btFilterEnd, btFilterMonths = [], btPrevStart, btPrevEnd;
                const btParts = tashkentDateParts();
                const btCurMonth = UZ_MONTHS[btParts.month] + ' ' + btParts.year;

                if (qQuarter) {
                    const qp = qQuarter.split(' ');
                    const qNum = parseInt((qp[0]||'').replace('Q',''));
                    const qYr = parseInt(qp[1]);
                    if (qNum >= 1 && qNum <= 4 && qYr) {
                        const fm = (qNum - 1) * 3 + 1;
                        btFilterStart = `${qYr}-${String(fm).padStart(2,'0')}-01`;
                        const lm = fm + 2;
                        const ld = new Date(Date.UTC(qYr, lm, 0)).getUTCDate();
                        btFilterEnd = `${qYr}-${String(lm).padStart(2,'0')}-${String(ld).padStart(2,'0')}`;
                        for (let m = fm; m <= fm + 2; m++) btFilterMonths.push(UZ_MONTHS[m] + ' ' + qYr);
                        // Previous quarter
                        const pqNum = qNum === 1 ? 4 : qNum - 1;
                        const pqYr = qNum === 1 ? qYr - 1 : qYr;
                        const pfm = (pqNum - 1) * 3 + 1;
                        btPrevStart = `${pqYr}-${String(pfm).padStart(2,'0')}-01`;
                        const plm = pfm + 2;
                        const pld = new Date(Date.UTC(pqYr, plm, 0)).getUTCDate();
                        btPrevEnd = `${pqYr}-${String(plm).padStart(2,'0')}-${String(pld).padStart(2,'0')}`;
                    }
                } else if (qRange) {
                    const rangeMap = { last3: 3, last6: 6, last12: 12 };
                    const n = rangeMap[qRange] || 6;
                    const endDate = new Date(Date.UTC(btParts.year, btParts.month, 0));
                    btFilterEnd = `${btParts.year}-${String(btParts.month).padStart(2,'0')}-${String(endDate.getUTCDate()).padStart(2,'0')}`;
                    const startDate = new Date(Date.UTC(btParts.year, btParts.month - n, 1));
                    btFilterStart = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2,'0')}-01`;
                    for (let i = 0; i < n; i++) {
                        const d = new Date(Date.UTC(btParts.year, btParts.month - 1 - i, 1));
                        btFilterMonths.push(UZ_MONTHS[d.getUTCMonth() + 1] + ' ' + d.getUTCFullYear());
                    }
                    // Previous range
                    const prevEnd = new Date(Date.UTC(btParts.year, btParts.month - n, 0));
                    btPrevEnd = `${prevEnd.getUTCFullYear()}-${String(prevEnd.getUTCMonth() + 1).padStart(2,'0')}-${String(prevEnd.getUTCDate()).padStart(2,'0')}`;
                    const prevStart = new Date(Date.UTC(btParts.year, btParts.month - n * 2, 1));
                    btPrevStart = `${prevStart.getUTCFullYear()}-${String(prevStart.getUTCMonth() + 1).padStart(2,'0')}-01`;
                } else if (qYear) {
                    const yr = parseInt(qYear);
                    btFilterStart = `${yr}-01-01`;
                    btFilterEnd = `${yr}-12-31`;
                    for (let m = 1; m <= 12; m++) btFilterMonths.push(UZ_MONTHS[m] + ' ' + yr);
                    btPrevStart = `${yr - 1}-01-01`;
                    btPrevEnd = `${yr - 1}-12-31`;
                } else {
                    // Single month (default to current)
                    const m = qMonth || btCurMonth;
                    btFilterStart = monthStartYmd(m);
                    btFilterEnd = monthEndYmd(m);
                    btFilterMonths = [m];
                    // Previous month
                    const mp = m.trim().split(/\s+/);
                    const mNum = MONTH_NUMS[mp[0]];
                    const mYr = parseInt(mp[1]);
                    const pmNum = mNum === 1 ? 12 : mNum - 1;
                    const pmYr = mNum === 1 ? mYr - 1 : mYr;
                    const prevM = UZ_MONTHS[pmNum] + ' ' + pmYr;
                    btPrevStart = monthStartYmd(prevM);
                    btPrevEnd = monthEndYmd(prevM);
                }
                if (!btFilterStart) {
                    btFilterStart = monthStartYmd();
                    btFilterEnd = monthEndYmd();
                    btFilterMonths = [btCurMonth];
                    const pmNum = btParts.month === 1 ? 12 : btParts.month - 1;
                    const pmYr = btParts.month === 1 ? btParts.year - 1 : btParts.year;
                    btPrevStart = monthStartYmd(UZ_MONTHS[pmNum] + ' ' + pmYr);
                    btPrevEnd = monthEndYmd(UZ_MONTHS[pmNum] + ' ' + pmYr);
                }

                const df = ' AND date_ymd >= ? AND date_ymd <= ?';
                const dfp = [btFilterStart, btFilterEnd];

                // Build timeline: group by week if single month, by month if multi-month
                const isMultiMonth = btFilterMonths.length > 1;
                let timelineRows;
                if (isMultiMonth) {
                    // Group by month
                    const fin = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(income) as income, SUM(expense) as expense FROM finance WHERE 1=1" + df + bs.sql + " GROUP BY ym ORDER BY ym").all(...dfp, ...bs.params);
                    const leads = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(count) as total FROM leads WHERE 1=1" + df + bs.sql + " GROUP BY ym ORDER BY ym").all(...dfp, ...bs.params);
                    const rej = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(count) as total FROM rejections WHERE 1=1" + df + bs.sql + " GROUP BY ym ORDER BY ym").all(...dfp, ...bs.params);
                    const debt = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(amount) as amt FROM debtors WHERE 1=1" + df + bs.sql + " GROUP BY ym ORDER BY ym").all(...dfp, ...bs.params);
                    const att = db.prepare("SELECT substr(date_ymd,1,7) as ym, SUM(expected) as exp, SUM(attended) as att FROM attendance WHERE 1=1" + df + bs.sql + " GROUP BY ym ORDER BY ym").all(...dfp, ...bs.params);

                    const fMap = {}, lMap = {}, rMap = {}, dMap = {}, aMap = {};
                    fin.forEach(r => fMap[r.ym] = r);
                    leads.forEach(r => lMap[r.ym] = r);
                    rej.forEach(r => rMap[r.ym] = r);
                    debt.forEach(r => dMap[r.ym] = r);
                    att.forEach(r => aMap[r.ym] = r);

                    const allYms = [...new Set([...Object.keys(fMap), ...Object.keys(lMap), ...Object.keys(rMap), ...Object.keys(dMap), ...Object.keys(aMap)])].sort();
                    timelineRows = allYms.map(ym => {
                        const parts = ym.split('-');
                        const mIdx = parseInt(parts[1]);
                        const label = UZ_MONTHS[mIdx] ? UZ_MONTHS[mIdx].substring(0, 3) : ym;
                        const f = fMap[ym] || {};
                        const l = lMap[ym] || {};
                        const r = rMap[ym] || {};
                        const d = dMap[ym] || {};
                        const a = aMap[ym] || {};
                        const leadTotal = l.total || 0;
                        const rejTotal = r.total || 0;
                        const convRate = leadTotal > 0 ? Math.round((leadTotal - rejTotal) / leadTotal * 100) : 0;
                        const attPct = (a.exp || 0) > 0 ? Math.round((a.att || 0) / a.exp * 100) : 0;
                        return { label, income: f.income || 0, expense: f.expense || 0, profit: (f.income || 0) - (f.expense || 0), leads: leadTotal, rejections: rejTotal, conversionRate: convRate, debtorAmount: d.amt || 0, attPct };
                    });
                } else {
                    // Single month: group by week
                    const fin = db.prepare("SELECT date_ymd, income, expense FROM finance WHERE 1=1" + df + bs.sql + " ORDER BY date_ymd").all(...dfp, ...bs.params);
                    const leads = db.prepare("SELECT date_ymd, count as total FROM leads WHERE 1=1" + df + bs.sql + " ORDER BY date_ymd").all(...dfp, ...bs.params);
                    const rej = db.prepare("SELECT date_ymd, count as total FROM rejections WHERE 1=1" + df + bs.sql + " ORDER BY date_ymd").all(...dfp, ...bs.params);
                    const debt = db.prepare("SELECT date_ymd, amount FROM debtors WHERE 1=1" + df + bs.sql + " ORDER BY date_ymd").all(...dfp, ...bs.params);
                    const att = db.prepare("SELECT date_ymd, expected, attended FROM attendance WHERE 1=1" + df + bs.sql + " ORDER BY date_ymd").all(...dfp, ...bs.params);

                    // Group into weeks
                    function weekNum(ymd) {
                        const d = new Date(ymd + 'T00:00:00Z');
                        const day = d.getUTCDate();
                        return Math.ceil(day / 7);
                    }
                    const weeks = {};
                    const addToWeek = (rows, fn) => {
                        rows.forEach(r => {
                            const w = weekNum(r.date_ymd);
                            if (!weeks[w]) weeks[w] = { income: 0, expense: 0, leads: 0, rejections: 0, debtorAmount: 0, attExp: 0, attAtt: 0 };
                            fn(weeks[w], r);
                        });
                    };
                    addToWeek(fin, (w, r) => { w.income += r.income || 0; w.expense += r.expense || 0; });
                    addToWeek(leads, (w, r) => { w.leads += r.total || 0; });
                    addToWeek(rej, (w, r) => { w.rejections += r.total || 0; });
                    addToWeek(debt, (w, r) => { w.debtorAmount += r.amount || 0; });
                    addToWeek(att, (w, r) => { w.attExp += r.expected || 0; w.attAtt += r.attended || 0; });

                    timelineRows = Object.keys(weeks).sort((a, b) => a - b).map(w => {
                        const d = weeks[w];
                        const convRate = d.leads > 0 ? Math.round((d.leads - d.rejections) / d.leads * 100) : 0;
                        const attPct = d.attExp > 0 ? Math.round(d.attAtt / d.attExp * 100) : 0;
                        return { label: w + '-hafta', income: d.income, expense: d.expense, profit: d.income - d.expense, leads: d.leads, rejections: d.rejections, conversionRate: convRate, debtorAmount: d.debtorAmount, attPct };
                    });
                }

                // Branch name
                let btBranchName = '';
                if (branchId) {
                    const br = db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId);
                    btBranchName = br ? br.name : '';
                }

                // Period totals (current vs previous)
                const curTotals = {
                    income: db.prepare("SELECT COALESCE(SUM(income),0) as v FROM finance WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    expense: db.prepare("SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    leads: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    rejections: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    debtors: db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM debtors WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    attendance: {
                        exp: db.prepare("SELECT COALESCE(SUM(expected),0) as v FROM attendance WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                        att: db.prepare("SELECT COALESCE(SUM(attended),0) as v FROM attendance WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    }
                };
                const prevDfp = [btPrevStart, btPrevEnd];
                const prevTotals = {
                    income: db.prepare("SELECT COALESCE(SUM(income),0) as v FROM finance WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...prevDfp, ...bs.params).v,
                    expense: db.prepare("SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...prevDfp, ...bs.params).v,
                    leads: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...prevDfp, ...bs.params).v,
                    rejections: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...prevDfp, ...bs.params).v,
                    debtors: db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM debtors WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...prevDfp, ...bs.params).v,
                    attendance: {
                        exp: db.prepare("SELECT COALESCE(SUM(expected),0) as v FROM attendance WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...prevDfp, ...bs.params).v,
                        att: db.prepare("SELECT COALESCE(SUM(attended),0) as v FROM attendance WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...prevDfp, ...bs.params).v,
                    }
                };

                // Leads by subject
                const leadsBySubject = db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE 1=1" + df + bs.sql + " GROUP BY subject HAVING total > 0 ORDER BY total DESC").all(...dfp, ...bs.params);

                // Period labels
                let curLabel = btFilterMonths.join(', ') || 'Joriy';
                let prevLabel = 'Oldingi davr';
                if (btFilterMonths.length === 1) {
                    const mp = btFilterMonths[0].split(' ');
                    const pmNum = MONTH_NUMS[mp[0]] === 1 ? 12 : MONTH_NUMS[mp[0]] - 1;
                    const pmYr = MONTH_NUMS[mp[0]] === 1 ? parseInt(mp[1]) - 1 : parseInt(mp[1]);
                    prevLabel = UZ_MONTHS[pmNum] + ' ' + pmYr;
                }

                return res.json({
                    timeline: timelineRows,
                    branchName: btBranchName,
                    periodTotals: { current: curTotals, previous: prevTotals },
                    curLabel,
                    prevLabel,
                    leadsBySubject
                });
            }

            case 'branch_compare': {
                if (!requirePerm(req, res, 'analytics')) return;

                // Parse period filter
                const qMonth = (req.query.month || '').trim();
                const qQuarter = (req.query.quarter || '').trim();
                const qRange = (req.query.range || '').trim();
                const qYear = (req.query.year || '').trim();
                let bcStart, bcEnd, bcMonths = [], bcPrevStart, bcPrevEnd;
                const bcParts = tashkentDateParts();
                const bcCurMonth = UZ_MONTHS[bcParts.month] + ' ' + bcParts.year;

                if (qQuarter) {
                    const qp = qQuarter.split(' ');
                    const qNum = parseInt((qp[0]||'').replace('Q',''));
                    const qYr = parseInt(qp[1]);
                    if (qNum >= 1 && qNum <= 4 && qYr) {
                        const fm = (qNum - 1) * 3 + 1;
                        bcStart = `${qYr}-${String(fm).padStart(2,'0')}-01`;
                        const lm = fm + 2;
                        const ld = new Date(Date.UTC(qYr, lm, 0)).getUTCDate();
                        bcEnd = `${qYr}-${String(lm).padStart(2,'0')}-${String(ld).padStart(2,'0')}`;
                        for (let m = fm; m <= fm + 2; m++) bcMonths.push(UZ_MONTHS[m] + ' ' + qYr);
                        const pqNum = qNum === 1 ? 4 : qNum - 1;
                        const pqYr = qNum === 1 ? qYr - 1 : qYr;
                        const pfm = (pqNum - 1) * 3 + 1;
                        bcPrevStart = `${pqYr}-${String(pfm).padStart(2,'0')}-01`;
                        const plm = pfm + 2;
                        const pld = new Date(Date.UTC(pqYr, plm, 0)).getUTCDate();
                        bcPrevEnd = `${pqYr}-${String(plm).padStart(2,'0')}-${String(pld).padStart(2,'0')}`;
                    }
                } else if (qRange) {
                    const rangeMap = { last3: 3, last6: 6, last12: 12 };
                    const n = rangeMap[qRange] || 6;
                    const endDate = new Date(Date.UTC(bcParts.year, bcParts.month, 0));
                    bcEnd = `${bcParts.year}-${String(bcParts.month).padStart(2,'0')}-${String(endDate.getUTCDate()).padStart(2,'0')}`;
                    const startDate = new Date(Date.UTC(bcParts.year, bcParts.month - n, 1));
                    bcStart = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2,'0')}-01`;
                    for (let i = 0; i < n; i++) {
                        const d = new Date(Date.UTC(bcParts.year, bcParts.month - 1 - i, 1));
                        bcMonths.push(UZ_MONTHS[d.getUTCMonth() + 1] + ' ' + d.getUTCFullYear());
                    }
                    const prevEnd = new Date(Date.UTC(bcParts.year, bcParts.month - n, 0));
                    bcPrevEnd = `${prevEnd.getUTCFullYear()}-${String(prevEnd.getUTCMonth() + 1).padStart(2,'0')}-${String(prevEnd.getUTCDate()).padStart(2,'0')}`;
                    const prevStart = new Date(Date.UTC(bcParts.year, bcParts.month - n * 2, 1));
                    bcPrevStart = `${prevStart.getUTCFullYear()}-${String(prevStart.getUTCMonth() + 1).padStart(2,'0')}-01`;
                } else if (qYear) {
                    const yr = parseInt(qYear);
                    bcStart = `${yr}-01-01`;
                    bcEnd = `${yr}-12-31`;
                    for (let m = 1; m <= 12; m++) bcMonths.push(UZ_MONTHS[m] + ' ' + yr);
                    bcPrevStart = `${yr - 1}-01-01`;
                    bcPrevEnd = `${yr - 1}-12-31`;
                } else {
                    const m = qMonth || bcCurMonth;
                    bcStart = monthStartYmd(m);
                    bcEnd = monthEndYmd(m);
                    bcMonths = [m];
                    const mp = m.trim().split(/\s+/);
                    const mNum = MONTH_NUMS[mp[0]];
                    const mYr = parseInt(mp[1]);
                    const pmNum = mNum === 1 ? 12 : mNum - 1;
                    const pmYr = mNum === 1 ? mYr - 1 : mYr;
                    const prevM = UZ_MONTHS[pmNum] + ' ' + pmYr;
                    bcPrevStart = monthStartYmd(prevM);
                    bcPrevEnd = monthEndYmd(prevM);
                }
                if (!bcStart) {
                    bcStart = monthStartYmd();
                    bcEnd = monthEndYmd();
                    bcMonths = [bcCurMonth];
                    const pmNum = bcParts.month === 1 ? 12 : bcParts.month - 1;
                    const pmYr = bcParts.month === 1 ? bcParts.year - 1 : bcParts.year;
                    bcPrevStart = monthStartYmd(UZ_MONTHS[pmNum] + ' ' + pmYr);
                    bcPrevEnd = monthEndYmd(UZ_MONTHS[pmNum] + ' ' + pmYr);
                }

                const df = ' AND date_ymd >= ? AND date_ymd <= ?';
                const dfp = [bcStart, bcEnd];
                const pdfp = [bcPrevStart, bcPrevEnd];

                // Get all branches the user can see
                const allBranches = req.perms.is_ceo
                    ? db.prepare('SELECT id, name FROM branches ORDER BY name').all()
                    : db.prepare('SELECT b.id, b.name FROM branches b JOIN user_branches ub ON b.id = ub.branch_id WHERE ub.user_id = ? ORDER BY b.name').all(req.perms.telegram_id);

                const branchResults = allBranches.map(br => {
                    const bSql = ' AND branch_id = ?';
                    const bParams = [br.id];

                    const fin = db.prepare("SELECT COALESCE(SUM(income),0) as income, COALESCE(SUM(expense),0) as expense FROM finance WHERE 1=1" + df + bSql).get(...dfp, ...bParams);
                    const prevFin = db.prepare("SELECT COALESCE(SUM(income),0) as income FROM finance WHERE 1=1" + " AND date_ymd >= ? AND date_ymd <= ?" + bSql).get(...pdfp, ...bParams);
                    const lead = db.prepare("SELECT COALESCE(SUM(count),0) as total FROM leads WHERE 1=1" + df + bSql).get(...dfp, ...bParams);
                    const prevLead = db.prepare("SELECT COALESCE(SUM(count),0) as total FROM leads WHERE 1=1" + " AND date_ymd >= ? AND date_ymd <= ?" + bSql).get(...pdfp, ...bParams);
                    const rej = db.prepare("SELECT COALESCE(SUM(count),0) as total FROM rejections WHERE 1=1" + df + bSql).get(...dfp, ...bParams);
                    const debt = db.prepare("SELECT COALESCE(SUM(amount),0) as amt FROM debtors WHERE 1=1" + df + bSql).get(...dfp, ...bParams);
                    const att = db.prepare("SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE 1=1" + df + bSql).get(...dfp, ...bParams);
                    const rooms = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(capacity * price_per_student),0) as potential FROM empty_rooms WHERE branch_id = ?").get(br.id);

                    const income = fin.income || 0;
                    const expense = fin.expense || 0;
                    const leads = lead.total || 0;
                    const rejections = rej.total || 0;
                    const attPct = (att.exp || 0) > 0 ? Math.round((att.att || 0) / att.exp * 100) : 0;
                    const convRate = leads > 0 ? Math.round((leads - rejections) / leads * 100) : 0;
                    const incGrowth = (prevFin.income || 0) > 0 ? Math.round((income - prevFin.income) / prevFin.income * 100) : (income > 0 ? 100 : 0);
                    const leadsGrowth = (prevLead.total || 0) > 0 ? Math.round((leads - prevLead.total) / prevLead.total * 100) : (leads > 0 ? 100 : 0);

                    // Composite score: weighted combination
                    const profitScore = income > 0 ? Math.min(100, Math.round(((income - expense) / income) * 100)) : 0;
                    const leadsScore = Math.min(100, leads * 2);
                    const attScore = attPct;
                    const debtPenalty = income > 0 ? Math.min(30, Math.round(((debt.amt || 0) / income) * 30)) : 0;
                    const score = Math.max(0, Math.min(100, Math.round(profitScore * 0.35 + leadsScore * 0.25 + attScore * 0.3 - debtPenalty)));

                    return {
                        name: br.name,
                        score,
                        income,
                        expense,
                        profit: income - expense,
                        leads,
                        rejections,
                        conversionRate: convRate,
                        debtorAmount: debt.amt || 0,
                        attPct,
                        roomCount: rooms.cnt || 0,
                        roomPotential: rooms.potential || 0,
                        incomeGrowth: incGrowth,
                        leadsGrowth: leadsGrowth,
                    };
                });

                // Sort by score descending
                branchResults.sort((a, b) => b.score - a.score);

                // Overall period totals
                const bs = branchScope(req, null);
                const curTotals = {
                    income: db.prepare("SELECT COALESCE(SUM(income),0) as v FROM finance WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    expense: db.prepare("SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    leads: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    rejections: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    debtors: db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM debtors WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    attendance: {
                        exp: db.prepare("SELECT COALESCE(SUM(expected),0) as v FROM attendance WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                        att: db.prepare("SELECT COALESCE(SUM(attended),0) as v FROM attendance WHERE 1=1" + df + bs.sql).get(...dfp, ...bs.params).v,
                    }
                };
                const prevTotals = {
                    income: db.prepare("SELECT COALESCE(SUM(income),0) as v FROM finance WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...pdfp, ...bs.params).v,
                    expense: db.prepare("SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...pdfp, ...bs.params).v,
                    leads: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM leads WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...pdfp, ...bs.params).v,
                    rejections: db.prepare("SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...pdfp, ...bs.params).v,
                    debtors: db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM debtors WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...pdfp, ...bs.params).v,
                    attendance: {
                        exp: db.prepare("SELECT COALESCE(SUM(expected),0) as v FROM attendance WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...pdfp, ...bs.params).v,
                        att: db.prepare("SELECT COALESCE(SUM(attended),0) as v FROM attendance WHERE 1=1 AND date_ymd >= ? AND date_ymd <= ?" + bs.sql).get(...pdfp, ...bs.params).v,
                    }
                };

                let curLabel = bcMonths.join(', ') || 'Joriy';
                let prevLabel = 'Oldingi davr';
                if (bcMonths.length === 1) {
                    const mp = bcMonths[0].split(' ');
                    const pmNum = MONTH_NUMS[mp[0]] === 1 ? 12 : MONTH_NUMS[mp[0]] - 1;
                    const pmYr = MONTH_NUMS[mp[0]] === 1 ? parseInt(mp[1]) - 1 : parseInt(mp[1]);
                    prevLabel = UZ_MONTHS[pmNum] + ' ' + pmYr;
                }

                return res.json({
                    branches: branchResults,
                    periodTotals: { current: curTotals, previous: prevTotals },
                    curLabel,
                    prevLabel,
                });
            }

            case 'att_trend': {
                if (!requirePerm(req, res, 'analytics')) return;
                const months6 = getLast6Months().reverse();
                const allBranches = req.perms.is_ceo
                    ? db.prepare('SELECT id, name FROM branches ORDER BY name').all()
                    : db.prepare('SELECT b.id, b.name FROM branches b JOIN user_branches ub ON b.id = ub.branch_id WHERE ub.user_id = ? ORDER BY b.name').all(req.perms.telegram_id);

                const monthLabels = months6.map(m => m.split(' ')[0].substring(0, 3));
                const branchData = allBranches.map(br => {
                    const pcts = months6.map(m => {
                        const mStart = monthStartYmd(m);
                        const mEnd = monthEndYmd(m);
                        const r = db.prepare('SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd >= ? AND date_ymd <= ? AND branch_id = ?').get(mStart, mEnd, br.id);
                        return (r.exp || 0) > 0 ? Math.round((r.att || 0) / r.exp * 100) : null;
                    });
                    return { name: br.name, pcts };
                });

                return res.json({ months: monthLabels, branches: branchData });
            }


            case 'hr_staff': {
                if (!requirePerm(req, res, 'hr')) return;
                const status = req.query.status || 'active';
                const search = req.query.search || '';
                const position = req.query.position || '';
                const category = req.query.category || '';
                let sql = 'SELECT * FROM hr_staff WHERE status = ?';
                const params = [status];
                if (search) { sql += " AND name LIKE ?"; params.push('%' + search.replace(/[%_]/g, '') + '%'); }
                if (position) { sql += ' AND position = ?'; params.push(position); }
                if (category) { sql += ' AND category = ?'; params.push(category); }
                if (req.query.subject !== undefined) { sql += ' AND subject = ?'; params.push(req.query.subject); }
                sql += ' ORDER BY name';
                let staff = db.prepare(sql).all(...params);
                // Attach branches and compute tenure
                staff = staff.map(s => {
                    const sbs = db.prepare('SELECT b.id, b.name FROM branches b JOIN hr_staff_branches sb ON b.id = sb.branch_id WHERE sb.staff_id = ?').all(s.id);
                    let tenure = null;
                    if (s.start_date) {
                        const start = new Date(s.start_date);
                        const end = s.end_date ? new Date(s.end_date) : new Date();
                        const months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
                        tenure = { years: Math.floor(months / 12), months: months % 12 };
                    }
                    return { ...s, branches: sbs, tenure };
                });
                // Filter by branch — if specific branch, filter to it. If all (0), managers see only their branches.
                if (branchId) {
                    staff = staff.filter(s => s.branches.length === 0 || s.branches.some(b => b.id === branchId));
                } else if (!req.perms.is_ceo) {
                    const ab = req.perms.allowed_branches;
                    if (ab.length) staff = staff.filter(s => s.branches.length === 0 || s.branches.some(b => ab.includes(b.id)));
                }

                // Auto-include bot users (CEO/Manager/User) as virtual Management staff
                if (status === 'active' && (!category || category === 'admin')) {
                    const botUsers = db.prepare("SELECT telegram_id, name, role FROM users WHERE role != 'ceo' ORDER BY CASE role WHEN 'manager' THEN 1 ELSE 2 END, name").all();
                    const existingTids = new Set(staff.filter(s => s.notes && s.notes.startsWith('bot_user:')).map(s => s.notes.replace('bot_user:', '')));
                    for (const u of botUsers) {
                        if (existingTids.has(u.telegram_id)) continue;
                        // Check if this user already exists in hr_staff by name match
                        if (staff.some(s => s.category === 'admin' && s.name === u.name)) continue;
                        const roleLabel = u.role === 'ceo' ? 'Director' : u.role === 'manager' ? 'Branch Manager' : 'Administrator';
                        const userBranches = u.role === 'ceo'
                            ? db.prepare('SELECT id, name FROM branches ORDER BY name').all()
                            : db.prepare('SELECT b.id, b.name FROM branches b JOIN user_branches ub ON b.id = ub.branch_id WHERE ub.user_id = ?').all(u.telegram_id);
                        // Apply branch filter
                        if (branchId && userBranches.length > 0 && !userBranches.some(b => b.id === branchId)) continue;
                        if (search && !u.name.toLowerCase().includes(search.toLowerCase())) continue;
                        if (position && roleLabel !== position) continue;
                        staff.push({
                            id: -parseInt(u.telegram_id),
                            name: u.name,
                            phone: '',
                            category: 'admin',
                            position: roleLabel,
                            subject: '',
                            start_date: '',
                            end_date: '',
                            status: 'active',
                            notes: 'bot_user:' + u.telegram_id,
                            branch_id: 0,
                            created_at: '',
                            branches: userBranches,
                            tenure: null,
                            _virtual: true,
                            _role: u.role,
                            _telegram_id: u.telegram_id
                        });
                    }
                }

                return res.json(staff);
            }

            case 'hr_staff_one': {
                if (!requirePerm(req, res, 'hr')) return;
                const sid = parseInt(req.query.id);
                if (!sid) return res.status(400).json({ error: 'id kerak' });
                // Handle virtual bot users (negative IDs)
                if (sid < 0) {
                    const tid = String(Math.abs(sid));
                    const vu = db.prepare('SELECT telegram_id, name, role FROM users WHERE telegram_id = ?').get(tid);
                    if (!vu) return res.status(404).json({ error: 'Topilmadi' });
                    const roleLabel = vu.role === 'ceo' ? 'Director' : vu.role === 'manager' ? 'Branch Manager' : 'Administrator';
                    const vBranches = vu.role === 'ceo'
                        ? db.prepare('SELECT id, name FROM branches ORDER BY name').all()
                        : db.prepare('SELECT b.id, b.name FROM branches b JOIN user_branches ub ON b.id = ub.branch_id WHERE ub.user_id = ?').all(tid);
                    return res.json({ id: sid, name: vu.name, phone: '', category: 'admin', position: roleLabel, subject: '', start_date: '', end_date: '', status: 'active', notes: '', branches: vBranches, tenure: null, _virtual: true, _role: vu.role, _telegram_id: tid });
                }
                const s = db.prepare('SELECT * FROM hr_staff WHERE id = ?').get(sid);
                if (!s) return res.status(404).json({ error: 'Topilmadi' });
                const sbs = db.prepare('SELECT b.id, b.name FROM branches b JOIN hr_staff_branches sb ON b.id = sb.branch_id WHERE sb.staff_id = ?').all(s.id);
                let tenure = null;
                if (s.start_date) {
                    const start = new Date(s.start_date);
                    const end = s.end_date ? new Date(s.end_date) : new Date();
                    const months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
                    tenure = { years: Math.floor(months / 12), months: months % 12 };
                }
                return res.json({ ...s, branches: sbs, tenure });
            }

            case 'hr_goals': {
                if (!requirePerm(req, res, 'hr')) return;
                let sql = 'SELECT g.*, b.name as branch_name FROM hr_goals g LEFT JOIN branches b ON g.branch_id = b.id WHERE 1=1';
                const params = [];
                if (branchId) { sql += ' AND g.branch_id = ?'; params.push(branchId); }
                else if (!req.perms.is_ceo) {
                    const ab = req.perms.allowed_branches;
                    if (ab.length) { sql += ' AND g.branch_id IN (' + ab.map(() => '?').join(',') + ')'; params.push(...ab); }
                }
                if (req.query.category) { sql += ' AND g.category = ?'; params.push(req.query.category); }
                if (req.query.subject) { sql += ' AND g.subject = ?'; params.push(req.query.subject); }
                sql += " ORDER BY CASE g.status WHEN 'in_progress' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, g.created_at DESC";
                return res.json(db.prepare(sql).all(...params));
            }



            case 'hr_stats': {
                if (!requirePerm(req, res, 'hr')) return;
                const bs = branchScope(req, branchId);
                const realTotal = db.prepare("SELECT COUNT(*) as c FROM hr_staff WHERE status = 'active'").get().c;
                // Virtual bot users (same as hr_analytics)
                const _vuStats = db.prepare("SELECT telegram_id, name, role FROM users WHERE role != 'ceo'").all();
                const _anStats = new Set(db.prepare("SELECT name FROM hr_staff WHERE status = 'active' AND category = 'admin'").all().map(r => r.name));
                const _vcStats = _vuStats.filter(u => !_anStats.has(u.name)).length;
                const total = realTotal + _vcStats;
                // For branch-scoped: use hr_staff_branches join
                
                const inactiveCount = db.prepare("SELECT COUNT(*) as c FROM hr_staff WHERE status = 'inactive'").get().c;
                const now = new Date();
                const mStart = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-01';
                const newThisMonth = db.prepare("SELECT COUNT(*) as c FROM hr_staff WHERE created_at >= ?").get(mStart).c;

                // Monthly hires (last 12 months)
                const monthlyHires = [];
                for (let i = 11; i >= 0; i--) {
                    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                    const ym = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
                    const c = db.prepare("SELECT COUNT(*) as c FROM hr_staff WHERE start_date LIKE ?").get(ym + '%').c;
                    monthlyHires.push({ month: ym, c });
                }

                // Tenure buckets
                const activeStaff = db.prepare("SELECT start_date FROM hr_staff WHERE status = 'active' AND start_date != ''").all();
                const buckets = { '< 3 oy': 0, '3-6 oy': 0, '6-12 oy': 0, '1-2 yil': 0, '2+ yil': 0 };
                activeStaff.forEach(s => {
                    const start = new Date(s.start_date);
                    const months = (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth();
                    if (months < 3) buckets['< 3 oy']++;
                    else if (months < 6) buckets['3-6 oy']++;
                    else if (months < 12) buckets['6-12 oy']++;
                    else if (months < 24) buckets['1-2 yil']++;
                    else buckets['2+ yil']++;
                });

                // By category
                const byCategory = db.prepare("SELECT category, COUNT(*) as c FROM hr_staff WHERE status = 'active' GROUP BY category ORDER BY c DESC").all();
                // Add virtual users to admin category
                const adminCat = byCategory.find(c => c.category === 'admin');
                if (adminCat) adminCat.c += virtualCount;
                else if (virtualCount > 0) byCategory.unshift({ category: 'admin', c: virtualCount });

                // Per branch
                const perBranch = db.prepare("SELECT b.name, COUNT(DISTINCT sb.staff_id) as c FROM branches b LEFT JOIN hr_staff_branches sb ON b.id = sb.branch_id LEFT JOIN hr_staff s ON sb.staff_id = s.id AND s.status = 'active' GROUP BY b.id ORDER BY c DESC").all();

                return res.json({ total: total, inactive: inactiveCount, newThisMonth, monthlyHires, tenureBuckets: buckets, byCategory, perBranch });
            }

            case 'lead_enrolled': {
                if (!requirePerm(req, res, 'leads')) return;
                { const bs = branchScope(req, branchId);
                const rows = db.prepare('SELECT le.*, b.name as branch_name FROM lead_enrolled le LEFT JOIN branches b ON le.branch_id = b.id WHERE le.date_ymd >= ? AND le.date_ymd <= ?' + bs.sql.replace(/branch_id/g, 'le.branch_id') + ' ORDER BY le.id DESC').all(from, to, ...bs.params);
                const bySub = db.prepare('SELECT subject, SUM(count) as total FROM lead_enrolled WHERE date_ymd >= ? AND date_ymd <= ?' + bs.sql + ' GROUP BY subject ORDER BY total DESC').all(from, to, ...bs.params);
                return res.json({ rows, bySubject: bySub, total: bySub.reduce((s,r) => s + r.total, 0) }); }
            }

            case 'ai_status':
                return res.json({ available: require('./ai').isAvailable() });

            case 'ai_analyze': {
                if (!req.perms.is_ceo && !req.perms.is_super) return res.status(403).json({ error: 'Faqat CEO/Super' });
                const ai = require('./ai');
                if (!ai.isAvailable()) return res.status(503).json({ error: 'AI xizmati sozlanmagan' });
                const bs = branchScope(req, branchId);
                const mStart = monthStartYmd();
                const tdy = todayYmd();
                const data = {
                    leads: db.prepare('SELECT COALESCE(SUM(count),0) as v FROM leads WHERE date_ymd >= ?' + bs.sql).get(mStart, ...bs.params).v,
                    rejections: db.prepare('SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE date_ymd >= ?' + bs.sql).get(mStart, ...bs.params).v,
                    income: db.prepare('SELECT COALESCE(SUM(income),0) as v FROM finance WHERE date_ymd >= ?' + bs.sql).get(mStart, ...bs.params).v,
                    expense: db.prepare('SELECT COALESCE(SUM(expense),0) as v FROM finance WHERE date_ymd >= ?' + bs.sql).get(mStart, ...bs.params).v,
                    debtors: db.prepare('SELECT COALESCE(SUM(count),0) as cnt, COALESCE(SUM(amount),0) as amt FROM debtors WHERE 1=1' + bs.sql).get(...bs.params),
                    attendance: db.prepare('SELECT COALESCE(SUM(expected),0) as exp, COALESCE(SUM(attended),0) as att FROM attendance WHERE date_ymd >= ?' + bs.sql).get(mStart, ...bs.params),
                    problems: db.prepare("SELECT COUNT(*) as c FROM problems WHERE status != 'solved'" + bs.sql).get(...bs.params).c,
                    leadsBySubject: db.prepare('SELECT subject, SUM(count) as total FROM leads WHERE date_ymd >= ?' + bs.sql + ' GROUP BY subject ORDER BY total DESC LIMIT 10').all(mStart, ...bs.params),
                    expensesByType: db.prepare("SELECT expense_type as type, SUM(expense) as amount FROM finance WHERE date_ymd >= ? AND expense > 0 AND expense_type != ''" + bs.sql + ' GROUP BY expense_type ORDER BY amount DESC').all(mStart, ...bs.params),
                };
                const summary = 'Oylik ma\'lumotlar:\n' +
                    'Leadlar: ' + data.leads + ' ta\n' +
                    'Rad etilganlar: ' + data.rejections + ' ta\n' +
                    'Kirim: ' + data.income + ' so\'m\n' +
                    'Chiqim: ' + data.expense + ' so\'m\n' +
                    'Foyda: ' + (data.income - data.expense) + ' so\'m\n' +
                    'Qarzdorlar: ' + data.debtors.cnt + ' ta (' + data.debtors.amt + ' so\'m)\n' +
                    'Davomat: ' + (data.attendance.exp > 0 ? Math.round(data.attendance.att / data.attendance.exp * 100) : 0) + '%\n' +
                    'Ochiq muammolar: ' + data.problems + ' ta\n' +
                    'Fan bo\'yicha leadlar: ' + data.leadsBySubject.map(r => r.subject + ': ' + r.total).join(', ') + '\n' +
                    'Xarajat turlari: ' + data.expensesByType.map(r => r.type + ': ' + r.amount).join(', ');
                const analysis = await ai.analyzeReport(summary, 'daily', req.perms.lang || 'uz');
                return res.json({ analysis: analysis || 'AI tahlil yaratib bo\'lmadi', data });
            }


            case 'hr_analytics': {
                if (!requirePerm(req, res, 'hr')) return;
                const bs = branchScope(req, branchId);
                // Count real staff
                let hrTotal = db.prepare("SELECT COUNT(*) as c FROM hr_staff WHERE status = 'active'").get().c;
                // Add virtual bot users (non-CEO) — same logic as hr_staff endpoint
                const virtualUsers = db.prepare("SELECT telegram_id, name, role FROM users WHERE role != 'ceo'").all();
                const realAdminNames = new Set(db.prepare("SELECT name FROM hr_staff WHERE status = 'active' AND category = 'admin'").all().map(r => r.name));
                const virtualCount = virtualUsers.filter(u => !realAdminNames.has(u.name)).length;
                hrTotal += virtualCount;
                const total = hrTotal;
                const byCategory = db.prepare("SELECT category, COUNT(*) as c FROM hr_staff WHERE status = 'active' GROUP BY category ORDER BY c DESC").all();
                const byCatBranch = !branchId ? getUserBranches(req).map(br => {
                    const cats = db.prepare("SELECT hs.category, COUNT(*) as c FROM hr_staff hs JOIN hr_staff_branches hsb ON hs.id = hsb.staff_id WHERE hs.status = 'active' AND hsb.branch_id = ? GROUP BY hs.category").all(br.id);
                    // Add virtual bot users for this branch
                    let brVirtual = 0;
                    virtualUsers.forEach(u => {
                        if (realAdminNames.has(u.name)) return;
                        const ubs = u.role === 'ceo' ? [br.id] : db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ?').all(u.telegram_id).map(r => r.branch_id);
                        if (ubs.includes(br.id)) brVirtual++;
                    });
                    if (brVirtual > 0) {
                        const ac = cats.find(c => c.category === 'admin');
                        if (ac) ac.c += brVirtual; else cats.push({ category: 'admin', c: brVirtual });
                    }
                    return { name: br.name, categories: cats, total: cats.reduce((s,r) => s + r.c, 0) };
                }) : undefined;
                const monthlyHires = [];
                const now = new Date();
                for (let i = 11; i >= 0; i--) {
                    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                    const ym = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
                    const c = db.prepare("SELECT COUNT(*) as c FROM hr_staff WHERE start_date LIKE ?").get(ym + '%').c;
                    monthlyHires.push({ month: ym, count: c });
                }
                return res.json({ total, byCategory, byCatBranch, monthlyHires });
            }

            default:
                return res.status(404).json({ error: 'Not found' });
            }
        } catch (e) {
            console.error('[TWA GET]', endpoint, e.message);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    // ════════════════════ WRITE ENDPOINTS ═════════════════════

    app.post(['/', '/api', '/twa/api', '/twa/api/'], writeLimiter);
    app.post(['/', '/api', '/twa/api', '/twa/api/'], (req, res) => {
        const endpoint = req.query.endpoint || '';
        const body = req.body || {};
        const today = todayYmd();
        const tid = req.tid;
        if (!tid) return res.status(401).json({ error: 'Avtorizatsiya talab etiladi' });
        if (!isValidDate(today)) return res.status(500).json({ error: 'Server sana xatoligi' });

        try {
            switch (endpoint) {

            case 'lead_add': {
                if (!requirePerm(req, res, 'leads')) return;
                const sub = normSubject(body.subject);
                const cnt = safeInt(body.count);
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!sub || cnt < 1) return res.status(400).json({ error: 'Fan va son kiriting' });
                const ts = nowTs();
                const leadResult = db.prepare('INSERT INTO leads (timestamp, subject, count, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ts, sub, cnt, tid, ts, today, bid);
                logAudit(req, 'add', 'leads', {subject: sub, count: cnt, branch_id: bid}, leadResult.lastInsertRowid);
                return res.json({ ok: true, message: "Lead qo'shildi" });
            }

            case 'lead_remove': {
                if (!requirePerm(req, res, 'leads')) return;
                const sub = normSubject(body.subject);
                const cnt = safeInt(body.count);
                const reason = (body.reason || '').trim();
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!sub || cnt < 1) return res.status(400).json({ error: 'Fan va son kiriting' });
                if (!reason) return res.status(400).json({ error: 'Sababni tanlang' });
                // Check active balance: leads - rejections - enrolled
                const bfq = bid ? ' AND branch_id = ?' : '';
                const bfp = bid ? [sub, bid] : [sub];
                const totalLeads = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM leads WHERE subject = ?' + bfq).get(...bfp).v;
                const totalRej = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM rejections WHERE subject = ?' + bfq).get(...bfp).v;
                const totalEnrolled = db.prepare('SELECT COALESCE(SUM(count),0) as v FROM lead_enrolled WHERE subject = ?' + bfq).get(...bfp).v;
                const activeBal = totalLeads - totalRej - totalEnrolled;
                if (activeBal < cnt) return res.status(400).json({ error: 'Yetarli aktiv lead soni yo\'q (' + sub + ': ' + activeBal + ' ta)' });
                const ts = nowTs();
                if (reason === 'sifatli') {
                    const r = db.prepare('INSERT INTO lead_enrolled (timestamp, date_ymd, subject, count, manager_id, created_at, branch_id) VALUES (?,?,?,?,?,?,?)')
                        .run(ts, today, sub, cnt, tid, ts, bid);
                    logAudit(req, 'lead_enrolled', 'leads', {subject: sub, count: cnt}, r.lastInsertRowid);
                    return res.json({ ok: true, message: "Sifatli lead — kursga yozildi!" });
                } else {
                    const r = db.prepare('INSERT INTO rejections (timestamp, subject, count, manager_id, created_at, date_ymd, branch_id) VALUES (?,?,?,?,?,?,?)')
                        .run(ts, sub, cnt, tid, ts, today, bid);
                    logAudit(req, 'lead_rejected', 'leads', {subject: sub, count: cnt}, r.lastInsertRowid);
                    return res.json({ ok: true, message: "Lead rad etildi" });
                }
            }


            case 'subject_add': {
                if (!requirePerm(req, res, 'leads')) return;
                const name = normSubject(body.name);
                if (!name) return res.status(400).json({ error: 'Fan nomini kiriting' });
                const existing = db.prepare('SELECT id FROM subjects WHERE LOWER(TRIM(name)) = LOWER(?)').get(name);
                if (existing) return res.status(409).json({ error: 'Bu fan allaqachon mavjud' });
                const subResult = db.prepare('INSERT INTO subjects (name) VALUES (?)').run(name);
                logAudit(req, 'add', 'subjects', {name}, subResult.lastInsertRowid);
                return res.json({ ok: true, message: "Fan qo'shildi" });
            }

            case 'subject_delete': {
                if (!requirePerm(req, res, 'leads')) return;
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'Fan tanlanmadi' });
                const subRow = db.prepare('SELECT name FROM subjects WHERE id = ?').get(id);
                if (!subRow) return res.status(404).json({ error: 'Fan topilmadi' });
                const subName = (subRow.name || '').trim().toLowerCase();
                if (subName) {
                    const hasLeads = db.prepare('SELECT COUNT(*) as cnt FROM leads WHERE LOWER(TRIM(subject)) = ?').get(subName);
                    const hasRejections = db.prepare('SELECT COUNT(*) as cnt FROM rejections WHERE LOWER(TRIM(subject)) = ?').get(subName);
                    if ((hasLeads.cnt || 0) > 0 || (hasRejections.cnt || 0) > 0) {
                        return res.status(400).json({ error: "Bu fanga tegishli tarixiy ma'lumotlar mavjud. O'chirish mumkin emas." });
                    }
                }
                db.prepare('DELETE FROM subjects WHERE id = ?').run(id);
                logAudit(req, 'delete', 'subjects', {name: subName}, id);
                return res.json({ ok: true, message: "Fan o'chirildi" });
            }

            case 'debtor_add': {
                if (!requirePerm(req, res, 'debtors')) return;
                const mo = normalizeMonth(body.month); const cnt = safeInt(body.count); const amt = safeInt(body.amount);
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!mo || cnt < 1 || amt < 1) return res.status(400).json({ error: 'Oy, son va summa kiriting' });
                const ts = nowTs();
                const txn = db.transaction(() => {
                    db.prepare('INSERT INTO debtors (timestamp, count, amount, month, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ts, cnt, amt, mo, tid, ts, today, bid);
                    db.prepare("INSERT INTO qarzdorlar_log (month, change_amount, type, note, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 'manual_add', 'TWA: Qarzdor qo''shildi', ?, ?, ?, ?)").run(mo, amt, tid, ts, today, bid);
                });
                txn();
                logAudit(req, 'add', 'debtors', {month: mo, count: cnt, amount: amt, branch_id: bid}, '');
                return res.json({ ok: true, message: "Qarzdor qo'shildi" });
            }

            case 'debtor_remove': {
                if (!requirePerm(req, res, 'debtors')) return;
                const mo = normalizeMonth(body.month); const cnt = safeInt(body.count); const amt = safeInt(body.amount);
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!mo || cnt < 1 || amt < 1) return res.status(400).json({ error: 'Oy, son va summa kiriting' });
                const ts = nowTs();
                const result = db.transaction(() => {
                    const bfqG = bid ? ' AND branch_id = ?' : '';
                    const bfpG = bid ? [mo, bid] : [mo];
                    const balC = db.prepare("SELECT COALESCE(SUM(count),0) as bal FROM debtors WHERE month=?" + bfqG).get(...bfpG);
                    if (balC.bal < cnt) return { error: 'Yetarli soni yo\'q', status: 400 };
                    const balA = db.prepare("SELECT COALESCE(SUM(amount),0) as bal FROM debtors WHERE month=?" + bfqG).get(...bfpG);
                    if (balA.bal < amt) return { error: 'Yetarli summa yo\'q', status: 400 };
                    db.prepare('INSERT INTO debtors (timestamp, count, amount, month, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ts, -cnt, -amt, mo, tid, ts, today, bid);
                    db.prepare("INSERT INTO qarzdorlar_log (month, change_amount, type, note, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 'manual_remove', 'TWA: Qarz ayirildi', ?, ?, ?, ?)").run(mo, -amt, tid, ts, today, bid);
                    return { ok: true };
                })();
                if (result.error) {
                    logAudit(req, 'failed_remove', 'debtors', {reason: result.error, month: mo, count: cnt, amount: amt}, '');
                    return res.status(result.status).json({ error: result.error });
                }
                logAudit(req, 'remove', 'debtors', {month: mo, count: cnt, amount: amt}, '');
                return res.json({ ok: true, message: 'Qarz ayirildi' });
            }

            case 'finance_income_official': {
                if (!requirePerm(req, res, 'finance')) return;
                const mo = normalizeMonth(body.month); const amt = safeInt(body.amount); const ks = safeInt(body.kassa_students); const cmt = (body.comment || '').trim();
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (amt < 0) return res.status(400).json({ error: 'Manfiy qiymat kiritish mumkin emas' });
                if (!mo || amt < 1) return res.status(400).json({ error: 'Oy va summa kiriting' });
                const ts = nowTs();
                const fioResult = db.prepare('INSERT INTO finance (timestamp, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ts, amt, mo, amt, ks, '', 'cat_2', cmt, tid, ts, today, bid);
                logAudit(req, 'add', 'finance', {type: 'cat_2_kirim', amount: amt, month: mo, branch_id: bid}, fioResult.lastInsertRowid);
                return res.json({ ok: true, message: 'Kirim saqlandi' });
            }

            case 'finance_income_unofficial': {
                if (!requirePerm(req, res, 'finance')) return;
                const mo = normalizeMonth(body.month); const ka = safeInt(body.kassa_amount); const ks = safeInt(body.kassa_students); const cmt = (body.comment || '').trim();
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (ka < 0) return res.status(400).json({ error: 'Manfiy qiymat kiritish mumkin emas' });
                if (!mo || ka < 1) return res.status(400).json({ error: 'Oy va summa kiriting' });
                const ts = nowTs();
                const fiuResult = db.prepare('INSERT INTO finance (timestamp, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ts, ka, mo, ka, ks, '', 'cat_1', cmt, tid, ts, today, bid);
                logAudit(req, 'add', 'finance', {type: 'cat_1_kirim', amount: ka, month: mo, branch_id: bid}, fiuResult.lastInsertRowid);
                return res.json({ ok: true, message: 'Kirim saqlandi' });
            }

            case 'finance_income_unofficial_deduct': {
                if (!requirePerm(req, res, 'finance')) return;
                const mo = normalizeMonth(body.month); const ka = safeInt(body.kassa_amount); const ks = safeInt(body.kassa_students); const cmt = (body.comment || '').trim() || 'Qarzdordan ayirish';
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!mo || ka < 1) return res.status(400).json({ error: 'Oy va summa kiriting' });
                const ts = nowTs();
                const deductResult = db.transaction(() => {
                    // Check current debtor balance for this month/manager before deducting
                    const debtorBal = db.prepare('SELECT COALESCE(SUM(amount),0) as bal FROM debtors WHERE month = ?' + (bid ? ' AND branch_id = ?' : '')).get(...(bid ? [mo, bid] : [mo]));
                    const currentBalance = debtorBal.bal;
                    if (currentBalance <= 0) return { skipped: true };
                    // Cap deduction at the current balance to prevent negative debtor balance
                    const cappedAmount = Math.min(ka, currentBalance);
                    const cappedStudents = cappedAmount < ka ? Math.round(ks * cappedAmount / ka) : ks;
                    // Create finance income record so books balance
                    db.prepare('INSERT INTO finance (timestamp, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ts, cappedAmount, mo, cappedAmount, cappedStudents, '', 'cat_1', cmt, tid, ts, today, bid);
                    // Reduce debtor balance (capped so it cannot go negative)
                    db.prepare('INSERT INTO debtors (timestamp, count, amount, month, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ts, -cappedStudents, -cappedAmount, mo, tid, ts, today, bid);
                    db.prepare("INSERT INTO qarzdorlar_log (month, change_amount, type, note, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 'norasmiy_deduction', 'TWA: Kirim ayirish', ?, ?, ?, ?)").run(mo, -cappedAmount, tid, ts, today, bid);
                    return { ok: true, cappedAmount };
                })();
                if (deductResult.skipped) {
                    logAudit(req, 'failed_deduct', 'finance', {reason: 'Qarzdor balansi 0', month: mo}, '');
                    return res.status(400).json({ error: 'Qarzdor balansi 0, ayirish mumkin emas' });
                }
                logAudit(req, 'deduct', 'finance', {type: 'norasmiy_deduction', amount: deductResult.cappedAmount, month: mo, students: ks, branch_id: bid}, '');
                return res.json({ ok: true, message: 'Qarzdorlardan ayirildi' });
            }

            case 'finance_income_official_cancel': {
                if (!requirePerm(req, res, 'finance')) return;
                const mo = normalizeMonth(body.month); const amt = safeInt(body.amount); const ks = safeInt(body.kassa_students); const cmt = (body.comment || '').trim() || 'Bekor qilish';
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!mo || amt < 1) return res.status(400).json({ error: 'Oy va summa kiriting' });
                const ts = nowTs();
                const fiocTxn = db.transaction(() => {
                    const rasmiyBalance = db.prepare("SELECT COALESCE(SUM(income),0) as total FROM finance WHERE month = ? AND category = 'cat_2'" + (bid ? ' AND branch_id = ?' : '')).get(...(bid ? [mo, bid] : [mo]));
                    if (rasmiyBalance.total < amt) return { error: 'Bekor qilish uchun yetarli kirim mavjud emas' };
                    const r = db.prepare('INSERT INTO finance (timestamp, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ts, -amt, mo, -amt, ks > 0 ? -ks : 0, '', 'cat_2', cmt, tid, ts, today, bid);
                    return { ok: true, id: r.lastInsertRowid };
                });
                const fiocResult = fiocTxn();
                if (fiocResult.error) return res.status(400).json({ error: fiocResult.error });
                logAudit(req, 'cancel', 'finance', {type: 'cat_2_kirim_bekor', amount: amt, month: mo, branch_id: bid}, fiocResult.id);
                notifyCEO('\ud83d\udeab <b>Kirim bekor</b>\n\ud83d\udc64 ' + escTg(req.perms?.name) + '\n\ud83d\udcb0 ' + amt + ' so\'m\n\ud83d\udcc5 ' + escTg(mo));
                return res.json({ ok: true, message: 'Kirim bekor qilindi' });
            }

            case 'finance_income_unofficial_cancel': {
                if (!requirePerm(req, res, 'finance')) return;
                const mo = normalizeMonth(body.month); const amt = safeInt(body.amount); const ka = safeInt(body.kassa_amount || body.amount); const ks = safeInt(body.kassa_students);
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!mo || amt < 1) return res.status(400).json({ error: 'Oy va summa kiriting' });
                const ts = nowTs();
                // LIMITATION: The deduction lookup finds the most recent norasmiy_deduction log entry
                // for this month/manager, but there is no direct FK link between the income record
                // being cancelled and the specific deduction log entry. We match by amount to reduce
                // the chance of reversing the wrong entry, but this is not a guarantee if multiple
                // deductions of the same amount exist.
                const txn = db.transaction(() => {
                    db.prepare('INSERT INTO finance (timestamp, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ts, -amt, mo, -ka, -ks, '', 'cat_1', 'Bekor qilish', tid, ts, today, bid);
                    const deduction = db.prepare("SELECT id, ABS(change_amount) as amt FROM qarzdorlar_log WHERE month = ? AND type = 'norasmiy_deduction' AND manager_id = ? AND ABS(change_amount) = ? AND note NOT LIKE '%[reversed]%' ORDER BY id DESC LIMIT 1").get(mo, req.perms.telegram_id, amt);
                    if (deduction) {
                        db.prepare('INSERT INTO debtors (timestamp, count, amount, month, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ts, ks, deduction.amt, mo, tid, ts, today, bid);
                        db.prepare("INSERT INTO qarzdorlar_log (month, change_amount, type, note, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 'norasmiy_reversal', 'TWA: Kirim bekor', ?, ?, ?, ?)").run(mo, deduction.amt, tid, ts, today, bid);
                        db.prepare("UPDATE qarzdorlar_log SET note = note || ' [reversed]' WHERE id = ?").run(deduction.id);
                    }
                });
                txn();
                notifyCEO('\ud83d\udeab <b>Kirim bekor</b>\n\ud83d\udc64 ' + escTg(req.perms?.name) + '\n\ud83d\udcb0 ' + amt + ' so\'m\n\ud83d\udcc5 ' + escTg(mo));
                logAudit(req, 'cancel', 'finance', {type: 'cat_1_kirim_bekor', amount: amt, month: mo, branch_id: bid}, '');
                return res.json({ ok: true, message: 'Kirim bekor qilindi' });
            }

            case 'finance_expense_official': {
                if (!requirePerm(req, res, 'finance')) return;
                const mo = normalizeMonth(body.month); const amt = safeInt(body.amount); const et = (body.expense_type || '').trim(); const cmt = (body.comment || '').trim();
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (amt < 0) return res.status(400).json({ error: 'Manfiy qiymat kiritish mumkin emas' });
                if (!mo || amt < 1) return res.status(400).json({ error: 'Oy va summa kiriting' });
                const ts = nowTs();
                const feoResult = db.prepare('INSERT INTO finance (timestamp, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, created_at, date_ymd, branch_id) VALUES (?, 0, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)').run(ts, amt, mo, et, 'cat_2', cmt, tid, ts, today, bid);
                logAudit(req, 'add', 'finance', {type: 'rasmiy_chiqim', amount: amt, expense_type: et, month: mo, branch_id: bid}, feoResult.lastInsertRowid);
                return res.json({ ok: true, message: 'Chiqim saqlandi' });
            }

            case 'finance_expense_unofficial': {
                if (!requirePerm(req, res, 'finance')) return;
                const mo = normalizeMonth(body.month); const amt = safeInt(body.amount); const et = (body.expense_type || '').trim(); const cmt = (body.comment || '').trim();
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (amt < 0) return res.status(400).json({ error: 'Manfiy qiymat kiritish mumkin emas' });
                if (!mo || amt < 1) return res.status(400).json({ error: 'Oy va summa kiriting' });
                const ts = nowTs();
                const feuResult = db.prepare('INSERT INTO finance (timestamp, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, created_at, date_ymd, branch_id) VALUES (?, 0, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)').run(ts, amt, mo, et, 'cat_1', cmt, tid, ts, today, bid);
                logAudit(req, 'add', 'finance', {type: 'norasmiy_chiqim', amount: amt, expense_type: et, month: mo, branch_id: bid}, feuResult.lastInsertRowid);
                return res.json({ ok: true, message: 'Chiqim saqlandi' });
            }

            case 'finance_expense_cancel': {
                if (!requirePerm(req, res, 'finance')) return;
                const mo = normalizeMonth(body.month); const amt = safeInt(body.amount); const et = (body.expense_type || '').trim(); const cat = (body.category || '').trim();
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!mo || amt < 1) return res.status(400).json({ error: 'Oy va summa kiriting' });
                if (!cat || !['cat_1','cat_2'].includes(cat)) return res.status(400).json({ error: 'Toifani tanlang' });
                const ts = nowTs();
                const fecTxn = db.transaction(() => {
                    const expBalance = db.prepare("SELECT COALESCE(SUM(expense),0) as total FROM finance WHERE month = ? AND category = ?" + (bid ? ' AND branch_id = ?' : '')).get(...(bid ? [mo, cat, bid] : [mo, cat]));
                    if (expBalance.total < amt) return { error: 'Bekor qilish uchun yetarli chiqim mavjud emas' };
                    const r = db.prepare('INSERT INTO finance (timestamp, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, created_at, date_ymd, branch_id) VALUES (?, 0, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)').run(ts, -amt, mo, et, cat, 'Chiqim bekor', tid, ts, today, bid);
                    return { ok: true, id: r.lastInsertRowid };
                });
                const fecResult = fecTxn();
                if (fecResult.error) return res.status(400).json({ error: fecResult.error });
                logAudit(req, 'cancel', 'finance', {type: 'chiqim_bekor', amount: amt, expense_type: et, month: mo, branch_id: bid}, fecResult.id);
                notifyCEO('\ud83d\udeab <b>Chiqim bekor (' + escTg(cat) + ')</b>\n\ud83d\udc64 ' + escTg(req.perms?.name) + '\n\ud83d\udcb0 ' + amt + ' so\'m\n\ud83d\udcc5 ' + escTg(mo));
                return res.json({ ok: true, message: 'Chiqim bekor qilindi' });
            }

            case 'expense_type_add': {
                if (!requirePerm(req, res, 'finance')) return;
                const name = (body.name || '').trim(); const cat = (body.category || '').trim();
                if (!name || !cat) return res.status(400).json({ error: 'Nom va toifa kiriting' });
                try {
                    const etaResult = db.prepare('INSERT INTO expense_types (name, category, created_at) VALUES (?, ?, ?)').run(name, cat, nowTs());
                    logAudit(req, 'add', 'expense_types', {name, category: cat}, etaResult.lastInsertRowid);
                    return res.json({ ok: true, message: "Chiqim turi qo'shildi" });
                } catch { return res.status(400).json({ error: 'Bu tur allaqachon mavjud' }); }
            }

            case 'expense_type_delete': {
                if (!requirePerm(req, res, 'finance')) return;
                const name = (body.name || '').trim(); const cat = (body.category || '').trim();
                if (!name || !cat) return res.status(400).json({ error: 'Nom va toifa kiriting' });
                const inUse = db.prepare("SELECT COUNT(*) as cnt FROM finance WHERE LOWER(TRIM(expense_type)) = LOWER(TRIM(?))").get(name);
                if (inUse.cnt > 0) return res.status(400).json({ error: 'Bu tur ishlatilmoqda, o\'chirib bo\'lmaydi' });
                const delResult = db.prepare('DELETE FROM expense_types WHERE LOWER(TRIM(name)) = ? AND category = ?').run(name.toLowerCase(), cat);
                if (delResult.changes === 0) return res.status(404).json({ error: 'Chiqim turi topilmadi' });
                logAudit(req, 'delete', 'expense_types', {name, category: cat}, '');
                return res.json({ ok: true, message: "Chiqim turi o'chirildi" });
            }

            case 'attendance_add': {
                if (!requirePerm(req, res, 'attendance')) return;
                const exp = safeInt(body.expected); const att = safeInt(body.attended);
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (exp < 1) return res.status(400).json({ error: 'Kutilgan sonini kiriting' });
                if (att > exp) return res.status(400).json({ error: 'Kelganlar soni kutilganlardan ko\'p bo\'lishi mumkin emas' });
                const ts = nowTs();
                const attResult = db.transaction(() => {
                    const dup = db.prepare("SELECT id, expected, attended FROM attendance WHERE date_ymd = ? AND manager_id = ? AND branch_id = ?").get(today, tid, bid);
                    if (dup) {
                        db.prepare('UPDATE attendance SET expected = ?, attended = ?, timestamp = ? WHERE id = ?').run(exp, att, ts, dup.id);
                        return { id: dup.id, corrected: true, old_expected: dup.expected, old_attended: dup.attended };
                    } else {
                        const r = db.prepare('INSERT INTO attendance (timestamp, expected, attended, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ts, exp, att, tid, ts, today, bid);
                        return { id: r.lastInsertRowid, corrected: false };
                    }
                })();
                if (attResult.corrected) {
                    logAudit(req, 'edit', 'attendance', {expected: exp, attended: att, corrected: true, old_expected: attResult.old_expected, old_attended: attResult.old_attended}, attResult.id);
                } else {
                    logAudit(req, 'add', 'attendance', {expected: exp, attended: att}, attResult.id);
                }
                if (exp > 0) {
                    const rate = Math.round(att * 100 / exp);
                    if (rate < 70) {
                        notifyReportsUsers(`⚠️ *Davomat ogohlantirishi* (${today})\n\n✅ Keldi: *${att}* / Kutilgan: *${exp}* = *${rate}%*\n\nDavomat 70% dan past. Iltimos muammolarni tekshiring.`);
                    }
                }
                return res.json({ ok: true, message: 'Davomat saqlandi' });
            }

            case 'problem_add': {
                if (!requirePerm(req, res, 'problems')) return;
                const br = (body.branch || '').trim(); const tp = (body.type || '').trim(); const is = (body.issue || '').trim();
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!tp || !is) return res.status(400).json({ error: "Barcha maydonlarni to'ldiring" });
                // Use branch name from branches table if branch_id provided, else fallback to free text
                let brName = br;
                if (bid && !brName) {
                    const brRow = db.prepare('SELECT name FROM branches WHERE id = ?').get(bid);
                    if (brRow) brName = brRow.name;
                }
                const ts = nowTs();
                const probResult = db.prepare('INSERT INTO problems (timestamp, branch, type, issue, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ts, brName || '', tp, is, tid, ts, today, bid);
                logAudit(req, 'add', 'problems', {branch: brName, type: tp, issue: is, branch_id: bid}, probResult.lastInsertRowid);
                return res.json({ ok: true, message: 'Muammo saqlandi' });
            }

            case 'problem_solve': {
                if (!requirePerm(req, res, 'problems')) return;
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                let result;
                if (req.perms.is_ceo) {
                    result = db.prepare("UPDATE problems SET status = 'solved' WHERE id = ?").run(id);
                } else {
                    result = db.prepare("UPDATE problems SET status = 'solved' WHERE id = ? AND manager_id = ?").run(id, tid);
                }
                if (result.changes === 0) return res.status(404).json({ error: 'Muammo topilmadi' });
                logAudit(req, 'solve', 'problems', {id}, id);
                return res.json({ ok: true, message: 'Muammo hal qilindi' });
            }

            case 'problem_delete': {
                if (!requirePerm(req, res, 'problems')) return;
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                let result;
                if (req.perms.is_ceo) {
                    result = db.prepare('DELETE FROM problems WHERE id = ?').run(id);
                } else {
                    result = db.prepare('DELETE FROM problems WHERE id = ? AND manager_id = ?').run(id, tid);
                }
                if (result.changes === 0) return res.status(404).json({ error: 'Muammo topilmadi' });
                logAudit(req, 'delete', 'problems', {id}, id);
                return res.json({ ok: true, message: "O'chirildi" });
            }

            case 'lead_edit': {
                if (!requirePerm(req, res, 'leads')) return;
                const id = safeInt(body.id);
                const cnt = safeInt(body.count);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                if (cnt < 1) return res.status(400).json({ error: 'Son kiriting' });
                const leadEditResult = db.transaction(() => {
                    let row;
                    if (req.perms.is_ceo) {
                        row = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
                    } else {
                        row = db.prepare('SELECT id FROM leads WHERE id = ? AND manager_id = ?').get(id, req.perms.telegram_id);
                    }
                    if (!row) return { error: 'Yozuv topilmadi', status: 404 };
                    if (req.perms.is_ceo) {
                        db.prepare('UPDATE leads SET count = ? WHERE id = ?').run(cnt, id);
                    } else {
                        db.prepare('UPDATE leads SET count = ? WHERE id = ? AND manager_id = ?').run(cnt, id, req.perms.telegram_id);
                    }
                    return { ok: true };
                })();
                if (leadEditResult.error) return res.status(leadEditResult.status).json({ error: leadEditResult.error });
                logAudit(req, 'edit', 'leads', {count: cnt}, id);
                return res.json({ ok: true, message: 'Lead yangilandi' });
            }

            case 'debtor_edit': {
                if (!requirePerm(req, res, 'debtors')) return;
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                const editAmt = body.amount !== undefined ? safeInt(body.amount) : undefined;
                const editCnt = body.count !== undefined ? safeInt(body.count) : undefined;
                if ((editAmt !== undefined && editAmt < 0) || (editCnt !== undefined && editCnt < 0)) return res.status(400).json({ error: 'Manfiy qiymat kiritish mumkin emas' });
                const sets = []; const vals = [];
                if (editAmt !== undefined) { sets.push('amount = ?'); vals.push(editAmt); }
                if (editCnt !== undefined) { sets.push('count = ?'); vals.push(editCnt); }
                if (!sets.length) return res.status(400).json({ error: 'Yangilanadigan maydon yo\'q' });
                const ts = nowTs();
                const debtEditResult = db.transaction(() => {
                    // Check ownership inside transaction to avoid TOCTOU
                    let row;
                    if (req.perms.is_ceo) {
                        row = db.prepare('SELECT * FROM debtors WHERE id = ?').get(id);
                    } else {
                        row = db.prepare('SELECT * FROM debtors WHERE id = ? AND manager_id = ?').get(id, req.perms.telegram_id);
                    }
                    if (!row) return { error: 'Yozuv topilmadi', status: 404 };
                    const updateVals = [...vals];
                    if (req.perms.is_ceo) {
                        updateVals.push(id);
                        db.prepare(`UPDATE debtors SET ${sets.join(', ')} WHERE id = ?`).run(...updateVals);
                    } else {
                        updateVals.push(id, req.perms.telegram_id);
                        db.prepare(`UPDATE debtors SET ${sets.join(', ')} WHERE id = ? AND manager_id = ?`).run(...updateVals);
                    }
                    const diff = (editAmt !== undefined) ? editAmt - (row.amount || 0) : 0;
                    if (diff !== 0) {
                        db.prepare("INSERT INTO qarzdorlar_log (month, change_amount, type, note, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, 'manual_edit', 'TWA: Qarzdor tahrirlandi', ?, ?, ?, ?)").run(row.month || '', diff, tid, ts, todayYmd(), row.branch_id || 0);
                    }
                    return { ok: true };
                })();
                if (debtEditResult.error) return res.status(debtEditResult.status).json({ error: debtEditResult.error });
                logAudit(req, 'edit', 'debtors', {id, amount: editAmt, count: editCnt}, id);
                return res.json({ ok: true, message: 'Qarzdor yangilandi' });
            }

            case 'finance_edit': {
                if (!requirePerm(req, res, 'finance')) return;
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                const finEditResult = db.transaction(() => {
                    // Check ownership inside transaction
                    let row;
                    if (req.perms.is_ceo) {
                        row = db.prepare('SELECT id FROM finance WHERE id = ?').get(id);
                    } else {
                        row = db.prepare('SELECT id FROM finance WHERE id = ? AND manager_id = ?').get(id, req.perms.telegram_id);
                    }
                    if (!row) return { error: 'Yozuv topilmadi', status: 404 };
                    const sets = []; const vals = [];
                    if (body.amount !== undefined) {
                        const amt = safeInt(body.amount);
                        // Get original values inside the same transaction to avoid TOCTOU
                        const orig = req.perms.is_ceo
                            ? db.prepare('SELECT income, expense, category, month FROM finance WHERE id = ?').get(id)
                            : db.prepare('SELECT income, expense, category, month FROM finance WHERE id = ? AND manager_id = ?').get(id, req.perms.telegram_id);
                        // Block editing norasmiy income that has linked deduction records
                        if ((orig.income || 0) > 0 && orig.category === 'cat_1') {
                            const linked = db.prepare("SELECT id FROM qarzdorlar_log WHERE month = ? AND type = 'norasmiy_deduction' AND ABS(change_amount) = ? AND note NOT LIKE '%[reversed]%' LIMIT 1").get(orig.month, Math.abs(orig.income));
                            if (linked) return { error: 'Bu kirimga bog\'liq qarzdor ayirmasi mavjud. Avval bekor qiling, keyin qayta kiriting.', status: 400 };
                        }
                        if ((orig.income || 0) !== 0) {
                            // This is an income record (positive or negative/cancel)
                            const newAmt = orig.income > 0 ? amt : -amt;
                            sets.push('income = ?'); vals.push(newAmt); sets.push('kassa_amount = ?'); vals.push(newAmt);
                        } else {
                            // This is an expense record
                            const newAmt = orig.expense > 0 ? amt : -amt;
                            sets.push('expense = ?'); vals.push(newAmt);
                        }
                    }
                    if (body.comment !== undefined) { sets.push('comment = ?'); vals.push((body.comment || '').trim()); }
                    if (!sets.length) return { error: 'Yangilanadigan maydon yo\'q', status: 400 };
                    if (req.perms.is_ceo) {
                        vals.push(id);
                        db.prepare(`UPDATE finance SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
                    } else {
                        vals.push(id, req.perms.telegram_id);
                        db.prepare(`UPDATE finance SET ${sets.join(', ')} WHERE id = ? AND manager_id = ?`).run(...vals);
                    }
                    return { ok: true };
                })();
                if (finEditResult.error) return res.status(finEditResult.status).json({ error: finEditResult.error });
                logAudit(req, 'edit', 'finance', {id, amount: body.amount, comment: body.comment}, id);
                const editorName = req.perms?.name || 'Noma\'lum';
                notifyCEO('\u270f\ufe0f <b>Moliya tahrirlandi</b>\n\ud83d\udc64 ' + escTg(editorName) + '\n\ud83d\udcb0 Yangi: ' + (body.amount||'') + (body.comment ? '\n\ud83d\udcdd ' + escTg(body.comment) : ''));
                return res.json({ ok: true, message: 'Moliya yangilandi' });
            }

            case 'problem_edit': {
                if (!requirePerm(req, res, 'problems')) return;
                const id = safeInt(body.id);
                const issue = (body.issue || '').trim();
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                if (!issue) return res.status(400).json({ error: 'Matn kiriting' });
                const probEditResult = db.transaction(() => {
                    let row;
                    if (req.perms.is_ceo) {
                        row = db.prepare('SELECT id FROM problems WHERE id = ?').get(id);
                    } else {
                        row = db.prepare('SELECT id FROM problems WHERE id = ? AND manager_id = ?').get(id, req.perms.telegram_id);
                    }
                    if (!row) return { error: 'Yozuv topilmadi', status: 404 };
                    const pType = (body.type || '').trim();
                    if (req.perms.is_ceo || req.perms.is_manager) {
                        if (pType) { db.prepare('UPDATE problems SET issue = ?, type = ? WHERE id = ?').run(issue, pType, id); }
                        else { db.prepare('UPDATE problems SET issue = ? WHERE id = ?').run(issue, id); }
                    } else {
                        if (pType) { db.prepare('UPDATE problems SET issue = ?, type = ? WHERE id = ? AND manager_id = ?').run(issue, pType, id, req.perms.telegram_id); }
                        else { db.prepare('UPDATE problems SET issue = ? WHERE id = ? AND manager_id = ?').run(issue, id, req.perms.telegram_id); }
                    }
                    return { ok: true };
                })();
                if (probEditResult.error) return res.status(probEditResult.status).json({ error: probEditResult.error });
                logAudit(req, 'edit', 'problems', {issue}, id);
                return res.json({ ok: true, message: 'Muammo yangilandi' });
            }

            case 'room_add': {
                if (!requirePerm(req, res, 'rooms')) return;
                const br = (body.branch || '').trim(); const rm = (body.room || '').trim();
                const dy = (body.days || '').trim(); const tm = (body.time || '').trim(); const pr = (body.period || '').trim();
                const cap = safeInt(body.capacity) || 20; const pps = safeInt(body.price_per_student) || 350000;
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                let brName = br;
                if (bid && !brName) {
                    const brRow = db.prepare('SELECT name FROM branches WHERE id = ?').get(bid);
                    if (brRow) brName = brRow.name;
                }
                if (!rm || !dy || !pr) return res.status(400).json({ error: "Barcha maydonlarni to'ldiring" });
                const exists = db.prepare('SELECT id FROM empty_rooms WHERE branch = ? AND room = ? AND days = ? AND period = ? AND time = ? AND branch_id = ?').get(brName || '', rm, dy, pr, tm, bid);
                if (exists) return res.status(400).json({ error: 'Bu xona allaqachon mavjud' });
                const ts = nowTs();
                const roomResult = db.prepare('INSERT INTO empty_rooms (timestamp, branch, room, days, time, period, manager_id, capacity, price_per_student, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ts, brName || '', rm, dy, tm, pr, tid, cap, pps, ts, today, bid);
                logAudit(req, 'add', 'rooms', {branch: brName, room: rm, days: dy, time: tm, period: pr, capacity: cap, price_per_student: pps, branch_id: bid}, roomResult.lastInsertRowid);
                return res.json({ ok: true, message: "Xona qo'shildi" });
            }

            case 'room_delete': {
                if (!requirePerm(req, res, 'rooms')) return;
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                let result;
                if (req.perms.is_ceo) {
                    result = db.prepare('DELETE FROM empty_rooms WHERE id = ?').run(id);
                } else {
                    result = db.prepare('DELETE FROM empty_rooms WHERE id = ? AND manager_id = ?').run(id, req.perms.telegram_id);
                }
                if (result.changes === 0) return res.status(404).json({ error: 'Yozuv topilmadi' });
                logAudit(req, 'delete', 'rooms', {id}, id);
                return res.json({ ok: true, message: "O'chirildi" });
            }

            case 'rejection_add': {
                if (!requirePerm(req, res, 'rejections')) return;
                const sub = normSubject(body.subject); const cnt = safeInt(body.count);
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!sub || cnt < 1) return res.status(400).json({ error: 'Fan va son kiriting' });
                const ts = nowTs();
                const rejResult = db.prepare('INSERT INTO rejections (timestamp, subject, count, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ts, sub, cnt, tid, ts, today, bid);
                logAudit(req, 'add', 'rejections', {subject: sub, count: cnt, branch_id: bid}, rejResult.lastInsertRowid);
                return res.json({ ok: true, message: "Rad etilgan qo'shildi" });
            }

            case 'rejection_remove': {
                if (!requirePerm(req, res, 'rejections')) return;
                const sub = normSubject(body.subject); const cnt = safeInt(body.count);
                const bid = resolveBranchId(req, res, safeInt(body.branch_id));
                if (bid === null) return;
                if (!sub || cnt < 1) return res.status(400).json({ error: 'Fan va son kiriting' });
                const ts = nowTs();
                const rejRemResult = db.transaction(() => {
                    const bfq = bid ? ' AND branch_id = ?' : '';
                    const bfp = bid ? [sub, bid] : [sub];
                    const bal = db.prepare('SELECT COALESCE(SUM(count),0) as bal FROM rejections WHERE subject=?' + bfq).get(...bfp);
                    if (bal.bal < cnt) return { error: 'Yetarli rad etilgan soni yo\'q', status: 400 };
                    const r = db.prepare('INSERT INTO rejections (timestamp, subject, count, manager_id, created_at, date_ymd, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ts, sub, -cnt, tid, ts, today, bid);
                    return { ok: true, id: r.lastInsertRowid };
                })();
                if (rejRemResult.error) return res.status(rejRemResult.status).json({ error: rejRemResult.error });
                logAudit(req, 'remove', 'rejections', {subject: sub, count: cnt}, rejRemResult.id);
                return res.json({ ok: true, message: 'Rad etilgan ayirildi' });
            }

            case 'cron_toggle': {
                if (!requirePerm(req, res, 'cron')) return;
                const name = (body.name || '').trim();
                const enabled = body.enabled === 1 || body.enabled === '1' ? 1 : 0;
                if (!name) return res.status(400).json({ error: 'Cron nomi kerak' });
                const existing = db.prepare('SELECT id FROM cron_settings WHERE job_key = ?').get(name);
                if (existing) {
                    db.prepare('UPDATE cron_settings SET enabled = ? WHERE job_key = ?').run(enabled, name);
                } else {
                    db.prepare('INSERT INTO cron_settings (job_key, enabled, label) VALUES (?, ?, ?)').run(name, enabled, name);
                }
                // Reload crons in the bot if possible
                try {
                    const { reloadCrons } = require('./cron');
                    reloadCrons(bot).catch(e => console.error('[TWA] cron reload error:', e.message));
                } catch {}
                logAudit(req, 'toggle', 'cron', {name, enabled}, name);
                return res.json({ ok: true, message: enabled ? 'Cron yoqildi' : 'Cron o\'chirildi' });
            }

            case 'cron_schedule': {
                if (!requirePerm(req, res, 'cron')) return;
                const name = (body.name || '').trim();
                const schedule = (body.schedule || '').trim();
                if (!name || !schedule) return res.status(400).json({ error: 'Cron nomi va jadval kerak' });
                // Validate cron expression
                try {
                    const cronMod = require('node-cron');
                    if (!cronMod.validate(schedule)) return res.status(400).json({ error: 'Noto\'g\'ri cron ifoda' });
                } catch (cronErr) {
                    return res.status(400).json({ error: 'Cron validatsiya xatoligi: ' + (cronErr.message || 'noma\'lum') });
                }
                const existing = db.prepare('SELECT id FROM cron_settings WHERE job_key = ?').get(name);
                if (existing) {
                    db.prepare('UPDATE cron_settings SET schedule = ? WHERE job_key = ?').run(schedule, name);
                } else {
                    db.prepare('INSERT INTO cron_settings (job_key, enabled, label, schedule) VALUES (?, 1, ?, ?)').run(name, name, schedule);
                }
                // Reload crons in the bot if possible
                try {
                    const { reloadCrons } = require('./cron');
                    reloadCrons(bot).catch(e => console.error('[TWA] cron reload error:', e.message));
                } catch {}
                logAudit(req, 'schedule', 'cron', {name, schedule}, name);
                return res.json({ ok: true, message: 'Jadval yangilandi' });
            }

            // ─── Cron Assignments CRUD ─────────────────────────────
            case 'cron_assign_add': {
                if (!req.perms.is_ceo && !req.perms.is_manager) return res.status(403).json({ error: "Ruxsat yo'q" });
                const label = (body.label || '').trim();
                const message = (body.message || '').trim();
                const schedule = (body.schedule || '').trim();
                const assignedTo = (body.assigned_to || '').trim(); // telegram_id or 'branch'
                const bid = safeInt(body.branch_id);

                if (!label) return res.status(400).json({ error: 'Eslatma nomini kiriting' });
                if (!message && (body.type || 'message') !== 'report') return res.status(400).json({ error: 'Xabar matnini kiriting' });
                if (!schedule) return res.status(400).json({ error: 'Jadval kiriting' });
                if (!assignedTo) return res.status(400).json({ error: 'Qabul qiluvchini tanlang' });

                // Validate cron expression
                try {
                    const cronMod = require('node-cron');
                    if (!cronMod.validate(schedule)) return res.status(400).json({ error: "Noto'g'ri cron ifoda" });
                } catch { return res.status(400).json({ error: 'Cron validatsiya xatoligi' }); }

                // If assigning to specific user, validate role chain
                if (assignedTo !== 'branch') {
                    const targetUser = db.prepare('SELECT role FROM users WHERE telegram_id = ?').get(assignedTo);
                    if (!targetUser) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
                    if (req.perms.is_ceo && targetUser.role === 'ceo') return res.status(400).json({ error: "CEOga eslatma belgilab bo'lmaydi" });
                    if (req.perms.is_manager) {
                        if (targetUser.role !== 'user') return res.status(403).json({ error: 'Faqat oddiy foydalanuvchilarga eslatma belgilash mumkin' });
                        const userBranches = db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ?').all(assignedTo).map(b => b.branch_id);
                        const overlap = userBranches.some(b => req.perms.allowed_branches.includes(b));
                        if (!overlap) return res.status(403).json({ error: "Bu foydalanuvchi sizning filialingizda emas" });
                    }
                } else {
                    // Branch broadcast — manager must own the branch
                    if (!bid) return res.status(400).json({ error: 'Filialni tanlang' });
                    if (req.perms.is_manager && !req.perms.allowed_branches.includes(bid)) {
                        return res.status(403).json({ error: "Siz bu filialda ishlash huquqiga ega emassiz" });
                    }
                }

                const cronType = (body.type || 'message').trim();
                const cronSections = Array.isArray(body.sections) ? body.sections.join(',') : (body.sections || '');
                db.prepare('INSERT INTO cron_assignments (label, message, schedule, assigned_to, assigned_by, branch_id, type, sections) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(label, cronType === 'report' ? '' : message, schedule, assignedTo, req.perms.telegram_id, bid, cronType, cronSections);
                logAudit(req, 'add', 'cron_assignment', { label, schedule, assigned_to: assignedTo, branch_id: bid }, '');
                // Reload crons
                try { const { reloadCrons } = require('./cron'); reloadCrons(bot).catch(() => {}); } catch {}
                return res.json({ ok: true, message: 'Eslatma belgilandi' });
            }

            case 'cron_assign_edit': {
                if (!req.perms.is_ceo && !req.perms.is_manager) return res.status(403).json({ error: "Ruxsat yo'q" });
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kiriting' });
                const row = db.prepare('SELECT * FROM cron_assignments WHERE id = ?').get(id);
                if (!row) return res.status(404).json({ error: 'Topilmadi' });
                if (row.assigned_by !== req.perms.telegram_id && !req.perms.is_ceo) return res.status(403).json({ error: "Ruxsat yo'q" });

                const label = (body.label || row.label).trim();
                const message = (body.message || row.message).trim();
                const schedule = (body.schedule || row.schedule).trim();
                const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : row.enabled;

                // Validate cron if changed
                if (schedule !== row.schedule) {
                    try {
                        const cronMod = require('node-cron');
                        if (!cronMod.validate(schedule)) return res.status(400).json({ error: "Noto'g'ri cron ifoda" });
                    } catch { return res.status(400).json({ error: 'Cron validatsiya xatoligi' }); }
                }

                db.prepare('UPDATE cron_assignments SET label = ?, message = ?, schedule = ?, enabled = ? WHERE id = ?').run(label, message, schedule, enabled, id);
                logAudit(req, 'edit', 'cron_assignment', { id, label, schedule, enabled }, String(id));
                try { const { reloadCrons } = require('./cron'); reloadCrons(bot).catch(() => {}); } catch {}
                return res.json({ ok: true, message: 'Eslatma yangilandi' });
            }

            case 'cron_assign_delete': {
                if (!req.perms.is_ceo && !req.perms.is_manager) return res.status(403).json({ error: "Ruxsat yo'q" });
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kiriting' });
                const row = db.prepare('SELECT * FROM cron_assignments WHERE id = ?').get(id);
                if (!row) return res.status(404).json({ error: 'Topilmadi' });
                if (row.assigned_by !== req.perms.telegram_id && !req.perms.is_ceo) return res.status(403).json({ error: "Ruxsat yo'q" });
                db.prepare('DELETE FROM cron_assignments WHERE id = ?').run(id);
                logAudit(req, 'delete', 'cron_assignment', { id, label: row.label, assigned_to: row.assigned_to }, String(id));
                try { const { reloadCrons } = require('./cron'); reloadCrons(bot).catch(() => {}); } catch {}
                return res.json({ ok: true, message: "Eslatma o'chirildi" });
            }

            case 'user_add': {
                if (!requirePerm(req, res, 'users')) return;
                const utid = (body.telegram_id || '').trim(); const uname = (body.name || '').trim();
                if (!utid || !uname) return res.status(400).json({ error: 'Telegram ID va ism kiriting' });
                if (!/^\d+$/.test(utid)) return res.status(400).json({error:'Telegram ID raqam bo\'lishi kerak'});
                const existing = db.prepare('SELECT telegram_id FROM users WHERE telegram_id = ?').get(utid);
                if (existing) return res.status(400).json({ error: 'Bu ID allaqachon mavjud' });
                const secs = body.sections || {};
                // Determine role for new user
                let newRole = (body.role || 'user').trim();
                // Manager can only create simple users
                if (req.perms.is_manager) {
                    newRole = 'user';
                }
                // Only CEO can create CEO/manager roles
                if (newRole === 'super' && !req.perms.is_super) {
                    return res.status(403).json({ error: 'Super admin faqat super admin tomonidan yaratiladi' });
                }
                if ((newRole === 'ceo' || newRole === 'manager') && !req.perms.is_ceo) {
                    return res.status(403).json({ error: "Faqat CEO rol berishi mumkin" });
                }
                // Max 2 CEO accounts allowed
                if (newRole === 'ceo') {
                    const ceoCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'ceo'").get();
                    if (ceoCount.cnt >= 2) return res.status(400).json({ error: "Maksimal 2 ta CEO bo'lishi mumkin" });
                }
                db.prepare('INSERT INTO users (telegram_id, name, role, sec_lead, sec_qarzdorlar, sec_rad_etilganlar, sec_moliya, sec_davomat, sec_muammo, sec_bosh_xonalar, sec_reports, sec_foydalanuvchilar, sec_cron, sec_bosh, sec_tahlil, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
                    utid, uname, newRole, safeInt(secs.sec_lead), safeInt(secs.sec_qarzdorlar), safeInt(secs.sec_rad_etilganlar),
                    safeInt(secs.sec_moliya), safeInt(secs.sec_davomat), safeInt(secs.sec_muammo),
                    safeInt(secs.sec_bosh_xonalar), safeInt(secs.sec_reports), newRole === 'ceo' ? 1 : 0, newRole === 'ceo' ? 1 : 0, safeInt(secs.sec_bosh), safeInt(secs.sec_tahlil), 'uz'
                );
                // Assign branches — manager can only assign their own branches
                if (Array.isArray(body.branch_ids)) {
                    // Max 5 branches for managers
                    let branchList = body.branch_ids.map(b => safeInt(b)).filter(b => b > 0);
                    if (req.perms.is_manager) branchList = branchList.filter(b => req.perms.allowed_branches.includes(b));
                    if (newRole === 'manager' && branchList.length > 5) {
                        return res.status(400).json({ error: "Menejerga maksimal 5 ta filial biriktirilishi mumkin" });
                    }
                    const ins = db.prepare('INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)');
                    for (const b of branchList) ins.run(utid, b);
                }
                // CEO gets all branches auto-assigned
                if (newRole === 'ceo') {
                    const allBr = db.prepare('SELECT id FROM branches').all();
                    const ins = db.prepare('INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)');
                    for (const b of allBr) ins.run(utid, b.id);
                }
                refreshBotUsers();
                logAudit(req, 'add', 'users', {name: uname, telegram_id: utid, role: newRole}, utid);
                notifyCEO('\ud83d\udc64 <b>Yangi foydalanuvchi</b>\n\ud83d\udcdd ' + escTg(uname) + '\nID: ' + escTg(utid) + '\nRol: ' + escTg(newRole));
                return res.json({ ok: true, message: "Foydalanuvchi qo'shildi" });
            }

            case 'user_edit': {
                if (!requirePerm(req, res, 'users')) return;
                const utid = (body.telegram_id || '').trim(); const uname = (body.name || '').trim();
                if (!utid) return res.status(400).json({ error: 'Telegram ID kerak' });
                const targetUser = db.prepare('SELECT role FROM users WHERE telegram_id = ?').get(utid);
                if (!targetUser) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
                // Manager cannot edit CEO or other managers
                if (targetUser.role === 'super') {
                    return res.status(403).json({ error: 'Super admin tahrirlab bo\'lmaydi' });
                }
                if (req.perms.is_manager && (targetUser.role === 'ceo' || targetUser.role === 'manager')) {
                    return res.status(403).json({ error: "Bu foydalanuvchini tahrirlash huquqingiz yo'q" });
                }
                let secs = body.sections || {};
                // If no section toggles were sent, preserve existing permissions
                if (Object.keys(secs).length === 0) {
                    const existing = db.prepare('SELECT sec_lead, sec_qarzdorlar, sec_rad_etilganlar, sec_moliya, sec_davomat, sec_muammo, sec_bosh_xonalar, sec_reports, sec_foydalanuvchilar, sec_cron, sec_bosh, sec_tahlil FROM users WHERE telegram_id = ?').get(utid);
                    if (existing) secs = existing;
                }
                let newRole = (body.role || targetUser.role || 'user').trim();
                // Manager cannot promote to CEO/manager
                if (req.perms.is_manager) newRole = 'user';
                // Only CEO can set CEO/manager roles
                if ((newRole === 'ceo' || newRole === 'manager') && !req.perms.is_ceo) newRole = 'user';
                // Only super can assign super role
                if (newRole === 'super' && !req.perms.is_super) newRole = targetUser.role || 'user';
                // Only super can assign super role
                if (newRole === 'super' && !req.perms.is_super) newRole = targetUser.role || 'user';
                // Super can set any role including CEO
                if (req.perms.is_super && (newRole === 'ceo' || newRole === 'super')) { /* allowed */ }
                // Guard: prevent removing last CEO
                if (targetUser.role === 'ceo' && newRole !== 'ceo') {
                    const ceoCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'ceo'").get();
                    if (ceoCount.cnt <= 1) return res.status(400).json({ error: 'Oxirgi CEO rolini olib bo\'lmaydi' });
                }
                // Max 2 CEO accounts allowed
                if (newRole === 'ceo' && targetUser.role !== 'ceo' && !req.perms.is_super) {
                    const ceoCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'ceo'").get();
                    if (ceoCount.cnt >= 2) return res.status(400).json({ error: "Maksimal 2 ta CEO bo'lishi mumkin" });
                }
                db.prepare('UPDATE users SET name=?, role=?, sec_lead=?, sec_qarzdorlar=?, sec_rad_etilganlar=?, sec_moliya=?, sec_davomat=?, sec_muammo=?, sec_bosh_xonalar=?, sec_reports=?, sec_foydalanuvchilar=?, sec_cron=?, sec_bosh=?, sec_tahlil=? WHERE telegram_id=?').run(
                    uname, newRole, safeInt(secs.sec_lead), safeInt(secs.sec_qarzdorlar), safeInt(secs.sec_rad_etilganlar),
                    safeInt(secs.sec_moliya), safeInt(secs.sec_davomat), safeInt(secs.sec_muammo),
                    safeInt(secs.sec_bosh_xonalar), safeInt(secs.sec_reports), newRole === 'ceo' ? 1 : 0, newRole === 'ceo' ? 1 : 0, safeInt(secs.sec_bosh), safeInt(secs.sec_tahlil), utid
                );
                // Update branch assignments — manager can only assign their own branches
                if (Array.isArray(body.branch_ids)) {
                    let branchList = body.branch_ids.map(b => safeInt(b)).filter(b => b > 0);
                    if (req.perms.is_manager) branchList = branchList.filter(b => req.perms.allowed_branches.includes(b));
                    // Max 5 branches for managers
                    if (newRole === 'manager') {
                        // Count branches assigned by other CEOs/managers that current user can't touch
                        const otherBranches = req.perms.is_ceo ? 0 :
                            db.prepare('SELECT COUNT(*) as cnt FROM user_branches WHERE user_id = ? AND branch_id NOT IN (' + req.perms.allowed_branches.map(() => '?').join(',') + ')').get(utid, ...req.perms.allowed_branches)?.cnt || 0;
                        if (branchList.length + otherBranches > 5) {
                            return res.status(400).json({ error: "Menejerga maksimal 5 ta filial biriktirilishi mumkin" });
                        }
                    }
                    if (req.perms.is_ceo) {
                        db.prepare('DELETE FROM user_branches WHERE user_id = ?').run(utid);
                    } else {
                        // Manager: only remove assignments for their own branches
                        for (const b of req.perms.allowed_branches) {
                            db.prepare('DELETE FROM user_branches WHERE user_id = ? AND branch_id = ?').run(utid, b);
                        }
                    }
                    const ins = db.prepare('INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)');
                    for (const b of branchList) ins.run(utid, b);
                }
                // CEO gets all branches auto-assigned
                if (newRole === 'ceo') {
                    const allBr = db.prepare('SELECT id FROM branches').all();
                    const ins = db.prepare('INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)');
                    for (const b of allBr) ins.run(utid, b.id);
                }
                refreshBotUsers();
                logAudit(req, 'edit', 'users', {name: uname, role: newRole, sections_changed: Object.keys(secs)}, utid);
                notifyCEO('\u270f\ufe0f <b>Foydalanuvchi tahrirlandi</b>\n\ud83d\udcdd ' + escTg(uname) + '\nID: ' + escTg(utid) + '\nRol: ' + escTg(newRole));
                return res.json({ ok: true, message: 'Foydalanuvchi yangilandi' });
            }

            case 'user_delete': {
                if (!requirePerm(req, res, 'users')) return;
                const utid = (body.telegram_id || '').trim();
                if (!utid) return res.status(400).json({ error: 'Telegram ID kerak' });
                const target = db.prepare('SELECT role FROM users WHERE telegram_id = ?').get(utid);
                if (!target) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
                if (target.role === 'super') return res.status(403).json({ error: "Super admin o'chirib bo'lmaydi" });
                if (target.role === 'ceo' && !req.perms.is_super) return res.status(400).json({ error: "CEO ni o'chirib bo'lmaydi" });
                // Manager cannot delete other managers
                if (req.perms.is_manager && target.role === 'manager') {
                    logAudit(req, 'failed_delete', 'users', {reason: 'Manager cannot delete manager', target_id: utid}, '');
                    return res.status(403).json({ error: "Managerni o'chirish huquqingiz yo'q" });
                }
                db.prepare('DELETE FROM kpi_assignments WHERE assigned_to = ? OR assigned_by = ?').run(utid, utid);
                db.prepare('DELETE FROM cron_assignments WHERE assigned_to = ? OR assigned_by = ?').run(utid, utid);
                db.prepare('DELETE FROM user_branches WHERE user_id = ?').run(utid);
                db.prepare('DELETE FROM active_users WHERE telegram_id = ?').run(utid);
                // Nullify manager_id in historical records (preserve data, remove attribution)
                const mgrTables = ['leads','debtors','rejections','finance','attendance','problems','empty_rooms','qarzdorlar_log'];
                for (const t of mgrTables) {
                    db.prepare('UPDATE ' + t + " SET manager_id = '' WHERE manager_id = ?").run(utid);
                }
                db.prepare('DELETE FROM users WHERE telegram_id = ?').run(utid);
                refreshBotUsers();
                logAudit(req, 'delete', 'users', {telegram_id: utid}, utid);
                notifyCEO('\ud83d\uddd1 <b>Foydalanuvchi o\'chirildi</b>\nID: ' + escTg(utid));
                return res.json({ ok: true, message: "Foydalanuvchi o'chirildi" });
            }


            case 'attendance_delete': {
                if (!requirePerm(req, res, 'attendance')) return;
                if (!req.perms.can_delete) return res.status(403).json({ error: "O'chirish huquqingiz yo'q" });
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                const attDelRow = req.perms.can_delete ? db.prepare('SELECT manager_id FROM attendance WHERE id = ?').get(id) : null;
                const result = req.perms.is_ceo
                    ? db.prepare('DELETE FROM attendance WHERE id = ?').run(id)
                    : db.prepare('DELETE FROM attendance WHERE id = ? AND manager_id = ?').run(id, tid);
                if (result.changes === 0) return res.status(404).json({ error: 'Yozuv topilmadi yoki ruxsat yo\'q' });
                logAudit(req, 'delete', 'attendance', {id, target_manager_id: attDelRow ? attDelRow.manager_id : tid}, id);
                return res.json({ ok: true, message: "Davomat o'chirildi" });
            }

            case 'attendance_edit': {
                if (!requirePerm(req, res, 'attendance')) return;
                if (!req.perms.can_edit) return res.status(403).json({ error: "Tahrirlash huquqingiz yo'q" });
                const id = safeInt(body.id);
                const exp = safeInt(body.expected);
                const att = safeInt(body.attended);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                if (exp < 1) return res.status(400).json({ error: 'Kutilgan sonini kiriting' });
                if (att < 0) return res.status(400).json({ error: 'Kelganlar soni manfiy bo\'lishi mumkin emas' });
                if (att > exp) return res.status(400).json({ error: 'Kelganlar soni kutilganlardan ko\'p bo\'lishi mumkin emas' });
                const attEditRow = req.perms.can_edit ? db.prepare('SELECT manager_id FROM attendance WHERE id = ?').get(id) : null;
                const result = req.perms.is_ceo
                    ? db.prepare('UPDATE attendance SET expected = ?, attended = ? WHERE id = ?').run(exp, att, id)
                    : db.prepare('UPDATE attendance SET expected = ?, attended = ? WHERE id = ? AND manager_id = ?').run(exp, att, id, tid);
                if (result.changes === 0) return res.status(404).json({ error: 'Yozuv topilmadi yoki ruxsat yo\'q' });
                logAudit(req, 'edit', 'attendance', {expected: exp, attended: att, target_manager_id: attEditRow ? attEditRow.manager_id : tid}, id);
                return res.json({ ok: true, message: 'Davomat yangilandi' });
            }

            case 'room_edit': {
                if (!requirePerm(req, res, 'rooms')) return;
                if (!req.perms.can_edit) return res.status(403).json({ error: "Tahrirlash huquqingiz yo'q" });
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                const br = (body.branch || '').trim(); const rm = (body.room || '').trim();
                const dy = (body.days || '').trim(); const tm = (body.time || '').trim(); const pr = (body.period || '').trim();
                const cap = safeInt(body.capacity); const pps = safeInt(body.price_per_student);
                if (!br || !rm || !dy || !pr) return res.status(400).json({ error: "Filial, xona, kunlar va davr maydonlarini to'ldiring" });
                const roomEditResult = db.transaction(() => {
                    let row;
                    if (req.perms.is_ceo) {
                        row = db.prepare('SELECT id FROM empty_rooms WHERE id = ?').get(id);
                    } else {
                        row = db.prepare('SELECT id FROM empty_rooms WHERE id = ? AND manager_id = ?').get(id, req.perms.telegram_id);
                    }
                    if (!row) return { error: 'Yozuv topilmadi', status: 404 };
                    if (req.perms.is_ceo) {
                        db.prepare('UPDATE empty_rooms SET branch = ?, room = ?, days = ?, time = ?, period = ?, capacity = ?, price_per_student = ? WHERE id = ?').run(br, rm, dy, tm, pr, cap, pps, id);
                    } else {
                        db.prepare('UPDATE empty_rooms SET branch = ?, room = ?, days = ?, time = ?, period = ?, capacity = ?, price_per_student = ? WHERE id = ? AND manager_id = ?').run(br, rm, dy, tm, pr, cap, pps, id, req.perms.telegram_id);
                    }
                    return { ok: true };
                })();
                if (roomEditResult.error) return res.status(roomEditResult.status).json({ error: roomEditResult.error });
                logAudit(req, 'edit', 'rooms', {branch: br, room: rm, days: dy, time: tm, period: pr, capacity: cap, price_per_student: pps}, id);
                return res.json({ ok: true, message: 'Xona yangilandi' });
            }

            case 'kpi_target_set': {
                if (!req.perms || !req.perms.is_ceo) return res.status(403).json({ error: "Ruxsat yo'q" });
                const metric = (body.metric || '').trim();
                const month = normalizeMonth(body.month);
                const target = safeInt(body.target_value);
                if (!metric || !month) return res.status(400).json({ error: 'Metrika va oy kiriting' });
                db.prepare('INSERT INTO kpi_targets (metric, month, target_value) VALUES (?, ?, ?) ON CONFLICT(metric, month) DO UPDATE SET target_value = excluded.target_value').run(metric, month, target);
                logAudit(req, 'set', 'kpi_targets', {metric, month, target}, '');
                return res.json({ ok: true, message: 'KPI target saqlandi' });
            }

            case 'kpi_target_delete': {
                if (!req.perms || !req.perms.is_ceo) return res.status(403).json({ error: "Ruxsat yo'q" });
                const metric = (body.metric || '').trim();
                const month = normalizeMonth(body.month);
                if (!metric || !month) return res.status(400).json({ error: 'Metrika va oy kiriting' });
                db.prepare('DELETE FROM kpi_targets WHERE metric = ? AND month = ?').run(metric, month);
                logAudit(req, 'delete', 'kpi_targets', {metric, month}, '');
                return res.json({ ok: true, message: "KPI target o'chirildi" });
            }

            // ─── KPI Chain CRUD ──────────────────────────────────
            case 'kpi_assign': {
                if (!req.perms.is_ceo && !req.perms.is_manager) return res.status(403).json({ error: "Ruxsat yo'q" });
                const metric = (body.metric || '').trim();
                const month = normalizeMonth(body.month);
                const targetValue = safeInt(body.target_value);
                const assignedTo = (body.assigned_to || '').trim();
                const direction = body.direction === 'down' ? 'down' : 'up';
                const bid = safeInt(body.branch_id);

                if (!metric || !month || !assignedTo) return res.status(400).json({ error: 'Metrika, oy va foydalanuvchi kiriting' });
                if (targetValue < 1) return res.status(400).json({ error: 'Maqsad qiymati kiriting' });

                const validMetrics = ['leads', 'income', 'expense', 'attendance', 'debtors', 'rejections', 'problems_solved'];
                if (!validMetrics.includes(metric)) return res.status(400).json({ error: "Noto'g'ri metrika" });

                // Check target user exists
                const targetUserRow = db.prepare('SELECT role FROM users WHERE telegram_id = ?').get(assignedTo);
                if (!targetUserRow) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

                // CEO can assign to managers, manager can assign to simple users only
                if (req.perms.is_ceo && targetUserRow.role === 'ceo') return res.status(400).json({ error: 'CEOga KPI belgilab bo\'lmaydi' });
                if (req.perms.is_manager) {
                    if (targetUserRow.role !== 'user') return res.status(403).json({ error: 'Faqat oddiy foydalanuvchilarga KPI belgilash mumkin' });
                    // Manager can only assign to users in their branches
                    const userBranches = db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ?').all(assignedTo).map(b => b.branch_id);
                    const overlap = userBranches.some(b => req.perms.allowed_branches.includes(b));
                    if (!overlap) return res.status(403).json({ error: "Bu foydalanuvchi sizning filialingizda emas" });
                }

                db.prepare('INSERT INTO kpi_assignments (month, metric, target_value, direction, assigned_to, assigned_by, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(month, metric, assigned_to, branch_id) DO UPDATE SET target_value = excluded.target_value, direction = excluded.direction').run(month, metric, targetValue, direction, assignedTo, req.perms.telegram_id, bid);
                logAudit(req, 'assign', 'kpi', {metric, month, target_value: targetValue, assigned_to: assignedTo, branch_id: bid}, '');
                return res.json({ ok: true, message: 'KPI belgilandi' });
            }

            case 'kpi_assign_delete': {
                if (!req.perms.is_ceo && !req.perms.is_manager) return res.status(403).json({ error: "Ruxsat yo'q" });
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kiriting' });
                // Only allow deleting own assignments
                const row = db.prepare('SELECT * FROM kpi_assignments WHERE id = ?').get(id);
                if (!row) return res.status(404).json({ error: 'Topilmadi' });
                if (row.assigned_by !== req.perms.telegram_id && !req.perms.is_ceo) return res.status(403).json({ error: "Ruxsat yo'q" });
                db.prepare('DELETE FROM kpi_assignments WHERE id = ?').run(id);
                logAudit(req, 'delete', 'kpi', {id, metric: row.metric, assigned_to: row.assigned_to}, '');
                return res.json({ ok: true, message: "KPI o'chirildi" });
            }

            // ─── Branch CRUD ─────────────────────────────────────
            case 'finance_category_update': {
                if (!req.perms.is_ceo && !req.perms.is_super) return res.status(403).json({ error: 'Faqat CEO/Super admin' });
                const { key, label, color } = body;
                if (!key || !label) return res.status(400).json({ error: 'key va label kerak' });
                const fcResult = db.prepare('UPDATE finance_categories SET label = ?, color = ? WHERE key = ?').run(label.trim(), color || '#06b6d4', key);
                if (fcResult.changes === 0) return res.status(404).json({ error: 'Toifa topilmadi' });
                _finCatCache = null; // bust cache
                logAudit(req, 'update', 'finance_categories', { key, label, color }, '');
                return res.json({ ok: true });
            }

            case 'branch_add': {
                if (!req.perms || !req.perms.is_ceo) return res.status(403).json({ error: "Ruxsat yo'q" });
                const name = (body.name || '').trim();
                if (!name) return res.status(400).json({ error: 'Filial nomini kiriting' });
                const existing = db.prepare('SELECT id FROM branches WHERE LOWER(TRIM(name)) = LOWER(?)').get(name);
                if (existing) return res.status(409).json({ error: 'Bu filial allaqachon mavjud' });
                const brResult = db.prepare('INSERT INTO branches (name) VALUES (?)').run(name);
                // Auto-assign new branch to all CEO users
                const ceoUsers = db.prepare("SELECT telegram_id FROM users WHERE role = 'ceo'").all();
                const insUb = db.prepare('INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)');
                for (const u of ceoUsers) insUb.run(u.telegram_id, brResult.lastInsertRowid);
                logAudit(req, 'add', 'branches', {name}, brResult.lastInsertRowid);
                return res.json({ ok: true, id: brResult.lastInsertRowid, message: "Filial qo'shildi" });
            }

            case 'branch_edit': {
                if (!req.perms || !req.perms.is_ceo) return res.status(403).json({ error: "Ruxsat yo'q" });
                const id = safeInt(body.id);
                const name = (body.name || '').trim();
                if (!id || !name) return res.status(400).json({ error: 'ID va nom kerak' });
                const dup = db.prepare('SELECT id FROM branches WHERE LOWER(TRIM(name)) = LOWER(?) AND id != ?').get(name, id);
                if (dup) return res.status(409).json({ error: 'Bu nom allaqachon mavjud' });
                const brEditResult = db.prepare('UPDATE branches SET name = ? WHERE id = ?').run(name, id);
                if (brEditResult.changes === 0) return res.status(404).json({ error: 'Filial topilmadi' });
                logAudit(req, 'edit', 'branches', {name}, id);
                return res.json({ ok: true, message: 'Filial yangilandi' });
            }

            case 'branch_delete': {
                if (!req.perms || !req.perms.is_ceo) return res.status(403).json({ error: "Ruxsat yo'q" });
                const id = safeInt(body.id);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                // Check if branch is in use
                const BRANCH_TABLES = ['leads','debtors','rejections','finance','attendance','problems','empty_rooms','qarzdorlar_log','kpi_assignments','cron_assignments'];
                for (const t of BRANCH_TABLES) {
                    const cnt = db.prepare('SELECT COUNT(*) as cnt FROM ' + t + ' WHERE branch_id = ?').get(id);
                    if (cnt.cnt > 0) return res.status(400).json({ error: `Bu filialga tegishli ${t} ma'lumotlari mavjud. O'chirish mumkin emas.` });
                }
                db.prepare('DELETE FROM user_branches WHERE branch_id = ?').run(id);
                const brDelResult = db.prepare('DELETE FROM branches WHERE id = ?').run(id);
                if (brDelResult.changes === 0) return res.status(404).json({ error: 'Filial topilmadi' });
                logAudit(req, 'delete', 'branches', {id}, id);
                return res.json({ ok: true, message: "Filial o'chirildi" });
            }

            case 'rejection_edit': {
                if (!requirePerm(req, res, 'rejections')) return;
                const id = safeInt(body.id);
                const cnt = safeInt(body.count);
                if (!id) return res.status(400).json({ error: 'ID kerak' });
                if (cnt < 1) return res.status(400).json({ error: 'Son kiriting' });
                const rejEditResult = db.transaction(() => {
                    let row;
                    if (req.perms.is_ceo) {
                        row = db.prepare('SELECT id FROM rejections WHERE id = ?').get(id);
                    } else {
                        row = db.prepare('SELECT id FROM rejections WHERE id = ? AND manager_id = ?').get(id, req.perms.telegram_id);
                    }
                    if (!row) return { error: 'Yozuv topilmadi', status: 404 };
                    if (req.perms.is_ceo) {
                        db.prepare('UPDATE rejections SET count = ? WHERE id = ?').run(cnt, id);
                    } else {
                        db.prepare('UPDATE rejections SET count = ? WHERE id = ? AND manager_id = ?').run(cnt, id, req.perms.telegram_id);
                    }
                    return { ok: true };
                })();
                if (rejEditResult.error) return res.status(rejEditResult.status).json({ error: rejEditResult.error });
                logAudit(req, 'edit', 'rejections', {count: cnt}, id);
                return res.json({ ok: true, message: 'Rad etilgan yangilandi' });
            }

            case 'hr_add': {
                if (!requirePerm(req, res, 'hr')) return;
                const { name, phone, category, position, subject, start_date, notes, branch_ids } = req.body;
                if (!name) return res.status(400).json({ error: 'Ism kerak' });
                const effectiveBranchIds = (branch_ids && branch_ids.length) ? branch_ids : (branchId ? [branchId] : []);
                const staffId = db.transaction(() => {
                    const r = db.prepare('INSERT INTO hr_staff (name, phone, category, position, subject, start_date, notes, branch_id) VALUES (?,?,?,?,?,?,?,?)').run(
                        name, phone||'', category||'', position||'', subject||'', start_date||'', notes||'', effectiveBranchIds[0] || 0
                    );
                    if (effectiveBranchIds.length) {
                        const ins = db.prepare('INSERT OR IGNORE INTO hr_staff_branches (staff_id, branch_id) VALUES (?,?)');
                        effectiveBranchIds.forEach(bid => ins.run(Number(r.lastInsertRowid), bid));
                    }
                    return r.lastInsertRowid;
                })();
                logAudit(req, 'hr_add', 'hr', { name, category, position }, staffId);
                return res.json({ ok: true, id: Number(staffId) });
            }

            case 'hr_edit': {
                if (!requirePerm(req, res, 'hr')) return;
                const { id, name, phone, category, position, subject, start_date, end_date, status, notes, branch_ids } = req.body;
                if (!id || !name) return res.status(400).json({ error: 'id va ism kerak' });
                db.transaction(() => {
                    db.prepare('UPDATE hr_staff SET name=?, phone=?, category=?, position=?, subject=?, start_date=?, end_date=?, status=?, notes=? WHERE id=?').run(
                        name, phone||'', category||'', position||'', subject||'', start_date||'', end_date||'', status||'active', notes||'', id
                    );
                    db.prepare('DELETE FROM hr_staff_branches WHERE staff_id = ?').run(id);
                    if (branch_ids && branch_ids.length) {
                        const ins = db.prepare('INSERT OR IGNORE INTO hr_staff_branches (staff_id, branch_id) VALUES (?,?)');
                        branch_ids.forEach(bid => ins.run(id, bid));
                    }
                })();
                logAudit(req, 'hr_edit', 'hr', { name, category, position }, id);
                return res.json({ ok: true });
            }

            case 'hr_deactivate': {
                if (!requirePerm(req, res, 'hr')) return;
                const { id } = req.body;
                if (!id) return res.status(400).json({ error: 'id kerak' });
                const today = todayYmd();
                db.prepare("UPDATE hr_staff SET status = 'inactive', end_date = ? WHERE id = ?").run(today, id);
                logAudit(req, 'hr_deactivate', 'hr', {}, id);
                return res.json({ ok: true });
            }

            case 'hr_delete': {
                if (!requirePerm(req, res, 'hr')) return;
                const { id } = req.body;
                if (!id) return res.status(400).json({ error: 'id kerak' });
                db.transaction(() => {
                    db.prepare('DELETE FROM hr_staff_branches WHERE staff_id = ?').run(id);
                    db.prepare('DELETE FROM hr_staff WHERE id = ?').run(id);
                })();
                logAudit(req, 'hr_delete', 'hr', {}, id);
                return res.json({ ok: true });
            }

            case 'goal_add': {
                if (!requirePerm(req, res, 'hr')) return;
                const { branch_id, category, subject, title, description, deadline, status } = req.body;
                if (!title) return res.status(400).json({ error: 'Sarlavha kerak' });
                const r = db.prepare('INSERT INTO hr_goals (branch_id, category, subject, title, description, deadline, status) VALUES (?,?,?,?,?,?,?)').run(
                    branch_id||0, category||'', subject||'', title, description||'', deadline||'', status||'pending'
                );
                logAudit(req, 'goal_add', 'hr', { title, category }, r.lastInsertRowid);
                return res.json({ ok: true, id: Number(r.lastInsertRowid) });
            }

            case 'goal_edit': {
                if (!requirePerm(req, res, 'hr')) return;
                const { id, title, description, deadline, status } = req.body;
                if (!id || !title) return res.status(400).json({ error: 'id va sarlavha kerak' });
                db.prepare('UPDATE hr_goals SET title=?, description=?, deadline=?, status=? WHERE id=?').run(title, description||'', deadline||'', status||'pending', id);
                logAudit(req, 'goal_edit', 'hr', { title }, id);
                return res.json({ ok: true });
            }

            case 'goal_complete': {
                if (!requirePerm(req, res, 'hr')) return;
                const { id } = req.body;
                if (!id) return res.status(400).json({ error: 'id kerak' });
                db.prepare("UPDATE hr_goals SET status = 'completed' WHERE id = ?").run(id);
                logAudit(req, 'goal_complete', 'hr', {}, id);
                return res.json({ ok: true });
            }

            case 'goal_delete': {
                if (!requirePerm(req, res, 'hr')) return;
                const { id } = req.body;
                if (!id) return res.status(400).json({ error: 'id kerak' });
                db.prepare('DELETE FROM hr_goals WHERE id = ?').run(id);
                logAudit(req, 'goal_delete', 'hr', {}, id);
                return res.json({ ok: true });
            }

            
            default:
                return res.status(404).json({ error: 'Not found' });
            }
        } catch (e) {
            console.error('[TWA POST]', endpoint, e.message);
            return res.status(500).json({ error: 'Ichki server xatoligi' });
        }
    });

    // ─── DB Admin (CEO or password) ─────────────────────────
    // DB_ADMIN_KEY removed — auth is via is_super_ceo only
    function dbAuth(req, res) {
        if (req.perms?.is_super_ceo) return true;
        res.status(403).json({ error: 'Access denied' });
        return false;
    }

    app.get(['/api/db/tables', '/twa/api/db/tables'], (req, res) => {
        if (!dbAuth(req, res)) return;
        try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
            const result = tables.map(t => {
                const count = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get().c;
                return { name: t.name, count };
            });
            res.json({ tables: result });
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get(['/api/db/table/:name', '/twa/api/db/table/:name'], (req, res) => {
        if (!dbAuth(req, res)) return;
        try {
            const tableName = req.params.name;
            // Validate table name exists
            const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
            if (!exists) return res.status(404).json({ error: 'Table not found' });
            const page = Math.max(1, parseInt(req.query.page) || 1);
            const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
            const offset = (page - 1) * limit;
            const total = db.prepare(`SELECT COUNT(*) as c FROM "${tableName}"`).get().c;
            const rows = db.prepare(`SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`).all(limit, offset);
            const columns = rows.length > 0 ? Object.keys(rows[0]) :
                db.prepare(`PRAGMA table_info("${tableName}")`).all().map(c => c.name);
            res.json({ columns, rows, total, page, limit });
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post(['/api/db/query', '/twa/api/db/query'], (req, res) => {
        if (!dbAuth(req, res)) return;
        try {
            const sql = (req.body.sql || '').trim();
            if (!sql) return res.status(400).json({ error: 'Empty query' });
            // Only allow read-only operations for safety
            const upper = sql.toUpperCase().trimStart();
            const isReadOnly = upper.startsWith('SELECT') || upper.startsWith('PRAGMA') || upper.startsWith('EXPLAIN');
            if (!isReadOnly) {
                return res.status(403).json({ error: 'Only SELECT/PRAGMA/EXPLAIN queries allowed. Use the bot for data modifications.' });
            }
            const start = Date.now();
            const stmt = db.prepare(sql);
            const rows = stmt.all();
            const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
            res.json({ columns, rows, total: rows.length, time: Date.now() - start });
        } catch(e) {
            res.status(400).json({ error: e.message });
        }
    });

    return app;
}

module.exports = { createTwaApi };
