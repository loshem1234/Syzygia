// Retrieval over the shared library. Three indexes work together:
//  1. structured: headwords and section numbers (exact),
//  2. full text over the accent-insensitive lookup copy (Postgres FTS),
//  3. semantic embeddings, when an embeddings provider is configured,
// merged with reciprocal rank fusion. Evaluation-only works are never returned.
import { all, one } from '../db/pool.js';
import { lookupKey } from './integrity.js';
import { refKey } from '../library/ingest.js';
import { embed } from '../providers/index.js';
import { config } from '../config.js';

// Works an agent may see: shared, its own private files, the project's dialect modules.
export async function visibleWorks({ agentId = null, dialects = [] } = {}) {
  return all(
    `SELECT * FROM library_works
      WHERE scope = 'shared'
         OR (scope = 'agent' AND agent_id = $1)
         OR (scope = 'dialect' AND (dialect = ANY($2::text[]) OR dialect IS NULL))
      ORDER BY id`, [agentId, dialects]);
}

export async function findWork(name, works) {
  const k = lookupKey(name || '').replace(/[^\p{L}\p{N}]/gu, '');
  if (!k) return null;
  const pool = works || await all(`SELECT * FROM library_works WHERE scope <> 'evaluation'`);
  return pool.find((w) => lookupKey(w.short).replace(/[^\p{L}\p{N}]/gu, '') === k)
    || pool.find((w) => lookupKey(w.title).replace(/[^\p{L}\p{N}]/gu, '') === k)
    || pool.find((w) => lookupKey(w.title).replace(/[^\p{L}\p{N}]/gu, '').includes(k) || k.includes(lookupKey(w.short).replace(/[^\p{L}\p{N}]/gu, '')))
    || null;
}

const withWork = `SELECT c.*, w.short AS work_short, w.title AS work_title, w.kind AS work_kind FROM reference_chunks c JOIN library_works w ON w.id = c.work_id`;

export async function byRef(workId, ref) {
  const k = refKey(ref);
  return (await one(`${withWork} WHERE c.work_id = $1 AND c.ref_key = $2 ORDER BY c.ord LIMIT 1`, [workId, k]))
    || one(`${withWork} WHERE c.work_id = $1 AND $2 = ANY(c.lemma_keys) ORDER BY c.ord LIMIT 1`, [workId, k]);
}

export async function byHeadword(lemmaKey, workIds, limit = 1) {
  if (!workIds.length) return [];
  return all(`${withWork} WHERE c.work_id = ANY($1::int[]) AND ($2 = ANY(c.lemma_keys) OR c.ref_key = $2) ORDER BY c.work_id, c.ord LIMIT $3`, [workIds, lemmaKey, limit * Math.max(1, workIds.length)]);
}

export async function search(query, { workIds, limit = 5 } = {}) {
  if (!workIds?.length || !query?.trim()) return [];
  const q = lookupKey(query);
  const ranked = [];

  // 1. structured
  const sec = q.match(/^(?:§\s*)?(\d{1,4}[a-z]?)$/);
  const structured = await all(
    `${withWork} WHERE c.work_id = ANY($1::int[]) AND (c.ref_key = $2 OR $2 = ANY(c.lemma_keys)) ORDER BY c.ord LIMIT 10`,
    [workIds, sec ? sec[1] : q.trim()]);
  ranked.push(structured);

  // 2. full text
  const terms = q.split(/\s+/).filter((t) => t.length > 1).map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (terms.length) {
    const fts = await all(
      `${withWork}, to_tsquery('simple', $2) query
        WHERE c.work_id = ANY($1::int[]) AND to_tsvector('simple', c.search_key) @@ query
        ORDER BY ts_rank(to_tsvector('simple', c.search_key), query) DESC LIMIT 20`,
      [workIds, terms.join(' & ')]).catch(() => []);
    ranked.push(fts.length ? fts : await all(
      `${withWork}, to_tsquery('simple', $2) query
        WHERE c.work_id = ANY($1::int[]) AND to_tsvector('simple', c.search_key) @@ query
        ORDER BY ts_rank(to_tsvector('simple', c.search_key), query) DESC LIMIT 20`,
      [workIds, terms.join(' | ')]).catch(() => []));
  }

  // 3. semantic
  if (config.embeddings.provider) {
    try {
      const [qv] = await embed([query]);
      if (qv) {
        const cands = await all(`${withWork} WHERE c.work_id = ANY($1::int[]) AND c.embedding IS NOT NULL`, [workIds]);
        ranked.push(cands.map((c) => ({ ...c, _score: cosine(qv, c.embedding) })).sort((a, b) => b._score - a._score).slice(0, 20));
      }
    } catch { /* semantic search is optional */ }
  }
  return fuse(ranked, limit);
}

export function fuse(lists, limit) {
  const score = new Map();
  const keep = new Map();
  for (const list of lists) {
    list.forEach((c, i) => {
      score.set(c.id, (score.get(c.id) || 0) + 1 / (60 + i));
      keep.set(c.id, c);
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => keep.get(id));
}

export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

export function citationOf(chunk) {
  return `${chunk.work_short} ${/^\d/.test(chunk.ref) ? '§' : ''}${chunk.ref}`;
}
