/**
 * CRM Sync Module
 * Pulls data from ModMe CRM API and syncs to local bot database.
 *
 * Supported sync targets:
 *   - leads       (CRM leads → bot leads table)
 *   - payments    (CRM payments → bot finance table as income)
 *   - expenses    (CRM expenses → bot finance table as expense)
 *   - debtors     (CRM debtors → bot debtors table)
 *   - attendance  (CRM attendance → bot attendance table)
 */

const db = require('./db');
const logger = require('./logger');
const { getTashkentDateString, getTashkentNow } = require('./utils');

// ── Config ───────────────────────────────────────────────────────────
const CRM_BASE_URL = (process.env.CRM_BASE_URL || '').replace(/\/+$/, '');
const CRM_PHONE    = process.env.CRM_PHONE    || '';
const CRM_PASSWORD = process.env.CRM_PASSWORD || '';
const CRM_BRANCH_ID = process.env.CRM_BRANCH_ID || '1';

let _accessToken = null;
let _tokenExpiresAt = 0;

// ── HTTP helper ──────────────────────────────────────────────────────
async function crmFetch(path, options = {}) {
    const url = `${CRM_BASE_URL}${path}`;
    const headers = {
        'Content-Type': 'application/json',
        'x-branch-id': CRM_BRANCH_ID,
        ...options.headers,
    };
    if (_accessToken) {
        headers['Authorization'] = `Bearer ${_accessToken}`;
    }

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`CRM API ${res.status}: ${path} — ${body}`);
    }
    return res.json();
}

// ── Auth ─────────────────────────────────────────────────────────────
async function ensureAuth() {
    if (_accessToken && Date.now() < _tokenExpiresAt) return;

    logger.info('[CRM-Sync] Authenticating...');
    const data = await crmFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ phone: CRM_PHONE, password: CRM_PASSWORD }),
    });

    _accessToken = data.accessToken;
    // Refresh 2 minutes before expiry (token is 15 min)
    _tokenExpiresAt = Date.now() + 13 * 60 * 1000;
    logger.info('[CRM-Sync] Authenticated OK');
}

// ── Sync helpers ─────────────────────────────────────────────────────

function nowTs() {
    return getTashkentNow().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
}

function todayYmd() {
    return getTashkentDateString();
}

/**
 * Get or create a sync cursor so we only import new records.
 * Stores last synced timestamp per sync type in a `crm_sync_state` table.
 */
function getLastSyncTime(syncType) {
    const row = db.prepare('SELECT last_synced_at FROM crm_sync_state WHERE sync_type = ?').get(syncType);
    return row ? row.last_synced_at : null;
}

function setLastSyncTime(syncType, isoDate) {
    db.prepare(`
        INSERT INTO crm_sync_state (sync_type, last_synced_at)
        VALUES (?, ?)
        ON CONFLICT(sync_type) DO UPDATE SET last_synced_at = excluded.last_synced_at
    `).run(syncType, isoDate);
}

