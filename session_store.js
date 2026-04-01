/**
 * SQLite-backed session store for Telegraf.
 * Persists sessions across bot restarts.
 */
const db = require('./db');
const logger = require('./logger');

// Create sessions table if not exists.
// Note: updated_at uses SQLite's datetime('now') which returns UTC.
// All session expiry calculations assume UTC timestamps.
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);
`);

const getStmt = db.prepare('SELECT data FROM sessions WHERE key = ?');
const setStmt = db.prepare('INSERT OR REPLACE INTO sessions (key, data, updated_at) VALUES (?, ?, datetime(\'now\'))');
const delStmt = db.prepare('DELETE FROM sessions WHERE key = ?');

// Clean up stale sessions older than 24 hours on load
try {
    const cleaned = db.prepare("DELETE FROM sessions WHERE updated_at < datetime('now', '-24 hours')").run();
    if (cleaned.changes > 0) {
        logger.info(`[SESSION] Cleaned ${cleaned.changes} stale sessions.`);
    }
} catch (e) {
    logger.warn('[SESSION] Failed to clean stale sessions:', e.message);
}

/**
 * Returns a session store compatible with Telegraf's session middleware.
 * Usage: bot.use(session({ store: sqliteSessionStore }))
 */
const sqliteSessionStore = {
    get(key) {
        try {
            const row = getStmt.get(key);
            if (!row) return undefined;
            return JSON.parse(row.data);
        } catch (e) {
            logger.warn(`[SESSION] Failed to read session ${key}:`, e.message);
            return undefined;
        }
    },
    set(key, value) {
        try {
            const serialized = JSON.stringify(value);
            if (serialized.length > 100000) {
                logger.warn(`[SESSION] Value too large for key ${key}: ${serialized.length} bytes, skipping write.`);
                return;
            }
            setStmt.run(key, serialized);
        } catch (e) {
            logger.warn(`[SESSION] Failed to write session ${key}:`, e.message);
        }
    },
    delete(key) {
        try {
            delStmt.run(key);
        } catch (e) {
            logger.warn(`[SESSION] Failed to delete session ${key}:`, e.message);
        }
    }
};


// Periodic session cleanup every 6 hours
const _sessionCleanupInterval = setInterval(() => {
    try {
        const cleaned = db.prepare("DELETE FROM sessions WHERE updated_at < datetime('now', '-24 hours')").run();
        if (cleaned.changes > 0) {
            logger.info(`[SESSION] Periodic cleanup: removed ${cleaned.changes} stale sessions.`);
        }
    } catch (e) {
        logger.warn('[SESSION] Periodic cleanup failed:', e.message);
    }
}, 6 * 60 * 60 * 1000);

sqliteSessionStore._cleanupInterval = _sessionCleanupInterval;
module.exports = sqliteSessionStore;
