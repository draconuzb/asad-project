const Database = require('better-sqlite3');
const path = require('path');

const NEW_DB_PATH = path.join(__dirname, 'data', 'bot.db');
const db = new Database(NEW_DB_PATH, { readonly: true });

// Check leads with empty date_ymd
const emptyDateLeads = db.prepare("SELECT * FROM leads WHERE date_ymd = '' OR date_ymd IS NULL ORDER BY id").all();
console.log('=== Leads with empty date_ymd ===');
console.log('Count:', emptyDateLeads.length);
console.log(JSON.stringify(emptyDateLeads, null, 2));

// Check leads with timestamps to infer dates
const allLeads = db.prepare("SELECT id, timestamp, date_ymd, subject, count, created_at FROM leads ORDER BY id").all();
console.log('\n=== ALL Leads ===');
for (const l of allLeads) {
    console.log(`  id=${l.id} | date_ymd="${l.date_ymd}" | ts="${l.timestamp}" | subject="${l.subject}" | count=${l.count} | created="${l.created_at}"`);
}

// Finance summary
const finSummary = db.prepare("SELECT category, SUM(income) as total_income, SUM(expense) as total_expense, COUNT(*) as rows FROM finance GROUP BY category").all();
console.log('\n=== Finance by Category ===');
console.log(JSON.stringify(finSummary, null, 2));

// Debtors summary
const debtSummary = db.prepare("SELECT month, SUM(count) as total_count, SUM(amount) as total_amount FROM debtors GROUP BY month").all();
console.log('\n=== Debtors by Month ===');
console.log(JSON.stringify(debtSummary, null, 2));

db.close();
process.exit(0);
