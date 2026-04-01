// Functions are declared async for interface consistency with callers,
// but better-sqlite3 operations are synchronous under the hood.
const path = require('path');
const { parseUzDate, getTashkentNow, getTashkentDateString, normalizeMonthKey } = require('./utils');
const { USER_SECTION_KEYS } = require('./constants');
const { sanitizeReportData, validateReportData } = require('./validation-utils');
const { SECTIONS } = require('./questions');
const logger = require('./logger');
const db = require('./db');

const NO_EMPTY_ROOMS_MARKER = '_NO_EMPTY_ROOMS_';


/**
 * Safe parseInt — returns 0 instead of NaN for invalid input
 */
function safeInt(val) {
    const s = String(val || '0').replace(/\s/g, '');
    // Handle European-style thousands separators (e.g., "1.500.000")
    if ((s.match(/\./g) || []).length > 1) {
        const n = parseInt(s.replace(/[.,]/g, ''), 10);
        return isNaN(n) ? 0 : n;
    }
    if (/^\d+[.,]\d+$/.test(s)) {
        const f = parseFloat(s.replace(',', '.'));
        return isNaN(f) ? 0 : Math.round(f);
    }
    const n = parseInt(s.replace(/[,]/g, ''), 10);
    return isNaN(n) ? 0 : n;
}

/**
 * Normalize month before storing — ensures consistent keys
 */
function normalizeMonth(month) {
    if (!month || month === 0 || month === '0') return null;
    const normalized = normalizeMonthKey(String(month).trim());
    if (!normalized || normalized === '0') return null;
    return normalized;
}

/**
 * Get today's date string in YYYY-MM-DD format (Tashkent timezone)
 */
function getTodayString() {
    return getTashkentDateString();
}

/**
 * Get yesterday's date string in YYYY-MM-DD format (Tashkent timezone)
 */
function getYesterdayString() {
    const todayTashkent = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
    todayTashkent.setDate(todayTashkent.getDate() - 1);
    return getTashkentDateString(todayTashkent);
}

/**
 * Save a structured report for a section — dispatches to SQLite
 */
async function saveDailyReport(sectionKey, reportData, userId = 'system') {
    try {
        reportData = sanitizeReportData(reportData);
        const validationResult = validateReportData(sectionKey, reportData);
        if (validationResult && !validationResult.valid) { // Log warnings but don't block
            logger.warn(`Report validation failed for ${sectionKey}: ${(validationResult.errors || []).join(", ")}`);
            // Don't block — validation is advisory. dispatchToDb handles type coercion.
        }
        await dispatchToDb(sectionKey, reportData, userId);
    } catch (e) {
        logger.error("Failed to save report:", e);
        return false;
    }
    return true;
}

/**
 * Helper to map JSON report data to SQLite inserts based on the section.
 */
