// Acceptance 8  — Ledger governance: a locked entry cannot change; a revert is
//                  refused; the third change in a chapter is refused.
// Acceptance 10 — Learning tiers: a promoted rule appears in a new book as a
//                  suggestion; an unused rule decays; the core never does.
// Acceptance 11 — Resume: killing the worker mid-verse and restarting resumes
//                  at the exact turn.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, teardown, mockProvider, useProviders, useMorph, makeAgents, makeRun, reply, all, one, q } from './helpers.js';
import { importChapter } from '../src/core/importer.js';
import { runChapter } from '../src/jobs/runChapter.js';
import { evaluateProposal, processVerseProposals, userUpsert, ledgerFor } from '../src/core/ledger.js';
import { learnFromVerse, decay, promotionProposals, promote } from '../src/core/learning.js';
import { lookupKey } from '../src/core/integrity.js';
import { enqueue, processOne, registerHandler } from '../src/jobs/queue.js';

before(async () => { await freshDb('governance'); useMorph({}); });
after(teardown);

test('ledger rules, evaluated', () => {
  const entry = { rendering: 'Intellect', locked: false };
  const ev = [{ type: 'text', note: 'x' }];
  assert.equal(evaluateProposal({ entry, proposal: { rendering: 'Mind' }, acceptedByOther: true }).decision, 'refused', 'evidence required');
  assert.equal(evaluateProposal({ entry: { ...entry, locked: true }, proposal: { rendering: 'Mind', evidence: ev }, acceptedByOther: true }).decision, 'pending', 'locked entries never change by agent action');
  assert.equal(evaluateProposal({ entry, history: ['Mind'], proposal: { rendering: 'mind', evidence: ev }, acceptedByOther: true }).decision, 'refused', 'no reverting');
  assert.equal(evaluateProposal({ entry, proposal: { rendering: 'Nous', evidence: ev }, acceptedByOther: true, chapterChangeCount: 2 }).decision, 'refused', 'third change refused');
  assert.equal(evaluateProposal({ entry, proposal: { rendering: 'Nous', evidence: ev }, acceptedByOther: false }).decision, 'pending', 'partner must accept');
  assert.equal(evaluateProposal({ entry, proposal: { rendering: 'Nous', evidence: ev }, acceptedByOther: true }).decision, 'applied');
});

test('ledger governance in the database', async () => {
  const project = await one(`INSERT INTO projects (title) VALUES ('Ledger') RETURNING *`);
  const { chapter } = await importChapter(project.id, { title: 'One', raw: '1 ὁ λόγος\n2 ὁ λόγος αὖθις\n3 ψυχή\n' });
  const verses = await all('SELECT * FROM verses WHERE chapter_id = $1 ORDER BY ord', [chapter.id]);
  for (const v of verses) await q(`INSERT INTO verse_lemmas (verse_id, lemma_key, lemma, form) VALUES ($1,'λογοσ','λόγος','λόγος')`, [v.id]);
  await q(`UPDATE verses SET final_rendering = 'done' WHERE id = $1`, [verses[0].id]);
  const agents = await makeAgents();
  const run = await makeRun(chapter.id, agents);
  await userUpsert({ projectId: project.id, lemma: 'ψυχή', rendering: 'soul', locked: true });
  const agentEntry = await one(`INSERT INTO ledger_entries (tier, project_id, lemma, lemma_key, rendering, created_by) VALUES ('book',$1,'λόγος',$2,'reason','agent') RETURNING *`, [project.id, lookupKey('λόγος')]);
  const ev = [{ type: 'text', note: 'context' }];
  const turnsWith = (lemma, rendering) => [
    { agent: 'A', payload: { ledger_proposals: [{ id: 'A2-L1', lemma, rendering, evidence: ev, verses: ['2'] }] } },
    { agent: 'B', payload: { ledger_responses: [{ proposal_id: 'A2-L1', accept: true }] } },
  ];

  // locked entry: queued for Loshem, unchanged
  let r = await processVerseProposals({ project, chapter, verse: verses[2], run, turns: turnsWith('ψυχή', 'life') });
  assert.equal(r[0].decision, 'pending');
  assert.equal((await one(`SELECT rendering FROM ledger_entries WHERE lemma_key = $1 AND project_id = $2`, [lookupKey('ψυχή'), project.id])).rendering, 'soul');

  // first change applied; finished verses using the lemma are flagged for review
  r = await processVerseProposals({ project, chapter, verse: verses[1], run, turns: turnsWith('λόγος', 'account') });
  assert.equal(r[0].decision, 'applied');
  assert.equal((await one('SELECT needs_review FROM verses WHERE id = $1', [verses[0].id])).needs_review, true);
  // reverting is refused
  r = await processVerseProposals({ project, chapter, verse: verses[1], run, turns: turnsWith('λόγος', 'reason') });
  assert.match(r[0].reason, /No reverting/);
  // second change applied, third refused and frozen into the apparatus
  r = await processVerseProposals({ project, chapter, verse: verses[1], run, turns: turnsWith('λόγος', 'discourse') });
  assert.equal(r[0].decision, 'applied');
  r = await processVerseProposals({ project, chapter, verse: verses[1], run, turns: turnsWith('λόγος', 'speech') });
  assert.equal(r[0].decision, 'refused');
  assert.ok(r[0].frozen);
  assert.equal((await one('SELECT rendering FROM ledger_entries WHERE id = $1', [agentEntry.id])).rendering, 'discourse');
  assert.ok(await one(`SELECT 1 FROM apparatus_notes WHERE verse_id = $1 AND kind = 'ledger' AND text LIKE '%speech%'`, [verses[1].id]));
});

