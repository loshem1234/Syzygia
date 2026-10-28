// Ledger governance. Agents may refine the ledger, but every change must move
// toward refinement and none can loop:
//  - evidence is required,
//  - the partner must accept the change in the same verse's debate,
//  - Loshem's entries are locked (agent changes are queued for his review),
//  - an entry can never return to a rendering it has held before,
//  - an entry may change at most twice per chapter, then it is frozen.
import { all, one, q } from '../db/pool.js';
import { lookupKey } from './integrity.js';

export const CHANGE_BUDGET_PER_CHAPTER = 2;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function evaluateProposal({ entry, history = [], proposal, acceptedByOther, chapterChangeCount = 0 }) {
  if (!proposal.evidence?.length && !proposal.verses?.length) return { decision: 'refused', reason: 'Evidence is required for a ledger change.' };
  if (!entry) return acceptedByOther ? { decision: 'applied', reason: 'New term accepted by both agents.' } : { decision: 'pending', reason: 'New term awaiting acceptance.' };
  if (norm(entry.rendering) === norm(proposal.rendering)) return { decision: 'refused', reason: 'The ledger already has this rendering.' };
  const past = new Set([entry.rendering, ...history].map(norm));
  if (past.has(norm(proposal.rendering))) return { decision: 'refused', reason: 'No reverting: this entry has held that rendering before.' };
  if (chapterChangeCount >= CHANGE_BUDGET_PER_CHAPTER) return { decision: 'refused', reason: 'Change budget for this chapter is spent; the entry is frozen until the next chapter.', frozen: true };
  if (entry.locked) return { decision: 'pending', reason: "Locked entry: the change is queued for Loshem's review." };
  if (!acceptedByOther) return { decision: 'pending', reason: 'The partner did not accept the change in this verse.' };
  return { decision: 'applied', reason: 'Accepted by both agents with evidence.' };
}

// Entries visible to a project: book entries override corpus, which override global.
export async function ledgerFor(project) {
  const rows = await all(
    `SELECT * FROM ledger_entries
      WHERE (tier = 'book' AND project_id = $1)
         OR (tier = 'corpus' AND corpus_profile_id = $2)
         OR (tier = 'global')
      ORDER BY CASE tier WHEN 'book' THEN 0 WHEN 'corpus' THEN 1 ELSE 2 END, id`, [project.id, project.corpus_profile_id]);
  const byKey = new Map();
  for (const r of rows) if (!byKey.has(r.lemma_key)) byKey.set(r.lemma_key, r);
  return [...byKey.values()].sort((a, b) => a.lemma_key.localeCompare(b.lemma_key));
}

async function historyOf(entryId) {
  return (await all(`SELECT old_rendering FROM ledger_changes WHERE entry_id = $1 AND status IN ('applied','rolled_back') AND old_rendering IS NOT NULL`, [entryId])).map((r) => r.old_rendering);
}

async function changesThisChapter(entryId, chapterId) {
  return (await one(`SELECT count(*)::int AS n FROM ledger_changes WHERE entry_id = $1 AND chapter_id = $2 AND status = 'applied'`, [entryId, chapterId])).n;
}