// ── Sync: Leads ──────────────────────────────────────────────────────
async function syncLeads() {
    await ensureAuth();
    const data = await crmFetch('/api/leads');

    // CRM returns { data: { LEAD: [...], EXPECTATION: [...], SET: [...] }, counts: {...} }
    const allLeads = [
        ...(data.data.LEAD || []),
        ...(data.data.EXPECTATION || []),
        ...(data.data.SET || []),
    ];

    const lastSync = getLastSyncTime('leads');
    const newLeads = lastSync
        ? allLeads.filter(l => l.createdAt > lastSync)
        : allLeads;

    if (newLeads.length === 0) {
        logger.info('[CRM-Sync] Leads: no new records');
        return { synced: 0 };
    }

    // Group by course name
    const byCourse = {};
    for (const lead of newLeads) {
        const courseName = lead.course?.name || 'Boshqa';
        byCourse[courseName] = (byCourse[courseName] || 0) + 1;
    }

    const ts = nowTs();
    const dateYmd = todayYmd();
    const insert = db.prepare('INSERT INTO leads (timestamp, date_ymd, subject, count, manager_id, branch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

    const insertAll = db.transaction(() => {
        for (const [subject, count] of Object.entries(byCourse)) {
            insert.run(ts, dateYmd, subject, count, 'crm-sync', '', ts);
        }
    });
    insertAll();

    // Update cursor to the latest createdAt
    const maxDate = newLeads.reduce((max, l) => l.createdAt > max ? l.createdAt : max, '');
    if (maxDate) setLastSyncTime('leads', maxDate);

    logger.info(`[CRM-Sync] Leads: synced ${newLeads.length} (${Object.keys(byCourse).length} courses)`);
    return { synced: newLeads.length, byCourse };
}

// ── Sync: Payments (Income) ──────────────────────────────────────────
async function syncPayments() {
    await ensureAuth();

    const lastSync = getLastSyncTime('payments');
    let url = '/api/finance/payments?page=1&limit=100';
    if (lastSync) {
        url += `&startDate=${lastSync.split('T')[0]}`;
    }

    const data = await crmFetch(url);
    const payments = data.data || [];

    const newPayments = lastSync
        ? payments.filter(p => p.date > lastSync || p.createdAt > lastSync)
        : payments;

    if (newPayments.length === 0) {
        logger.info('[CRM-Sync] Payments: no new records');
        return { synced: 0 };
    }

    const ts = nowTs();
    const dateYmd = todayYmd();
    const insert = db.prepare(`
        INSERT INTO finance (timestamp, date_ymd, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, branch_id, created_at)
        VALUES (?, ?, ?, 0, ?, ?, 1, '', ?, ?, ?, ?, ?)
    `);

    const insertAll = db.transaction(() => {
        for (const p of newPayments) {
            const amount = parseInt(p.amount, 10) || 0;
            if (amount <= 0) continue;

            const payDate = new Date(p.date || p.createdAt);
            const month = payDate.toLocaleString('uz-UZ', { year: 'numeric', month: '2-digit', timeZone: 'Asia/Tashkent' });

            // Map CRM payment method to bot category
            const category = p.method === 'CASH' ? 'cat_1' : 'cat_2';
            const comment = `CRM: ${p.student?.user?.firstName || ''} ${p.student?.user?.lastName || ''} (${p.method})`.trim();

            insert.run(ts, dateYmd, amount, month, amount, category, comment, 'crm-sync', '', ts);
        }
    });
    insertAll();

    const maxDate = newPayments.reduce((max, p) => {
        const d = p.date || p.createdAt;
        return d > max ? d : max;
    }, '');
    if (maxDate) setLastSyncTime('payments', maxDate);

    logger.info(`[CRM-Sync] Payments: synced ${newPayments.length}`);
    return { synced: newPayments.length };
}

// ── Sync: Expenses ───────────────────────────────────────────────────
async function syncExpenses() {
    await ensureAuth();

    const lastSync = getLastSyncTime('expenses');
    let url = '/api/finance/expenses?page=1&limit=100';
    if (lastSync) {
        url += `&startDate=${lastSync.split('T')[0]}`;
    }

    const data = await crmFetch(url);
    const expenses = data.data || [];

    const newExpenses = lastSync
        ? expenses.filter(e => e.createdAt > lastSync)
        : expenses;

    if (newExpenses.length === 0) {
        logger.info('[CRM-Sync] Expenses: no new records');
        return { synced: 0 };
    }

    const ts = nowTs();
    const dateYmd = todayYmd();
    const insert = db.prepare(`
        INSERT INTO finance (timestamp, date_ymd, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id, branch_id, created_at)
        VALUES (?, ?, 0, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)
    `);

    const insertAll = db.transaction(() => {
        for (const e of newExpenses) {
            const amount = parseInt(e.amount, 10) || 0;
            if (amount <= 0) continue;

            const expDate = new Date(e.createdAt);
            const month = expDate.toLocaleString('uz-UZ', { year: 'numeric', month: '2-digit', timeZone: 'Asia/Tashkent' });
            const category = 'cat_1';
            const comment = `CRM: ${e.category || ''} - ${e.description || ''}`.trim();

            insert.run(ts, dateYmd, amount, month, e.category || '', category, comment, 'crm-sync', '', ts);
        }
    });
    insertAll();

    const maxDate = newExpenses.reduce((max, e) => e.createdAt > max ? e.createdAt : max, '');
    if (maxDate) setLastSyncTime('expenses', maxDate);

    logger.info(`[CRM-Sync] Expenses: synced ${newExpenses.length}`);
    return { synced: newExpenses.length };
}

// ── Sync: Debtors ────────────────────────────────────────────────────
async function syncDebtors() {
    await ensureAuth();
    const data = await crmFetch('/api/finance/debtors?page=1&limit=500');
    const debtors = data.data || [];

    if (debtors.length === 0) {
        logger.info('[CRM-Sync] Debtors: no records in CRM');
        return { synced: 0 };
    }

    const ts = nowTs();
    const dateYmd = todayYmd();
    const now = getTashkentNow();
    const month = now.toLocaleString('uz-UZ', { year: 'numeric', month: '2-digit', timeZone: 'Asia/Tashkent' });

    // Calculate total count and amount
    let totalCount = debtors.length;
    let totalAmount = 0;
    for (const d of debtors) {
        const bal = parseInt(d.balance || d.debt || '0', 10);
        totalAmount += Math.abs(bal);
    }

    // Check if we already synced debtors today
    const existing = db.prepare("SELECT id FROM debtors WHERE date_ymd = ? AND manager_id = 'crm-sync'").get(dateYmd);
    if (existing) {
        logger.info('[CRM-Sync] Debtors: already synced today');
        return { synced: 0, skipped: true };
    }

    db.prepare('INSERT INTO debtors (timestamp, date_ymd, count, amount, month, manager_id, branch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ts, dateYmd, totalCount, totalAmount, month, 'crm-sync', '', ts);

    setLastSyncTime('debtors', new Date().toISOString());

    logger.info(`[CRM-Sync] Debtors: synced ${totalCount} debtors, ${totalAmount} sum`);
    return { synced: totalCount, totalAmount };
}

// ── Sync: Attendance ─────────────────────────────────────────────────
async function syncAttendance() {
    await ensureAuth();

    const today = todayYmd();
    const data = await crmFetch(`/api/attendance/report?startDate=${today}&endDate=${today}`);
    const records = data.data || [];

    if (records.length === 0) {
        logger.info('[CRM-Sync] Attendance: no records for today');
        return { synced: 0 };
    }

    // Aggregate: count PRESENT and total
    let attended = 0;
    let expected = 0;
    for (const r of records) {
        expected++;
        if (r.status === 'PRESENT' || r.status === 'LATE') {
            attended++;
        }
    }

    // Check if already synced today
    const existing = db.prepare("SELECT id FROM attendance WHERE date_ymd = ? AND manager_id = 'crm-sync'").get(today);
    if (existing) {
        // Update existing record
        db.prepare("UPDATE attendance SET expected = ?, attended = ? WHERE date_ymd = ? AND manager_id = 'crm-sync'")
            .run(expected, attended, today);
        logger.info(`[CRM-Sync] Attendance: updated today — ${attended}/${expected}`);
        return { synced: 1, updated: true, expected, attended };
    }

    const ts = nowTs();
    db.prepare('INSERT INTO attendance (timestamp, date_ymd, expected, attended, manager_id, branch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ts, today, expected, attended, 'crm-sync', '', ts);

    setLastSyncTime('attendance', new Date().toISOString());
    logger.info(`[CRM-Sync] Attendance: synced — ${attended}/${expected}`);
    return { synced: 1, expected, attended };
}

// ── Run all syncs ────────────────────────────────────────────────────
async function syncAll() {
    if (!CRM_BASE_URL || !CRM_PHONE) {
        logger.warn('[CRM-Sync] Disabled — CRM_BASE_URL or CRM_PHONE not set');
        return null;
    }

    logger.info('[CRM-Sync] Starting full sync...');
    const results = {};

    const tasks = [
        ['leads', syncLeads],
        ['payments', syncPayments],
        ['expenses', syncExpenses],
        ['debtors', syncDebtors],
        ['attendance', syncAttendance],
    ];

    for (const [name, fn] of tasks) {
        try {
            results[name] = await fn();
        } catch (err) {
            logger.error(`[CRM-Sync] ${name} failed:`, err.message);
            results[name] = { error: err.message };
        }
    }

    logger.info('[CRM-Sync] Full sync complete:', JSON.stringify(results));
    return results;
}

// ── Exports ──────────────────────────────────────────────────────────
module.exports = {
    syncAll,
    syncLeads,
    syncPayments,
    syncExpenses,
    syncDebtors,
    syncAttendance,
    isConfigured: () => Boolean(CRM_BASE_URL && CRM_PHONE),
};