test('learning tiers: promotion, suggestion in a new book, decay, a fixed core', async () => {
  const corpus = await one(`INSERT INTO corpus_profiles (name) VALUES ('Iamblichus') RETURNING *`);
  const book1 = await one(`INSERT INTO projects (title, corpus_profile_id) VALUES ('Book one', $1) RETURNING *`, [corpus.id]);
  const { chapter } = await importChapter(book1.id, { title: 'One', raw: '1 μὲν οὖν α\n2 μὲν οὖν β\n3 μὲν οὖν γ\n4 νοῦς\n' });
  const verses = await all('SELECT * FROM verses WHERE chapter_id = $1 ORDER BY ord', [chapter.id]);
  const agents = await makeAgents();
  const run = await makeRun(chapter.id, agents);
  const w = await one(`INSERT INTO library_works (title, short, kind) VALUES ('Particles', 'Denniston', 'particles') RETURNING *`);
  const chunk = await one(`INSERT INTO reference_chunks (work_id, ord, ref, ref_key, text, search_key, lemma_keys) VALUES ($1,1,'μὲν οὖν','μεν ουν','μὲν οὖν, corrective','μεν ουν corrective','{}') RETURNING *`, [w.id]);
  const triggers = [{ type: 'particle', value: 'μεν ουν' }];
  let learned = [];
  for (const v of verses.slice(0, 3)) {
    await q(`INSERT INTO retrieval_log (run_id, verse_id, phase, agent, source, chunk_id, query, triggers, cited) VALUES ($1,$2,'B1','B','tool',$3,'search μὲν οὖν',$4,true)`, [run.id, v.id, chunk.id, ['particle:μεν ουν']]);
    learned = await learnFromVerse({ project: book1, verse: v, runId: run.id, triggers });
  }
  assert.equal(learned.length, 1, 'searched and cited in three verses: the rule goes active');
  const rule = await one(`SELECT * FROM prefetch_rules WHERE tier = 'book' AND project_id = $1 AND status = 'active'`, [book1.id]);
  assert.equal(rule.target_ref, 'μὲν οὖν');

  await q(`INSERT INTO ledger_entries (tier, project_id, lemma, lemma_key, rendering) VALUES ('book',$1,'νοῦς','νουσ','Intellect')`, [book1.id]);
  for (const v of verses) { await q(`INSERT INTO verse_lemmas VALUES ($1,'νουσ','νοῦς','νοῦς') ON CONFLICT DO NOTHING`, [v.id]); await q(`UPDATE verses SET final_rendering = 'x' WHERE id = $1`, [v.id]); }
  const proposals = await promotionProposals(book1);
  const lp = proposals.find((p) => p.kind === 'ledger');
  const rp = proposals.find((p) => p.kind === 'rule');
  assert.ok(lp && rp);
  await promote({ kind: 'ledger', id: lp.id, to: 'corpus', corpusProfileId: corpus.id });
  await promote({ kind: 'rule', id: rp.id, to: 'corpus', corpusProfileId: corpus.id });

  const book2 = await one(`INSERT INTO projects (title, corpus_profile_id) VALUES ('Book two', $1) RETURNING *`, [corpus.id]);
  const inherited = (await ledgerFor(book2)).find((e) => e.lemma_key === 'νουσ');
  assert.equal(inherited.status, 'suggestion', 'arrives as a suggestion, not a ruling');
  assert.equal(inherited.locked, false);
  assert.ok(await one(`SELECT 1 FROM prefetch_rules WHERE tier = 'corpus' AND corpus_profile_id = $1 AND status = 'active'`, [corpus.id]));

  // decay: an unused learned rule is demoted, then retired; the core is untouched
  await q(`UPDATE prefetch_rules SET last_used_seq = 1 WHERE id = $1`, [rule.id]);
  await decay({ project: book1, currentSeq: 1000, window: 100 });
  assert.equal((await one('SELECT status FROM prefetch_rules WHERE id = $1', [rule.id])).status, 'retired');
  const core = await all(`SELECT status FROM prefetch_rules WHERE tier = 'core'`);
  assert.ok(core.length >= 5 && core.every((c) => c.status === 'active'));
});

