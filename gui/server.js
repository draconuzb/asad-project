const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.argv[2] || path.join(__dirname, '..', 'ns-bot-backups', 'bot.db');
const PORT = 3333;
const AUTH_TOKEN = process.env.GUI_AUTH_TOKEN;
if (!AUTH_TOKEN) { console.error('[GUI] GUI_AUTH_TOKEN not set. GUI server disabled.'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '10mb' }));

// Open database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---- Auth Middleware ----
function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token || token !== AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized. Provide Bearer token or ?token= query param.' });
    }
    next();
}
app.use('/api', requireAuth);

// ---- Table/Column Validation ----
function getValidTables() {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name);
}
function getValidColumns(tableName) {
    return db.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '')}")`).all().map(c => c.name);
}
function isValidTable(name) {
    return getValidTables().includes(name);
}
function isValidColumn(tableName, colName) {
    const cols = db.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '')}")`).all().map(c => c.name);
    return cols.includes(colName);
}

// ---- API ----

// List all tables
app.get('/api/tables', (req, res) => {
    res.json(getValidTables());
});

// Get table schema
app.get('/api/tables/:name/schema', (req, res) => {
    if (!isValidTable(req.params.name)) return res.status(404).json({ error: 'Table not found' });
    try {
        const cols = db.prepare(`PRAGMA table_info("${req.params.name.replace(/"/g, '')}")`).all();
        res.json(cols);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Get all rows from a table
app.get('/api/tables/:name/rows', (req, res) => {
    if (!isValidTable(req.params.name)) return res.status(404).json({ error: 'Table not found' });
    try {
        const rows = db.prepare(`SELECT rowid, * FROM "${req.params.name.replace(/"/g, '')}"`).all();
        res.json(rows);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Update a cell
app.put('/api/tables/:name/rows/:rowid', (req, res) => {
    if (!isValidTable(req.params.name)) return res.status(404).json({ error: 'Table not found' });
    try {
        const { column, value } = req.body;
        if (!isValidColumn(req.params.name, column)) return res.status(400).json({ error: 'Invalid column name' });
        const rowid = parseInt(req.params.rowid);
        if (isNaN(rowid)) return res.status(400).json({ error: 'Invalid rowid' });
        db.prepare(`UPDATE "${req.params.name.replace(/"/g, '')}" SET "${column.replace(/"/g, '')}" = ? WHERE rowid = ?`).run(value, rowid);
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Insert a new row
app.post('/api/tables/:name/rows', (req, res) => {
    if (!isValidTable(req.params.name)) return res.status(404).json({ error: 'Table not found' });
    try {
        const cols = Object.keys(req.body);
        for (const c of cols) {
            if (!isValidColumn(req.params.name, c)) return res.status(400).json({ error: `Invalid column: ${c}` });
        }
        const vals = Object.values(req.body);
        const placeholders = cols.map(() => '?').join(', ');
        const safeCols = cols.map(c => `"${c.replace(/"/g, '')}"`).join(', ');
        const result = db.prepare(`INSERT INTO "${req.params.name.replace(/"/g, '')}" (${safeCols}) VALUES (${placeholders})`).run(...vals);
        res.json({ ok: true, lastInsertRowid: Number(result.lastInsertRowid) });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Delete a row
app.delete('/api/tables/:name/rows/:rowid', (req, res) => {
    if (!isValidTable(req.params.name)) return res.status(404).json({ error: 'Table not found' });
    try {
        const rowid = parseInt(req.params.rowid);
        if (isNaN(rowid)) return res.status(400).json({ error: 'Invalid rowid' });
        db.prepare(`DELETE FROM "${req.params.name.replace(/"/g, '')}" WHERE rowid = ?`).run(rowid);
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Run custom SQL — READ-ONLY
app.post('/api/sql', (req, res) => {
    try {
        const { query } = req.body;
        const lower = query.trim().toLowerCase();
        if (!lower.startsWith('select') && !lower.startsWith('pragma') && !lower.startsWith('explain')) {
            return res.status(403).json({ error: 'Only SELECT/PRAGMA/EXPLAIN queries allowed via API' });
        }
        const rows = db.prepare(query).all();
        res.json({ rows, type: 'select' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ---- Frontend ----
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  📊 NS-Bot Database GUI`);
    console.log(`  ─────────────────────`);
    console.log(`  Database: ${DB_PATH}`);
    console.log(`  Open:     http://localhost:${PORT}`);
    console.log(`  Auth Token: ${AUTH_TOKEN.slice(0, 5)}***\n`);
});
