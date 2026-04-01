/**
 * Centralized sheet/table names.
 * Change these if tabs are ever renamed — no more scattered string literals.
 */
const USER_SECTION_KEYS = Object.freeze(['lead', 'qarzdorlar', 'rad_etilganlar', 'moliya', 'davomat', 'muammo', 'bosh_xonalar', 'reports', 'foydalanuvchilar', 'cron', 'bosh', 'tahlil']);

module.exports = {
    USER_SECTION_KEYS,
    SHEETS: {
        LEAD: 'Lead',
        FINANCE: 'Moliya',
        DEBTORS: 'Qarzdorlar',
        REJECTIONS: 'Rad Etilganlar',
        ATTENDANCE: 'Davomat',
        PROBLEMS: 'Muammolar',
        EMPTY_ROOMS: 'Bosh Xonalar',
        EMPTY_ROOMS_HISTORY: 'Bosh Xonalar Tarix',
        USERS: 'Foydalanuvchilar',
        ACTIVE_USERS: 'Foydalanuvchilar_Active',
        SUBJECTS: 'Fanlar',
        EXPENSE_TYPES: 'Xarajat Turlari',
        SETTINGS: '⚙️ Sozlamalar',
        CRON_SETTINGS: 'CronSozlamalari'
    }
};
