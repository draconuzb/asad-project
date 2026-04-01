/**
 * migrate_old_data.js
 * Merges data from old_bot.db (Server 1) into the current bot.db (Server 2).
 * Only inserts rows that don't already exist (by comparing timestamps + key fields).
 */
const Database = require('better-sqlite3');
const path = require('path');

const NEW_DB_PATH = path.join(__dirname, 'data', 'bot.db');
const OLD_DB_PATH = path.join(process.env.HOME || '/home/ubuntu', 'old_bot.db');

const newDb = new Database(NEW_DB_PATH);
const oldDb = new Database(OLD_DB_PATH, { readonly: true });

// Enable WAL for performance
newDb.pragma('journal_mode = WAL');

function getTableNames(db) {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
}

function getColumnNames(db, table) {
    return db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
}

const TABLES_TO_MIGRATE = [
    'leads',
    'debtors',
    'finance',
    'rejections',
    'attendance',
    'problems',
    'empty_rooms',
    'subjects',
    'expense_types',
    'users',
    'qarzdorlar_log',
    'settings'
];

let totalInserted = 0;
let totalSkipped = 0;

const oldTables = getTableNames(oldDb);
const newTables = getTableNames(newDb);

console.log('Old DB tables:', oldTables.join(', '));
console.log('New DB tables:', newTables.join(', '));
console.log('');

for (const table of TABLES_TO_MIGRATE) {
    if (!oldTables.includes(table)) {
        console.log(`⏭️  Skipping "${table}" — not in old DB`);
        continue;
    }
    if (!newTables.includes(table)) {
        console.log(`⏭️  Skipping "${table}" — not in new DB`);
        continue;
    }

    const oldCols = getColumnNames(oldDb, table);
    const newCols = getColumnNames(newDb, table);

    // Find intersecting columns (excluding auto-increment 'id')
    const commonCols = oldCols.filter(c => newCols.includes(c) && c !== 'id');
    
    if (commonCols.length === 0) {
        console.log(`⏭️  Skipping "${table}" — no common columns`);
        continue;
    }

    const oldRows = oldDb.prepare(`SELECT ${commonCols.map(c => `"${c}"`).join(', ')} FROM "${table}"`).all();
    
    if (oldRows.length === 0) {
        console.log(`⏭️  Skipping "${table}" — no data in old DB`);
        continue;
    }

    // For deduplication: check if row exists using all common columns
    const whereClauses = commonCols.map(c => `"${c}" = @${c}`).join(' AND ');
    const checkStmt = newDb.prepare(`SELECT COUNT(*) as cnt FROM "${table}" WHERE ${whereClauses}`);
    
    const colList = commonCols.map(c => `"${c}"`).join(', ');
    const paramList = commonCols.map(c => `@${c}`).join(', ');
    const insertStmt = newDb.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${paramList})`);

    let inserted = 0;
    let skipped = 0;

    const migrateAll = newDb.transaction(() => {
        for (const row of oldRows) {
            // Build params object
            const params = {};
            for (const col of commonCols) {
                params[col] = row[col];
            }
            
            try {
                const exists = checkStmt.get(params);
                if (exists && exists.cnt > 0) {
                    skipped++;
                } else {
                    insertStmt.run(params);
                    inserted++;
                }
            } catch (e) {
                console.error(`  ⚠️  Error on row in "${table}":`, e.message);
                skipped++;
            }
        }
    });

    migrateAll();

    console.log(`✅ "${table}": ${inserted} inserted, ${skipped} skipped (of ${oldRows.length} old rows)`);
    totalInserted += inserted;
    totalSkipped += skipped;
}

console.log('');
console.log(`🏁 Migration complete! Total inserted: ${totalInserted}, Total skipped: ${totalSkipped}`);

// Verify leads after migration
const leadsCheck = newDb.prepare("SELECT subject, SUM(count) as total FROM leads WHERE date_ymd LIKE '2026-03%' GROUP BY subject").all();
console.log('\n=== March 2026 Leads After Migration ===');
console.log(JSON.stringify(leadsCheck, null, 2));

const allLeads = newDb.prepare("SELECT COUNT(*) as total, MIN(date_ymd) as earliest, MAX(date_ymd) as latest FROM leads").get();
console.log('\n=== All Leads Stats After Migration ===');
console.log(JSON.stringify(allLeads, null, 2));

oldDb.close();
newDb.close();
process.exit(0);
