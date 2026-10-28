// The whole app through its HTTP API, as the interface uses it: import, agents,
// library, a run through the job queue, corrections, leaderboard, exports, backup.
// Acceptance 12 — Golden run: real models on three real verses (only with GOLDEN_FILE and API keys).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, teardown, mockProvider, useProviders, useMorph, reply } from './helpers.js';
import { createApp } from '../src/app.js';
import { registerAll } from '../src/jobs/handlers.js';
import { processOne } from '../src/jobs/queue.js';
import { setProviderOverrides } from '../src/providers/index.js';

let server, base;
const api = async (method, path, body, raw = false) => {
  const res = await fetch(base + path, { method, headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  if (raw) return res;
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error}`);
  return json;
};
const drain = async () => { while (await processOne()) { /* run every queued job */ } };

before(async () => {
  await freshDb('api');
  useMorph({});
  const script = (phase, ctx) => {
    if (phase === 'READ') return { dialect: 'Attic', terms: [{ lemma: 'νοῦς', proposed: 'Intellect', note: 'hypostasis' }], style_conventions: ['Render ἀρετή as virtue'], quotations: [] };
    const n = ctx.verse;
    if (phase === 'A1') return reply.A1(`draft ${n}`);
    if (phase === 'B1') return reply.B1(`rev ${n}`);
    if (phase === 'A2') return reply.A2(`ref ${n}`);
    if (phase === 'B2') return reply.B2(`final ${n}`);
    return { digest: 'Chapter digest.' };
  };
  useProviders({ anthropic: mockProvider('anthropic', script), google: mockProvider('google', script) });
  registerAll();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { server?.close(); setProviderOverrides(null); await teardown(); });

test('the full workflow through the API', async () => {
  const meta = await api('GET', '/meta');
  assert.ok(meta.charter.startsWith('THE CHARTER OF SYZYGIA'));
  const project = await api('POST', '/projects', { title: 'De vita Pythagorica', author: 'Iamblichus' });
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('1 ὁ νοῦς βασιλεύς\n2 ἡ ἀρετὴ ἁρμονία\n', 'utf8')]), 'ch1.txt');
  fd.append('title', 'Proem');
  const imported = await api('POST', `/projects/${project.id}/chapters`, fd);
  assert.equal(imported.verses, 2);
  await api('POST', `/projects/${project.id}/work`, { raw: '1 ὁ νοῦς βασιλεύς\n2 ἡ ἀρετὴ ἁρμονία\n' });

  const A = await api('POST', '/agents', { name: 'Philologos', provider: 'anthropic', model: 'claude-sonnet-5-5', escalation_model: 'claude-opus-5-5', instructions: 'Literal first.' });
  const B = await api('POST', '/agents', { name: 'Kritikos', provider: 'google', model: 'gemini-3.1-pro', instructions: 'Exacting.' });
  await api('PUT', '/pricing', { 'claude-sonnet-5-5': { input: 3, output: 15 }, 'gemini-3.1-pro': { input: 2, output: 12 } });

  const lib = new FormData();
  lib.append('raw', '2070. The genitive absolute. A participle in the genitive.\n2071. Its uses.');
  lib.append('title', 'Greek Grammar'); lib.append('short', 'Smyth'); lib.append('kind', 'grammar'); lib.append('split_mode', 'section');
  assert.equal((await api('POST', '/library', lib)).chunks, 2);
  assert.equal((await api('POST', '/library/search', { query: 'genitive absolute' }))[0].citation, 'Smyth §2070');

  await api('POST', `/projects/${project.id}/ledger/import`, { text: 'ψυχή = soul; life | Loshem' });
  await api('POST', `/projects/${project.id}/reading-pass`, { agentIds: [A.id, B.id] });
  await drain();
  const notes = await api('GET', `/projects/${project.id}/study-notes`);
  assert.equal(notes.length, 2);
  const approved = await api('POST', `/study-notes/${notes[0].id}/approve`, {});
  assert.equal(approved.terms, 1);
  const ledger = await api('GET', `/projects/${project.id}/ledger`);
  assert.deepEqual(ledger.entries.map((e) => e.lemma).sort(), ['νοῦς', 'ψυχή']);

  const chapterId = imported.chapter.id;
  const est = await api('POST', '/runs/estimate', { chapterId, agentA: A.id, agentB: B.id });
  assert.ok(est.priced && est.usd > 0);
  const run = await api('POST', '/runs', { chapterId, agentA: A.id, agentB: B.id, escalateMode: 'auto' });
  await drain();
  const ch = await api('GET', `/chapters/${chapterId}`);
  assert.ok(ch.verified);
  assert.deepEqual(ch.verses.map((v) => v.final_rendering), ['final 1.1', 'final 1.2']);
  assert.equal(ch.runs[0].status, 'done');
  const verse = await api('GET', `/verses/${ch.verses[0].id}?runId=${run.id}`);
  assert.equal(verse.turns.length, 4);

  // Loshem's correction: a new version, a win on the leaderboard
  const edit = await api('POST', `/verses/${ch.verses[0].id}/edit`, { rendering: 'Intellect is king.' });
  assert.equal(edit.version.origin, 'manual');
  const board = await api('GET', '/leaderboard');
  assert.ok(board.find((b) => b.pairing === 'manual').rating > 1500);

  // blind comparison against an evaluation-only reference
  await api('POST', `/chapters/${chapterId}/reference`, { text: '1 Intellect is king.\n2 Virtue is harmony.' });
  const cmp = await api('GET', `/projects/${project.id}/compare/next`);
  assert.ok(cmp && cmp.left && cmp.right);
  await api('POST', `/comparisons/${cmp.comparisonId}`, { winner: 'left' });

  // re-run one verse with a note: a new version, nothing overwritten
  await api('POST', '/runs', { chapterId, agentA: A.id, agentB: B.id, verseIds: [ch.verses[1].id], note: 'Keep ἁρμονία as harmony' });
  await drain();
  const versions = await api('GET', `/chapters/${chapterId}/versions`);
  assert.equal(versions.find((v) => v.num === '2').versions.length, 2);

  for (const format of ['pdf', 'docx', 'md', 'txt', 'tei']) {
    const res = await api('GET', `/chapters/${chapterId}/export?format=${format}&layout=facing&dissent=1`, null, true);
    assert.equal(res.status, 200, format);
    assert.ok((await res.arrayBuffer()).byteLength > 100);
  }

  const backup = await (await api('GET', '/backup', null, true)).json();
  assert.equal(backup.app, 'syzygia');
  assert.ok(backup.tables.verses.length === 2 && backup.tables.turns.length >= 8);

  const knowledge = await api('GET', `/knowledge?projectId=${project.id}`);
  assert.ok(knowledge.rules.some((r) => r.tier === 'core'));
  await assert.rejects(api('PATCH', `/rules/${knowledge.rules.find((r) => r.tier === 'core').id}`, { status: 'retired' }), /Core rules are fixed/);
});

test('golden run on real models (needs GOLDEN_FILE and API keys)', { skip: !process.env.GOLDEN_FILE }, async () => {
  // GOLDEN_FILE: a .txt with three numbered verses of your own text, e.g. the
  // opening of the Pythagorean Life from your Nauck edition.
  setProviderOverrides(null);
  const fs = await import('node:fs');
  const raw = fs.readFileSync(process.env.GOLDEN_FILE, 'utf8');
  const project = await api('POST', '/projects', { title: 'Golden run' });
  const imported = await api('POST', `/projects/${project.id}/chapters`, { title: 'Golden', raw });
  await api('POST', `/projects/${project.id}/work`, { raw });
  const A = await api('POST', '/agents', { name: 'Philologos', provider: process.env.GOLDEN_A_PROVIDER || 'anthropic', model: process.env.GOLDEN_A || 'claude-sonnet-5-5', instructions: 'Literal first.' });
  const B = await api('POST', '/agents', { name: 'Kritikos', provider: process.env.GOLDEN_B_PROVIDER || 'google', model: process.env.GOLDEN_B || 'gemini-3.1-pro', instructions: 'Exacting.' });
  await api('POST', '/runs', { chapterId: imported.chapter.id, agentA: A.id, agentB: B.id });
  await drain();
  const ch = await api('GET', `/chapters/${imported.chapter.id}`);
  assert.equal(ch.runs[0].status, 'done', ch.runs[0].error || ch.runs[0].pause_reason || '');
  for (const v of ch.verses) assert.ok(v.final_rendering && v.final_rendering.length > 10, `verse ${v.num} translated`);
  console.log(ch.verses.map((v) => `${v.num} [${v.status}] ${v.final_rendering}`).join('\n'));
});
