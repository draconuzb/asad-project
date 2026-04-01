const db = require('./db');
require('dotenv').config();

async function clearAllData() {
    console.log("Starting to clear data tables...");
    const tables = ['leads', 'debtors', 'finance', 'rejections', 'problems', 'attendance', 'empty_rooms'];

    for (const table of tables) {
        console.log(`Clearing ${table}...`);
        try {
            const result = db.prepare(`DELETE FROM ${table}`).run();
            console.log(`✅ ${table} cleared (${result.changes} rows).`);
        } catch (e) {
            console.error(`❌ Failed to clear ${table}:`, e.message);
        }
    }

    console.log("All operations finished.");
    process.exit(0);
}

// Safety: require --confirm flag
if (!process.argv.includes('--confirm')) {
    console.log('⚠️  This will DELETE all data from report tables!');
    console.log('   Run with --confirm to proceed: node clear_data.js --confirm');
    process.exit(1);
}
clearAllData();
