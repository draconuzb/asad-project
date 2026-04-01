/**
 * Standalone TWA API entry point for AlwaysData Node.js site.
 * AlwaysData routes edup.alwaysdata.net/twa/api/ here directly.
 * No PHP proxy or Unix socket needed.
 */
require('dotenv').config();
const { Telegraf } = require('telegraf');
const { createTwaApi } = require('./twa_api');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN not set in .env');
    process.exit(1);
}

// Create a Telegraf instance for API calls only (no polling)
const bot = new Telegraf(botToken);

// Create Express app — pass empty object for getAuthorizedUsers (standalone mode)
// Using {} instead of [] so Object.keys/Object.assign in refreshBotUsers works correctly
const app = createTwaApi(bot, botToken, () => ({}));

const host = process.env.IP || '::';
const port = parseInt(process.env.PORT) || 8100;

app.listen(port, host, () => {
    console.log(`TWA API listening on [${host}]:${port}`);
});
