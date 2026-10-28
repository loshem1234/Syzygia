// Accumulated knowledge. What the system learns is kept in three tiers:
//   global  (the shared library: rules about Greek itself)
//   corpus  (a profile such as "Iamblichus" or "Neoplatonic prose")
//   book    (this project)
// Safeguards against a bubble: evidence to promote, decay of unused rules,
// a fixed core that never shrinks, open search, and ablation measurement.
import { all, one, q } from '../db/pool.js';
import { COMMON_LEMMAS } from './prefetch.js';
import { config } from '../config.js';

export const PROMOTE_AFTER_VERSES = 3;
export const GLOBAL_AFTER_BOOKS = 2;

export async function markCited({ runId, verseId, chunkIds }) {
  if (!chunkIds.length) return;
  const rows = await all(`UPDATE retrieval_log SET cited = true WHERE run_id = $1 AND verse_id = $2 AND chunk_id = ANY($3::int[]) AND cited = false RETURNING rule_id`, [runId, verseId, chunkIds]);
  const ruleIds = [...new Set(rows.map((r) => r.rule_id).filter(Boolean))];
  if (ruleIds.length) await q('UPDATE prefetch_rules SET cites = cites + 1 WHERE id = ANY($1::int[])', [ruleIds]);
}

function learnableTriggers(triggers) {
  return triggers.filter((t) => t.type !== 'lemma' || !COMMON_LEMMAS.has(t.value))
    .sort((a, b) => ({ term: 0, particle: 1, construction: 2, dialect: 3, lemma: 4 }[a.type] ?? 5) - ({ term: 0, particle: 1, construction: 2, dialect: 3, lemma: 4 }[b.type] ?? 5))
    .slice(0, 6);
}

// After a verse locks: references the agents had to search for, and then cited,
// become candidate book rules; a candidate seen in enough verses goes active.
export async function learnFromVerse({ project, verse, runId, triggers }) {
  const cited = await all(
    `SELECT DISTINCT rl.chunk_id, c.work_id, c.ref FROM retrieval_log rl JOIN reference_chunks c ON c.id = rl.chunk_id
      WHERE rl.run_id = $1 AND rl.verse_id = $2 AND rl.source = 'tool' AND rl.cited = true`, [runId, verse.id]);
  const learned = [];
  for (const c of cited) {
    for (const t of learnableTriggers(triggers)) {
      let rule = await one(
        `SELECT * FROM prefetch_rules WHERE tier = 'book' AND project_id = $1 AND trigger_type = $2 AND trigger_value = $3 AND target_kind = 'ref' AND target_work_id = $4 AND target_ref = $5`,
        [project.id, t.type, t.value, c.work_id, c.ref]);
      if (!rule) {
        rule = await one(
          `INSERT INTO prefetch_rules (tier, project_id, trigger_type, trigger_value, target_kind, target_work_id, target_ref, status, max_chunks, note, books)
           VALUES ('book',$1,$2,$3,'ref',$4,$5,'candidate',1,'Learned: agents searched for this reference and cited it',$6) RETURNING *`,
          [project.id, t.type, t.value, c.work_id, c.ref, [String(project.id)]]);
      }
      const evidence = await one(`SELECT count(DISTINCT rl.verse_id)::int AS n FROM retrieval_log rl JOIN verses v ON v.id = rl.verse_id
          WHERE rl.chunk_id = $1 AND rl.cited = true AND rl.source = 'tool' AND $2 = ANY(rl.triggers)`, [c.chunk_id, `${t.type}:${t.value}`]);
      if (rule.status === 'candidate' && evidence.n >= PROMOTE_AFTER_VERSES) {
        await q(`UPDATE prefetch_rules SET status = 'active', cites = $2, last_used_seq = $3 WHERE id = $1`, [rule.id, evidence.n, verse.seq]);
        learned.push({ ruleId: rule.id, trigger: `${t.type}:${t.value}`, ref: c.ref });
      }
    }
  }
  return learned;
}

// Decay: learned rules that go unused, or are used but never cited, are demoted, then retired.
export async function decay({ project, currentSeq, window = config.limits.decayWindowVerses }) {
  const demoted = await all(
    `UPDATE prefetch_rules SET status = 'demoted'
      WHERE tier <> 'core' AND status = 'active'
        AND ((tier = 'book' AND project_id = $1) OR tier IN ('corpus','global'))
        AND ((last_used_seq < $2::int - $3::int) OR (uses >= 10 AND cites = 0))
      RETURNING id`, [project.id, currentSeq, window]);
  const retired = await all(
    `UPDATE prefetch_rules SET status = 'retired'
      WHERE tier <> 'core' AND status = 'demoted' AND last_used_seq < $2::int - 2 * $3::int
        AND ((tier = 'book' AND project_id = $1) OR tier IN ('corpus','global'))
      RETURNING id`, [project.id, currentSeq, window]);
  await q(`UPDATE prefetch_rules SET status = 'retired' WHERE tier = 'book' AND project_id = $1 AND status = 'candidate' AND created_at < now() - interval '90 days'`, [project.id]);
  return { demoted: demoted.length, retired: retired.length };
}

