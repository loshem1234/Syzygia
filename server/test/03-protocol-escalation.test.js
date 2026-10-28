// Acceptance 4 — Protocol paths: agreed, synthesized and dissent each end locked,
//                 none exceeds six turns.
// Acceptance 5 — Escalation: a disputed verse switches to the escalation models
//                 for synthesis only, and the next verse returns to the primaries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, teardown, mockProvider, useProviders, useMorph, makeAgents, makeRun, reply, all, one } from './helpers.js';
import { importChapter } from '../src/core/importer.js';
import { runChapter } from '../src/jobs/runChapter.js';
import { next } from '../src/core/protocol.js';

const RAW = '1 πρῶτον ῥῆμα\n2 δεύτερον ῥῆμα\n3 τρίτον ῥῆμα\n4 τέταρτον ῥῆμα\n';
const blocking = [{ id: 'B2-1', kind: 'error', severity: 'major', category: 'syntax', greek: 'ῥῆμα', point: 'The genitive is causal', evidence: [{ type: 'text', note: 'case' }] }];

let mocks;
before(async () => {
  await freshDb('protocol');
  useMorph({});
  const script = (phase, ctx) => {
    const n = ctx.verse.split('.')[1];
    switch (phase) {
      case 'A1': return reply.A1(`draft ${n}`);
      case 'B1': return reply.B1(`revised ${n}`, [{ id: 'B1-1', kind: 'preference', severity: 'minor', greek: 'ῥῆμα', point: 'word', suggestion: 'utterance' }]);
      case 'A2': return reply.A2(`refined ${n}`, [{ to: 'B1-1', action: 'decline', note: 'saying is better' }]);
      case 'B2': return n === '1' || n === '4' ? reply.B2(`final ${n}`) : reply.B2(`final ${n}`, false, blocking);
      case 'S1': return reply.S1(`joint A ${n}`);
      case 'S2': return n === '2' ? reply.S2(`joint A ${n}`, true) : reply.S2(`joint B ${n}`, false);
      default: return { digest: 'A short chapter about words.' };
    }
  };
  mocks = { anthropic: mockProvider('anthropic', script), google: mockProvider('google', script) };
  useProviders(mocks);
});
after(teardown);

test('agreed, synthesized and disputed paths all lock; escalation is used only for synthesis', async () => {
  const p = await one(`INSERT INTO projects (title) VALUES ('Paths') RETURNING *`);
  const { chapter } = await importChapter(p.id, { title: 'One', raw: RAW });
  const agents = await makeAgents();
  const run = await makeRun(chapter.id, agents);
  await runChapter(run.id);

  const verses = await all('SELECT * FROM verses WHERE chapter_id = $1 ORDER BY ord', [chapter.id]);
  assert.deepEqual(verses.map((v) => v.status), ['agreed', 'synthesized', 'disputed', 'agreed']);
  assert.deepEqual(verses.map((v) => v.final_rendering), ['final 1', 'joint A 2', 'joint B 3', 'final 4']);
  for (const v of verses) assert.ok(v.current_version_id, 'every verse is locked with a version');

  const turns = await all('SELECT t.*, v.num FROM turns t JOIN verses v ON v.id = t.verse_id WHERE t.run_id = $1 ORDER BY t.id', [run.id]);
  const byVerse = (n) => turns.filter((t) => t.num === n);
  assert.deepEqual(byVerse('1').map((t) => t.phase), ['A1', 'B1', 'A2', 'B2']);
  assert.deepEqual(byVerse('2').map((t) => t.phase), ['A1', 'B1', 'A2', 'B2', 'S1', 'S2']);
  assert.deepEqual(byVerse('3').map((t) => t.phase), ['A1', 'B1', 'A2', 'B2', 'S1', 'S2']);
  for (const n of ['1', '2', '3', '4']) assert.ok(byVerse(n).length <= 6);

  // escalation: S1/S2 on the escalation models, everything else on the primaries
  for (const t of turns) {
    const synth = t.phase.startsWith('S');
    assert.equal(t.escalated, synth, `${t.num} ${t.phase} escalated=${t.escalated}`);
    assert.equal(t.model, synth ? (t.agent === 'A' ? 'escalation-a' : 'escalation-b') : (t.agent === 'A' ? 'primary-a' : 'primary-b'));
  }
  assert.equal(byVerse('4')[0].model, 'primary-a', 'the next verse returns to the primary model');

  // dissent became apparatus; declined preferences are kept as optional notes
  const notes = await all('SELECT a.kind, a.text, v.num FROM apparatus_notes a JOIN verses v ON v.id = a.verse_id WHERE v.chapter_id = $1', [chapter.id]);
  assert.ok(notes.some((n) => n.num === '3' && n.kind === 'dissent' && /concessive/.test(n.text)));
  assert.ok(notes.some((n) => n.num === '3' && n.kind === 'dissent' && /joint A 3/.test(n.text)));
  assert.ok(notes.some((n) => n.kind === 'preference' && /utterance/.test(n.text)));
  assert.equal((await one('SELECT status FROM runs WHERE id = $1', [run.id])).status, 'done');
  assert.ok(await one('SELECT digest FROM chapter_digests WHERE chapter_id = $1', [chapter.id]));
});

test('escalation off keeps synthesis on the primaries; premium escalates every turn', () => {
  const t = (phase, agent, payload) => ({ phase, agent, payload });
  const base = [t('A1', 'A', { rendering: 'a' }), t('B1', 'B', { rendering: 'b', critique: [] }), t('A2', 'A', { rendering: 'c', signoff: false, critique: [] }), t('B2', 'B', { rendering: 'd', signoff: false, critique: [] })];
  assert.deepEqual(next(base, { escalateMode: 'off' }), { action: 'turn', phase: 'S1', agent: 'A', escalate: false });
  assert.deepEqual(next(base, { escalateMode: 'auto' }), { action: 'turn', phase: 'S1', agent: 'A', escalate: true });
  assert.deepEqual(next([], { escalateMode: 'premium' }), { action: 'turn', phase: 'A1', agent: 'A', escalate: true });
  assert.deepEqual(next([], { escalateMode: 'auto' }), { action: 'turn', phase: 'A1', agent: 'A', escalate: false });
});
