const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB per log file
const MAX_LOG_FILES = 3; // Keep up to 3 rotated copies

/**
 * Lightweight structured logger — adds ISO timestamps and severity levels.
 */
function ts() {
    return new Date().toISOString();
}

/**
 * Rotate a log file if it exceeds MAX_LOG_SIZE.
 * Keeps up to MAX_LOG_FILES old copies (file.1, file.2, ...).
 */
async function rotateIfNeeded(filePath) {
    try {
        const stat = await fs.stat(filePath);
        if (stat.size < MAX_LOG_SIZE) return;
        // Shift old rotations
        for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
            const older = `${filePath}.${i + 1}`;
            const newer = `${filePath}.${i}`;
            try { await fs.rename(newer, older); } catch (_) {}
        }
        await fs.rename(filePath, `${filePath}.1`);
    } catch (_) {
        // File doesn't exist yet or can't stat — no rotation needed
    }
}

/**
 * Centrally managed debug logger for file-based tracing.
 * Uses non-blocking asynchronous I/O with size-based rotation.
 */
async function dlog(filename, location, message, data = {}) {
    try {
        const logDir = path.join(__dirname, 'logs');
        await fs.mkdir(logDir, { recursive: true });

        const filePath = path.join(logDir, filename);
        await rotateIfNeeded(filePath);

        const entry = JSON.stringify({
            timestamp: Date.now(),
            iso: ts(),
            location,
            message,
            data
        }) + '\n';

        await fs.appendFile(filePath, entry);
    } catch (e) {
        // Silently fail to avoid crashing the worker on logging errors
    }
}

module.exports = {
    info: (...args) => console.log(`[${ts()}] [INFO]`, ...args),
    warn: (...args) => console.warn(`[${ts()}] [WARN]`, ...args),
    error: (...args) => console.error(`[${ts()}] [ERROR]`, ...args),
    debug: (...args) => {
        if (process.env.DEBUG === 'true') console.log(`[${ts()}] [DEBUG]`, ...args);
    },
    dlog
};
