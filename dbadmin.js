/**
 * NS-Bot SQLite Admin Panel (Node.js - no dependencies except better-sqlite3)
 * Run: node dbadmin.js
 */
const http = require('http');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const Database = require(path.join(__dirname, 'node_modules/better-sqlite3'));

const crypto = require('crypto');
const DB_PATH = path.join(__dirname, 'data/bot.db');
const PORT = 3001;
const PASSWORD = process.env.DBADMIN_PASSWORD;
if (!PASSWORD) { console.error('[dbadmin] DBADMIN_PASSWORD not set — admin panel login disabled.'); }
const SESSION_MAX_AGE_MS = 3600000; // 1 hour
const sessions = new Map();
const crypto_csrf = require('crypto');
function csrfToken(sessionId) { return crypto_csrf.createHash('sha256').update(sessionId + 'csrf-salt-ns').digest('hex').slice(0, 32); }

function genId() { return crypto.randomBytes(32).toString('hex'); }

// Prune expired sessions every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of sessions.entries()) {
        if (now - data.created > SESSION_MAX_AGE_MS) sessions.delete(id);
    }
}, 600000);
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function parseCookies(req) {
    const obj = {};
    (req.headers.cookie || '').split(';').forEach(c => {
        const [k, v] = c.trim().split('=');
        if (k) obj[k] = v;
    });
    return obj;
}

function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => resolve(querystring.parse(body)));
    });
}

const CSS = `
:root{--bg:#1a1a2e;--card:#16213e;--accent:#e94560;--accent2:#0f3460;--text:#e0e0e0;--text2:#a0a0b0;--border:#0f3460;--success:#4caf50}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);font-size:14px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{display:flex;min-height:100vh}
.sidebar{width:220px;background:var(--card);padding:20px;border-right:1px solid var(--border);position:fixed;height:100vh;overflow-y:auto}
.sidebar h2{color:var(--accent);font-size:18px;margin-bottom:15px}
.sidebar ul{list-style:none}.sidebar li{margin:2px 0}
.sidebar li a{display:block;padding:8px 12px;border-radius:6px;color:var(--text2);transition:.2s}
.sidebar li a:hover,.sidebar li a.active{background:var(--accent2);color:var(--text);text-decoration:none}
.sidebar li a.active{border-left:3px solid var(--accent)}
.main{margin-left:220px;padding:20px;flex:1;min-width:0}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px}
.topbar h1{font-size:20px}
.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:13px;display:inline-block}
.btn-primary{background:var(--accent);color:#fff}.btn-danger{background:#c0392b;color:#fff}
.btn-edit{background:var(--accent2);color:#fff}.btn-sm{padding:5px 10px;font-size:12px}
.btn-logout{background:transparent;color:var(--text2);border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:8px;overflow:hidden;margin-bottom:15px}
th{background:var(--accent2);color:var(--text);padding:10px 12px;text-align:left;font-weight:600;font-size:13px;white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid var(--border);font-size:13px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:hover td{background:rgba(15,52,96,.3)}
.msg{padding:10px 15px;border-radius:6px;margin-bottom:15px;background:#1b5e20;color:#a5d6a7;border:1px solid #2e7d32}
.msg.error{background:#b71c1c33;color:#ef9a9a;border-color:#c62828}
.pagination{display:flex;gap:5px;margin-top:15px;flex-wrap:wrap}
.pagination a,.pagination span{padding:6px 12px;border-radius:4px;background:var(--card);border:1px solid var(--border);color:var(--text2)}
.pagination a:hover{background:var(--accent2);text-decoration:none}.pagination .current{background:var(--accent);color:#fff;border-color:var(--accent)}
.sql-box{width:100%;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:15px;color:var(--text);font-family:'Fira Code',monospace;font-size:14px;resize:vertical;min-height:100px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:20px}
.stat{background:var(--card);padding:15px;border-radius:8px;border:1px solid var(--border)}
.stat .num{font-size:24px;font-weight:700;color:var(--accent)}.stat .label{color:var(--text2);font-size:12px;margin-top:4px}
.edit-form input{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:4px;width:100%;font-size:13px}
.table-count{color:var(--text2);font-size:12px;margin-left:4px}
.login-wrap{display:flex;justify-content:center;align-items:center;height:100vh;background:var(--bg)}
.login{background:var(--card);padding:40px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);text-align:center;color:var(--text)}
.login input{padding:12px;width:250px;border:1px solid var(--accent2);border-radius:6px;margin:10px 0;background:var(--bg);color:var(--text);font-size:16px}
.login button{padding:12px 30px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:16px}
.login h2{color:var(--accent);margin-bottom:20px}
@media(max-width:768px){.sidebar{display:none}.main{margin-left:0}}
`;

