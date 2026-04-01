/**
 * Seed script — populates the database with fake business data
 * Run: node seed_scenario.js
 */
const db = require('./db');

// ─── Helpers ────────────────────────────────────────────────────────────────
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickN(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}
function ts(date, h, m) {
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${ymd(date)} ${hh}:${mm}:00`;
}
function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── Date range: Jan 1 - Mar 25, 2026 ──────────────────────────────────────
const START = new Date(2026, 0, 1);
const END   = new Date(2026, 2, 25);
const allDays = [];
for (let d = new Date(START); d <= END; d.setDate(d.getDate() + 1)) {
  allDays.push(new Date(d));
}

// ─── Begin transaction ─────────────────────────────────────────────────────
const seed = db.transaction(() => {

  // 1. Clear tables
  const clearTables = [
    'leads', 'debtors', 'finance', 'attendance', 'problems',
    'empty_rooms', 'empty_rooms_history', 'rejections', 'qarzdorlar_log'
  ];
  for (const t of clearTables) {
    db.exec(`DELETE FROM ${t}`);
  }
  console.log('Cleared tables:', clearTables.join(', '));

  // 2. Add branches (Yangi bozor=1, Parkent=2 already exist — but table is empty, insert all)
  db.exec(`DELETE FROM branches`);
  db.exec(`DELETE FROM user_branches`);
  const insertBranch = db.prepare(`INSERT INTO branches (id, name) VALUES (?, ?)`);
  const branchList = [
    [1, 'Yangi bozor'],
    [2, 'Parkent'],
    [3, 'Chilonzor'],
    [4, 'Sergeli'],
    [5, "Mirzo Ulug'bek"],
  ];
  for (const [id, name] of branchList) {
    insertBranch.run(id, name);
  }
  console.log('Inserted 5 branches');

  // Branch map for convenience
  const branches = branchList.map(([id, name]) => ({ id, name }));

  // 3. Expense types — keep existing, add missing
  const existingET = db.prepare('SELECT name, category FROM expense_types').all();
  const etSet = new Set(existingET.map(e => `${e.name}|${e.category}`));
  const insertET = db.prepare(`INSERT OR IGNORE INTO expense_types (name, category, created_at) VALUES (?, ?, datetime('now'))`);
  const neededET = [
    ['Oylik', 'Norasmiy'], ['Kanstavar', 'Norasmiy'],
    ['Soliq', 'Norasmiy'], ['Ijara', 'Norasmiy'], ['Kamunal', 'Norasmiy'],
    ['Oylik', 'Rasmiy'], ['Soliq', 'Rasmiy'], ['Ijara', 'Rasmiy'],
    ['Kamunal', 'Rasmiy'], ['Konstovar', 'Rasmiy'],
  ];
  let etCount = 0;
  for (const [name, cat] of neededET) {
    if (!etSet.has(`${name}|${cat}`)) {
      insertET.run(name, cat);
      etCount++;
    }
  }
  console.log(`Added ${etCount} new expense_types (kept existing)`);

  // 4. User-branch assignments
  const insertUB = db.prepare(`INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)`);
  // Asad (CEO) → all 5
  for (const b of branches) insertUB.run('5398436618', b.id);
  // Abduraxmon → 1, 3, 4
  for (const bid of [1, 3, 4]) insertUB.run('5035706309', bid);
  // Ulug'bek → 2, 5
  for (const bid of [2, 5]) insertUB.run('6445905278', bid);
  console.log('Set up user_branches');

  // 5. Read subjects
  const subjects = db.prepare('SELECT name FROM subjects').all().map(r => r.name);
  if (!subjects.length) {
    console.error('No subjects found! Aborting.');
    return;
  }
  console.log(`Found ${subjects.length} subjects`);

  // Branch config
  const branchCfg = {
    1: { leadsMin: 8, leadsMax: 12, manager: '5035706309', expMin: 15, expMax: 25, attMin: 120, attMax: 150, label: 'large' },
    3: { leadsMin: 8, leadsMax: 12, manager: '5035706309', expMin: 20, expMax: 30, attMin: 130, attMax: 160, label: 'large' },
    2: { leadsMin: 5, leadsMax: 8, manager: '6445905278', expMin: 10, expMax: 18, attMin: 80, attMax: 110, label: 'medium' },
    4: { leadsMin: 5, leadsMax: 8, manager: '5035706309', expMin: 10, expMax: 15, attMin: 80, attMax: 110, label: 'medium' },
    5: { leadsMin: 3, leadsMax: 5, manager: '6445905278', expMin: 5, expMax: 10, attMin: 50, attMax: 80, label: 'small' },
  };

  // ── LEADS (~300) ──────────────────────────────────────────────────────────
  const insertLead = db.prepare(
    `INSERT INTO leads (timestamp, date_ymd, subject, count, manager_id, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // Pick ~65% of days
  const leadDays = allDays.filter(() => Math.random() < 0.23);
  let leadCount = 0;
  for (const day of leadDays) {
    for (const b of branches) {
      const cfg = branchCfg[b.id];
      const totalLeads = randInt(cfg.leadsMin, cfg.leadsMax);
      const nSubjects = randInt(2, 4);
      const chosenSubjects = pickN(subjects, nSubjects);
      // Distribute totalLeads across subjects
      let remaining = totalLeads;
      for (let i = 0; i < chosenSubjects.length; i++) {
        const cnt = i === chosenSubjects.length - 1
          ? remaining
          : Math.max(1, randInt(1, Math.ceil(remaining / (chosenSubjects.length - i))));
        remaining -= cnt;
        if (cnt <= 0) continue;
        const h = randInt(9, 18);
        const m = randInt(0, 59);
        const timestamp = ts(day, h, m);
        insertLead.run(timestamp, ymd(day), chosenSubjects[i], cnt, cfg.manager, timestamp, b.id);
        leadCount++;
      }
    }
  }
  console.log(`Inserted ${leadCount} leads`);

  // ── REJECTIONS (~60) ──────────────────────────────────────────────────────
  const insertRej = db.prepare(
    `INSERT INTO rejections (timestamp, date_ymd, subject, count, manager_id, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // Pick ~15% of days across branches
  let rejCount = 0;
  for (const day of allDays) {
    if (Math.random() > 0.25) continue; // ~25% of days
    const dayBranches = branches.filter(() => Math.random() < 0.5); // subset of branches
    for (const b of dayBranches) {
      const cfg = branchCfg[b.id];
      const nSubjects = randInt(1, 2);
      const chosenSubjects = pickN(subjects, nSubjects);
      for (const subj of chosenSubjects) {
        const cnt = randInt(1, 3);
        const h = randInt(9, 18);
        const m = randInt(0, 59);
        const timestamp = ts(day, h, m);
        insertRej.run(timestamp, ymd(day), subj, cnt, cfg.manager, timestamp, b.id);
        rejCount++;
      }
    }
  }
  console.log(`Inserted ${rejCount} rejections`);

  // ── DEBTORS (~45) + qarzdorlar_log ────────────────────────────────────────
  const insertDebtor = db.prepare(
    `INSERT INTO debtors (timestamp, date_ymd, count, amount, month, manager_id, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertQLog = db.prepare(
    `INSERT INTO qarzdorlar_log (month, date_ymd, change_amount, type, note, manager_id, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const months = [
    { label: 'Yanvar 2026', idx: 0, days: [5, 10, 15, 20, 25] },
    { label: 'Fevral 2026', idx: 1, days: [5, 10, 15, 20, 25] },
    { label: 'Mart 2026', idx: 2, days: [5, 10, 15, 20] },
  ];
  const debtorNames = [
    'Alisher', 'Bobur', 'Dilshod', 'Eldor', 'Farrux', 'Gulnora', 'Hamid',
    'Ibrohim', 'Jasur', 'Kamol', 'Laziz', 'Mansur', 'Nodir', 'Otabek',
    'Pulat', 'Ravshan', 'Sardor', 'Tohir', 'Ulmas', 'Vohid', 'Yusuf', 'Zafar',
    'Bekzod', 'Doniyor', 'Firdavs', 'Hurshid', 'Islom', 'Jahongir',
  ];
  let debtorCount = 0;
  let qlogCount = 0;

  for (const mo of months) {
    for (const b of branches) {
      const cfg = branchCfg[b.id];
      let nDebtors, amtMin, amtMax;
      if (cfg.label === 'large') { nDebtors = randInt(2, 4); amtMin = 400000; amtMax = 800000; }
      else if (cfg.label === 'medium') { nDebtors = randInt(1, 3); amtMin = 200000; amtMax = 500000; }
      else { nDebtors = randInt(1, 2); amtMin = 100000; amtMax = 300000; }

      // Positive entries
      const posCount = mo.idx === 0 ? nDebtors : Math.ceil(nDebtors * 0.7);
      for (let i = 0; i < posCount; i++) {
        const dayNum = pick(mo.days);
        const date = new Date(2026, mo.idx, dayNum);
        const amount = randInt(amtMin, amtMax);
        const cnt = randInt(1, 3);
        const h = randInt(9, 17);
        const timestamp = ts(date, h, randInt(0, 59));
        insertDebtor.run(timestamp, ymd(date), cnt, amount, mo.label, cfg.manager, timestamp, b.id);
        debtorCount++;
        // Corresponding log entry
        insertQLog.run(mo.label, ymd(date), amount, 'qarzdor', pick(debtorNames), cfg.manager, timestamp, b.id);
        qlogCount++;
      }

      // Negative entries (repayments) in Feb and March
      if (mo.idx >= 1) {
        const repayCount = randInt(1, 3);
        for (let i = 0; i < repayCount; i++) {
          const dayNum = pick(mo.days);
          const date = new Date(2026, mo.idx, dayNum);
          const amount = -randInt(amtMin, amtMax);
          const h = randInt(9, 17);
          const timestamp = ts(date, h, randInt(0, 59));
          insertDebtor.run(timestamp, ymd(date), 1, amount, mo.label, cfg.manager, timestamp, b.id);
          debtorCount++;
          insertQLog.run(mo.label, ymd(date), amount, "to'lov", pick(debtorNames), cfg.manager, timestamp, b.id);
          qlogCount++;
        }
      }
    }
  }
  console.log(`Inserted ${debtorCount} debtors, ${qlogCount} qarzdorlar_log entries`);

  // ── FINANCE (~120, ALL Norasmiy) ──────────────────────────────────────────
  const insertFin = db.prepare(
    `INSERT INTO finance (timestamp, date_ymd, income, expense, month, expense_type, category, manager_id, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const expenseTypes = ['Oylik', 'Ijara', 'Kamunal', 'Soliq', 'Kanstavar'];
  const expenseWeights = [0.50, 0.20, 0.10, 0.10, 0.10];
  let finCount = 0;

  for (const mo of months) {
    for (const b of branches) {
      const cfg = branchCfg[b.id];
      // Income: split across 3-5 entries per month
      const totalIncome = randInt(cfg.expMin, cfg.expMax) * 1_000_000;
      const incomeEntries = randInt(2, 3);
      let incomeRemaining = totalIncome;

      for (let i = 0; i < incomeEntries; i++) {
        const dayNum = randInt(1, mo.idx === 2 ? 25 : 28);
        const date = new Date(2026, mo.idx, dayNum);
        const amt = i === incomeEntries - 1
          ? incomeRemaining
          : Math.round(incomeRemaining * (Math.random() * 0.4 + 0.1));
        incomeRemaining -= amt;
        const h = randInt(9, 17);
        const timestamp = ts(date, h, randInt(0, 59));
        insertFin.run(timestamp, ymd(date), amt, 0, mo.label, '-', 'Norasmiy', cfg.manager, timestamp, b.id);
        finCount++;
      }

      // Expenses: 60-75% of income, distributed by type weights
      const totalExpense = Math.round(totalIncome * (0.60 + Math.random() * 0.15));
      for (let t = 0; t < expenseTypes.length; t++) {
        const typeAmt = Math.round(totalExpense * expenseWeights[t]);
        // Split each type into 1-2 entries
        const nEntries = randInt(1, 2);
        let rem = typeAmt;
        for (let e = 0; e < nEntries; e++) {
          const dayNum = randInt(1, mo.idx === 2 ? 25 : 28);
          const date = new Date(2026, mo.idx, dayNum);
          const amt = e === nEntries - 1 ? rem : Math.round(rem * (0.4 + Math.random() * 0.3));
          rem -= amt;
          const h = randInt(9, 17);
          const timestamp = ts(date, h, randInt(0, 59));
          insertFin.run(timestamp, ymd(date), 0, amt, mo.label, expenseTypes[t], 'Norasmiy', cfg.manager, timestamp, b.id);
          finCount++;
        }
      }
    }
  }
  console.log(`Inserted ${finCount} finance records`);

  // ── ATTENDANCE (~250) ─────────────────────────────────────────────────────
  const insertAtt = db.prepare(
    `INSERT INTO attendance (timestamp, date_ymd, expected, attended, manager_id, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let attCount = 0;
  for (const day of allDays) {
    const dow = day.getDay(); // 0=Sun, 6=Sat
    if (dow === 0) continue; // Skip Sundays always
    if (dow === 6 && Math.random() < 0.5) continue; // Skip ~50% Saturdays

    for (const b of branches) {
      const cfg = branchCfg[b.id];
      // Skip some days randomly (~25% skip per branch)
      if (Math.random() < 0.25) continue;
      const expected = randInt(cfg.attMin, cfg.attMax);
      const isBadDay = Math.random() < 0.05;
      const rate = isBadDay
        ? (0.60 + Math.random() * 0.10)
        : (0.80 + Math.random() * 0.15);
      const attended = Math.round(expected * rate);
      const h = randInt(17, 19);
      const timestamp = ts(day, h, randInt(0, 59));
      insertAtt.run(timestamp, ymd(day), expected, attended, cfg.manager, timestamp, b.id);
      attCount++;
    }
  }
  console.log(`Inserted ${attCount} attendance records`);

  // ── PROBLEMS (15) ─────────────────────────────────────────────────────────
  const insertProb = db.prepare(
    `INSERT INTO problems (timestamp, date_ymd, branch, type, issue, manager_id, created_at, status, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const problemTypes = ['Texnik', "O'qituvchi", "O'quvchi", 'Boshqa'];
  const problemIssues = [
    'Proyektor ishlamayapti',
    'Internet sekin',
    "O'qituvchi kelmadi",
    'Sinf xonasi sovuq',
    "O'quvchilar shovqin",
    'Kompyuter buzilgan',
    'Elektr muammosi',
    'Konditsioner ishlamayapti',
    'Doska buzilgan',
    "Printer ishlamayapti",
    "O'qituvchi kech keldi",
    "Suv yo'q",
    'Stullar singan',
    'Dars jadvali chalkashgan',
    'Kitoblar yetishmayapti',
  ];
  let probCount = 0;
  for (let i = 0; i < 15; i++) {
    const b = pick(branches);
    const cfg = branchCfg[b.id];
    const day = pick(allDays);
    const h = randInt(9, 17);
    const timestamp = ts(day, h, randInt(0, 59));
    const status = Math.random() < 0.6 ? 'solved' : 'open';
    insertProb.run(
      timestamp, ymd(day), b.name, pick(problemTypes),
      problemIssues[i], cfg.manager, timestamp, status, b.id
    );
    probCount++;
  }
  console.log(`Inserted ${probCount} problems`);

  // ── EMPTY ROOMS (11) ─────────────────────────────────────────────────────
  const insertRoom = db.prepare(
    `INSERT INTO empty_rooms (timestamp, branch, room, days, time, period, manager_id, capacity, price_per_student, date_ymd, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const roomDefs = [
    // Large branches: 2 each
    { bid: 1, rooms: ['101-xona', '203-xona'] },
    { bid: 3, rooms: ['105-xona', '210-xona'] },
    // Medium branches: 2 each
    { bid: 2, rooms: ['102-xona', '204-xona'] },
    { bid: 4, rooms: ['103-xona', '201-xona'] },
    // Small branch: 3
    { bid: 5, rooms: ['104-xona', '202-xona', '301-xona'] },
  ];
  const dayOptions = ['Du-Chor-Ju', 'Se-Pay-Sha'];
  const timeOptions = ['09:00-11:00', '14:00-16:00', '16:00-18:00'];
  const periodOptions = ['Ertalab', 'Kechqurun'];
  let roomCount = 0;
  const today = new Date(2026, 2, 25);
  const todayTs = ts(today, 10, 0);
  const todayYmd = ymd(today);

  for (const rd of roomDefs) {
    const b = branches.find(x => x.id === rd.bid);
    const cfg = branchCfg[rd.bid];
    for (const roomName of rd.rooms) {
      insertRoom.run(
        todayTs, b.name, roomName, pick(dayOptions), pick(timeOptions),
        pick(periodOptions), cfg.manager, randInt(15, 30), randInt(300000, 500000),
        todayYmd, todayTs, b.id
      );
      roomCount++;
    }
  }
  console.log(`Inserted ${roomCount} empty_rooms`);

  // Summary
  console.log('\n--- Seed complete ---');
  console.log(`Branches: 5, Expense types added: ${etCount}`);
  console.log(`Leads: ${leadCount}, Rejections: ${rejCount}`);
  console.log(`Debtors: ${debtorCount}, Qarzdorlar log: ${qlogCount}`);
  console.log(`Finance: ${finCount}, Attendance: ${attCount}`);
  console.log(`Problems: ${probCount}, Empty rooms: ${roomCount}`);
});

seed();
console.log('Done.');
process.exit(0);
