/**
 * One-time migration: Google Sheets → SQLite
 * Run: node migrate-sheets-to-sqlite.js
 */
require('dotenv').config();
const db = require('./db');
const sheets = require('./sheets');
const { SHEETS, USER_SECTION_KEYS } = require('./constants');

async function migrate() {
    console.log('=== NS Bot V6: Google Sheets → SQLite Migration ===\n');

    // 1. Leads
    try {
        const rows = await sheets.getRows(SHEETS.LEAD);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT INTO leads (timestamp, subject, count, manager_id) VALUES (?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || r.length === 0) continue;
                    stmt.run(r[0] || '', r[1] || '', parseInt(r[2]) || 0, r[3] || '');
                }
            });
            insertAll();
            console.log(`✅ Leads: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Leads: no data');
        }
    } catch (e) { console.error('❌ Leads:', e.message); }

    // 2. Debtors
    try {
        const rows = await sheets.getRows(SHEETS.DEBTORS);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT INTO debtors (timestamp, count, amount, month, manager_id) VALUES (?, ?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || r.length === 0) continue;
                    stmt.run(r[0] || '', parseInt(String(r[1] || '0').replace(/[.,\s]/g, '')) || 0, parseInt(String(r[2] || '0').replace(/[.,\s]/g, '')) || 0, r[3] || '', r[4] || '');
                }
            });
            insertAll();
            console.log(`✅ Debtors: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Debtors: no data');
        }
    } catch (e) { console.error('❌ Debtors:', e.message); }

    // 3. Rejections
    try {
        const rows = await sheets.getRows(SHEETS.REJECTIONS);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT INTO rejections (timestamp, subject, count, manager_id) VALUES (?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || r.length === 0) continue;
                    stmt.run(r[0] || '', r[1] || '', parseInt(r[2]) || 0, r[3] || '');
                }
            });
            insertAll();
            console.log(`✅ Rejections: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Rejections: no data');
        }
    } catch (e) { console.error('❌ Rejections:', e.message); }

    // 4. Finance
    try {
        const rows = await sheets.getRows(SHEETS.FINANCE);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT INTO finance (timestamp, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || r.length === 0) continue;
                    stmt.run(
                        r[0] || '',
                        parseInt(String(r[1] || '0').replace(/[.,\s]/g, '')) || 0,
                        parseInt(String(r[2] || '0').replace(/[.,\s]/g, '')) || 0,
                        r[3] || '',
                        parseInt(String(r[4] || '0').replace(/[.,\s]/g, '')) || 0,
                        parseInt(String(r[5] || '0').replace(/[.,\s]/g, '')) || 0,
                        r[6] || '-',
                        r[7] || '-',
                        r[8] || '',
                        r[9] || ''
                    );
                }
            });
            insertAll();
            console.log(`✅ Finance: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Finance: no data');
        }
    } catch (e) { console.error('❌ Finance:', e.message); }

    // 5. Problems
    try {
        const rows = await sheets.getRows(SHEETS.PROBLEMS);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT INTO problems (timestamp, branch, type, issue, manager_id) VALUES (?, ?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || r.length === 0) continue;
                    stmt.run(r[0] || '', r[1] || '', r[2] || '', r[3] || '', r[4] || '');
                }
            });
            insertAll();
            console.log(`✅ Problems: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Problems: no data');
        }
    } catch (e) { console.error('❌ Problems:', e.message); }

    // 6. Attendance
    try {
        const rows = await sheets.getRows(SHEETS.ATTENDANCE);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT INTO attendance (timestamp, expected, attended, manager_id) VALUES (?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || r.length === 0) continue;
                    stmt.run(r[0] || '', parseInt(r[1]) || 0, parseInt(r[2]) || 0, r[3] || '');
                }
            });
            insertAll();
            console.log(`✅ Attendance: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Attendance: no data');
        }
    } catch (e) { console.error('❌ Attendance:', e.message); }

    // 7. Empty Rooms
    try {
        const rows = await sheets.getRows(SHEETS.EMPTY_ROOMS);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT INTO empty_rooms (timestamp, branch, room, days, time, period, manager_id, capacity, price_per_student) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || r.length === 0) continue;
                    stmt.run(r[0] || '', r[1] || '', r[2] || '', r[3] || '', r[4] || '', r[5] || '', r[6] || '', parseInt(r[7]) || 20, parseInt(String(r[8] || '350000').replace(/[.,\s]/g, '')) || 350000);
                }
            });
            insertAll();
            console.log(`✅ Empty Rooms: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Empty Rooms: no data');
        }
    } catch (e) { console.error('❌ Empty Rooms:', e.message); }

    // 8. Empty Rooms History
    try {
        const rows = await sheets.getRows(SHEETS.EMPTY_ROOMS_HISTORY);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT INTO empty_rooms_history (date_ymd, branch, room, days, time, period, capacity, price_per_student, potential) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || r.length === 0) continue;
                    stmt.run(r[0] || '', r[1] || '', r[2] || '', r[3] || '', r[4] || '', r[5] || '', parseInt(r[6]) || 0, parseInt(String(r[7] || '0').replace(/[.,\s]/g, '')) || 0, parseInt(String(r[8] || '0').replace(/[.,\s]/g, '')) || 0);
                }
            });
            insertAll();
            console.log(`✅ Empty Rooms History: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Empty Rooms History: no data');
        }
    } catch (e) { console.error('❌ Empty Rooms History:', e.message); }

    // 9. Users
    try {
        const rows = await sheets.getRows(SHEETS.USERS);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT OR REPLACE INTO users (telegram_id, name, sec_lead, sec_qarzdorlar, sec_rad_etilganlar, sec_moliya, sec_davomat, sec_muammo, sec_bosh_xonalar, sec_reports, sec_foydalanuvchilar, sec_cron, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || !r[0] || r[0].toString().trim() === '') continue;
                    const telegramId = r[0].toString().trim();
                    const name = r[1] ? r[1].trim() : 'Unknown';
                    const sections = USER_SECTION_KEYS.map((key, idx) => {
                        const val = r[2 + idx];
                        return (val && val.toString().toUpperCase() === 'TRUE') ? 1 : 0;
                    });
                    const lang = r[12] ? r[12].trim().toLowerCase() : 'uz';
                    stmt.run(telegramId, name, ...sections, lang);
                }
            });
            insertAll();
            console.log(`✅ Users: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Users: no data');
        }
    } catch (e) { console.error('❌ Users:', e.message); }

    // 10. Active Users
    try {
        const rows = await sheets.getRows(SHEETS.ACTIVE_USERS);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT OR IGNORE INTO active_users (telegram_id, last_active) VALUES (?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || !r[0]) continue;
                    stmt.run(r[0].toString(), r[1] || new Date().toISOString());
                }
            });
            insertAll();
            console.log(`✅ Active Users: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Active Users: no data');
        }
    } catch (e) { console.error('❌ Active Users:', e.message); }

    // 11. Subjects
    try {
        const rows = await sheets.getRows(SHEETS.SUBJECTS);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT OR IGNORE INTO subjects (name, created_at) VALUES (?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || !r[0]) continue;
                    const name = r[0].trim().charAt(0).toUpperCase() + r[0].trim().slice(1).toLowerCase();
                    stmt.run(name, r[1] || '');
                }
            });
            insertAll();
            console.log(`✅ Subjects: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Subjects: no data');
        }
    } catch (e) { console.error('❌ Subjects:', e.message); }

    // 12. Expense Types
    try {
        const rows = await sheets.getRows(SHEETS.EXPENSE_TYPES);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT OR IGNORE INTO expense_types (name, created_at) VALUES (?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || !r[0]) continue;
                    stmt.run(r[0].trim(), r[1] || '');
                }
            });
            insertAll();
            console.log(`✅ Expense Types: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Expense Types: no data');
        }
    } catch (e) { console.error('❌ Expense Types:', e.message); }

    // 13. Settings
    try {
        const rows = await sheets.getRows(SHEETS.SETTINGS);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT INTO settings (section_id, title, button_text, is_loop, item_label, q_key, q_text, options_raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || r.length < 7) continue;
                    stmt.run(r[0], r[1], r[2], r[3] === 'TRUE' ? 1 : 0, r[4] || '', r[5], r[6], r[7] || '');
                }
            });
            insertAll();
            console.log(`✅ Settings: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Settings: no data');
        }
    } catch (e) { console.error('❌ Settings:', e.message); }

    // 14. Cron Settings
    try {
        const rows = await sheets.getRows(SHEETS.CRON_SETTINGS);
        if (rows && rows.length > 1) {
            const stmt = db.prepare('INSERT OR IGNORE INTO cron_settings (job_key, enabled, label, assigned_users, schedule, message) VALUES (?, ?, ?, ?, ?, ?)');
            const insertAll = db.transaction(() => {
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    if (!r || !r[0]) continue;
                    stmt.run(
                        r[0].trim(),
                        (r[1] || 'TRUE').toString().toUpperCase() === 'TRUE' ? 1 : 0,
                        r[2] || r[0].trim(),
                        r[3] || '',
                        r[4] || '',
                        r[5] || ''
                    );
                }
            });
            insertAll();
            console.log(`✅ Cron Settings: ${rows.length - 1} rows migrated`);
        } else {
            console.log('⚠️  Cron Settings: no data');
        }
    } catch (e) { console.error('❌ Cron Settings:', e.message); }

    // Verification
    console.log('\n=== Verification ===');
    const tables = ['leads', 'debtors', 'rejections', 'finance', 'problems', 'attendance', 'empty_rooms', 'empty_rooms_history', 'users', 'active_users', 'subjects', 'expense_types', 'settings', 'cron_settings'];
    for (const table of tables) {
        const count = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get();
        console.log(`  ${table}: ${count.cnt} rows`);
    }

    console.log('\n✅ Migration complete!');
    process.exit(0);
}

migrate().catch(e => { console.error('Migration failed:', e); process.exit(1); });