async function dispatchToDb(sectionKey, reportData, userId = 'system') {
    userId = String(userId);
    const now = new Date();
    const timestamp = now.toLocaleString('uz-UZ', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Asia/Tashkent'
    }).replace(',', '');
    const dateYmd = getTashkentDateString();

    try {
        if (sectionKey === 'lead') {
            const stmt = db.prepare('INSERT INTO leads (timestamp, date_ymd, subject, count, manager_id) VALUES (?, ?, ?, ?, ?)');
            const insertMany = db.transaction((entries) => {
                for (const entry of entries) {
                    if (!entry || typeof entry !== 'object') continue;
                    if (!entry.subject || !entry.subject.trim()) continue;
                    stmt.run(timestamp, dateYmd, entry.subject, safeInt(entry.count), userId);
                }
            });
            insertMany(reportData.entries || []);

        } else if (sectionKey === 'lead_remove') {
            const stmt = db.prepare('INSERT INTO leads (timestamp, date_ymd, subject, count, manager_id) VALUES (?, ?, ?, ?, ?)');
            const insertMany = db.transaction((entries) => {
                for (const entry of entries) {
                    if (!entry || typeof entry !== 'object') continue;
                    if (!entry.subject || !entry.subject.trim()) continue;
                    const num = parseInt(String(entry.count).replace(/[.,\s]/g, '')) || 0;
                    stmt.run(timestamp, dateYmd, entry.subject, -Math.abs(num), userId);
                }
            });
            insertMany(reportData.entries || []);

        } else if (sectionKey === 'qarzdorlar') {
            const amt = safeInt(reportData.amount);
            const month = normalizeMonth(reportData.month);
            if (!month) {
                logger.warn('Debtor add rejected: month is required');
                return;
            }
            const cnt = safeInt(reportData.count);
            if (cnt <= 0 || amt <= 0) {
                logger.warn(`Debtor add rejected: count=${cnt}, amount=${amt} — values must be positive`);
                return;
            }
            db.transaction(() => {
                db.prepare('INSERT INTO debtors (timestamp, date_ymd, count, amount, month, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(timestamp, dateYmd, cnt, amt, month, userId);
                db.prepare('INSERT INTO qarzdorlar_log (month, date_ymd, change_amount, type, note, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(month, dateYmd, amt, 'manual_add', `+${amt} qarzdorlik qo'shildi`, userId);
            })();

        } else if (sectionKey === 'qarzdorlar_remove') {
            const num = safeInt(reportData.count);
            const amt = safeInt(reportData.amount);
            const month = normalizeMonth(reportData.month);
            if (!month) {
                logger.warn('Debtor remove rejected: month is required');
                return;
            }
            db.transaction(() => {
                const currentBalance = db.prepare('SELECT COALESCE(SUM(amount), 0) as total, COALESCE(SUM(count), 0) as totalCount FROM debtors WHERE month = ?').get(month);
                if (currentBalance.total - Math.abs(amt) < 0) {
                    logger.warn(`Debtor remove rejected: balance would go negative: current=${currentBalance.total}, removing=${amt}, month=${month}`);
                    throw new Error('Balance would go negative');
                }
                if (currentBalance.totalCount - Math.abs(num) < 0) {
                    logger.warn(`Debtor count remove rejected: count would go negative: current=${currentBalance.totalCount}, removing=${num}, month=${month}`);
                    throw new Error('Balance would go negative');
                }
                db.prepare('INSERT INTO debtors (timestamp, date_ymd, count, amount, month, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(timestamp, dateYmd, -Math.abs(num), -Math.abs(amt), month, userId);
                db.prepare('INSERT INTO qarzdorlar_log (month, date_ymd, change_amount, type, note, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(month, dateYmd, -Math.abs(amt), 'manual_remove', `-${amt} qarzdorlik ayirildi`, userId);
            })();

        } else if (sectionKey === 'bosh_xonalar') {
            const stmt = db.prepare('INSERT INTO empty_rooms (timestamp, date_ymd, branch, room, days, time, period, manager_id, capacity, price_per_student) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const insertMany = db.transaction((entries) => {
                for (const entry of entries) {
                    if (!entry || typeof entry !== 'object') continue;
                    if (!entry.branch || !entry.room) continue;
                    stmt.run(timestamp, dateYmd, entry.branch, entry.room, entry.days || '', entry.time || '', entry.period || '', userId, safeInt(entry.capacity) || 20, safeInt(entry.price_per_student) || 350000);
                }
            });
            insertMany(reportData.entries || []);

        } else if (sectionKey === 'rad_etilganlar') {
            const stmt = db.prepare('INSERT INTO rejections (timestamp, date_ymd, subject, count, manager_id) VALUES (?, ?, ?, ?, ?)');
            const insertMany = db.transaction((entries) => {
                for (const entry of entries) {
                    if (!entry || typeof entry !== 'object') continue;
                    if (!entry.subject || !entry.subject.trim()) continue;
                    stmt.run(timestamp, dateYmd, entry.subject, safeInt(entry.count), userId);
                }
            });
            insertMany(reportData.entries || []);

        } else if (sectionKey === 'rad_remove') {
            const stmt = db.prepare('INSERT INTO rejections (timestamp, date_ymd, subject, count, manager_id) VALUES (?, ?, ?, ?, ?)');
            const insertMany = db.transaction((entries) => {
                for (const entry of entries) {
                    if (!entry || typeof entry !== 'object') continue;
                    if (!entry.subject || !entry.subject.trim()) continue;
                    const num = parseInt(String(entry.count).replace(/[.,\s]/g, '')) || 0;
                    stmt.run(timestamp, dateYmd, entry.subject, -Math.abs(num), userId);
                }
            });
            insertMany(reportData.entries || []);

        } else if (sectionKey === 'moliya_kirim' || sectionKey === 'moliya_kirim_rasmiy' || sectionKey === 'moliya_kirim_norasmiy') {
            let incomeToifa = '-';
            if (sectionKey === 'moliya_kirim_rasmiy') incomeToifa = 'Rasmiy';
            else if (sectionKey === 'moliya_kirim_norasmiy') incomeToifa = 'Norasmiy';

            const incomeAmt = safeInt(reportData.today_income);
            // For norasmiy, kassa_amount = income amount (wizard doesn't ask separately)
            const kassaAmt = safeInt(reportData.today_kassa_amount) || incomeAmt;
            const kassaStudents = safeInt(reportData.today_kassa_students);

            if (incomeAmt <= 0) {
                logger.warn(`Income insert rejected: incomeAmt=${incomeAmt} — value must be positive`);
                return;
            }

            const finMonth = normalizeMonth(reportData.month) || '';
            db.transaction(() => {
                db.prepare('INSERT INTO finance (timestamp, date_ymd, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(timestamp, dateYmd, incomeAmt, 0, finMonth, kassaAmt, kassaStudents, '-', incomeToifa, reportData.comment || '', userId);

            })();

        } else if (sectionKey === 'moliya_kirim_del' || sectionKey === 'moliya_kirim_rasmiy_del' || sectionKey === 'moliya_kirim_norasmiy_del') {
            const inc = safeInt(reportData.today_income);
            const kAmt = safeInt(reportData.today_kassa_amount);
            const kStd = safeInt(reportData.today_kassa_students);

            let delToifa = '-';
            if (sectionKey === 'moliya_kirim_rasmiy_del') delToifa = 'Rasmiy';
            else if (sectionKey === 'moliya_kirim_norasmiy_del') delToifa = 'Norasmiy';

            const delMonth = normalizeMonth(reportData.month) || '';
            const delIncAmt = Math.abs(inc) || Math.abs(kAmt);
            db.transaction(() => {
                db.prepare('INSERT INTO finance (timestamp, date_ymd, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(timestamp, dateYmd, -Math.abs(inc), 0, delMonth, kAmt > 0 ? -Math.abs(kAmt) : 0, kStd > 0 ? -Math.abs(kStd) : 0, '-', delToifa, '', userId);

                // Only reverse qarzdorlar if a deduction was actually made for this month
                if (sectionKey === 'moliya_kirim_norasmiy_del' && delIncAmt > 0 && delMonth) {
                    const deduction = db.prepare("SELECT id, note FROM qarzdorlar_log WHERE month = ? AND type = 'norasmiy_deduction' AND ABS(change_amount) = ? AND note NOT LIKE '%[reversed]%' LIMIT 1").get(delMonth, delIncAmt);
                    if (deduction) {
                        // Extract the actual student count from the deduction log note, e.g. "(5 ta o'quvchi)"
                        const countMatch = deduction.note && deduction.note.match(/\((\d+)\s+ta/);
                        const actualStudentCount = countMatch ? parseInt(countMatch[1], 10) : Math.abs(kStd);
                        db.prepare('INSERT INTO debtors (timestamp, date_ymd, count, amount, month, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
                            .run(timestamp, dateYmd, actualStudentCount, delIncAmt, delMonth, userId);
                        db.prepare('INSERT INTO qarzdorlar_log (month, date_ymd, change_amount, type, note, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
                            .run(delMonth, dateYmd, delIncAmt, 'norasmiy_reversal', `Norasmiy tushum bekor: +${delIncAmt} (${actualStudentCount} o'quvchi)`, userId);
                        db.prepare('UPDATE qarzdorlar_log SET note = note || ? WHERE id = ?')
                            .run(' [reversed]', deduction.id);
                    }
                }
            })();

        } else if (sectionKey === 'moliya_chiqim' || sectionKey === 'moliya_chiqim_rasmiy' || sectionKey === 'moliya_chiqim_norasmiy') {
            let toifa = 'Norasmiy';
            if (sectionKey === 'moliya_chiqim_rasmiy') {
                toifa = 'Rasmiy';
            } else if (sectionKey === 'moliya_chiqim_norasmiy') {
                toifa = 'Norasmiy';
            } else {
                const rawCat = reportData.expense_category || '';
                // M-32: More robust emoji stripping
                toifa = rawCat.replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier_Base}\p{Extended_Pictographic}\s]+/gu, '').trim() || 'Norasmiy';
            }

            const chiqimMonth = normalizeMonth(reportData.month) || '';
            const chiqimAmt = safeInt(reportData.today_expense);
            db.transaction(() => {
                db.prepare('INSERT INTO finance (timestamp, date_ymd, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(timestamp, dateYmd, 0, chiqimAmt, chiqimMonth, 0, 0, reportData.expense_type || '', toifa, reportData.comment || '', userId);
            })();

        } else if (sectionKey === 'moliya_chiqim_del') {
            const exp = safeInt(reportData.today_expense);
            const rawCat = reportData.expense_category || '';
            // M-32: More robust emoji stripping
            const toifa = rawCat.replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier_Base}\p{Extended_Pictographic}\s]+/gu, '').trim() || 'Norasmiy';
            const delChiqimMonth = normalizeMonth(reportData.month) || '';
            db.transaction(() => {
                const existingExpense = db.prepare(`SELECT id FROM finance WHERE expense > 0 AND ABS(expense) = ? AND month = ? AND LOWER(TRIM(category)) = ? AND expense_type = ? AND COALESCE(comment,'') != '[REVERSED]' LIMIT 1`).get(Math.abs(exp), delChiqimMonth, toifa.toLowerCase(), reportData.expense_type || '');
                if (!existingExpense) {
                    logger.warn(`Expense deletion rejected: no matching positive expense found for amount=${exp}, month=${delChiqimMonth}`);
                    return;
                }
                // Mark original expense as reversed to prevent double-deletion
                db.prepare("UPDATE finance SET comment = '[REVERSED]' WHERE id = ?").run(existingExpense.id);
                db.prepare('INSERT INTO finance (timestamp, date_ymd, income, expense, month, kassa_amount, kassa_students, expense_type, category, comment, manager_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(timestamp, dateYmd, 0, -Math.abs(exp), delChiqimMonth, 0, 0, reportData.expense_type || '', toifa, '', userId);
            })();

        } else if (sectionKey === 'muammo') {
            const stmt = db.prepare('INSERT INTO problems (timestamp, date_ymd, branch, type, issue, manager_id) VALUES (?, ?, ?, ?, ?, ?)');
            const insertMany = db.transaction((entries) => {
                for (const entry of entries) {
                    if (!entry || typeof entry !== 'object') continue;
                    if (!entry.issue) continue;
                    stmt.run(timestamp, dateYmd, entry.branch || '', entry.type || '', entry.issue, userId);
                }
            });
            insertMany(reportData.entries || []);

        } else if (sectionKey === 'davomat') {
            db.prepare('INSERT INTO attendance (timestamp, date_ymd, expected, attended, manager_id) VALUES (?, ?, ?, ?, ?)')
                .run(timestamp, dateYmd, safeInt(reportData.expected), safeInt(reportData.attended), userId);
        }
    } catch (e) {
        logger.error(`Failed to dispatch ${sectionKey} to DB:`, e);
        throw e; // Re-throw so saveDailyReport returns false on failure
    }
}

// --- Audit Log ---

