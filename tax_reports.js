/**
 * Tax Report Generation Module
 * 
 * Generates two types of tax reports:
 * 1. Foyda soligi (Profit Tax) — based on kassa income
 * 2. Daromad soligi (Income Tax) — based on official (Rasmiy) expenses
 */
const storage = require('./storage');
const { getTashkentDateString, formatNumber } = require('./utils');
const { t } = require('./i18n');

/**
 * Generate Foyda Soligi (Profit Tax) report.
 * Based on kassa (cash register) income data.
 * @param {number} month - Month number (1-12)
 * @param {number} year - Full year (e.g. 2026)
 * @returns {string} Formatted text report
 */
async function generateFoydaSoligi(month, year, lang = 'uz') {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const allData = await storage.fetchAllData(startDate, endDate);
    const finance = allData.finance || {};

    const rasmiyIncome = finance.income_rasmiy || 0;
    const rasmiyExpense = finance.expense_rasmiy || 0;
    const rasmiyProfit = Math.max(0, rasmiyIncome - rasmiyExpense);

    // Uzbekistan education center profit tax rate: typically 12% (based strictly on Rasmiy Qoldiq/Profit)
    const taxRate = 0.12;
    const estimatedTax = Math.round(rasmiyProfit * taxRate);

    let report = t(lang, 'tax_foyda_title') + '\n';
    report += `━━━━━━━━━━━━━━━━━━━━━\n`;
    report += t(lang, 'tax_label_period', { month: t(lang, `month_${parseInt(month, 10)}`), year }) + '\n\n';

    report += t(lang, 'tax_sec_rasmiy_finance') + '\n';
    report += `   ` + t(lang, 'tax_label_rasmiy_income', { amount: formatNumber(rasmiyIncome, lang) }) + '\n';
    report += `   ` + t(lang, 'tax_label_rasmiy_profit', { amount: formatNumber(rasmiyProfit, lang) }) + '\n\n';

    report += t(lang, 'tax_sec_calc') + '\n';
    report += `   ` + t(lang, 'tax_label_base', { amount: formatNumber(rasmiyProfit, lang) }) + '\n';
    report += `   ` + t(lang, 'tax_label_rate', { rate: (taxRate * 100).toFixed(0) }) + '\n';
    report += `   ` + t(lang, 'tax_label_estimated', { amount: formatNumber(estimatedTax, lang) }) + '\n\n';

    report += t(lang, 'tax_footer_note');

    return report;
}

/**
 * Generate Daromad Soligi (Income Tax / Expense Report) report.
 * Based on official (Rasmiy) expenses only.
 * @param {number} month - Month number (1-12)
 * @param {number} year - Full year (e.g. 2026)
 * @returns {string} Formatted text report
 */
async function generateDaromadSoligi(month, year, lang = 'uz') {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const allData = await storage.fetchAllData(startDate, endDate);
    const finance = allData.finance || {};

    // Daromad Soligi calculation (typically 12% of official expenses/salaries)
    const taxRate = 0.12;
    const estimatedTax = Math.round(finance.expense_rasmiy * taxRate);

    let report = t(lang, 'tax_daromad_title') + '\n';
    report += `━━━━━━━━━━━━━━━━━━━━━\n`;
    report += t(lang, 'tax_label_period', { month: t(lang, `month_${parseInt(month, 10)}`), year }) + '\n\n';

    // Official expenses breakdown
    report += t(lang, 'tax_sec_rasmiy') + '\n';
    if (Object.keys(finance.expenses_by_type_rasmiy).length > 0) {
        for (const [type, amount] of Object.entries(finance.expenses_by_type_rasmiy)) {
            report += `   🔹 ${type}: ${formatNumber(amount, lang)} ` + t(lang, 'unit_som') + `\n`;
        }
        report += `   ───────────────\n`;
        report += `   ` + t(lang, 'tax_label_total_rasmiy', { amount: formatNumber(finance.expense_rasmiy, lang) }) + `\n\n`;
    } else {
        report += `   ` + t(lang, 'tax_no_data') + `\n\n`;
    }

    // Only Official expenses are shown in the Daromad Soligi report

    // Tax calculation info
    report += t(lang, 'tax_sec_daromad_calc') + '\n';
    report += `   ` + t(lang, 'tax_label_base_rasmiy', { amount: formatNumber(finance.expense_rasmiy, lang) }) + '\n';
    report += `   ` + t(lang, 'tax_label_rate', { rate: (taxRate * 100).toFixed(0) }) + '\n';
    report += `   ` + t(lang, 'tax_label_estimated', { amount: formatNumber(estimatedTax, lang) }) + '\n\n';

    report += t(lang, 'tax_footer_note_rasmiy');

    return report;
}

module.exports = {
    generateFoydaSoligi,
    generateDaromadSoligi
};