function getDb() {
    const db = new Database(DB_PATH, { readonly: false });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    return db;
}

function getTables(db) {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
}

function loginPage(error = '') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>NS-Bot DB Admin</title><style>${CSS}</style></head><body>
    <div class="login-wrap"><div class="login"><h2>NS-Bot DB Admin</h2>
    <form method="post" action="/login"><input type="password" name="password" placeholder="Password" autofocus>
    <br><button type="submit">Login</button></form>
    ${error ? `<p style="color:var(--accent);margin-top:10px">${esc(error)}</p>` : ''}
    </div></div></body></html>`;
}

function layout(title, sidebar, content) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(title)} - NS-Bot DB</title><style>${CSS}</style></head><body>
    <div class="wrap"><div class="sidebar">${sidebar}</div><div class="main">${content}</div></div></body></html>`;
}

function buildSidebar(tables, db, currentTable, action) {
    let s = `<h2>NS-Bot DB</h2><ul>`;
    s += `<li><a href="/" class="${!currentTable && action !== 'sql' ? 'active' : ''}">Overview</a></li>`;
    s += `<li><a href="/sql" class="${action === 'sql' ? 'active' : ''}">SQL Query</a></li>`;
    s += `<li style="margin-top:10px;padding:8px 12px;color:var(--text2);font-size:11px;text-transform:uppercase;letter-spacing:1px">Tables</li>`;
    for (const t of tables) {
        const cnt = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c;
        s += `<li><a href="/table/${encodeURIComponent(t)}" class="${currentTable === t ? 'active' : ''}">${esc(t)} <span class="table-count">(${cnt})</span></a></li>`;
    }
    s += `</ul>`;
    return s;
}