async function logAudit(action, userId, details = {}) {
    try {
        const dateYmd = getTashkentDateString();
        const timestamp = new Date().toLocaleString('uz-UZ', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            timeZone: 'Asia/Tashkent'
        }).replace(',', '');
        db.prepare(
            'INSERT INTO audit_log (timestamp, date_ymd, user_id, user_name, action, section, details, record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
            timestamp,
            dateYmd,
            String(userId || ''),
            String(details.user_name || ''),
            String(action || ''),
            String(details.section || ''),
            typeof details === 'object' ? JSON.stringify(details) : String(details),
            String(details.record_id || '')
        );
    } catch (e) {
        logger.error('Failed to write audit log:', e);
    }
}

// --- Empty Rooms ---

async function getEmptyRooms() {
    const rows = db.prepare('SELECT * FROM empty_rooms ORDER BY id').all();
    return rows.map(row => ({
        rowIndex: row.id,
        timestamp: row.timestamp,
        branch: row.branch,
        room: row.room,
        days: row.days,
        time: row.time,
        period: row.period,
        capacity: row.capacity || 20,
        price_per_student: row.price_per_student || 350000
    }));
}

async function deleteEmptyRoom(rowIndex) {
    const result = db.prepare('DELETE FROM empty_rooms WHERE id = ?').run(rowIndex);
    return result.changes > 0;
}

async function calculatePotentialIncome() {
    const rooms = await getEmptyRooms();
    const result = {
        totalPotential: 0,
        roomCount: rooms.length,
        byBranch: {},
        byPeriod: {},
        rooms: []
    };

    for (const room of rooms) {
        const roomPotential = room.capacity * room.price_per_student;
        result.rooms.push({ ...room, potential: roomPotential });
        result.totalPotential += roomPotential;

        if (!result.byBranch[room.branch]) result.byBranch[room.branch] = { rooms: 0, potential: 0 };
        result.byBranch[room.branch].rooms += 1;
        result.byBranch[room.branch].potential += roomPotential;

        const periodKey = room.period || 'Boshqa';
        if (!result.byPeriod[periodKey]) result.byPeriod[periodKey] = { rooms: 0, potential: 0 };
        result.byPeriod[periodKey].rooms += 1;
        result.byPeriod[periodKey].potential += roomPotential;
    }
    return result;
}

async function saveEmptyRoomsSnapshot(dateYmd) {
    // H-17: Use a transaction to atomically read rooms, check for duplicates and insert
    const stmt = db.prepare('INSERT INTO empty_rooms_history (date_ymd, branch, room, days, time, period, capacity, price_per_student, potential) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

    const result = db.transaction(() => {
        // Read rooms INSIDE the transaction to prevent race condition
        const rooms = db.prepare('SELECT * FROM empty_rooms ORDER BY id').all();

        // Check inside the transaction to prevent race condition
        const existing = db.prepare('SELECT COUNT(*) as cnt FROM empty_rooms_history WHERE date_ymd = ?').get(dateYmd);
        if (existing.cnt > 0) {
            return { saved: false, roomCount: 0, totalPotential: 0, reason: 'duplicate' };
        }

        if (rooms.length === 0) {
            stmt.run(dateYmd, NO_EMPTY_ROOMS_MARKER, '', '', '', '', 0, 0, 0);
            return { saved: true, roomCount: 0, totalPotential: 0 };
        }

        let totalPotential = 0;
        for (const room of rooms) {
            const potential = (room.capacity || 20) * (room.price_per_student || 350000);
            stmt.run(dateYmd, room.branch, room.room, room.days, room.time, room.period, room.capacity || 20, room.price_per_student || 350000, potential);
            totalPotential += potential;
        }
        return { saved: true, roomCount: rooms.length, totalPotential };
    })();

    if (!result.saved) {
        logger.info(`Snapshot for ${dateYmd} already exists, skipping.`);
    }

    return result;
}

async function getEmptyRoomsForDate(dateYmd) {
    const rows = db.prepare('SELECT * FROM empty_rooms_history WHERE date_ymd = ?').all(dateYmd);
    if (rows.length === 0) return null;

    const rooms = [];
    for (const row of rows) {
        if (row.branch === NO_EMPTY_ROOMS_MARKER) continue;
        rooms.push({
            branch: row.branch,
            room: row.room,
            days: row.days,
            time: row.time,
            period: row.period,
            capacity: row.capacity || 20,
            price_per_student: row.price_per_student || 350000
        });
    }
    return rooms;
}

async function calculatePotentialIncomeForDate(dateYmd) {
    const rooms = await getEmptyRoomsForDate(dateYmd);
    if (rooms === null) return null;

    const result = {
        totalPotential: 0,
        roomCount: rooms.length,
        byBranch: {},
        byPeriod: {},
        rooms: []
    };

    for (const room of rooms) {
        const roomPotential = room.capacity * room.price_per_student;
        result.rooms.push({ ...room, potential: roomPotential });
        result.totalPotential += roomPotential;

        if (!result.byBranch[room.branch]) result.byBranch[room.branch] = { rooms: 0, potential: 0 };
        result.byBranch[room.branch].rooms += 1;
        result.byBranch[room.branch].potential += roomPotential;

        const periodKey = room.period || 'Boshqa';
        if (!result.byPeriod[periodKey]) result.byPeriod[periodKey] = { rooms: 0, potential: 0 };
        result.byPeriod[periodKey].rooms += 1;
        result.byPeriod[periodKey].potential += roomPotential;
    }
    return result;
}

// --- Month helpers ---

function extractMonthFromRow(timestamp, monthCol) {
    let monthName = monthCol ? String(monthCol).trim() : "";
    if (!monthName) {
        const rowDateObj = parseUzDate(timestamp || '');
        if (rowDateObj.getTime() > 0) {
            const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
            monthName = `${monthsUz[rowDateObj.getMonth()]} ${rowDateObj.getFullYear()}`;
        } else {
            monthName = "Noma'lum";
        }
    } else {
        monthName = normalizeMonthKey(monthName);
    }
    return monthName;
}

// --- Rejection/Debtor/Finance by Month ---

async function getRejectionByMonth() {
    const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];

    // SQL GROUP BY: aggregate counts per month-key and subject in the database
    const rows = db.prepare(`
        SELECT
            CASE
                WHEN date_ymd != '' THEN substr(date_ymd, 1, 7)
                WHEN timestamp LIKE '____-__-__%' THEN substr(timestamp, 1, 7)
                ELSE ''
            END AS month_key,
            UPPER(SUBSTR(TRIM(subject), 1, 1)) || LOWER(SUBSTR(TRIM(subject), 2)) AS norm_subject,
            SUM(count) AS total
        FROM rejections
        WHERE TRIM(subject) != ''
        GROUP BY month_key, norm_subject
    `).all();

    if (rows.length === 0) return {};

    const allSubjects = await getSubjects();
    const totalsByMonth = {};

    for (const row of rows) {
        // Convert YYYY-MM key to Uzbek month name
        let monthName = "Noma'lum";
        if (row.month_key && row.month_key.length >= 7) {
            const [y, m] = row.month_key.split('-').map(Number);
            if (m >= 1 && m <= 12 && y > 0) {
                monthName = `${monthsUz[m - 1]} ${y}`;
            }
        }

        if (!totalsByMonth[monthName]) {
            totalsByMonth[monthName] = {};
            allSubjects.forEach(s => totalsByMonth[monthName][s] = 0);
        }
        totalsByMonth[monthName][row.norm_subject] = (totalsByMonth[monthName][row.norm_subject] || 0) + row.total;
    }
    return totalsByMonth;
}

