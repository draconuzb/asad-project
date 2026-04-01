const db = require('./db');

// Check all leads for March 2026
const leads = db.prepare("SELECT * FROM leads WHERE date_ymd LIKE '2026-03%' ORDER BY date_ymd").all();
console.log("=== March 2026 Leads ===");
console.log("Total rows:", leads.length);
console.log(JSON.stringify(leads, null, 2));

// Check total count by subject
const summary = db.prepare("SELECT subject, SUM(count) as total FROM leads WHERE date_ymd LIKE '2026-03%' GROUP BY subject").all();
console.log("\n=== Summary by Subject ===");
console.log(JSON.stringify(summary, null, 2));

// Check ALL leads in the database
const allLeads = db.prepare("SELECT COUNT(*) as total, MIN(date_ymd) as earliest, MAX(date_ymd) as latest FROM leads").get();
console.log("\n=== All Leads Stats ===");
console.log(JSON.stringify(allLeads, null, 2));

process.exit(0);
