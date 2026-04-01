/**
 * Warnings Database Module — now backed by main SQLite database
 * Replaces the old JSON file-based storage for warning timestamps.
 */
const db = require('./db');
const logger = require('./logger');

// Prepared statements for performance
const _getStmt = db.prepare('SELECT last_time FROM warnings WHERE key = ?');
const _setStmt = db.prepare('INSERT OR REPLACE INTO warnings (key, last_time) VALUES (?, ?)');

async function getLastWarningTime(key) {
    try {
        const row = _getStmt.get(key);
        return row ? row.last_time : 0;
    } catch (e) {
        logger.error('warningsDb getLastWarningTime error:', e.message);
        return 0;
    }
}

async function setLastWarningTime(key, timestamp) {
    try {
        _setStmt.run(key, timestamp);
    } catch (e) {
        logger.error('warningsDb setLastWarningTime error:', e.message);
    }
}

module.exports = {
    getLastWarningTime,
    setLastWarningTime
};