async function getDebtorByMonth() {
    const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];

    // SQL GROUP BY: aggregate count and amount per month in the database.
    // Priority: use 'month' column if set, else derive from date_ymd or timestamp.
    const rows = db.prepare(`
        SELECT
            CASE
                WHEN TRIM(month) != '' THEN TRIM(month)
                WHEN date_ymd != '' THEN substr(date_ymd, 1, 7)
                WHEN timestamp LIKE '____-__-__%' THEN substr(timestamp, 1, 7)
                ELSE ''
            END AS month_key,
            SUM(count) AS total_count,
            SUM(amount) AS total_amount
        FROM debtors
        GROUP BY month_key
    `).all();

    if (rows.length === 0) return {};

    const totalsByMonth = {};
    for (const row of rows) {
        let monthName;
        // month_key is either an already-normalized name like "Mart 2026" or a "YYYY-MM" date key
        if (row.month_key && /^\d{4}-\d{2}$/.test(row.month_key)) {
            const [y, m] = row.month_key.split('-').map(Number);
            monthName = (m >= 1 && m <= 12 && y > 0) ? `${monthsUz[m - 1]} ${y}` : "Noma'lum";
        } else {
            monthName = row.month_key ? normalizeMonthKey(row.month_key) || "Noma'lum" : "Noma'lum";
        }

        if (!totalsByMonth[monthName]) totalsByMonth[monthName] = { count: 0, amount: 0 };
        totalsByMonth[monthName].count += row.total_count;
        totalsByMonth[monthName].amount += row.total_amount;
    }
    return totalsByMonth;
}

async function getFinanceByMonth() {
    const monthsUz = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];

    // SQL GROUP BY: aggregate all finance metrics per month and category in the database.
    // Uses CASE expressions to split income/expense by rasmiy/norasmiy category.
    const rows = db.prepare(`
        SELECT
            CASE
                WHEN TRIM(month) != '' THEN TRIM(month)
                WHEN date_ymd != '' THEN substr(date_ymd, 1, 7)
                WHEN timestamp LIKE '____-__-__%' THEN substr(timestamp, 1, 7)
                ELSE ''
            END AS month_key,
            SUM(income) AS income,
            SUM(expense) AS expense,
            SUM(CASE WHEN LOWER(TRIM(category)) = 'rasmiy' THEN income ELSE 0 END) AS income_rasmiy,
            SUM(CASE WHEN LOWER(TRIM(category)) = 'norasmiy' THEN income ELSE 0 END) AS income_norasmiy,
            SUM(CASE WHEN LOWER(TRIM(category)) NOT IN ('rasmiy', 'norasmiy') THEN income ELSE 0 END) AS income_uncategorized,
            SUM(CASE WHEN LOWER(TRIM(category)) = 'rasmiy' THEN expense ELSE 0 END) AS expense_rasmiy,
            SUM(CASE WHEN LOWER(TRIM(category)) = 'norasmiy' THEN expense ELSE 0 END) AS expense_norasmiy,
            SUM(CASE WHEN LOWER(TRIM(category)) NOT IN ('rasmiy', 'norasmiy') THEN expense ELSE 0 END) AS expense_uncategorized,
            SUM(kassa_amount) AS kassa_amount,
            SUM(kassa_students) AS kassa_students
        FROM finance
        GROUP BY month_key
    `).all();

    if (rows.length === 0) return {};

    const totalsByMonth = {};
    for (const row of rows) {
        let monthName;
        if (row.month_key && /^\d{4}-\d{2}$/.test(row.month_key)) {
            const [y, m] = row.month_key.split('-').map(Number);
            monthName = (m >= 1 && m <= 12 && y > 0) ? `${monthsUz[m - 1]} ${y}` : "Noma'lum";
        } else {
            monthName = row.month_key ? normalizeMonthKey(row.month_key) || "Noma'lum" : "Noma'lum";
        }

        if (!totalsByMonth[monthName]) {
            totalsByMonth[monthName] = {
                income: 0, income_rasmiy: 0, income_norasmiy: 0, income_uncategorized: 0,
                expense: 0, expense_rasmiy: 0, expense_norasmiy: 0, expense_uncategorized: 0,
                kassa_amount: 0, kassa_students: 0,
                expenses_by_type: {}, expenses_by_type_rasmiy: {},
                expense_details: []
            };
        }

        totalsByMonth[monthName].income += row.income;
        totalsByMonth[monthName].expense += row.expense;
        totalsByMonth[monthName].income_rasmiy += row.income_rasmiy;
        totalsByMonth[monthName].income_norasmiy += row.income_norasmiy;
        totalsByMonth[monthName].expense_rasmiy += row.expense_rasmiy;
        totalsByMonth[monthName].expense_norasmiy += row.expense_norasmiy;
        totalsByMonth[monthName].income_uncategorized += row.income_uncategorized;
        totalsByMonth[monthName].expense_uncategorized += row.expense_uncategorized;
        totalsByMonth[monthName].kassa_amount += row.kassa_amount;
        totalsByMonth[monthName].kassa_students += row.kassa_students;
    }

    // Populate expenses_by_type from individual finance rows per month
    const expenseRows = db.prepare(`
        SELECT
            CASE
                WHEN TRIM(month) != '' THEN TRIM(month)
                WHEN date_ymd != '' THEN substr(date_ymd, 1, 7)
                WHEN timestamp LIKE '____-__-__%' THEN substr(timestamp, 1, 7)
                ELSE ''
            END AS month_key,
            CASE WHEN TRIM(expense_type) != '' AND TRIM(expense_type) != '-' THEN TRIM(expense_type) ELSE 'Boshqa xarajat' END AS etype,
            LOWER(TRIM(category)) AS cat,
            SUM(expense) AS total_expense
        FROM finance
        WHERE expense != 0
        GROUP BY month_key, etype, cat
    `).all();

    for (const eRow of expenseRows) {
        let mn;
        if (eRow.month_key && /^\d{4}-\d{2}$/.test(eRow.month_key)) {
            const [y, m] = eRow.month_key.split('-').map(Number);
            mn = (m >= 1 && m <= 12 && y > 0) ? `${monthsUz[m - 1]} ${y}` : "Noma'lum";
        } else {
            mn = eRow.month_key ? normalizeMonthKey(eRow.month_key) || "Noma'lum" : "Noma'lum";
        }
        if (!totalsByMonth[mn]) continue;
        const target = eRow.cat === 'rasmiy' ? 'expenses_by_type_rasmiy' : 'expenses_by_type';
        totalsByMonth[mn][target][eRow.etype] = (totalsByMonth[mn][target][eRow.etype] || 0) + eRow.total_expense;
    }

    return totalsByMonth;
}

async function getLeadStatus() {
    const rows = db.prepare(`
        SELECT
            UPPER(SUBSTR(TRIM(subject), 1, 1)) || LOWER(SUBSTR(TRIM(subject), 2)) AS norm_subject,
            SUM(count) as total
        FROM leads
        WHERE TRIM(subject) != ''
        GROUP BY norm_subject
    `).all();
    const totals = {};
    for (const row of rows) {
        if (!row.norm_subject) continue;
        totals[row.norm_subject] = (totals[row.norm_subject] || 0) + row.total;
    }
    return totals;
}

// --- Problems ---

async function getAllProblems() {
    const rows = db.prepare('SELECT * FROM problems ORDER BY id').all();
    return rows.map(row => ({
        timestamp: row.timestamp,
        branch: row.branch || "Noma'lum",
        type: row.type || "Noma'lum",
        issue: row.issue || '',
        rowIndex: row.id
    }));
}

async function deleteProblem(rowIndex) {
    const result = db.prepare('DELETE FROM problems WHERE id = ?').run(rowIndex);
    return result.changes > 0;
}

// --- Settings ---

