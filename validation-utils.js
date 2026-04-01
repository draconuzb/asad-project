/**
 * Input Validation & Sanitization Utilities
 * Ensures user input is safe before storing
 */

const logger = require('./logger');

/**
 * Sanitize string input
 * Removes potentially dangerous characters
 * @param {*} input - Input to sanitize
 * @param {number} maxLength - Maximum length (default: 500)
 * @returns {string} Sanitized string
 */
function sanitizeString(input, maxLength = 500) {
    if (input === null || input === undefined) return '';
    
    const str = String(input).trim();
    
    // Remove control characters but keep common punctuation
    const sanitized = str.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
    
    // Limit length
    return sanitized.slice(0, maxLength);
}

/**
 * Validate and sanitize number input
 * @param {*} input - Input to validate
 * @param {object} options - { min, max, allowNegative }
 * @returns {number|null} Validated number or null
 */
function sanitizeNumber(input, options = {}) {
    const { min = -Infinity, max = Infinity, allowNegative = true } = options;
    
    try {
        // Remove commas, spaces, currency symbols
        let cleaned = String(input).trim();
        const isNegative = cleaned.startsWith('-');
        cleaned = cleaned.replace(/[^0-9.]/g, '');
        // Keep only the first decimal point
        const dotIdx = cleaned.indexOf('.');
        if (dotIdx !== -1) {
            cleaned = cleaned.slice(0, dotIdx + 1) + cleaned.slice(dotIdx + 1).replace(/\./g, '');
        }
        if (isNegative && allowNegative) cleaned = '-' + cleaned;
        if (!cleaned) return null;

        const num = parseFloat(cleaned);
        if (Number.isNaN(num)) return null;
        
        // Validate range
        if (num < min || num > max) return null;
        if (!allowNegative && num < 0) return null;
        
        return num;
    } catch (e) {
        return null;
    }
}

/**
 * Validate report data before storage
 * @param {string} sectionKey - Section identifier
 * @param {object} reportData - Data to validate
 * @returns {object} Validation result { valid: boolean, errors: string[] }
 */
function validateReportData(sectionKey, reportData) {
    const errors = [];
    
    if (!reportData || typeof reportData !== 'object') {
        errors.push('Report data must be an object');
        return { valid: false, errors };
    }
    
    switch (sectionKey) {
        case 'lead':
        case 'rad_etilganlar':
            if (reportData.entries && Array.isArray(reportData.entries)) {
                for (let i = 0; i < reportData.entries.length; i++) {
                    const entry = reportData.entries[i];
                    if (!entry.subject) errors.push(`Entry ${i}: subject is required`);
                    if (!entry.count && entry.count !== 0) errors.push(`Entry ${i}: count is required`);
                    if (typeof entry.subject !== 'string') errors.push(`Entry ${i}: subject must be string`);
                }
            }
            break;
            
        case 'qarzdorlar':
            if (reportData.count === undefined) errors.push('count is required');
            if (reportData.amount === undefined) errors.push('amount is required');
            if (typeof reportData.count !== 'number') errors.push('count must be number');
            if (typeof reportData.amount !== 'number') errors.push('amount must be number');
            break;
            
        case 'moliya_kirim':
        case 'moliya_kirim_rasmiy':
        case 'moliya_kirim_norasmiy':
            if (reportData.today_income === undefined) errors.push('today_income is required');
            if (typeof reportData.today_income !== 'number') errors.push('today_income must be number');
            break;

        case 'moliya_chiqim':
        case 'moliya_chiqim_rasmiy':
        case 'moliya_chiqim_norasmiy':
            if (reportData.today_expense === undefined) errors.push('today_expense is required');
            break;

        case 'bosh_xonalar':
            if (reportData.entries && Array.isArray(reportData.entries)) {
                for (let i = 0; i < reportData.entries.length; i++) {
                    const entry = reportData.entries[i];
                    if (!entry.branch) errors.push(`Entry ${i}: branch is required`);
                    if (!entry.room) errors.push(`Entry ${i}: room is required`);
                }
            }
            break;

        case 'muammo':
            if (!reportData.branch) errors.push('branch is required');
            if (!reportData.type) errors.push('type is required');
            break;

        case 'davomat':
            if (reportData.expected === undefined) errors.push('expected is required');
            if (reportData.attended === undefined) errors.push('attended is required');
            break;
    }
    
    return { valid: errors.length === 0, errors };
}

/**
 * Sanitize all report data fields
 * @param {object} reportData - Data to sanitize
 * @returns {object} Sanitized data
 */
function sanitizeReportData(reportData) {
    return deepSanitize(reportData);
}

function deepSanitize(value, depth = 0) {
    if (depth > 20) return value;
    if (typeof value === 'string') {
        return sanitizeString(value);
    }
    if (Array.isArray(value)) {
        return value.map(item => deepSanitize(item, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
        const result = {};
        for (const key of Object.keys(value)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            result[key] = deepSanitize(value[key], depth + 1);
        }
        return result;
    }
    return value;
}

/**
 * Validate and sanitize user ID (Telegram ID)
 * @param {*} userId - User ID to validate
 * @returns {string|null} Validated user ID or null
 */
function validateUserId(userId) {
    const cleaned = String(userId).trim();
    
    const safeId = String(userId).slice(0, 30);

    // Telegram IDs are positive integers
    if (!/^\d+$/.test(cleaned)) {
        logger.warn(`Invalid user ID format: ${safeId}`);
        return null;
    }

    const id = parseInt(cleaned, 10);
    if (id < 0) {
        logger.warn(`Invalid user ID (negative): ${safeId}`);
        return null;
    }
    
    return String(id);
}

module.exports = {
    sanitizeString,
    sanitizeNumber,
    validateReportData,
    sanitizeReportData,
    validateUserId
};
