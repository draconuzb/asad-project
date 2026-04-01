/**
 * Production-Safe Cleanup Utilities
 * Ensures proper resource cleanup with error handling and logging
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

/**
 * Safely delete a file with error logging
 * @param {string} filePath - Path to file to delete
 * @returns {Promise<boolean>} true if deleted or not found, false on error
 */
async function safeDeleteFile(filePath) {
    if (!filePath) return true;
    try {
        await fs.unlink(filePath);
        logger.info(`[CLEANUP] Deleted: ${filePath}`);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT') {
            // File doesn't exist, that's fine
            return true;
        }
        logger.error(`[CLEANUP] Failed to delete ${filePath}: ${e.message}`);
        return false;
    }
}

/**
 * Safely delete multiple files
 * @param {string[]} filePaths - Array of file paths
 * @returns {Promise<number>} Count of successfully deleted files
 */
async function safeDeleteFiles(filePaths) {
    if (!Array.isArray(filePaths)) return 0;
    
    let deletedCount = 0;
    for (const filePath of filePaths) {
        if (await safeDeleteFile(filePath)) {
            deletedCount++;
        }
    }
    return deletedCount;
}

/**
 * Clean up temporary PDF files in /tmp
 * Removes PDFs older than 1 hour
 * @returns {Promise<number>} Count of deleted files
 */
async function cleanupOldTempFiles() {
    try {
        const tmpDir = '/tmp';
        const files = await fs.readdir(tmpDir);
        const now = Date.now();
        const oneHourMs = 60 * 60 * 1000;
        
        let deletedCount = 0;
        for (const file of files) {
            // Only touch our PDF files
            if (!file.startsWith('report_') && !file.startsWith('ns_export_') && !file.match(/umumiy_report_.*\.pdf$/ )) {
                continue;
            }
            
            try {
                const filePath = path.join(tmpDir, file);
                const stat = await fs.stat(filePath);
                const ageMs = now - stat.mtimeMs;
                
                // Delete if older than 1 hour
                if (ageMs > oneHourMs) {
                    await safeDeleteFile(filePath);
                    deletedCount++;
                }
            } catch (e) {
                // Skip inaccessible files
                continue;
            }
        }
        
        if (deletedCount > 0) {
            logger.info(`[CLEANUP] Removed ${deletedCount} old temporary files`);
        }
        return deletedCount;
    } catch (e) {
        logger.error(`[CLEANUP] Error cleaning temp files: ${e.message}`);
        return 0;
    }
}

/**
 * Schedule regular cleanup of temporary files
 * Runs every 30 minutes
 * @returns {NodeJS.Timer} Interval handle for later cancellation
 */
function scheduleCleanupTask() {
    const intervalHandle = setInterval(async () => {
        try {
            await cleanupOldTempFiles();
        } catch (e) {
            logger.error(`[CLEANUP] Scheduled cleanup failed: ${e.message}`);
        }
    }, 30 * 60 * 1000); // 30 minutes
    
    // Also run immediately on startup
    cleanupOldTempFiles().catch(e => {
        logger.error(`[CLEANUP] Initial cleanup failed: ${e.message}`);
    });
    
    return intervalHandle;
}

module.exports = {
    safeDeleteFile,
    safeDeleteFiles,
    cleanupOldTempFiles,
    scheduleCleanupTask
};