async function loadDynamicSettings() {
    const rows = db.prepare('SELECT * FROM settings ORDER BY id').all();

    const config = {};
    for (const row of rows) {
        const sectionId = row.section_id;
        const title = row.title;
        const buttonText = row.button_text;
        const isLoop = row.is_loop === 1;
        const itemLabel = row.item_label || '';
        const qKey = row.q_key;
        const qText = row.q_text;
        const optionsRaw = row.options_raw || '';

        if (!config[sectionId]) {
            config[sectionId] = { title, buttonText, loop: isLoop, itemLabel, questions: [] };
        }

        const questionObj = { key: qKey, question: qText };
        if (qKey === 'subject') {
            questionObj.dynamicOptions = 'subjects';
        } else if (optionsRaw.trim() === 'last_6_months') {
            questionObj.dynamicOptions = 'last_6_months';
        } else if (optionsRaw.trim() === 'expense_types') {
            questionObj.dynamicOptions = 'expense_types';
        } else if (optionsRaw.trim() !== '') {
            questionObj.options = optionsRaw.split(',').map(o => o.trim());
        }
        config[sectionId].questions.push(questionObj);
    }

    // Ensure Moliya has the month question
    if (config['moliya']) {
        const hasMonth = config['moliya'].questions.some(q => q.key === 'month');
        if (!hasMonth) {
            config['moliya'].questions.unshift({ key: 'month', question: 'Qaysi oy uchun?', dynamicOptions: 'last_6_months' });
        }
        const hasType = config['moliya'].questions.some(q => q.key === 'expense_type');
        if (!hasType) {
            const expIdx = config['moliya'].questions.findIndex(q => q.key === 'today_expense');
            const typeQ = { key: 'expense_type', question: 'Xarajat turi qanday?', dynamicOptions: 'expense_types' };
            if (expIdx >= 0) config['moliya'].questions.splice(expIdx + 1, 0, typeQ);
            else config['moliya'].questions.push(typeQ);
        }
    }

    if (config['qarzdorlar']) {
        const hasMonth = config['qarzdorlar'].questions.some(q => q.key === 'month');
        if (!hasMonth) config['qarzdorlar'].questions.unshift({ key: 'month', question: 'Qaysi oy uchun?', dynamicOptions: 'last_6_months' });
    }
    if (config['qarzdorlar_remove']) {
        const hasMonth = config['qarzdorlar_remove'].questions.some(q => q.key === 'month');
        if (!hasMonth) config['qarzdorlar_remove'].questions.unshift({ key: 'month', question: 'Qaysi oy uchun?', dynamicOptions: 'last_6_months' });
    }

    if (config['bosh_xonalar']) {
        const hasPeriod = config['bosh_xonalar'].questions.some(q => q.key === 'period');
        if (!hasPeriod) {
            const timeIdx = config['bosh_xonalar'].questions.findIndex(q => q.key === 'time');
            const periodQ = { key: 'period', question: "Xona qay vaqtda bo'sh?", options: ['Tushlikgacha', 'Tushlikdan keyin', "To'liq kun"] };
            if (timeIdx >= 0) config['bosh_xonalar'].questions.splice(timeIdx, 0, periodQ);
            else config['bosh_xonalar'].questions.push(periodQ);
        }
        const hasCapacity = config['bosh_xonalar'].questions.some(q => q.key === 'capacity');
        if (!hasCapacity) config['bosh_xonalar'].questions.push({ key: 'capacity', question: "Xona nechta o'quvchi sig'adi?" });
        const hasPrice = config['bosh_xonalar'].questions.some(q => q.key === 'price_per_student');
        if (!hasPrice) config['bosh_xonalar'].questions.push({ key: 'price_per_student', question: "Kurs narxi qancha? (so'm)" });
    }

    if (config['muammo']) {
        const hasType = config['muammo'].questions.some(q => q.key === 'type');
        if (!hasType) {
            const branchIdx = config['muammo'].questions.findIndex(q => q.key === 'branch');
            const typeQ = { key: 'type', question: "Muammo turi qanday?", options: ["Ta'mirlash", "Jihozlar", "Dars jarayoni", "Boshqa"] };
            if (branchIdx >= 0) config['muammo'].questions.splice(branchIdx + 1, 0, typeQ);
            else config['muammo'].questions.splice(1, 0, typeQ);
        }
    }

    // Merge any missing static sections
    for (const key in SECTIONS) {
        if (!config[key]) config[key] = SECTIONS[key];
    }

    return config;
}

// --- Users ---

async function loadAuthorizedUsers() {
    logger.info("Loading authorized users from SQLite...");
    const rows = db.prepare('SELECT * FROM users').all();
    const users = {};

    if (rows.length === 0) {
        logger.warn("⚠️ No users found in SQLite users table!");
        return users;
    }

    for (const row of rows) {
        const telegramId = row.telegram_id;
        if (!telegramId) continue;

        const sections = USER_SECTION_KEYS.filter(key => {
            const val = row[`sec_${key}`];
            // Handle various formats: integer 1, string '1', 'TRUE', 'true', boolean true
            return val === 1 || val === true || val === '1' || (typeof val === 'string' && val.toLowerCase() === 'true');
        });
        users[telegramId] = {
            id: telegramId,
            name: row.name || "Unknown",
            sections: sections,
            lang: row.lang || 'uz'
        };
        logger.debug(`User ${telegramId} (${users[telegramId].name}) sections: ${sections.join(', ')}`);
    }

    logger.info(`✅ Loaded ${Object.keys(users).length} authorized users: ${Object.keys(users).join(', ')}`);
    return users;
}

async function addUser(telegramId, name, sections, lang) {
    const idStr = String(telegramId).trim();
    if (!/^\d+$/.test(idStr)) {
        throw new Error(`Invalid telegramId format: must be numeric, got "${idStr}"`);
    }
    const params = {
        telegram_id: telegramId.toString(),
        name: name,
        lang: lang || 'uz'
    };
    for (const key of USER_SECTION_KEYS) {
        params[`sec_${key}`] = sections.includes(key) ? 1 : 0;
    }
    db.prepare(`INSERT INTO users (telegram_id, name, sec_lead, sec_qarzdorlar, sec_rad_etilganlar, sec_moliya, sec_davomat, sec_muammo, sec_bosh_xonalar, sec_reports, sec_foydalanuvchilar, sec_cron, sec_bosh, sec_tahlil, lang) VALUES (@telegram_id, @name, @sec_lead, @sec_qarzdorlar, @sec_rad_etilganlar, @sec_moliya, @sec_davomat, @sec_muammo, @sec_bosh_xonalar, @sec_reports, @sec_foydalanuvchilar, @sec_cron, @sec_bosh, @sec_tahlil, @lang) ON CONFLICT(telegram_id) DO UPDATE SET name=excluded.name, sec_lead=excluded.sec_lead, sec_qarzdorlar=excluded.sec_qarzdorlar, sec_rad_etilganlar=excluded.sec_rad_etilganlar, sec_moliya=excluded.sec_moliya, sec_davomat=excluded.sec_davomat, sec_muammo=excluded.sec_muammo, sec_bosh_xonalar=excluded.sec_bosh_xonalar, sec_reports=excluded.sec_reports, sec_foydalanuvchilar=excluded.sec_foydalanuvchilar, sec_cron=excluded.sec_cron, sec_bosh=excluded.sec_bosh, sec_tahlil=excluded.sec_tahlil, lang=excluded.lang`)
        .run(params);
}

async function updateUser(telegramId, name, sections, lang) {
    const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId.toString());
    if (!existing) throw new Error('Foydalanuvchi topilmadi');

    const params = { telegram_id: telegramId.toString(), name, lang: lang || 'uz' };
    for (const key of USER_SECTION_KEYS) {
        params[`sec_${key}`] = sections.includes(key) ? 1 : 0;
    }
    db.prepare(`UPDATE users SET name = @name, sec_lead = @sec_lead, sec_qarzdorlar = @sec_qarzdorlar, sec_rad_etilganlar = @sec_rad_etilganlar, sec_moliya = @sec_moliya, sec_davomat = @sec_davomat, sec_muammo = @sec_muammo, sec_bosh_xonalar = @sec_bosh_xonalar, sec_reports = @sec_reports, sec_foydalanuvchilar = @sec_foydalanuvchilar, sec_cron = @sec_cron, sec_bosh = @sec_bosh, sec_tahlil = @sec_tahlil, lang = @lang WHERE telegram_id = @telegram_id`)
        .run(params);
}

