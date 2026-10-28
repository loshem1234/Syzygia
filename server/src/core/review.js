// The leaderboard and Loshem's corrections. Comparisons are blind; ratings are
// Elo per agent pairing. A manual correction is the strongest signal of all.
import { all, one, q } from '../db/pool.js';
import { ledgerFor } from './ledger.js';

const K = 24;
const expected = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));

export async function pairingOf(kind, id) {
  if (kind === 'reference') {
    const r = await one('SELECT source FROM reference_translations WHERE id = $1', [id]);
    return { key: `reference:${r.source}`, label: `Reference (${r.source})` };
  }
  if (kind === 'manual') return { key: 'manual', label: "Loshem's corrections" };
  const v = await one(`SELECT r.agent_a_version_id AS a, r.agent_b_version_id AS b, r.learned_rules, aa.name AS an, va.model AS am, ab.name AS bn, vb.model AS bm
      FROM verse_versions vv JOIN runs r ON r.id = vv.run_id
      JOIN agent_versions va ON va.id = r.agent_a_version_id JOIN agents aa ON aa.id = va.agent_id
      JOIN agent_versions vb ON vb.id = r.agent_b_version_id JOIN agents ab ON ab.id = vb.agent_id WHERE vv.id = $1`, [id]);
  const suffix = v.learned_rules ? '' : '|learned-off';
  return { key: `a:${v.a}|b:${v.b}${suffix}`, label: `${v.an} (${v.am}) + ${v.bn} (${v.bm})${v.learned_rules ? '' : ' — learned rules off'}` };
}

async function rating(key, label) {
  return (await one('SELECT * FROM pairing_ratings WHERE pairing = $1', [key]))
    || one('INSERT INTO pairing_ratings (pairing, label) VALUES ($1,$2) RETURNING *', [key, label]);
}

export async function recordResult(left, right, winner) {
  const L = await pairingOf(left.kind, left.id);
  const R = await pairingOf(right.kind, right.id);
  if (L.key === R.key) return;
  const a = await rating(L.key, L.label);
  const b = await rating(R.key, R.label);
  const sa = winner === 'left' ? 1 : winner === 'right' ? 0 : 0.5;
  const ea = expected(a.rating, b.rating);
  await q('UPDATE pairing_ratings SET rating = rating + $2, games = games + 1 WHERE id = $1', [a.id, K * (sa - ea)]);
  await q('UPDATE pairing_ratings SET rating = rating + $2, games = games + 1 WHERE id = $1', [b.id, K * ((1 - sa) - (1 - ea))]);
}

// A blind pair for one verse of a benchmark chapter: a run version against the
// reference translation or against another pairing's version. Sides are shuffled.
export async function nextComparison(projectId) {
  const rows = await all(
    `SELECT v.id AS verse_id, v.num, v.source, ch.ord AS chapter, vv.id AS version_id, vv.rendering, rt.id AS ref_id, rt.rendering AS ref_rendering
       FROM verse_versions vv JOIN verses v ON v.id = vv.verse_id JOIN chapters ch ON ch.id = v.chapter_id
       LEFT JOIN reference_translations rt ON rt.chapter_id = ch.id AND rt.verse_num = v.num
      WHERE ch.project_id = $1 AND vv.origin = 'run'
        AND NOT EXISTS (SELECT 1 FROM comparisons c WHERE c.verse_id = v.id AND ((c.left_kind = 'run' AND c.left_id = vv.id) OR (c.right_kind = 'run' AND c.right_id = vv.id)) AND c.winner IS NOT NULL)
      ORDER BY random() LIMIT 40`, [projectId]);
  for (const r of rows) {
    const others = await all(`SELECT id, rendering FROM verse_versions WHERE verse_id = $1 AND origin = 'run' AND id <> $2 ORDER BY random() LIMIT 1`, [r.verse_id, r.version_id]);
    let left = { kind: 'run', id: r.version_id, text: r.rendering };
    let right = r.ref_id ? { kind: 'reference', id: r.ref_id, text: r.ref_rendering } : others[0] ? { kind: 'run', id: others[0].id, text: others[0].rendering } : null;
    if (!right) continue;
    if (Math.random() < 0.5) [left, right] = [right, left];
    const c = await one(`INSERT INTO comparisons (verse_id, left_kind, left_id, right_kind, right_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [r.verse_id, left.kind, left.id, right.kind, right.id]);
    return { comparisonId: c.id, chapter: r.chapter, verse: r.num, greek: r.source, left: left.text, right: right.text };
  }
  return null;
}

export async function judge(comparisonId, winner) {
  const c = await one('SELECT * FROM comparisons WHERE id = $1', [comparisonId]);
  if (!c || c.winner) return null;
  await q('UPDATE comparisons SET winner = $2 WHERE id = $1', [comparisonId, winner]);
  await recordResult({ kind: c.left_kind, id: c.left_id }, { kind: c.right_kind, id: c.right_id }, winner);
  return { ok: true };
}

// Loshem edits a finished verse: a new version, a win over the agents' version,
// and the ledger changes the edit implies, offered for one-click acceptance.
export async function manualEdit(verseId, rendering, note = '') {
  const verse = await one('SELECT v.*, ch.project_id FROM verses v JOIN chapters ch ON ch.id = v.chapter_id WHERE v.id = $1', [verseId]);
  const previous = verse.current_version_id ? await one('SELECT * FROM verse_versions WHERE id = $1', [verse.current_version_id]) : null;
  const version = await one(`INSERT INTO verse_versions (verse_id, origin, status, rendering, note) VALUES ($1,'manual','edited',$2,$3) RETURNING *`, [verseId, rendering, note]);
  await q(`UPDATE verses SET final_rendering = $2, current_version_id = $3, needs_review = false, review_reason = NULL WHERE id = $1`, [verseId, rendering, version.id]);
  if (previous?.origin === 'run') {
    await q(`INSERT INTO comparisons (verse_id, left_kind, left_id, right_kind, right_id, winner) VALUES ($1,'manual',$2,'run',$3,'left')`, [verseId, version.id, previous.id]);
    await recordResult({ kind: 'manual', id: version.id }, { kind: 'run', id: previous.id }, 'left');
  }
  // implied ledger changes: a ledger rendering that was in the old text but not in the new one
  const project = await one('SELECT * FROM projects WHERE id = $1', [verse.project_id]);
  const ledger = await ledgerFor(project);
  const lemmas = new Set((await all('SELECT lemma_key FROM verse_lemmas WHERE verse_id = $1', [verseId])).map((r) => r.lemma_key));
  const low = (s) => (s || '').toLowerCase();
  const implied = ledger.filter((e) => lemmas.has(e.lemma_key) && low(previous?.rendering).includes(low(e.rendering)) && !low(rendering).includes(low(e.rendering)))
    .map((e) => ({ entryId: e.id, lemma: e.lemma, current: e.rendering, message: `Your edit no longer uses "${e.rendering}" for ${e.lemma}. Update the ledger?` }));
  return { version, implied };
}