// Process every ledger proposal made during a verse's debate.
export async function processVerseProposals({ project, chapter, verse, run, turns }) {
  const results = [];
  const responses = new Map();
  for (const t of turns) for (const r of t.payload?.ledger_responses || []) responses.set(r.proposal_id, { ...r, agent: t.agent });
  const book = await ledgerFor(project);
  const seen = new Set();
  for (const t of turns) {
    for (const p of t.payload?.ledger_proposals || []) {
      const key = lookupKey(p.lemma);
      const sig = `${key}|${norm(p.rendering)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      let entry = book.find((e) => e.lemma_key === key) || null;
      // a corpus or global entry is overridden by creating a book entry
      if (entry && entry.tier !== 'book') entry = { ...entry, inherited: true };
      const resp = responses.get(p.id);
      const acceptedByOther = Boolean(resp && resp.agent !== t.agent && resp.accept);
      const history = entry?.id && !entry.inherited ? await historyOf(entry.id) : [];
      const count = entry?.id && !entry.inherited ? await changesThisChapter(entry.id, chapter.id) : 0;
      const verdict = evaluateProposal({ entry, history, proposal: p, acceptedByOther, chapterChangeCount: count });
      let entryId = entry && !entry.inherited ? entry.id : null;
      if (verdict.decision === 'applied') {
        if (!entryId) {
          const created = await one(`INSERT INTO ledger_entries (tier, project_id, lemma, lemma_key, rendering, note, created_by) VALUES ('book',$1,$2,$3,$4,$5,'agent') RETURNING id`,
            [project.id, p.lemma, key, p.rendering, p.note]);
          entryId = created.id;
        } else {
          await q('UPDATE ledger_entries SET rendering = $2 WHERE id = $1', [entryId, p.rendering]);
          // finished verses that use this lemma are flagged for review, never silently re-run
          await q(`UPDATE verses v SET needs_review = true, review_reason = $3
                    FROM verse_lemmas vl, chapters ch
                   WHERE vl.verse_id = v.id AND ch.id = v.chapter_id AND ch.project_id = $1 AND vl.lemma_key = $2
                     AND v.final_rendering IS NOT NULL AND v.id <> $4`,
            [project.id, key, `Ledger changed: ${p.lemma} → ${p.rendering}`, verse.id]);
        }
      }
      await q(`INSERT INTO ledger_changes (entry_id, lemma, old_rendering, new_rendering, proposer, evidence, verse_id, chapter_id, run_id, accepted_by, status, reason)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [entryId, p.lemma, entry?.rendering || null, p.rendering, t.agent, JSON.stringify(p.evidence), verse.id, chapter.id, run.id,
          acceptedByOther ? resp.agent : null, verdict.decision, verdict.reason]);
      if (verdict.decision === 'refused' && verdict.frozen) {
        await q(`INSERT INTO apparatus_notes (verse_id, run_id, kind, agent, text) VALUES ($1,$2,'ledger',$3,$4)`,
          [verse.id, run.id, t.agent, `Proposed rendering of ${p.lemma} as "${p.rendering}" (ledger frozen for this chapter): ${p.note}`]);
      }
      results.push({ proposal: p, ...verdict });
    }
  }
  return results;
}

// Loshem's own actions are not bound by the agent rules.
export async function userUpsert({ projectId, tier = 'book', corpusProfileId = null, lemma, rendering, alternatives = [], note = '', locked = true }) {
  const key = lookupKey(lemma);
  const existing = await one(`SELECT * FROM ledger_entries WHERE lemma_key = $1 AND tier = $2 AND coalesce(project_id,0) = coalesce($3,0) AND coalesce(corpus_profile_id,0) = coalesce($4,0)`, [key, tier, projectId, corpusProfileId]);
  if (existing) {
    if (existing.rendering !== rendering) {
      await q(`INSERT INTO ledger_changes (entry_id, lemma, old_rendering, new_rendering, proposer, status, reason) VALUES ($1,$2,$3,$4,'user','applied','Edited by Loshem')`, [existing.id, lemma, existing.rendering, rendering]);
    }
    return one(`UPDATE ledger_entries SET rendering=$2, alternatives=$3, note=$4, locked=$5, status='active' WHERE id=$1 RETURNING *`, [existing.id, rendering, alternatives, note, locked]);
  }
  return one(`INSERT INTO ledger_entries (tier, project_id, corpus_profile_id, lemma, lemma_key, rendering, alternatives, note, locked, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'user') RETURNING *`,
    [tier, projectId, corpusProfileId, lemma, key, rendering, alternatives, note, locked]);
}

export async function acceptPending(changeId) {
  const ch = await one('SELECT * FROM ledger_changes WHERE id = $1', [changeId]);
  if (!ch || ch.status !== 'pending') return null;
  if (ch.entry_id) await q('UPDATE ledger_entries SET rendering = $2 WHERE id = $1', [ch.entry_id, ch.new_rendering]);
  else {
    const v = await one('SELECT ch.project_id FROM verses v JOIN chapters ch ON ch.id = v.chapter_id WHERE v.id = $1', [ch.verse_id]);
    const e = await one(`INSERT INTO ledger_entries (tier, project_id, lemma, lemma_key, rendering, created_by) VALUES ('book',$1,$2,$3,$4,'agent') RETURNING id`, [v.project_id, ch.lemma, lookupKey(ch.lemma), ch.new_rendering]);
    await q('UPDATE ledger_changes SET entry_id = $2 WHERE id = $1', [changeId, e.id]);
  }
  return one(`UPDATE ledger_changes SET status = 'applied', accepted_by = 'user' WHERE id = $1 RETURNING *`, [changeId]);
}

export async function rollback(changeId) {
  const ch = await one('SELECT * FROM ledger_changes WHERE id = $1', [changeId]);
  if (!ch || ch.status !== 'applied' || !ch.entry_id || ch.old_rendering == null) return null;
  await q('UPDATE ledger_entries SET rendering = $2 WHERE id = $1', [ch.entry_id, ch.old_rendering]);
  return one(`UPDATE ledger_changes SET status = 'rolled_back' WHERE id = $1 RETURNING *`, [changeId]);
}
