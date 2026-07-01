const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(path.join(DATA_DIR, 'uploads'))) fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const sqlite = new Database(path.join(DATA_DIR, 'Arcadia.db'));
sqlite.pragma('journal_mode = WAL');

const db = {
  pragma(sql) { sqlite.pragma(sql); },

  exec(sql) { sqlite.exec(sql); },

  run(sql, ...params) {
    const stmt = sqlite.prepare(sql);
    const result = stmt.run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  },

  get(sql, ...params) {
    return sqlite.prepare(sql).get(...params);
  },

  all(sql, ...params) {
    return sqlite.prepare(sql).all(...params);
  }
};

module.exports = db;
