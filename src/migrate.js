'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function run() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] omitida  ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] aplicada ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Fallo la migracion ${file}: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  run()
    .then(() => {
      console.log('[migrate] listo');
      return pool.end();
    })
    .catch((err) => {
      console.error('[migrate]', err.message);
      process.exit(1);
    });
}

module.exports = { run };
