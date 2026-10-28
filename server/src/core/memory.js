// Book memory: what keeps a translation consistent from chapter 1 to the end.
// Lives in the database and is rebuilt on demand.
import { all, one, q } from '../db/pool.js';
import { lookupKey, greekWords } from './integrity.js';

export async function styleSheetFor(project) {
  return all(
    `SELECT * FROM style_sheet_entries
      WHERE status = 'active'
        AND ((tier = 'book' AND project_id = $1) OR (tier = 'corpus' AND corpus_profile_id = $2) OR tier = 'global')
      ORDER BY CASE tier WHEN 'book' THEN 0 WHEN 'corpus' THEN 1 ELSE 2 END, id`, [project.id, project.corpus_profile_id]);
}

export async function approvedStudyNotes(projectId) {
  return all(`SELECT * FROM study_notes WHERE project_id = $1 AND status = 'approved' ORDER BY id`, [projectId]);
}

// All finished verses of the book, in order, each once. The current verse is excluded.
export async function translationSoFar(project, { excludeVerseId } = {}) {
  return all(
    `SELECT v.id, v.num, v.final_rendering, ch.id AS chapter_id, ch.ord AS chapter, ch.title AS chapter_title
       FROM verses v JOIN chapters ch ON ch.id = v.chapter_id
      WHERE ch.project_id = $1 AND v.final_rendering IS NOT NULL AND v.id <> coalesce($2, -1)
      ORDER BY ch.ord, v.ord`, [project.id, excludeVerseId]);
}

export async function digestsFor(projectId) {
  return all(`SELECT d.*, ch.ord AS chapter FROM chapter_digests d JOIN chapters ch ON ch.id = d.chapter_id WHERE ch.project_id = $1 ORDER BY ch.ord`, [projectId]);
}

// Earlier renderings, anywhere in the book, of verses that share this verse's key lemmas.
export async function concordanceFor({ project, verse, lemmaKeys, limit = 5, skip = new Set() }) {
  const keys = lemmaKeys.filter(Boolean);
  if (!keys.length) return [];
  const rows = await all(
    `SELECT v.id, v.num, v.source, v.final_rendering, ch.ord AS chapter, array_agg(DISTINCT vl.lemma) AS shared, count(DISTINCT vl.lemma_key)::int AS n
       FROM verse_lemmas vl JOIN verses v ON v.id = vl.verse_id JOIN chapters ch ON ch.id = v.chapter_id
      WHERE ch.project_id = $1 AND vl.lemma_key = ANY($2::text[]) AND v.id <> $3 AND v.final_rendering IS NOT NULL
      GROUP BY v.id, ch.ord ORDER BY n DESC, ch.ord, v.ord LIMIT $4`, [project.id, keys, verse.id, limit * 2]);
  return rows.slice(0, limit).map((r) => ({ ...r, inLayer5: skip.has(r.id) }));
}

export async function indexVerseLemmas(verse, parsed) {
  await q('DELETE FROM verse_lemmas WHERE verse_id = $1', [verse.id]);
  for (const t of parsed) {
    const lemmas = t.analyses.length ? [...new Set(t.analyses.map((a) => a.lemma))] : [t.form];
    for (const lemma of lemmas) {
      await q('INSERT INTO verse_lemmas (verse_id, lemma_key, lemma, form) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [verse.id, lookupKey(lemma), lemma, t.form]);
    }
  }
}

export async function lemmaFrequency(projectId) {
  const rows = await all(`SELECT vl.lemma_key, count(*)::int AS n FROM verse_lemmas vl JOIN verses v ON v.id = vl.verse_id JOIN chapters ch ON ch.id = v.chapter_id WHERE ch.project_id = $1 GROUP BY vl.lemma_key`, [projectId]);
  return new Map(rows.map((r) => [r.lemma_key, r.n]));
}

// Quotations: earlier renderings of quoted passages that recur in this verse.
export async function quotationsIn(project, verse) {
  const key = greekWords(verse.source).join(' ');
  const rows = await all(`SELECT * FROM quotations WHERE project_id = $1`, [project.id]);
  return rows.filter((r) => r.greek_key && key.includes(r.greek_key) && r.first_verse_id !== verse.id);
}

export async function recordQuotations(project, verse, quotations, rendering, markedBy = 'agent') {
  for (const qt of quotations) {
    const gk = greekWords(qt.greek).join(' ');
    if (!gk || gk.split(' ').length < 3) continue;
    const exists = await one('SELECT id FROM quotations WHERE project_id = $1 AND greek_key = $2', [project.id, gk]);
    if (!exists) await q('INSERT INTO quotations (project_id, source_ref, greek_key, first_verse_id, rendering, marked_by) VALUES ($1,$2,$3,$4,$5,$6)', [project.id, qt.source, gk, verse.id, rendering, markedBy]);
  }
}

// Detect repeated passages (5+ words) across the work, as quotation candidates.
export function repeatedPassages(verses, n = 5) {
  const seen = new Map();
  const hits = [];
  for (const v of verses) {
    const w = greekWords(v.source);
    for (let i = 0; i + n <= w.length; i++) {
      const g = w.slice(i, i + n).join(' ');
      const prev = seen.get(g);
      if (prev && prev !== v.id) hits.push({ greek: g, first: prev, again: v.id });
      else if (!prev) seen.set(g, v.id);
    }
  }
  return hits;
}

