/**
 * Startup Configuration Validator
 * Ensures all required settings and files are in place before starting the bot.
 * Run this on bot startup to catch errors early.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const requiredEnvVars = {
    'TELEGRAM_BOT_TOKEN': 'Telegram bot token from @BotFather',
    'CEO_TELEGRAM_ID': 'CEO Telegram ID for reports',
};

const optionalEnvVars = {
    'GEMINI_API_KEY': 'Google Gemini AI API key (AI features disabled if missing)',
    'MANAGER_ID': 'Manager Telegram ID for notifications',
    'DEBUG': 'Enable debug logging (true/false)',
    'GEMINI_MODEL': 'Gemini model name (default: gemini-2.0-flash)',
};

const requiredFiles = [
    'constants.js',
    'storage.js',
    'db.js',
    'questions.js',
    'i18n.js',
    'utils.js',
    'notify.js',
    'fonts/Roboto-Regular.ttf',
    'fonts/Roboto-Bold.ttf',
];

/**
 * Validate environment variables
 */
function validateEnvVars() {
    const errors = [];
    const warnings = [];

    // Check required vars
    for (const [key, description] of Object.entries(requiredEnvVars)) {
        if (!process.env[key]) {
            errors.push(`❌ Missing required env var: ${key} (${description})`);
        }
    }

    // Check optional vars
    for (const [key, description] of Object.entries(optionalEnvVars)) {
        if (!process.env[key]) {
            warnings.push(`⚠️  Optional env var not set: ${key} (${description})`);
        }
    }

    return { errors, warnings };
}

/**
 * Validate required files exist
 */
function validateFiles() {
    const errors = [];

    for (const file of requiredFiles) {
        const filePath = path.join(__dirname, file);
        if (!fs.existsSync(filePath)) {
            errors.push(`❌ Missing required file: ${file}`);
        }
    }

    return errors;
}



/**
 * Run all validations
 * @returns {boolean} true if all validations pass
 */
function validateStartup() {
    logger.info('========================================');
    logger.info('🔍 STARTUP CONFIGURATION VALIDATION');
    logger.info('========================================');

    let allValid = true;

    // Check files
    logger.info('Checking required files...');
    const fileErrors = validateFiles();
    if (fileErrors.length > 0) {
        fileErrors.forEach(err => logger.error(err));
        allValid = false;
    } else {
        logger.info('✅ All required files present');
    }


    // Check environment variables
    logger.info('Checking environment variables...');
    const { errors: envErrors, warnings: envWarnings } = validateEnvVars();
    if (envErrors.length > 0) {
        envErrors.forEach(err => logger.error(err));
        allValid = false;
    } else {
        logger.info('✅ All required environment variables set');
    }
    if (envWarnings.length > 0) {
        envWarnings.forEach(warn => logger.warn(warn));
    }



    if (!allValid) {
        logger.error('\n❌ VALIDATION FAILED - Fix errors above before starting the bot');
        logger.info('\n📋 Setup Instructions:');
        logger.info('  1. Copy .env.example to .env');
        logger.info('  2. Fill in all required environment variables');
        logger.info('  3. Place credentials.json in project root');
        logger.info('  4. See README.md for detailed setup instructions');
        logger.info('========================================');
        return false;
    }

    logger.info('\n✅ All validations passed! Bot is ready to start.');
    logger.info('========================================');
    return true;
}

module.exports = {
    validateStartup,
    validateEnvVars,
    validateFiles
};
