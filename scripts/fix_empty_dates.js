/**
 * fix_empty_dates.js
 * Backfills empty date_ymd fields by parsing the timestamp column.
 * Handles both "YYYY-MM-DD HH:MM:SS" and "DD/MM/YYYY HH:MM:SS" formats.
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'bot.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const TABLES = ['leads', 'finance', 'debtors', 'rejections', 'attendance', 'problems', 'empty_rooms'];

function parseDate(ts) {
    if (!ts) return null;
    ts = ts.trim();

    // Format: YYYY-MM-DD HH:MM:SS
    let m = ts.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;

    // Format: DD/MM/YYYY HH:MM:SS or DD.MM.YYYY
    m = ts.match(/^(\d{2})[\/.](\d{2})[\/.](\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;

    return null;
}

let totalFixed = 0;

for (const table of TABLES) {
    try {
        // Check if table has both columns
        const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
        if (!cols.includes('date_ymd') || !cols.includes('timestamp')) {
            console.log(`⏭️  "${table}" — missing date_ymd or timestamp column`);
            continue;
        }

        const rows = db.prepare(`SELECT id, timestamp, date_ymd FROM "${table}" WHERE date_ymd = '' OR date_ymd IS NULL`).all();
        if (rows.length === 0) {
            console.log(`✅ "${table}" — no empty dates`);
            continue;
        }

        const updateStmt = db.prepare(`UPDATE "${table}" SET date_ymd = ? WHERE id = ?`);
        let fixed = 0;
        let failed = 0;

        const fixAll = db.transaction(() => {
            for (const row of rows) {
                const date = parseDate(row.timestamp);
                if (date) {
                    updateStmt.run(date, row.id);
                    fixed++;
                } else {
                    console.log(`  ⚠️  Could not parse date from: "${row.timestamp}" (id=${row.id})`);
                    failed++;
                }
            }
        });

        fixAll();
        console.log(`✅ "${table}" — fixed ${fixed} rows, ${failed} failures (of ${rows.length} empty)`);
        totalFixed += fixed;
    } catch (e) {
        console.error(`❌ Error on "${table}":`, e.message);
    }
}

console.log(`\n🏁 Total date_ymd fields fixed: ${totalFixed}`);

// Verify leads after fix
const marchLeads = db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE date_ymd LIKE '2026-03%' GROUP BY subject").all();
console.log('\n=== March 2026 Leads After Fix ===');
for (const l of marchLeads) {
    console.log(`  ${l.subject}: ${l.total}`);
}

const totalLeadsMarch = db.prepare("SELECT SUM(count) as total FROM leads WHERE date_ymd LIKE '2026-03%'").get();
console.log(`\n📊 Total March 2026 leads: ${totalLeadsMarch.total}`);

db.close();
process.exit(0);
