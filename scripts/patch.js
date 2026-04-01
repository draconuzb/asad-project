const fs = require('fs');

// --- 1. Patch storage.js ---
let storage = fs.readFileSync('storage.js', 'utf8');

// Remove auto-deduction logic
const autoDeductRegex = /\/\/ Auto-deduct norasmiy tushum.*?if \(sectionKey === 'moliya_kirim_norasmiy' && incomeAmt > 0 && finMonth\).*?\}\(\)\);/s;
storage = storage.replace(autoDeductRegex, "})();");

// Add deductFromQarzdorlar function before exports
const deductFn = `
async function deductFromQarzdorlar(month, amount, studentCount, userId) {
    const now = getTashkentNow();
    const timestamp = now.toLocaleString('uz-UZ', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(',', '');
    const dateYmd = getTashkentDateString(now);
    const normMonth = normalizeMonth(month);

    db.transaction(() => {
        db.prepare('INSERT INTO debtors (timestamp, date_ymd, count, amount, month, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run(timestamp, dateYmd, -Math.abs(studentCount), -Math.abs(amount), normMonth, userId);
        db.prepare('INSERT INTO qarzdorlar_log (month, change_amount, type, note, manager_id) VALUES (?, ?, ?, ?, ?)')
            .run(normMonth, -Math.abs(amount), 'norasmiy_deduction', "Norasmiy tushum hisobidan yechildi (" + studentCount + " ta o'quvchi)", userId);
    })();
}

module.exports = {`;
storage = storage.replace('module.exports = {', deductFn);

// Export deductFromQarzdorlar
storage = storage.replace('updateQarzdorlarBalance,', 'updateQarzdorlarBalance,\n    deductFromQarzdorlar,');

fs.writeFileSync('storage.js', storage);


// --- 2. Patch scenes.js ---
let scenes = fs.readFileSync('scenes.js', 'utf8');

// Replace standard doConfirmSave call specifically for moliya_kirim_norasmiy in buildScenes
// Inside scenes.js, doConfirmSave is called as the FINAL step for all kirim workflows.
// But wait, the wizard steps are generated dynamically. Let's look at scenes.js dynamically generated wizard steps.