// At a book's end: what deserves to outlive it. Loshem approves each item.
export async function promotionProposals(project) {
  const ledger = await all(
    `SELECT e.*, (SELECT count(DISTINCT vl.verse_id) FROM verse_lemmas vl JOIN verses v ON v.id = vl.verse_id JOIN chapters ch ON ch.id = v.chapter_id
                   WHERE ch.project_id = $1 AND vl.lemma_key = e.lemma_key AND v.final_rendering IS NOT NULL)::int AS uses
       FROM ledger_entries e WHERE e.tier = 'book' AND e.project_id = $1 AND e.status = 'active'`, [project.id]);
  const style = await all(`SELECT * FROM style_sheet_entries WHERE tier = 'book' AND project_id = $1 AND status = 'active'`, [project.id]);
  const rules = await all(`SELECT r.*, w.short AS work_short FROM prefetch_rules r LEFT JOIN library_works w ON w.id = r.target_work_id
      WHERE r.tier = 'book' AND r.project_id = $1 AND r.status = 'active' AND r.cites >= $2`, [project.id, PROMOTE_AFTER_VERSES]);
  const out = [];
  for (const e of ledger.filter((x) => x.uses >= 3)) out.push({ kind: 'ledger', id: e.id, label: `${e.lemma} → ${e.rendering}`, evidence: `used in ${e.uses} verses`, to: 'corpus' });
  for (const s of style) out.push({ kind: 'style', id: s.id, label: s.rule, evidence: 'held through the book', to: 'corpus' });
  for (const r of rules) {
    const elsewhere = await one(`SELECT count(DISTINCT project_id)::int AS n FROM prefetch_rules WHERE tier = 'book' AND status = 'active' AND trigger_type = $1 AND trigger_value = $2 AND target_work_id = $3 AND target_ref = $4`,
      [r.trigger_type, r.trigger_value, r.target_work_id, r.target_ref]);
    out.push({ kind: 'rule', id: r.id, label: `${r.trigger_type} ${r.trigger_value} → ${r.work_short} ${r.target_ref}`, evidence: `cited ${r.cites} times; useful in ${elsewhere.n} book(s)`, to: elsewhere.n >= GLOBAL_AFTER_BOOKS ? 'global' : 'corpus' });
  }
  return out;
}

export async function promote({ kind, id, to, corpusProfileId }) {
  if (to === 'corpus' && !corpusProfileId) throw new Error('Choose a corpus profile to promote into.');
  if (kind === 'ledger') {
    const e = await one('SELECT * FROM ledger_entries WHERE id = $1', [id]);
    return one(`INSERT INTO ledger_entries (tier, corpus_profile_id, lemma, lemma_key, rendering, alternatives, note, locked, created_by, status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,false,'promotion','suggestion') RETURNING *`,
      [to, to === 'corpus' ? corpusProfileId : null, e.lemma, e.lemma_key, e.rendering, e.alternatives, e.note]);
  }
  if (kind === 'style') {
    const s = await one('SELECT * FROM style_sheet_entries WHERE id = $1', [id]);
    return one(`INSERT INTO style_sheet_entries (tier, corpus_profile_id, rule, status, proposer) VALUES ($1,$2,$3,'active','promotion') RETURNING *`,
      [to, to === 'corpus' ? corpusProfileId : null, s.rule]);
  }
  if (kind === 'rule') {
    const r = await one('SELECT * FROM prefetch_rules WHERE id = $1', [id]);
    return one(`INSERT INTO prefetch_rules (tier, corpus_profile_id, trigger_type, trigger_value, target_kind, target_work_id, target_ref, max_chunks, status, cites, books, note, last_used_seq)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,0) RETURNING *`,
      [to, to === 'corpus' ? corpusProfileId : null, r.trigger_type, r.trigger_value, r.target_kind, r.target_work_id, r.target_ref, r.max_chunks, r.cites, r.books, `Promoted from book ${r.project_id}`]);
  }
  throw new Error(`Unknown kind ${kind}`);
}
