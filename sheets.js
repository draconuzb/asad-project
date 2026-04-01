const { google } = require('googleapis');
const logger = require('./logger');
const path = require('path');
require('dotenv').config();

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

let _cachedAuthClient = null;

async function getAuthClient() {
    if (_cachedAuthClient) return _cachedAuthClient;
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: CREDENTIALS_PATH,
            scopes: SCOPES,
        });
        _cachedAuthClient = await auth.getClient();
        return _cachedAuthClient;
    } catch (e) {
        throw new Error(`Google Auth error: Make sure credentials.json is placed in ${CREDENTIALS_PATH} - Details: ${e.message}`);
    }
}

/**
 * Generic retry helper for Google API calls
 */
async function withRetry(fn, retries = 3, delay = 1000) {
    try {
        return await fn();
    } catch (e) {
        const status = e.code || e.status || (e.response && e.response.status);
        // Don't retry client errors (400, 404) — they won't succeed
        if (status === 400 || status === 404) throw e;
        // Clear cached auth on auth errors to force re-authentication
        if (status === 401 || status === 403) {
            _cachedAuthClient = null;
            logger.warn('Auth error — cleared cached credentials for re-auth');
        }
        if (retries <= 0) throw e;
        logger.warn(`Google API error (${status || 'unknown'}), retrying in ${delay}ms... (Retries left: ${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return withRetry(fn, retries - 1, delay * 2);
    }
}

/**
 * Append a row to a specific Sheet (tab name).
 * @param {string} sheetName - The name of the tab in the Google Spreadsheet
 * @param {Array} valuesArray - An array of strings representing columns in the row
 */
async function appendRow(sheetName, valuesArray, { valueInputOption = 'RAW' } = {}) {
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    return await withRetry(async () => {
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: `${sheetName}!A1`,
            valueInputOption,
            requestBody: {
                values: [valuesArray],
            },
        });
        invalidateCache(sheetName);
        return true;
    });
}

/**
 * Append multiple rows in a single batch call.
 * @param {string} sheetName 
 * @param {Array<Array>} rowsArray 
 */
async function appendRowsBatch(sheetName, rowsArray) {
    if (!rowsArray || rowsArray.length === 0) return true;
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    return await withRetry(async () => {
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: `${sheetName}!A1`,
            valueInputOption: 'RAW',
            requestBody: {
                values: rowsArray,
            },
        });
        invalidateCache(sheetName);
        return true;
    });
}

/**
 * Get all rows from a specific Sheet (tab name).
 * Uses a TTL cache to avoid excessive Google API calls during report generation.
 */
const _rowsCache = {};
const CACHE_TTL = 30000; // 30 seconds

async function getRows(sheetName) {
    const now = Date.now();
    const cached = _rowsCache[sheetName];
    if (cached && now - cached.ts < CACHE_TTL) {
        // Return deep copy to prevent callers from mutating cached data
        return JSON.parse(JSON.stringify(cached.data));
    }

    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    return await withRetry(async () => {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: `${sheetName}`,
        });
        const data = res.data.values || [];
        _rowsCache[sheetName] = { data, ts: Date.now() };
        return data;
    });
}

/**
 * Invalidate cache for a specific sheet or all sheets.
 * Call this after writes to ensure fresh reads.
 */
function invalidateCache(sheetName) {
    if (sheetName) {
        delete _rowsCache[sheetName];
    } else {
        for (const key of Object.keys(_rowsCache)) {
            delete _rowsCache[key];
        }
    }
}

/**
 * Delete a specific row by its 0-based index.
 */
async function deleteRow(sheetName, rowIndex) {
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    return await withRetry(async () => {
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        });
        const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetName);
        if (!sheet) return false;

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            requestBody: {
                requests: [
                    {
                        deleteDimension: {
                            range: {
                                sheetId: sheet.properties.sheetId,
                                dimension: "ROWS",
                                startIndex: rowIndex,
                                endIndex: rowIndex + 1
                            }
                        }
                    }
                ]
            }
        });
        invalidateCache(sheetName);
        return true;
    });
}

/**
 * Delete multiple rows by their 0-based indices in a single API call.
 * Automatically sorts indices descending to prevent index shifting during deletion.
 */
async function deleteRowsBatch(sheetName, rowIndices) {
    if (!rowIndices || rowIndices.length === 0) return true;

    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    return await withRetry(async () => {
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        });
        const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetName);
        if (!sheet) return false;

        // Sort descending: delete from bottom to top so lower indices don't shift
        const sortedIndices = [...rowIndices].sort((a, b) => b - a);

        const requests = sortedIndices.map(index => ({
            deleteDimension: {
                range: {
                    sheetId: sheet.properties.sheetId,
                    dimension: "ROWS",
                    startIndex: index,
                    endIndex: index + 1
                }
            }
        }));

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            requestBody: { requests }
        });
        invalidateCache(sheetName);
        return true;
    });
}

/**
 * Update a specific row (e.g. for header initialization)
 */
async function updateRow(sheetName, rowIndex, valuesArray, { valueInputOption = 'RAW' } = {}) {
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    return await withRetry(async () => {
        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: `${sheetName}!A${rowIndex + 1}`,
            valueInputOption,
            requestBody: {
                values: [valuesArray],
            },
        });
        invalidateCache(sheetName);
        return true;
    });
}

/**
 * Create a new sheet (tab) if it doesn't exist
 */
async function createSheet(sheetName) {
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    return await withRetry(async () => {
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        });
        const sheetExists = spreadsheet.data.sheets.some(s => s.properties.title === sheetName);
        if (sheetExists) return true;

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            requestBody: {
                requests: [{ addSheet: { properties: { title: sheetName } } }]
            }
        });
        return true;
    });
}

/**
 * Clears sheet data starting from row 2 to preserve headers
 * @param {string} sheetName - The name of the tab in the Google Spreadsheet
 */
async function clearSheetData(sheetName) {
    const authClient = await getAuthClient();
    const sheetsAPI = google.sheets({ version: 'v4', auth: authClient });

    return await withRetry(async () => {
        await sheetsAPI.spreadsheets.values.clear({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: `${sheetName}!A2:ZZ`,
        });
        invalidateCache(sheetName);
        return true;
    });
}

module.exports = {
    appendRow,
    appendRowsBatch,
    getRows,
    deleteRow,
    deleteRowsBatch,
    updateRow,
    createSheet,
    invalidateCache,
    clearSheetData
};
