// Acceptance 1 — Polytonic round trip: a hard sample survives import, storage,
// every prompt and every export byte for byte.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { freshDb, teardown, mockProvider, useProviders, useMorph, makeAgents, makeRun, reply, one, all, q } from './helpers.js';
import { importWork, importChapter } from '../src/core/importer.js';
import { segmentVerses, segmentationLossless, sha256, encodingWarnings } from '../src/core/integrity.js';
import { runChapter } from '../src/jobs/runChapter.js';
import { exportChapter } from '../src/export/index.js';

// Every hazard in one text: oxia and tonos forms, ano teleia, Greek question
// mark, combining breathings and accents, iota subscripts.
const V1 = 'Πυθαγόρας ὁ Σάμιος· τίς ἦν;';
const V2 = 'ὁ λόγος καὶ ὁ λόγος ἓν ἀμφότεροι';
const V3 = 'τῷ ἄνθρωπῳ ᾳδε λέγει· καὶ ᾄδει';
const RAW = `1 ${V1}\n2 ${V2}\n3 ${V3}\n`;

let mocks;
before(async () => {
  await freshDb('integrity');
  useMorph({});
  const script = (phase, ctx) => {
    const n = ctx.verse.split('.')[1];
    if (phase === 'A1') return reply.A1(`English ${n}`);
    if (phase === 'B1') return reply.B1(`English ${n}`);
    if (phase === 'A2') return reply.A2(`English ${n}`);
    return reply.B2(`English ${n}`);
  };
  mocks = { anthropic: mockProvider('anthropic', script), google: mockProvider('google', script) };
  useProviders(mocks);
});
after(teardown);

test('segmentation is lossless and slices are exact', () => {
  const verses = segmentVerses(RAW);
  assert.equal(verses.length, 3);
  assert.deepEqual(verses.map((v) => v.source), [V1, V2, V3]);
  assert.ok(segmentationLossless(RAW, verses));
  assert.ok(encodingWarnings(RAW).some((w) => w.includes('Mixed acute')));
});

test('the source survives import, storage, prompts and every export byte for byte', async () => {
  const p = await one(`INSERT INTO projects (title, author) VALUES ('De vita Pythagorica', 'Iamblichus') RETURNING *`);
  const work = await importWork(p.id, RAW);
  assert.equal(work.hash, sha256(RAW));
  const { chapter } = await importChapter(p.id, { title: 'Proem', raw: RAW });

  const stored = await one('SELECT source_raw, source_hash FROM chapters WHERE id = $1', [chapter.id]);
  assert.equal(Buffer.compare(Buffer.from(stored.source_raw, 'utf8'), Buffer.from(RAW, 'utf8')), 0);
  const verses = await all('SELECT source FROM verses WHERE chapter_id = $1 ORDER BY ord', [chapter.id]);
  assert.deepEqual(verses.map((v) => v.source), [V1, V2, V3]);

  // the database refuses any change to the source
  await assert.rejects(q('UPDATE chapters SET source_raw = $2 WHERE id = $1', [chapter.id, RAW.normalize('NFC')]), /immutable/);
  await assert.rejects(q('UPDATE projects SET work_raw = $2 WHERE id = $1', [p.id, 'x']), /immutable/);
  await assert.rejects(q('UPDATE verses SET source = $2 WHERE chapter_id = $1', [chapter.id, 'x']), /immutable/);

  const agents = await makeAgents();
  const run = await makeRun(chapter.id, agents);
  await runChapter(run.id);

  // every prompt carried the exact Greek
  const debateCalls = [...mocks.anthropic.calls, ...mocks.google.calls].filter((c) => /^(A|B|S)\d$/.test(c.phase));
  assert.equal(debateCalls.length, 12, 'three verses, four turns each');
  for (const call of debateCalls) {
    const all = call.blocks.map((b) => b.text).join('\n');
    assert.ok(all.includes(RAW), 'layer 2 holds the whole work exactly');
    const layer6 = call.blocks.find((b) => b.text.startsWith('LAYER 6')).text;
    assert.ok([V1, V2, V3].some((v) => layer6.includes(`Greek (exact): ${v}`)));
  }

  for (const format of ['txt', 'md', 'tei']) {
    const out = await exportChapter(chapter.id, format, { layout: 'facing' });
    const text = out.body.toString('utf8');
    for (const v of [V1, V2, V3]) assert.ok(text.includes(v), `${format} carries ${JSON.stringify(v)} exactly`);
  }
  const docx = await exportChapter(chapter.id, 'docx', { layout: 'facing' });
  const xml = await (await JSZip.loadAsync(docx.body)).file('word/document.xml').async('string');
  for (const v of [V1, V2, V3]) assert.ok(xml.includes(v), 'docx carries the Greek exactly');
  const pdf = await exportChapter(chapter.id, 'pdf', { layout: 'facing' });
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.body.includes(Buffer.from('GFSDidot')), 'the polytonic font is embedded');

  // the stored source is still intact after everything
  const after = await one('SELECT source_raw FROM chapters WHERE id = $1', [chapter.id]);
  assert.equal(sha256(after.source_raw), stored.source_hash);
});
