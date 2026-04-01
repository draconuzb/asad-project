/**
 * Graceful Shutdown Handler
 * Ensures clean resource cleanup when bot stops
 */

const logger = require('./logger');

let _cleanupCallbacks = [];
let _isShuttingDown = false;

/**
 * Register a cleanup callback to run during shutdown
 * @param {Function} callback - Async function to run during cleanup
 */
function onShutdown(callback) {
    if (typeof callback === 'function') {
        _cleanupCallbacks.push(callback);
    }
}

/**
 * Execute graceful shutdown
 */
async function gracefulShutdown() {
    if (_isShuttingDown) return;
    _isShuttingDown = true;

    logger.info('🛑 Graceful shutdown initiated...');

    try {
        // Run all cleanup callbacks in reverse order
        for (const callback of [..._cleanupCallbacks].reverse()) {
            try {
                await callback();
            } catch (e) {
                logger.error(`Cleanup callback failed: ${e.message}`);
            }
        }

        logger.info('✅ All resources cleaned up successfully');
        process.exit(0);
    } catch (e) {
        logger.error(`Graceful shutdown failed: ${e.message}`);
        process.exit(1);
    }
}

/**
 * Initialize graceful shutdown handlers
 * Listens to SIGTERM and SIGINT signals
 */
function initShutdownHandlers() {
    // SIGTERM (from container orchestration or process managers)
    process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM signal');
        await gracefulShutdown();
    });

    // SIGINT (from Ctrl+C)
    process.on('SIGINT', async () => {
        logger.info('Received SIGINT signal');
        await gracefulShutdown();
    });

    // Unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
        // Don't exit, just log
    });

    // Uncaught exceptions
    process.on('uncaughtException', (e) => {
        logger.error(`Uncaught Exception: ${e.message}`, e.stack);
        // Try graceful shutdown, but exit anyway in 5 seconds
        gracefulShutdown().catch(() => {
            logger.error('Graceful shutdown failed after exception');
            process.exit(1);
        });
        
        setTimeout(() => {
            logger.error('Forcing shutdown after timeout');
            process.exit(1);
        }, 5000);
    });
}

module.exports = {
    onShutdown,
    gracefulShutdown,
    initShutdownHandlers
};