async function updateUserLang(telegramId, lang) {
    db.prepare('UPDATE users SET lang = ? WHERE telegram_id = ?').run(lang, telegramId.toString());
}

async function deleteUser(telegramId) {
    const tid = telegramId.toString();
    db.transaction(() => {
        const result = db.prepare('DELETE FROM users WHERE telegram_id = ?').run(tid);
        if (result.changes === 0) throw new Error('Foydalanuvchi topilmadi');
        // Cascade cleanup: remove related records for deleted user
        db.prepare('DELETE FROM user_branches WHERE user_id = ?').run(tid);
        db.prepare('DELETE FROM active_users WHERE telegram_id = ?').run(tid);
        db.prepare('DELETE FROM kpi_assignments WHERE assigned_to = ?').run(tid);
        db.prepare('DELETE FROM cron_assignments WHERE assigned_to = ?').run(tid);
    })();
}

// --- Subjects ---

async function getSubjects() {
    const rows = db.prepare('SELECT name FROM subjects ORDER BY id').all();
    return rows.map(r => r.name);
}

async function getAllSubjects() {
    const fanlarSubjects = await getSubjects();
    const leadTotals = await getLeadStatus();
    const seen = new Set(fanlarSubjects);
    const merged = [...fanlarSubjects];
    for (const subj of Object.keys(leadTotals)) {
        if (!seen.has(subj)) { seen.add(subj); merged.push(subj); }
    }
    return merged;
}

async function addSubject(name) {
    const normalized = name.trim().charAt(0).toUpperCase() + name.trim().slice(1).toLowerCase();
    const existing = db.prepare('SELECT id FROM subjects WHERE LOWER(TRIM(name)) = ?').get(normalized.toLowerCase());
    if (existing) return true;
    const timestamp = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
    db.prepare('INSERT INTO subjects (name, created_at) VALUES (?, ?)').run(normalized, timestamp);
    return true;
}

async function deleteSubject(name) {
    const normalizedName = name.trim().toLowerCase();
    const row = db.prepare('SELECT id, name FROM subjects WHERE LOWER(name) = ?').get(normalizedName);
    if (!row) return false;
    db.prepare('DELETE FROM subjects WHERE id = ?').run(row.id);
    return true;
}

async function deleteLeadsBySubject(subjectName) {
    const normalizedTarget = subjectName.trim().toLowerCase();
    const result = db.prepare('DELETE FROM leads WHERE LOWER(TRIM(subject)) = ?').run(normalizedTarget);
    return result.changes > 0;
}

async function deleteRejectionsBySubject(subjectName) {
    const normalizedTarget = subjectName.trim().toLowerCase();
    const result = db.prepare('DELETE FROM rejections WHERE LOWER(TRIM(subject)) = ?').run(normalizedTarget);
    return result.changes > 0;
}

// --- Expense Types ---

async function getExpenseTypes(category) {
    if (category) {
        const rows = db.prepare('SELECT name FROM expense_types WHERE category = ? ORDER BY id').all(category);
        return rows.map(r => r.name);
    }
    const rows = db.prepare('SELECT name FROM expense_types ORDER BY id').all();
    return rows.map(r => r.name);
}

async function addExpenseType(name, category) {
    const timestamp = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
    try {
        if (category) {
            db.prepare('INSERT INTO expense_types (name, category, created_at) VALUES (?, ?, ?)').run(name, category, timestamp);
        } else {
            db.prepare('INSERT INTO expense_types (name, created_at) VALUES (?, ?)').run(name, timestamp);
        }
    } catch (e) {
        if (e.message.includes('UNIQUE')) return true; // Already exists
        throw e;
    }
    return true;
}

async function deleteExpenseType(name, category) {
    const normalizedTarget = name.trim().toLowerCase();
    if (category) {
        const result = db.prepare('DELETE FROM expense_types WHERE LOWER(TRIM(name)) = ? AND category = ?').run(normalizedTarget, category);
        return result.changes > 0;
    }
    const result = db.prepare('DELETE FROM expense_types WHERE LOWER(TRIM(name)) = ?').run(normalizedTarget);
    return result.changes > 0;
}

// --- Active Users ---

async function saveActiveUser(userId) {
    if (!userId) return;
    try {
        db.prepare('INSERT OR REPLACE INTO active_users (telegram_id, last_active) VALUES (?, ?)')
            .run(userId.toString(), new Date().toISOString());
    } catch (e) {
        logger.error("Error saving active user:", e);
    }
}

async function loadActiveUsers() {
    try {
        const rows = db.prepare('SELECT telegram_id FROM active_users').all();
        return rows.map(r => r.telegram_id);
    } catch (e) {
        logger.error("Error loading active users:", e);
        return [];
    }
}

async function removeActiveUser(userId) {
    try {
        const result = db.prepare('DELETE FROM active_users WHERE telegram_id = ?').run(String(userId));
        if (result.changes > 0) logger.info(`Removed active user ${userId}.`);
        return result.changes > 0;
    } catch (e) {
        logger.error(`Failed to remove active user ${userId}:`, e.message);
        return false;
    }
}

// --- fetchAllData (unified, optimized with SQL WHERE on date_ymd) ---

