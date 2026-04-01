/**
 * Sync Module — One-way SQLite → Google Sheets
 * Periodically writes all SQLite data to Google Sheets so CEO can view in spreadsheet.
 * If sync fails, the bot is unaffected — Sheets is just a viewer.
 */
const db = require('./db');
const sheets = require('./sheets');
const { SHEETS } = require('./constants');
const logger = require('./logger');
const { USER_SECTION_KEYS } = require('./constants');

let _syncing = false;

async function syncAllToSheets() {
    if (_syncing) {
        logger.info('[SYNC] Already syncing, skipping.');
        return;
    }
    _syncing = true;
    try {
    const startTime = Date.now();

    const tables = [
        {
            table: 'leads', sheet: SHEETS.LEAD,
            columns: ['timestamp', 'date_ymd', 'subject', 'count', 'manager_id']
        },
        {
            table: 'debtors', sheet: SHEETS.DEBTORS,
            columns: ['timestamp', 'date_ymd', 'count', 'amount', 'month', 'manager_id']
        },
        {
            table: 'rejections', sheet: SHEETS.REJECTIONS,
            columns: ['timestamp', 'date_ymd', 'subject', 'count', 'manager_id']
        },
        {
            table: 'finance', sheet: SHEETS.FINANCE,
            columns: ['timestamp', 'date_ymd', 'income', 'expense', 'month', 'kassa_amount', 'kassa_students', 'expense_type', 'category', 'comment', 'manager_id']
        },
        {
            table: 'problems', sheet: SHEETS.PROBLEMS,
            columns: ['timestamp', 'date_ymd', 'branch', 'type', 'issue', 'manager_id']
        },
        {
            table: 'attendance', sheet: SHEETS.ATTENDANCE,
            columns: ['timestamp', 'date_ymd', 'expected', 'attended', 'manager_id']
        },
        {
            table: 'empty_rooms', sheet: SHEETS.EMPTY_ROOMS,
            columns: ['timestamp', 'date_ymd', 'branch', 'room', 'days', 'time', 'period', 'manager_id', 'capacity', 'price_per_student']
        }
    ];

    let successCount = 0;
    let failCount = 0;

    for (const { table, sheet, columns } of tables) {
        try {
            const rows = db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY id`).all();
            // Safer sync: clear THEN immediately append (reduces window of data loss)
            // If append fails, old data is already gone — but this is a viewer-only copy
            await sheets.clearSheetData(sheet);
            if (rows.length > 0) {
                const values = rows.map(r => columns.map(c => r[c] !== null && r[c] !== undefined ? r[c] : ''));
                await sheets.appendRowsBatch(sheet, values);
            }
            successCount++;
        } catch (e) {
            logger.error(`[SYNC] Failed to sync ${sheet}:`, e.message);
            failCount++;
        }
        // Delay between sheets to avoid Google Sheets rate limiting
        await new Promise(r => setTimeout(r, 4000));
    }

    // Sync users table
    await new Promise(r => setTimeout(r, 4000));
    try {
        const users = db.prepare('SELECT * FROM users ORDER BY telegram_id').all();
        await sheets.clearSheetData(SHEETS.USERS);
        if (users.length > 0) {
            const values = users.map(u => {
                const row = [u.telegram_id, u.name];
                for (const key of USER_SECTION_KEYS) {
                    row.push(u[`sec_${key}`] ? 'TRUE' : 'FALSE');
                }
                row.push(u.lang || 'uz');
                return row;
            });
            await sheets.appendRowsBatch(SHEETS.USERS, values);
        }
        successCount++;
    } catch (e) {
        logger.error('[SYNC] Failed to sync Users:', e.message);
        failCount++;
    }

    // Sync subjects
    try {
        await new Promise(r => setTimeout(r, 4000));
        const subjects = db.prepare('SELECT name, created_at FROM subjects ORDER BY id').all();
        await sheets.clearSheetData(SHEETS.SUBJECTS);
        if (subjects.length > 0) {
            await sheets.appendRowsBatch(SHEETS.SUBJECTS, subjects.map(s => [s.name, s.created_at]));
        }
        successCount++;
    } catch (e) {
        logger.error('[SYNC] Failed to sync Subjects:', e.message);
        failCount++;
    }

    // Sync expense types
    try {
        await new Promise(r => setTimeout(r, 4000));
        const types = db.prepare('SELECT name, created_at FROM expense_types ORDER BY id').all();
        await sheets.clearSheetData(SHEETS.EXPENSE_TYPES);
        if (types.length > 0) {
            await sheets.appendRowsBatch(SHEETS.EXPENSE_TYPES, types.map(t => [t.name, t.created_at]));
        }
        successCount++;
    } catch (e) {
        logger.error('[SYNC] Failed to sync Expense Types:', e.message);
        failCount++;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[SYNC] Completed in ${elapsed}s — ${successCount} synced, ${failCount} failed.`);
    } finally {
        _syncing = false;
    }
}

module.exports = { syncAllToSheets };
