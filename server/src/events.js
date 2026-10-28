// Run events travel through Postgres LISTEN/NOTIFY, so the web process sees
// turns produced by a worker in another process, with no extra services.
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { getPool } from './db/pool.js';
import { config } from './config.js';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

export async function emit(event) {
  const payload = JSON.stringify(event);
  // NOTIFY payloads are limited to 8000 bytes; send a pointer for large events.
  const safe = payload.length > 7000 ? JSON.stringify({ ...event, data: undefined, truncated: true }) : payload;
  try { await getPool().query('SELECT pg_notify($1, $2)', ['syzygia_events', safe]); }
  catch { bus.emit('event', event); }
}

let listener;
export async function startListening(url = config.databaseUrl) {
  if (listener) return;
  listener = new pg.Client({ connectionString: url, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
  await listener.connect();
  await listener.query('LISTEN syzygia_events');
  listener.on('notification', (msg) => {
    try { bus.emit('event', JSON.parse(msg.payload)); } catch { /* ignore */ }
  });
}
export async function stopListening() { if (listener) { await listener.end(); listener = undefined; } }