async function fetchAllData(startDateYmd, endDateYmd, financeAccountingMonth = null, ignoreDateForFinance = false) {
    // Build SQL WHERE clause for date filtering
    const hasDateFilter = !!startDateYmd;
    const effectiveEnd = endDateYmd || startDateYmd;

    const reporterIds = new Set();

    // Helper to collect reporter IDs
    const collectReporters = (rows) => {
        for (const row of rows) {
            const managerId = row.manager_id ? String(row.manager_id).trim() : '';
            if (managerId) reporterIds.add(managerId);
        }
    };

    // --- LEADS (SQL-filtered) ---
    const leadRows = hasDateFilter
        ? db.prepare('SELECT subject, count, manager_id FROM leads WHERE date_ymd BETWEEN ? AND ?').all(startDateYmd, effectiveEnd)
        : db.prepare('SELECT subject, count, manager_id FROM leads').all();
    const leadsBreakdown = {};
    let totalLeads = 0;
    for (const row of leadRows) {
        const sub = row.subject ? row.subject.trim() : '';
        if (!sub) continue;
        const subject = sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase();
        leadsBreakdown[subject] = (leadsBreakdown[subject] || 0) + row.count;
        totalLeads += row.count;
    }
    collectReporters(leadRows);

    // --- DEBTORS (SQL-filtered) ---
    const debtorRows = hasDateFilter
        ? db.prepare('SELECT count, amount, manager_id FROM debtors WHERE date_ymd BETWEEN ? AND ?').all(startDateYmd, effectiveEnd)
        : db.prepare('SELECT count, amount, manager_id FROM debtors').all();
    let debtorCount = 0, debtorAmount = 0;
    for (const row of debtorRows) {
        debtorCount += row.count;
        debtorAmount += row.amount;
    }
    collectReporters(debtorRows);

    // --- REJECTIONS (SQL-filtered) ---
    const rejectionRows = hasDateFilter
        ? db.prepare('SELECT subject, count, manager_id FROM rejections WHERE date_ymd BETWEEN ? AND ?').all(startDateYmd, effectiveEnd)
        : db.prepare('SELECT subject, count, manager_id FROM rejections').all();
    const rejectionsBreakdown = {};
    let totalRejections = 0;
    for (const row of rejectionRows) {
        const sub = row.subject ? row.subject.trim() : '';
        if (!sub) continue;
        const subject = sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase();
        rejectionsBreakdown[subject] = (rejectionsBreakdown[subject] || 0) + row.count;
        totalRejections += row.count;
    }
    collectReporters(rejectionRows);

    // --- FINANCE (SQL-filtered with optional month accounting) ---
    let financeRows;
    if (ignoreDateForFinance && financeAccountingMonth) {
        // Filter by month only, ignore date
        const targetMonths = Array.isArray(financeAccountingMonth)
            ? financeAccountingMonth.map(normalizeMonthKey)
            : [normalizeMonthKey(financeAccountingMonth)];
        const placeholders = targetMonths.map(() => '?').join(',');
        financeRows = db.prepare(`SELECT * FROM finance WHERE month IN (${placeholders})`).all(...targetMonths);
    } else if (financeAccountingMonth && hasDateFilter) {
        // Filter by both date range AND month
        const targetMonths = Array.isArray(financeAccountingMonth)
            ? financeAccountingMonth.map(normalizeMonthKey)
            : [normalizeMonthKey(financeAccountingMonth)];
        const placeholders = targetMonths.map(() => '?').join(',');
        financeRows = db.prepare(`SELECT * FROM finance WHERE date_ymd BETWEEN ? AND ? AND month IN (${placeholders})`).all(startDateYmd, effectiveEnd, ...targetMonths);
    } else if (hasDateFilter) {
        financeRows = db.prepare('SELECT * FROM finance WHERE date_ymd BETWEEN ? AND ?').all(startDateYmd, effectiveEnd);
    } else {
        financeRows = db.prepare('SELECT * FROM finance').all();
    }

    let fIncome = 0, fExpense = 0, fExpenseRasmiy = 0, fExpenseNorasmiy = 0;
    let fIncomeRasmiy = 0, fIncomeNorasmiy = 0, fKassaAmt = 0, fKassaStd = 0;
    const fExpensesByType = {};
    const fExpensesByTypeRasmiy = {};
    const fExpenseDetails = [];

    for (const row of financeRows) {
        fIncome += row.income;
        fKassaAmt += row.kassa_amount;
        fKassaStd += row.kassa_students;

        const rowCategory = (row.category || '').trim().toLowerCase();
        if (row.income !== 0) {
            if (rowCategory === 'rasmiy') fIncomeRasmiy += row.income;
            else if (rowCategory === 'norasmiy') fIncomeNorasmiy += row.income;
        }
        if (row.expense !== 0) {
            const eType = (row.expense_type && row.expense_type.trim() !== '-' && row.expense_type.trim() !== '')
                ? row.expense_type.trim() : 'Boshqa xarajat';
            fExpenseDetails.push({ type: eType, amount: row.expense, category: rowCategory });
            if (rowCategory === 'rasmiy') {
                fExpenseRasmiy += row.expense;
                fExpensesByTypeRasmiy[eType] = (fExpensesByTypeRasmiy[eType] || 0) + row.expense;
            } else if (rowCategory === 'norasmiy') {
                fExpenseNorasmiy += row.expense;
                fExpensesByType[eType] = (fExpensesByType[eType] || 0) + row.expense;
            }
            fExpense += row.expense;
        }
        const managerId = row.manager_id ? String(row.manager_id).trim() : '';
        if (managerId) reporterIds.add(managerId);
    }

    // --- PROBLEMS (SQL-filtered) ---
    const problemRows = hasDateFilter
        ? db.prepare('SELECT branch, type, issue, manager_id FROM problems WHERE date_ymd BETWEEN ? AND ?').all(startDateYmd, effectiveEnd)
        : db.prepare('SELECT branch, type, issue, manager_id FROM problems').all();
    const problems = problemRows.map(row => ({
        branch: row.branch || "Noma'lum",
        type: row.type || 'Muammo',
        issue: row.issue || ''
    }));
    collectReporters(problemRows);

    // --- ATTENDANCE (SQL-filtered) ---
    const attendanceRows = hasDateFilter
        ? db.prepare('SELECT expected, attended, manager_id FROM attendance WHERE date_ymd BETWEEN ? AND ?').all(startDateYmd, effectiveEnd)
        : db.prepare('SELECT expected, attended, manager_id FROM attendance').all();
    let aExpected = 0, aAttended = 0;
    for (const row of attendanceRows) {
        aExpected += row.expected;
        aAttended += row.attended;
    }
    collectReporters(attendanceRows);

    return {
        leads: leadsBreakdown,
        leadsTotal: totalLeads,
        debtors: { count: debtorCount, amount: debtorAmount },
        rejections: rejectionsBreakdown,
        rejectionsTotal: totalRejections,
        finance: {
            income: fIncome, income_rasmiy: fIncomeRasmiy, income_norasmiy: fIncomeNorasmiy,
            expense: fExpense, expense_rasmiy: fExpenseRasmiy, expense_norasmiy: fExpenseNorasmiy,
            kassa_amount: fKassaAmt, kassa_students: fKassaStd,
            expenses_by_type: fExpensesByType, expenses_by_type_rasmiy: fExpensesByTypeRasmiy,
            expense_details: fExpenseDetails
        },
        problems: problems,
        attendance: { expected: aExpected, attended: aAttended },
        reporterIds: Array.from(reporterIds)
    };
}

// --- Cron Settings ---

const CRON_JOB_DEFAULTS = [
    { key: 'manager_reminder', label: "Menejer eslatmasi (18:00)", schedule: "Har kuni 18:00", enabled: true },
    { key: 'morning_summary', label: "Kunlik xisobot (09:00)", schedule: "Har kuni 09:00", enabled: true },
    { key: 'lead_monitor', label: "Lead monitor (har soat)", schedule: "Har soatda", enabled: true },
    { key: 'weekly_report', label: "Xaftalik xisobot (Dushanba 09:00)", schedule: "Dushanba 09:00", enabled: true },
    { key: 'monthly_report', label: "Oylik xisobot (1-kunda 09:05)", schedule: "Oyning 1-kuni 09:05", enabled: true },
    { key: 'accountability', label: "Hisobot nazorati (21:00)", schedule: "Har kuni 21:00", enabled: true },
];

async function loadCronSettings() {
    try {
        const rows = db.prepare('SELECT * FROM cron_settings ORDER BY id').all();
        if (rows.length === 0) {
            const result = {};
            CRON_JOB_DEFAULTS.forEach(j => { result[j.key] = { enabled: j.enabled, assignedUsers: [], custom: false }; });
            return result;
        }

        const result = {};
        for (const row of rows) {
            const key = row.job_key;
            const assignedUsers = row.assigned_users ? row.assigned_users.split(',').map(s => s.trim()).filter(Boolean) : [];
            const isCustom = key.startsWith('custom_');
            const entry = { enabled: row.enabled === 1, assignedUsers, custom: isCustom };
            if (isCustom) {
                entry.label = row.label || key;
                entry.cronExpression = row.schedule || '';
                entry.message = row.message || '';
            } else {
                entry.cronExpression = row.schedule || null;
            }
            result[key] = entry;
        }

        CRON_JOB_DEFAULTS.forEach(j => {
            if (!(j.key in result)) result[j.key] = { enabled: j.enabled, assignedUsers: [], custom: false, cronExpression: null };
        });

        return result;
    } catch (e) {
        logger.error('loadCronSettings error:', e);
        const result = {};
        CRON_JOB_DEFAULTS.forEach(j => { result[j.key] = { enabled: j.enabled, assignedUsers: [], custom: false }; });
        return result;
    }
}

async function loadCronSettingsSimple() {
    const full = await loadCronSettings();
    const simple = {};
    for (const [key, val] of Object.entries(full)) simple[key] = val.enabled;
    return simple;
}

async function updateCronSetting(key, enabled) {
    const existing = db.prepare('SELECT id FROM cron_settings WHERE job_key = ?').get(key);
    if (existing) {
        db.prepare('UPDATE cron_settings SET enabled = ? WHERE job_key = ?').run(enabled ? 1 : 0, key);
    } else {
        const job = CRON_JOB_DEFAULTS.find(j => j.key === key);
        db.prepare('INSERT INTO cron_settings (job_key, enabled, label) VALUES (?, ?, ?)').run(key, enabled ? 1 : 0, job ? job.label : key);
    }
}

