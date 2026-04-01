/**
 * Notification helper
 * Sends alert messages to all users who have the 'reports' section
 */

const logger = require('./logger');

let _bot = null;
let _getUsersRef = null;

function init(bot, getUsersRef) {
    _bot = bot;
    _getUsersRef = getUsersRef;
}

async function notifyReportsUsers(message) {
    if (!_bot || !_getUsersRef) return;
    const users = _getUsersRef();
    const targets = Object.values(users).filter(u => u.sections && u.sections.includes('reports'));
    const safeMessage = message;
    for (const user of targets) {
        try {
            await _bot.telegram.sendMessage(user.id, safeMessage, { parse_mode: 'Markdown' });
        } catch (e) {
            if (e.description && (e.description.includes('forbidden') || e.description.includes('blocked'))) {
                // Silently skip blocked users — this is expected
            } else {
                logger.error(`notify: Failed to send to ${user.id}:`, e.message);
            }
        }
    }
}

module.exports = { init, notifyReportsUsers };
