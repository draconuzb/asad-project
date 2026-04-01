require('dotenv').config();
const db = require('./db');
const r = db.prepare("DELETE FROM users WHERE name = 'Unknown' AND sec_lead = 0 AND sec_reports = 0 AND sec_moliya = 0 AND sec_qarzdorlar = 0").run();
console.log('Cleaned:', r.changes, 'empty rows');
const c = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
console.log('Remaining:', c.cnt, 'users');
const users = db.prepare('SELECT telegram_id, name FROM users').all();
users.forEach(u => console.log(' ', u.telegram_id, u.name));
