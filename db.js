/**
 * SQLite Database Module
 * Primary data store for all read/write operations.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'bot.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
// foreign_keys is ON but no actual FK constraints are defined in the schema.
// Adding FK constraints retroactively is risky on existing data — leaving as-is.
db.pragma('foreign_keys = ON');
// H-18: Prevent SQLITE_BUSY errors under concurrent access
db.pragma('busy_timeout = 5000');

// --- Schema ---
// NOTE: created_at columns use datetime('now') which stores UTC.
// Application code (reports, UI) converts to Asia/Tashkent (UTC+5) at display time.
// Changing defaults in SQLite is not practical retroactively — keep UTC in storage.
db.exec(`
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date_ymd TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    count INTEGER NOT NULL,
    manager_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS debtors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date_ymd TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    month TEXT NOT NULL DEFAULT '',
    manager_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date_ymd TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    count INTEGER NOT NULL,
    manager_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date_ymd TEXT NOT NULL DEFAULT '',
    income INTEGER NOT NULL DEFAULT 0,
    expense INTEGER NOT NULL DEFAULT 0,
    month TEXT NOT NULL DEFAULT '',
    kassa_amount INTEGER NOT NULL DEFAULT 0,
    kassa_students INTEGER NOT NULL DEFAULT 0,
    expense_type TEXT NOT NULL DEFAULT '-',
    category TEXT NOT NULL DEFAULT '-',
    comment TEXT NOT NULL DEFAULT '',
    manager_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS problems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date_ymd TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL,
    type TEXT NOT NULL,
    issue TEXT NOT NULL DEFAULT '',
    manager_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date_ymd TEXT NOT NULL DEFAULT '',
    expected INTEGER NOT NULL,
    attended INTEGER NOT NULL,
    manager_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS empty_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    branch TEXT NOT NULL,
    room TEXT NOT NULL DEFAULT '',
    days TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL DEFAULT '',
    period TEXT NOT NULL DEFAULT '',
    manager_id TEXT NOT NULL DEFAULT '',
    capacity INTEGER NOT NULL DEFAULT 20,
    price_per_student INTEGER NOT NULL DEFAULT 350000,
    date_ymd TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS empty_rooms_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_ymd TEXT NOT NULL,
    branch TEXT NOT NULL,
    room TEXT NOT NULL DEFAULT '',
    days TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL DEFAULT '',
    period TEXT NOT NULL DEFAULT '',
    capacity INTEGER NOT NULL DEFAULT 0,
    price_per_student INTEGER NOT NULL DEFAULT 0,
    potential INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sec_lead INTEGER NOT NULL DEFAULT 0,
    sec_qarzdorlar INTEGER NOT NULL DEFAULT 0,
    sec_rad_etilganlar INTEGER NOT NULL DEFAULT 0,
    sec_moliya INTEGER NOT NULL DEFAULT 0,
    sec_davomat INTEGER NOT NULL DEFAULT 0,
    sec_muammo INTEGER NOT NULL DEFAULT 0,
    sec_bosh_xonalar INTEGER NOT NULL DEFAULT 0,
    sec_reports INTEGER NOT NULL DEFAULT 0,
    sec_foydalanuvchilar INTEGER NOT NULL DEFAULT 0,
    sec_cron INTEGER NOT NULL DEFAULT 0,
    sec_bosh INTEGER NOT NULL DEFAULT 0,
    sec_tahlil INTEGER NOT NULL DEFAULT 0,
    lang TEXT NOT NULL DEFAULT 'uz'
);

CREATE TABLE IF NOT EXISTS active_users (
    telegram_id TEXT PRIMARY KEY,
    last_active TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    UNIQUE(name, category)
);

CREATE TABLE IF NOT EXISTS expense_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Norasmiy',
    created_at TEXT NOT NULL DEFAULT '',
    UNIQUE(name, category)
);

-- M-10: settings table is currently unused scaffolding — kept for future use, do not drop.
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    button_text TEXT NOT NULL DEFAULT '',
    is_loop INTEGER NOT NULL DEFAULT 0,
    item_label TEXT NOT NULL DEFAULT '',
    q_key TEXT NOT NULL DEFAULT '',
    q_text TEXT NOT NULL DEFAULT '',
    options_raw TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cron_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    label TEXT NOT NULL DEFAULT '',
    assigned_users TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS qarzdorlar_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    date_ymd TEXT NOT NULL DEFAULT '',
    change_amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    manager_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);


CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT '',
    date_ymd TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    user_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    section TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    record_id TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS kpi_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric TEXT NOT NULL,
    month TEXT NOT NULL,
    target_value INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(metric, month)
);

CREATE TABLE IF NOT EXISTS kpi_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    metric TEXT NOT NULL,
    target_value INTEGER NOT NULL DEFAULT 0,
    direction TEXT NOT NULL DEFAULT 'up',
    assigned_to TEXT NOT NULL,
    assigned_by TEXT NOT NULL,
    branch_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(month, metric, assigned_to, branch_id)
);

CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS warnings (
    key TEXT PRIMARY KEY,
    last_time INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cron_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL DEFAULT '0 9 * * *',
    assigned_to TEXT NOT NULL,
    assigned_by TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    branch_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for date-range queries
CREATE INDEX IF NOT EXISTS idx_leads_timestamp ON leads(timestamp);
CREATE INDEX IF NOT EXISTS idx_leads_date_ymd ON leads(date_ymd);
CREATE INDEX IF NOT EXISTS idx_debtors_timestamp ON debtors(timestamp);
CREATE INDEX IF NOT EXISTS idx_debtors_month ON debtors(month);
CREATE INDEX IF NOT EXISTS idx_debtors_date_ymd ON debtors(date_ymd);
CREATE INDEX IF NOT EXISTS idx_qarzdorlar_log_month ON qarzdorlar_log(month);
CREATE INDEX IF NOT EXISTS idx_rejections_timestamp ON rejections(timestamp);
CREATE INDEX IF NOT EXISTS idx_rejections_date_ymd ON rejections(date_ymd);
CREATE INDEX IF NOT EXISTS idx_finance_timestamp ON finance(timestamp);
CREATE INDEX IF NOT EXISTS idx_finance_month ON finance(month);
CREATE INDEX IF NOT EXISTS idx_finance_date_ymd ON finance(date_ymd);
CREATE INDEX IF NOT EXISTS idx_finance_category ON finance(category);
CREATE INDEX IF NOT EXISTS idx_problems_timestamp ON problems(timestamp);
CREATE INDEX IF NOT EXISTS idx_problems_status ON problems(status);
CREATE INDEX IF NOT EXISTS idx_attendance_timestamp ON attendance(timestamp);
CREATE INDEX IF NOT EXISTS idx_attendance_date_ymd ON attendance(date_ymd);
CREATE INDEX IF NOT EXISTS idx_empty_rooms_history_date ON empty_rooms_history(date_ymd);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_section ON audit_log(section);
CREATE INDEX IF NOT EXISTS idx_audit_log_date_ymd ON audit_log(date_ymd);

-- H-06: Missing indexes for foreign-key-like columns and frequently filtered columns
CREATE INDEX IF NOT EXISTS idx_finance_manager ON finance(manager_id);
CREATE INDEX IF NOT EXISTS idx_leads_subject ON leads(subject);
CREATE INDEX IF NOT EXISTS idx_rejections_subject ON rejections(subject);
CREATE INDEX IF NOT EXISTS idx_debtors_manager ON debtors(manager_id);
CREATE INDEX IF NOT EXISTS idx_attendance_manager ON attendance(manager_id);
CREATE INDEX IF NOT EXISTS idx_problems_manager ON problems(manager_id);
CREATE INDEX IF NOT EXISTS idx_empty_rooms_branch ON empty_rooms(branch);
CREATE INDEX IF NOT EXISTS idx_problems_date_ymd ON problems(date_ymd);

CREATE INDEX IF NOT EXISTS idx_cron_assignments_to ON cron_assignments(assigned_to);
CREATE INDEX IF NOT EXISTS idx_cron_assignments_by ON cron_assignments(assigned_by);
CREATE INDEX IF NOT EXISTS idx_cron_assignments_branch ON cron_assignments(branch_id);

`);

// --- Migration helper (M-11) ---
// Logs success/skip/failure instead of silently swallowing errors.
function safeMigration(sql, description) {
    try {
        db.exec(sql);
        logger.info(`Migration OK: ${description}`);
    } catch (e) {
        // "duplicate column name" or "already exists" → skip (expected on re-run)
        if (/duplicate column|already exists/i.test(e.message)) {
            logger.debug(`Migration SKIP (already applied): ${description}`);
        } else {
            logger.error(`Migration FAIL: ${description} — ${e.message}`);
        }
    }
}

// Migrations for existing databases
safeMigration('ALTER TABLE users ADD COLUMN sec_bosh INTEGER NOT NULL DEFAULT 0', 'users: add sec_bosh');
safeMigration('ALTER TABLE users ADD COLUMN sec_tahlil INTEGER NOT NULL DEFAULT 0', 'users: add sec_tahlil');

// Role migration: add role column (ceo, manager, user)
safeMigration("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'", 'users: add role column');
// Migrate existing CEO users: sec_foydalanuvchilar=1 → role='ceo'
safeMigration("UPDATE users SET role = 'ceo' WHERE sec_foydalanuvchilar = 1 AND role = 'user'", 'users: promote existing CEOs');

// Branch migrations — add branch_id to tables that need it
safeMigration('ALTER TABLE leads ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0', 'leads: add branch_id');
safeMigration('ALTER TABLE debtors ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0', 'debtors: add branch_id');
safeMigration('ALTER TABLE rejections ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0', 'rejections: add branch_id');
safeMigration('ALTER TABLE finance ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0', 'finance: add branch_id');
safeMigration('ALTER TABLE attendance ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0', 'attendance: add branch_id');
safeMigration('ALTER TABLE problems ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0', 'problems: add branch_id');
safeMigration('ALTER TABLE empty_rooms ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0', 'empty_rooms: add branch_id');
safeMigration('ALTER TABLE empty_rooms_history ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0', 'empty_rooms_history: add branch_id');
safeMigration('ALTER TABLE qarzdorlar_log ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0', 'qarzdorlar_log: add branch_id');

// Branch indexes
safeMigration('CREATE INDEX IF NOT EXISTS idx_leads_branch ON leads(branch_id)', 'index: leads.branch_id');
safeMigration('CREATE INDEX IF NOT EXISTS idx_debtors_branch ON debtors(branch_id)', 'index: debtors.branch_id');
safeMigration('CREATE INDEX IF NOT EXISTS idx_rejections_branch ON rejections(branch_id)', 'index: rejections.branch_id');
safeMigration('CREATE INDEX IF NOT EXISTS idx_finance_branch ON finance(branch_id)', 'index: finance.branch_id');
safeMigration('CREATE INDEX IF NOT EXISTS idx_attendance_branch ON attendance(branch_id)', 'index: attendance.branch_id');
safeMigration('CREATE INDEX IF NOT EXISTS idx_problems_branch ON problems(branch_id)', 'index: problems.branch_id');
safeMigration('CREATE INDEX IF NOT EXISTS idx_empty_rooms_branch_id ON empty_rooms(branch_id)', 'index: empty_rooms.branch_id');
safeMigration('CREATE INDEX IF NOT EXISTS idx_qarzdorlar_log_branch ON qarzdorlar_log(branch_id)', 'index: qarzdorlar_log.branch_id');
safeMigration('CREATE INDEX IF NOT EXISTS idx_qarzdorlar_log_manager ON qarzdorlar_log(manager_id)', 'index: qarzdorlar_log.manager_id');

// S-004: Missing indexes for expense_type and expense_types lookups
safeMigration('CREATE INDEX IF NOT EXISTS idx_finance_expense_type ON finance(expense_type)', 'index: finance.expense_type');
safeMigration('CREATE INDEX IF NOT EXISTS idx_expense_types_name ON expense_types(name, category)', 'index: expense_types(name, category)');

// KPI assignment indexes (for user-delete cleanup & general lookups)
safeMigration('CREATE INDEX IF NOT EXISTS idx_kpi_assigned_to ON kpi_assignments(assigned_to)', 'index: kpi_assignments.assigned_to');
safeMigration('CREATE INDEX IF NOT EXISTS idx_kpi_assigned_by ON kpi_assignments(assigned_by)', 'index: kpi_assignments.assigned_by');

// CHECK constraints for data integrity (attendance only — leads/finance allow negatives intentionally)
// SQLite can't add CHECK via ALTER TABLE, so we enforce via trigger-based validation.
safeMigration(`
    CREATE TRIGGER IF NOT EXISTS trg_attendance_check_expected
    BEFORE INSERT ON attendance
    FOR EACH ROW
    WHEN NEW.expected < 0
    BEGIN
        SELECT RAISE(ABORT, 'attendance.expected must be >= 0');
    END
`, 'trigger: attendance CHECK expected >= 0 on INSERT');

safeMigration(`
    CREATE TRIGGER IF NOT EXISTS trg_attendance_check_attended
    BEFORE INSERT ON attendance
    FOR EACH ROW
    WHEN NEW.attended < 0
    BEGIN
        SELECT RAISE(ABORT, 'attendance.attended must be >= 0');
    END
`, 'trigger: attendance CHECK attended >= 0 on INSERT');

safeMigration(`
    CREATE TRIGGER IF NOT EXISTS trg_attendance_check_expected_upd
    BEFORE UPDATE ON attendance
    FOR EACH ROW
    WHEN NEW.expected < 0
    BEGIN
        SELECT RAISE(ABORT, 'attendance.expected must be >= 0');
    END
`, 'trigger: attendance CHECK expected >= 0 on UPDATE');

safeMigration(`
    CREATE TRIGGER IF NOT EXISTS trg_attendance_check_attended_upd
    BEFORE UPDATE ON attendance
    FOR EACH ROW
    WHEN NEW.attended < 0
    BEGIN
        SELECT RAISE(ABORT, 'attendance.attended must be >= 0');
    END
`, 'trigger: attendance CHECK attended >= 0 on UPDATE');

// User-branch assignment (many-to-many)
db.exec(`
CREATE TABLE IF NOT EXISTS user_branches (
    user_id TEXT NOT NULL,
    branch_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, branch_id)
);
`);

// Auto-assign CEO users to all branches
// NOTE: This also runs on branch_add in twa_api.js to cover newly created branches.
try {
    const ceoUsers = db.prepare("SELECT telegram_id FROM users WHERE role = 'ceo'").all();
    const allBranches = db.prepare("SELECT id FROM branches").all();
    const ins = db.prepare("INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)");
    for (const u of ceoUsers) {
        for (const b of allBranches) {
            ins.run(u.telegram_id, b.id);
        }
    }
} catch(e) {
    logger.error(`CEO auto-assignment failed: ${e.message}`);
}

logger.info(`✅ SQLite database initialized at ${DB_PATH}`);


// ── HR Staff & Goals ─────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS hr_staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    position TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL DEFAULT '',
    end_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT NOT NULL DEFAULT '',
    branch_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS hr_staff_branches (
    staff_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    PRIMARY KEY (staff_id, branch_id)
);
CREATE TABLE IF NOT EXISTS hr_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    deadline TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
);
`);

// ── Lead Enrollments (successful conversions from lead to student) ──
db.exec(`
CREATE TABLE IF NOT EXISTS lead_enrolled (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date_ymd TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    count INTEGER NOT NULL,
    manager_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    branch_id INTEGER NOT NULL DEFAULT 0
);
`);
// HR indexes
safeMigration('CREATE INDEX IF NOT EXISTS idx_hr_staff_status ON hr_staff(status, category)', 'index: hr_staff(status, category)');
safeMigration('CREATE INDEX IF NOT EXISTS idx_hr_goals_branch ON hr_goals(branch_id, category)', 'index: hr_goals(branch_id, category)');
safeMigration('CREATE INDEX IF NOT EXISTS idx_hr_staff_branches_bid ON hr_staff_branches(branch_id)', 'index: hr_staff_branches(branch_id)');

// Cron assignments: add type and sections columns for report-based notifications
safeMigration("ALTER TABLE cron_assignments ADD COLUMN type TEXT NOT NULL DEFAULT 'message'", 'cron_assignments: add type column');
safeMigration("ALTER TABLE cron_assignments ADD COLUMN sections TEXT NOT NULL DEFAULT ''", 'cron_assignments: add sections column');

module.exports = db;
