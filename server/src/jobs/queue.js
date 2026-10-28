// A small Postgres-backed job queue. Jobs survive restarts; a job whose worker
// stops heartbeating is picked up again, and the orchestrator resumes it at the
// exact turn where it stopped.
import os from 'node:os';
import { one, q } from '../db/pool.js';

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const handlers = {};

export function registerHandler(kind, fn) { handlers[kind] = fn; }

export async function enqueue(kind, payload = {}) {
  return one(`INSERT INTO jobs (kind, payload) VALUES ($1, $2) RETURNING *`, [kind, JSON.stringify(payload)]);
}

export async function claim() {
  return one(
    `UPDATE jobs SET status = 'running', locked_at = now(), heartbeat_at = now(), locked_by = $1, attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued' OR (status = 'running' AND heartbeat_at < now() - interval '2 minutes')
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`, [WORKER_ID]);
}

export async function processOne() {
  const job = await claim();
  if (!job) return null;
  const beat = setInterval(() => { q('UPDATE jobs SET heartbeat_at = now() WHERE id = $1', [job.id]).catch(() => {}); }, 30000);
  try {
    const fn = handlers[job.kind];
    if (!fn) throw new Error(`No handler for job kind ${job.kind}`);
    await fn(job.payload, job);
    await q(`UPDATE jobs SET status = 'done' WHERE id = $1`, [job.id]);
  } catch (e) {
    await q(`UPDATE jobs SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END, error = $2 WHERE id = $1`, [job.id, String(e.message).slice(0, 2000)]);
    console.error(`[job ${job.id}] ${job.kind} failed:`, e.message);
  } finally {
    clearInterval(beat);
  }
  return job;
}

let running = false;
export function startWorker({ intervalMs = 2000 } = {}) {
  if (running) return;
  running = true;
  const loop = async () => {
    while (running) {
      let job = null;
      try { job = await processOne(); } catch (e) { console.error('[worker]', e.message); }
      if (!job) await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  loop();
  console.log(`[worker] started (${WORKER_ID})`);
}
export function stopWorker() { running = false; }
