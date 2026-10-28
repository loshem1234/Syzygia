import pg from 'pg';
import { config } from '../config.js';

let pool;
export function getPool(url = config.databaseUrl) {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 10,
      ssl: /sslmode=require/.test(url) || process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}
export function setPool(p) { pool = p; }
export async function closePool() { if (pool) { await pool.end(); pool = undefined; } }

// Thin query helpers.
export const q = (text, params) => getPool().query(text, params);
export const one = async (text, params) => (await q(text, params)).rows[0] || null;
export const all = async (text, params) => (await q(text, params)).rows;

export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn({
      q: (t, p) => client.query(t, p),
      one: async (t, p) => (await client.query(t, p)).rows[0] || null,
      all: async (t, p) => (await client.query(t, p)).rows,
    });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