async function updateCronSettingOverride(key, cronExpression) {
    const existing = db.prepare('SELECT id FROM cron_settings WHERE job_key = ?').get(key);
    if (existing) {
        db.prepare('UPDATE cron_settings SET schedule = ? WHERE job_key = ?').run(cronExpression, key);
    } else {
        const job = CRON_JOB_DEFAULTS.find(j => j.key === key);
        db.prepare('INSERT INTO cron_settings (job_key, enabled, label, schedule) VALUES (?, ?, ?, ?)').run(key, 1, job ? job.label : key, cronExpression);
    }
}

async function updateCronAssignedUsers(key, userIds) {
    const existing = db.prepare('SELECT id FROM cron_settings WHERE job_key = ?').get(key);
    if (existing) {
        db.prepare('UPDATE cron_settings SET assigned_users = ? WHERE job_key = ?').run(userIds.join(','), key);
    } else {
        const job = CRON_JOB_DEFAULTS.find(j => j.key === key);
        db.prepare('INSERT INTO cron_settings (job_key, enabled, label, assigned_users) VALUES (?, ?, ?, ?)').run(key, 1, job ? job.label : key, userIds.join(','));
    }
}

async function addCustomCron(label, cronExpression, message, assignedUsers) {
    const key = 'custom_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    db.prepare('INSERT INTO cron_settings (job_key, enabled, label, assigned_users, schedule, message) VALUES (?, ?, ?, ?, ?, ?)')
        .run(key, 1, label, (assignedUsers || []).join(','), cronExpression, message);
    return key;
}

async function updateCustomCron(key, label, cronExpression, message) {
    if (!key.startsWith('custom_')) return false;
    const result = db.prepare('UPDATE cron_settings SET label = ?, schedule = ?, message = ? WHERE job_key = ?')
        .run(label, cronExpression, message, key);
    return result.changes > 0;
}

async function deleteCustomCron(key) {
    if (!key.startsWith('custom_')) return false;
    const result = db.prepare('DELETE FROM cron_settings WHERE job_key = ?').run(key);
    return result.changes > 0;
}

// --- Qarzdorlar Balance & Log ---

/**
 * Get qarzdorlar balance per month (sum of all debtors entries for each month)
 */
async function getQarzdorlarBalance(month) {
    if (month) {
        month = normalizeMonth(month) || month;
        const row = db.prepare('SELECT COALESCE(SUM(amount), 0) as total, COALESCE(SUM(count), 0) as totalCount FROM debtors WHERE month = ?').get(month);
        return { amount: row.total, count: row.totalCount };
    }
    // Return all months
    const rows = db.prepare('SELECT month, COALESCE(SUM(amount), 0) as total, COALESCE(SUM(count), 0) as totalCount FROM debtors WHERE month != \'\' GROUP BY month').all();
    const result = {};
    for (const r of rows) {
        result[r.month] = { amount: r.total, count: r.totalCount };
    }
    return result;
}

/**
 * Get qarzdorlar log entries for a specific month
 */
async function getQarzdorlarLog(month) {
    if (month) {
        return db.prepare('SELECT * FROM qarzdorlar_log WHERE month = ? ORDER BY id DESC').all(month);
    }
    return db.prepare('SELECT * FROM qarzdorlar_log ORDER BY id DESC').all();
}

/**
 * Update (set) qarzdorlar balance for a month — inserts a correction entry
 */
async function updateQarzdorlarBalance(month, newTotal, userId, newCount = null) {
    userId = String(userId);
    const normMonth = normalizeMonth(month) || month;
    const safeTotal = safeInt(newTotal);

    const now = new Date();
    const timestamp = now.toLocaleString('uz-UZ', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Asia/Tashkent'
    }).replace(',', '');
    const dateYmd = getTashkentDateString();

    const result = db.transaction(() => {
        const row = db.prepare('SELECT COALESCE(SUM(amount), 0) as total, COALESCE(SUM(count), 0) as totalCount FROM debtors WHERE month = ?').get(normMonth);
        const current = { amount: row.total, count: row.totalCount };
        const diff = safeTotal - current.amount;
        const countDiff = newCount !== null ? (safeInt(newCount) - current.count) : 0;
        if (diff === 0 && countDiff === 0) return { changed: false, oldBalance: current.amount, newBalance: safeTotal, oldCount: current.count, newCount: newCount !== null ? safeInt(newCount) : current.count };

        db.prepare('INSERT INTO debtors (timestamp, date_ymd, count, amount, month, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run(timestamp, dateYmd, countDiff, diff, normMonth, userId);

        db.prepare('INSERT INTO qarzdorlar_log (month, date_ymd, change_amount, type, note, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run(normMonth, dateYmd, diff, 'manual_edit', `Qarzdorlik ${current.amount} → ${safeTotal} ga o'zgartirildi`, userId);

        return { changed: true, oldBalance: current.amount, newBalance: safeTotal, oldCount: current.count, newCount: newCount !== null ? safeInt(newCount) : current.count };
    })();

    return result;
}

/**
 * Check if norasmiy deduction would make qarzdorlar negative, return warning info
 */
async function checkQarzdorlarDeduction(month, deductionAmount) {
    month = normalizeMonth(month) || month;
    const current = await getQarzdorlarBalance(month);
    const currentBalance = current.amount;
    const newBalance = currentBalance - deductionAmount;
    return {
        currentBalance,
        currentCount: current.count,
        newBalance,
        wouldBeNegative: newBalance < 0
    };
}


async function deductFromQarzdorlar(month, amount, studentCount, userId) {
    userId = String(userId);
    const now = new Date();
    const timestamp = now.toLocaleString('uz-UZ', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Asia/Tashkent'
    }).replace(',', '');
    const dateYmd = getTashkentDateString();
    const normMonth = normalizeMonth(month) || month;

    db.transaction(() => {
        const row = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM debtors WHERE month = ?').get(normMonth);
        if (row.total - Math.abs(amount) < 0) {
            logger.warn(`Deduction rejected: balance would go negative: current=${row.total}, deducting=${amount}, month=${normMonth}`);
            throw new Error('Balance would go negative');
        }
        db.prepare('INSERT INTO debtors (timestamp, date_ymd, count, amount, month, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run(timestamp, dateYmd, -Math.abs(studentCount), -Math.abs(amount), normMonth, userId);
        db.prepare('INSERT INTO qarzdorlar_log (month, date_ymd, change_amount, type, note, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run(normMonth, dateYmd, -Math.abs(amount), 'norasmiy_deduction', "Norasmiy tushum hisobidan yechildi (" + studentCount + " ta o'quvchi)", userId);
    })();
}

module.exports = {
    getSubjects,
    getAllSubjects,
    addSubject,
    deleteSubject,
    getTodayString,
    getYesterdayString,
    saveDailyReport,
    getEmptyRooms,
    deleteEmptyRoom,
    calculatePotentialIncome,
    loadDynamicSettings,
    loadAuthorizedUsers,
    getAllProblems,
    deleteProblem,
    deleteLeadsBySubject,
    deleteRejectionsBySubject,
    getExpenseTypes,
    addExpenseType,
    deleteExpenseType,
    saveActiveUser,
    removeActiveUser,
    loadActiveUsers,
    getRejectionByMonth,
    getDebtorByMonth,
    getFinanceByMonth,
    getLeadStatus,
    fetchAllData,
    addUser,
    updateUser,
    updateUserLang,
    deleteUser,
    loadCronSettings,
    loadCronSettingsSimple,
    updateCronSetting,
    updateCronSettingOverride,
    updateCronAssignedUsers,
    addCustomCron,
    deleteCustomCron,
    updateCustomCron,
    CRON_JOB_DEFAULTS,
    saveEmptyRoomsSnapshot,
    getEmptyRoomsForDate,
    calculatePotentialIncomeForDate,
    getQarzdorlarBalance,
    getQarzdorlarLog,
    updateQarzdorlarBalance,
    deductFromQarzdorlar,
    checkQarzdorlarDeduction,
    logAudit
};
