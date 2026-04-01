/**
 * CSV Data Export Module
 * Generates CSV files from SQLite data for a given month.
 */
const db = require('./db');
const logger = require('./logger');
const { parseUzDate } = require('./utils');
const fsp = require('fs').promises;
const path = require('path');

function csvEscape(val) {
    let str = val === null || val === undefined ? '' : String(val);
    if (/^[=+\-@\t\r|]/.test(str)) {
        str = "'" + str;
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function toCsv(rows) {
    return rows.map(row => row.map(csvEscape).join(',')).join('\n');
}

function filterByMonth(rows, timestampKey, month, year) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    return rows.filter(row => {
        // Prefer date_ymd if available (YYYY-MM-DD format, timezone-safe)
        if (row.date_ymd) return row.date_ymd.startsWith(prefix);
        const dt = parseUzDate(row[timestampKey] || '');
        return dt.getMonth() + 1 === month && dt.getFullYear() === year;
    });
}

async function generateCsvExport(month, year) {
    const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
    const monthLabel = `${monthsUz[month - 1]} ${year}`;

    const sections = [
        { name: 'Leadlar', table: 'leads', columns: ['timestamp', 'subject', 'count', 'manager_id'], headers: ['Sana', 'Fan', 'Soni', 'Menejer ID'] },
        { name: 'Moliya', table: 'finance', columns: ['timestamp', 'income', 'expense', 'month', 'kassa_amount', 'kassa_students', 'expense_type', 'category', 'comment', 'manager_id'], headers: ['Sana', 'Kirim', 'Chiqim', 'Oy', 'Kassa', 'Talabalar', 'Xarajat turi', 'Toifa', 'Izoh', 'Menejer ID'] },
        { name: 'Qarzdorlar', table: 'debtors', columns: ['timestamp', 'count', 'amount', 'month', 'manager_id'], headers: ['Sana', 'Soni', 'Miqdori', 'Oy', 'Menejer ID'] },
        { name: 'Rad Etilganlar', table: 'rejections', columns: ['timestamp', 'subject', 'count', 'manager_id'], headers: ['Sana', 'Fan', 'Soni', 'Menejer ID'] },
        { name: 'Davomat', table: 'attendance', columns: ['timestamp', 'expected', 'attended', 'manager_id'], headers: ['Sana', 'Kutilgan', 'Kelgan', 'Menejer ID'] },
        { name: 'Muammolar', table: 'problems', columns: ['timestamp', 'branch', 'type', 'issue', 'manager_id'], headers: ['Sana', 'Filial', 'Turi', 'Muammo', 'Menejer ID'] },
        { name: 'Bosh Xonalar', table: 'empty_rooms', columns: ['timestamp', 'branch', 'room', 'days', 'time', 'period', 'manager_id', 'capacity', 'price_per_student'], headers: ['Sana', 'Filial', 'Xona', 'Kunlar', 'Vaqt', 'Davr', 'Menejer ID', "Sig'im", 'Narx'] }
    ];

    let csvContent = `# Nodir School — ${monthLabel} Export\n\n`;

    for (const section of sections) {
        try {
            const allRows = db.prepare(`SELECT ${section.columns.join(',')} FROM ${section.table} ORDER BY id`).all();
            const filtered = filterByMonth(allRows, 'timestamp', month, year);

            csvContent += `\n--- ${section.name} (${filtered.length} ta yozuv) ---\n`;

            if (filtered.length > 0) {
                const dataRows = [section.headers, ...filtered.map(r => section.columns.map(c => r[c]))];
                csvContent += toCsv(dataRows) + '\n';
            } else {
                csvContent += "Ma'lumot topilmadi.\n";
            }
        } catch (e) {
            logger.error(`CSV export error for ${section.name}:`, e);
            csvContent += `\n--- ${section.name} ---\nMa'lumot yuklanmadi.\n`;
        }
    }

    const safeName = `ns_export_${year}_${String(month).padStart(2, '0')}_${Date.now()}.csv`;
    const filePath = path.join('/tmp', safeName);
    await fsp.writeFile(filePath, '\uFEFF' + csvContent, 'utf8');
    return filePath;
}

module.exports = { generateCsvExport };