test('resume: a worker killed mid-verse resumes at the exact turn', async () => {
  let crash = true;
  const script = (phase, ctx) => {
    if (phase === 'B2' && crash) { crash = false; throw new Error('worker killed'); }
    if (phase === 'A1') return reply.A1(`draft ${ctx.verse}`);
    if (phase === 'B1') return reply.B1(`rev ${ctx.verse}`);
    if (phase === 'A2') return reply.A2(`ref ${ctx.verse}`);
    if (phase === 'B2') return reply.B2(`final ${ctx.verse}`);
    return { digest: 'd' };
  };
  const mocks = { anthropic: mockProvider('anthropic', script), google: mockProvider('google', script) };
  useProviders(mocks);
  const project = await one(`INSERT INTO projects (title) VALUES ('Resume') RETURNING *`);
  const { chapter } = await importChapter(project.id, { title: 'One', raw: '1 ἓν\n2 δύο\n' });
  const agents = await makeAgents();
  const run = await makeRun(chapter.id, agents);
  registerHandler('run_chapter', (p) => runChapter(p.runId));
  await enqueue('run_chapter', { runId: run.id });

  await processOne(); // crashes at B2 of verse 1; the job is re-queued
  const saved = await all('SELECT phase FROM turns WHERE run_id = $1 ORDER BY id', [run.id]);
  assert.deepEqual(saved.map((t) => t.phase), ['A1', 'B1', 'A2'], 'every finished turn was saved');
  assert.equal((await one('SELECT status FROM jobs ORDER BY id DESC LIMIT 1')).status, 'queued');

  await processOne(); // restarted worker
  const calls = [...mocks.anthropic.calls, ...mocks.google.calls].filter((c) => c.verse === '1.1').map((c) => c.phase);
  assert.deepEqual(calls.sort(), ['A1', 'A2', 'B1', 'B2', 'B2'], 'no turn was repeated except the one that crashed');
  assert.equal((await one('SELECT status FROM runs WHERE id = $1', [run.id])).status, 'done');
  const finals = await all('SELECT final_rendering FROM verses WHERE chapter_id = $1 ORDER BY ord', [chapter.id]);
  assert.deepEqual(finals.map((f) => f.final_rendering), ['final 1.1', 'final 1.2']);
});