async function handleRequest(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const query = parsed.query;
    const cookies = parseCookies(req);
    const sid = cookies.sid;
    const sessionData = sid ? sessions.get(sid) : null;
    const authed = sessionData && (Date.now() - sessionData.created < SESSION_MAX_AGE_MS);

    // Login
    if (pathname === '/login' && req.method === 'POST') {
        const body = await parseBody(req);
        if (PASSWORD && body.password === PASSWORD) {
            const id = genId();
            sessions.set(id, { created: Date.now() });
            res.writeHead(302, { 'Set-Cookie': `sid=${id}; Path=/; HttpOnly; SameSite=Strict; Secure`, 'Location': '/' });
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(loginPage('Wrong password'));
    }

    if (pathname === '/logout') {
        if (sid) sessions.delete(sid);
        res.writeHead(302, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; Max-Age=0', 'Location': '/' });
        return res.end();
    }

    if (!authed) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(loginPage());
    }

    const db = getDb();
    try {
        const tables = getTables(db);
        let msg = '';

        // POST handlers
        if (req.method === 'POST') {
            const body = await parseBody(req);
            // CSRF validation
            const expectedCsrf = csrfToken(sid);
            if (body._csrf && body._csrf !== expectedCsrf) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                return res.end('CSRF token mismatch');
            }

            // Delete
            if (body.delete_id && body.table_name) {
                if (!tables.includes(body.table_name)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Invalid table'); }
                db.prepare(`DELETE FROM "${body.table_name}" WHERE rowid = ?`).run(parseInt(body.delete_id));
                msg = `Row #${body.delete_id} deleted.`;
                res.writeHead(302, { 'Location': `/table/${encodeURIComponent(body.table_name)}?msg=${encodeURIComponent(msg)}` });
                return res.end();
            }

            // Edit save
            if (body.edit_id && body.table_name) {
                if (!tables.includes(body.table_name)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Invalid table'); }
                const validCols = db.prepare(`PRAGMA table_info("${body.table_name}")`).all().map(c => c.name);
                const sets = [];
                const vals = [];
                for (const [k, v] of Object.entries(body)) {
                    if (k.startsWith('field__')) {
                        const col = k.slice(7);
                        if (!validCols.includes(col)) continue;
                        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) continue; // sanitize column name
                        sets.push(`"${col}" = ?`);
                        vals.push(v);
                    }
                }
                if (sets.length) {
                    vals.push(parseInt(body.edit_id));
                    db.prepare(`UPDATE "${body.table_name}" SET ${sets.join(', ')} WHERE rowid = ?`).run(...vals);
                    msg = `Row #${body.edit_id} updated.`;
                }
                res.writeHead(302, { 'Location': `/table/${encodeURIComponent(body.table_name)}?msg=${encodeURIComponent(msg)}` });
                return res.end();
            }

            // SQL
            if (body.custom_sql !== undefined) {
                const sql = body.custom_sql.trim();
                let sqlResult = '';
                if (sql) {
                    try {
                        if (/^\s*(select|pragma|explain)/i.test(sql)) {
                            const rows = db.prepare(sql).all();
                            if (rows.length) {
                                const cols = Object.keys(rows[0]);
                                sqlResult = `<div class="msg">${rows.length} rows returned.</div><div style="overflow-x:auto"><table><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
                                for (const r of rows) {
                                    sqlResult += `<tr>${cols.map(c => `<td title="${esc(r[c])}">${esc(r[c])}</td>`).join('')}</tr>`;
                                }
                                sqlResult += `</table></div>`;
                            } else {
                                sqlResult = `<div class="msg">0 rows returned.</div>`;
                            }
                        } else {
                            sqlResult = `<div class="msg error">Faqat SELECT/PRAGMA/EXPLAIN so'rovlari ruxsat etiladi. O'zgartirish uchun jadval sahifasidan foydalaning.</div>`;
                        }
                    } catch (e) {
                        sqlResult = `<div class="msg error">Error: ${esc(e.message)}</div>`;
                    }
                }
                const content = `<div class="topbar"><h1>SQL Query</h1><a href="/logout" class="btn btn-logout">Logout</a></div>
                    <form method="post" action="/sql"><textarea name="custom_sql" class="sql-box" placeholder="SELECT * FROM finance LIMIT 10;">${esc(sql)}</textarea>
                    <div style="margin-top:10px"><button type="submit" class="btn btn-primary">Execute</button></div></form>
                    <div style="margin-top:15px">${sqlResult}</div>`;
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end(layout('SQL Query', buildSidebar(tables, db, '', 'sql'), content));
            }
        }

        // GET Routes
        // Overview
        if (pathname === '/' || pathname === '/overview') {
            let stats = '<div class="stats">';
            for (const t of tables) {
                const cnt = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c;
                stats += `<a href="/table/${encodeURIComponent(t)}" style="text-decoration:none"><div class="stat"><div class="num">${cnt.toLocaleString()}</div><div class="label">${esc(t)}</div></div></a>`;
            }
            stats += '</div>';
            const content = `<div class="topbar"><h1>Database Overview</h1><a href="/logout" class="btn btn-logout">Logout</a></div>${stats}`;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(layout('Overview', buildSidebar(tables, db, '', 'overview'), content));
        }

        // SQL page
        if (pathname === '/sql') {
            const content = `<div class="topbar"><h1>SQL Query</h1><a href="/logout" class="btn btn-logout">Logout</a></div>
                <form method="post" action="/sql"><textarea name="custom_sql" class="sql-box" placeholder="SELECT * FROM finance LIMIT 10;"></textarea>
                <div style="margin-top:10px"><button type="submit" class="btn btn-primary">Execute</button></div></form>`;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(layout('SQL Query', buildSidebar(tables, db, '', 'sql'), content));
        }

        // Table browse / edit
        const tableMatch = pathname.match(/^\/table\/([^/]+)(\/edit\/(\d+))?$/);
        if (tableMatch) {
            const tableName = decodeURIComponent(tableMatch[1]);
            if (!tables.includes(tableName)) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('Table not found');
            }

            msg = query.msg || '';

            // Edit form
            if (tableMatch[3]) {
                const rowid = parseInt(tableMatch[3]);
                const row = db.prepare(`SELECT rowid, * FROM "${tableName}" WHERE rowid = ?`).get(rowid);
                if (!row) { res.writeHead(404); return res.end('Row not found'); }
                let form = `<div class="topbar"><h1>Edit ${esc(tableName)} #${rowid}</h1><a href="/logout" class="btn btn-logout">Logout</a></div>`;
                form += `<form method="post" action="/table/${encodeURIComponent(tableName)}"><input type="hidden" name="edit_id" value="${rowid}"><input type="hidden" name="table_name" value="${esc(tableName)}"><table>`;
                for (const [col, val] of Object.entries(row)) {
                    if (col === 'rowid') continue;
                    form += `<tr><th style="width:150px">${esc(col)}</th><td class="edit-form"><input name="field__${esc(col)}" value="${esc(val)}"></td></tr>`;
                }
                form += `</table><div style="margin-top:10px;display:flex;gap:10px"><button type="submit" class="btn btn-primary">Save</button>
                    <a href="/table/${encodeURIComponent(tableName)}" class="btn btn-edit" style="text-align:center">Cancel</a></div></form>`;
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end(layout(`Edit ${tableName}`, buildSidebar(tables, db, tableName, 'browse'), form));
            }

            // Browse
            const page = Math.max(1, parseInt(query.page) || 1);
            const perPage = 50;
            const total = db.prepare(`SELECT COUNT(*) as c FROM "${tableName}"`).get().c;
            const totalPages = Math.max(1, Math.ceil(total / perPage));
            const offset = (page - 1) * perPage;
            const rows = db.prepare(`SELECT rowid, * FROM "${tableName}" ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(perPage, offset);

            let html = `<div class="topbar"><h1>${esc(tableName)}</h1><a href="/logout" class="btn btn-logout">Logout</a></div>`;
            if (msg) html += `<div class="msg">${esc(msg)}</div>`;
            html += `<div style="margin-bottom:10px;color:var(--text2)">${total.toLocaleString()} rows total — Page ${page}/${totalPages}</div>`;

            if (rows.length) {
                const cols = Object.keys(rows[0]);
                html += `<div style="overflow-x:auto"><table><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}<th>Actions</th></tr>`;
                for (const r of rows) {
                    html += `<tr>${cols.map(c => `<td title="${esc(r[c])}">${esc(r[c])}</td>`).join('')}`;
                    html += `<td style="white-space:nowrap">
                        <a href="/table/${encodeURIComponent(tableName)}/edit/${r.rowid}" class="btn btn-edit btn-sm">Edit</a>
                        <form method="post" action="/table/${encodeURIComponent(tableName)}" style="display:inline" onsubmit="return confirm('Delete row #${r.rowid}?')">
                        <input type="hidden" name="delete_id" value="${r.rowid}"><input type="hidden" name="table_name" value="${esc(tableName)}">
                        <button class="btn btn-danger btn-sm">Del</button></form></td></tr>`;
                }
                html += `</table></div>`;
            }

            // Pagination
            if (totalPages > 1) {
                html += `<div class="pagination">`;
                if (page > 1) html += `<a href="/table/${encodeURIComponent(tableName)}?page=${page-1}">Prev</a>`;
                for (let i = Math.max(1, page - 3); i <= Math.min(totalPages, page + 3); i++) {
                    html += i === page ? `<span class="current">${i}</span>` : `<a href="/table/${encodeURIComponent(tableName)}?page=${i}">${i}</a>`;
                }
                if (page < totalPages) html += `<a href="/table/${encodeURIComponent(tableName)}?page=${page+1}">Next</a>`;
                html += `</div>`;
            }

            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(layout(tableName, buildSidebar(tables, db, tableName, 'browse'), html));
        }

        res.writeHead(302, { 'Location': '/' });
        res.end();
    } finally {
        db.close();
    }
}

const server = http.createServer(handleRequest);
server.listen(PORT, '127.0.0.1', () => {
    console.log(`NS-Bot DB Admin running on port ${PORT}`);
});
