const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => '$' + (++idx));
}

const db = {
  exec: async function(sql) {
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      try { await pool.query(stmt); } catch(e) { if (e.code !== '42P07' && e.code !== '42710') console.error('Exec error:', e.message); }
    }
  },

  run: async function(sql, ...params) {
    const converted = convertPlaceholders(sql);
    const result = await pool.query(converted, params);
    return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id || null };
  },

  get: async function(sql, ...params) {
    const converted = convertPlaceholders(sql);
    const result = await pool.query(converted, params);
    return result.rows[0] || undefined;
  },

  all: async function(sql, ...params) {
    const converted = convertPlaceholders(sql);
    const result = await pool.query(converted, params);
    return result.rows;
  }
};

module.exports = db;
