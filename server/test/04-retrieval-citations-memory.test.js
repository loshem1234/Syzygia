// Acceptance 6 — Pre-fetch rules: a verse with a known particle, construction and
//                 Doric form loads exactly the expected Denniston, Smyth and Buck sections.
// Acceptance 7 — Citation verification: a fabricated citation is caught and
//                 returned to the agent.
// Acceptance 9 — Book memory: concordance retrieval returns earlier renderings
//                 of a shared lemma from another chapter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, teardown, mockProvider, useProviders, useMorph, makeAgents, makeRun, reply, all, one, q } from './helpers.js';
import { importChapter } from '../src/core/importer.js';
import { runChapter } from '../src/jobs/runChapter.js';
import { splitWork } from '../src/library/ingest.js';
import { detectTriggers } from '../src/core/constructions.js';
import { prefetch } from '../src/core/prefetch.js';
import { visibleWorks } from '../src/core/retrieval.js';
import { makeToolExecutor } from '../src/core/tools.js';

const LSJ = [
  { ref: 'νοῦς', text: 'νοῦς, ὁ, contr. for νόος: mind, intellect; in Plotinus and later the second hypostasis, Intellect.', lemmas: ['νοῦς'] },
  { ref: 'ἀρετή', text: 'ἀρετή, ἡ, goodness, excellence, of any kind; Dor. ἀρετά.', lemmas: ['ἀρετή'] },
  { ref: 'βασιλεύω', text: 'βασιλεύω, to be king, rule, reign.', lemmas: ['βασιλεύω'] },
].map((o) => JSON.stringify(o)).join('\n');
const DENNISTON = `γάρ, the causal and explanatory particle. Its primary force is confirmatory.
δή, emphatic particle denoting that a thing is clearly so.
μὲν οὖν, a combination expressing correction or continuation.`;
const SMYTH = `2070. The genitive absolute. A participle in the genitive with a noun or pronoun in the genitive, not grammatically connected with the rest of the sentence.
2071. The genitive absolute may express time, cause, condition or concession.
1814. The optative mood in independent sentences expresses a wish or a potential.`;
const BUCK = `41. Doric ā for Attic η. In Doric the original long ā is retained where Attic has η, as ἀρετά for ἀρετή.
42. Ionic η for ā. In Ionic η appears even after ε, ι, ρ.`;

const RAW1 = '1 ὁ νοῦς βασιλεύει\n';
const RAW2 = '1 τοῦ δὲ νοῦ βασιλεύοντος γάρ ἀρετά\n';

const MORPH = {
  'ὁ': [{ lemma: 'ὁ', pos: 'article', case: 'nom', features: [], dialects: [] }],
  'νοῦς': [{ lemma: 'νοῦς', pos: 'noun', case: 'nom', number: 'sg', features: [], dialects: [] }],
  'βασιλεύει': [{ lemma: 'βασιλεύω', pos: 'verb', mood: 'ind', tense: 'pres', features: [], dialects: [] }],
  'τοῦ': [{ lemma: 'ὁ', pos: 'article', case: 'gen', features: [], dialects: [] }],
  'δὲ': [{ lemma: 'δέ', pos: 'particle', features: ['particle'], dialects: [] }],
  'νοῦ': [{ lemma: 'νοῦς', pos: 'noun', case: 'gen', number: 'sg', features: [], dialects: [] }],
  'βασιλεύοντος': [{ lemma: 'βασιλεύω', pos: 'participle', mood: 'part', case: 'gen', tense: 'pres', features: [], dialects: [] }],
  'γάρ': [{ lemma: 'γάρ', pos: 'particle', features: ['particle'], dialects: [] }],
  'ἀρετά': [{ lemma: 'ἀρετή', pos: 'noun', case: 'nom', features: [], dialects: ['doric'] }],
};

async function addWork(title, short, kind, mode, raw) {
  const w = await one(`INSERT INTO library_works (title, short, kind, split_mode) VALUES ($1,$2,$3,$4) RETURNING *`, [title, short, kind, mode]);
  for (const [i, c] of splitWork(raw, mode).entries()) {
    await q(`INSERT INTO reference_chunks (work_id, ord, ref, ref_key, heading, text, search_key, lemma_keys, topics) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [w.id, i + 1, c.ref, c.ref_key, c.heading, c.text, c.search_key, c.lemma_keys, c.topics]);
  }
  return w;
}

let mocks, project, ch1, ch2, agents;
before(async () => {
  await freshDb('retrieval');
  useMorph(MORPH);
  await addWork('A Greek-English Lexicon', 'LSJ', 'lexicon', 'jsonl', LSJ);
  await addWork('The Greek Particles', 'Denniston', 'particles', 'particle', DENNISTON);
  await addWork('Greek Grammar', 'Smyth', 'grammar', 'section', SMYTH);
  await addWork('The Greek Dialects', 'Buck', 'dialect', 'section', BUCK);
  await addWork('Evaluation translation', 'EVAL', 'translation', 'paragraph', 'The king of all is Intellect.');
  await q(`UPDATE library_works SET scope = 'evaluation' WHERE short = 'EVAL'`);
  project = await one(`INSERT INTO projects (title) VALUES ('Retrieval') RETURNING *`);
  ch1 = (await importChapter(project.id, { title: 'One', raw: RAW1 })).chapter;
  ch2 = (await importChapter(project.id, { title: 'Two', raw: RAW2 })).chapter;
  agents = await makeAgents();
});
after(teardown);

test('splitting keeps each work along its own structure', () => {
  assert.deepEqual(splitWork(SMYTH, 'section').map((c) => c.ref), ['2070', '2071', '1814']);
  assert.deepEqual(splitWork(DENNISTON, 'particle').map((c) => c.ref), ['γάρ', 'δή', 'μὲν οὖν']);
  assert.deepEqual(splitWork(BUCK, 'section').map((c) => c.ref), ['41', '42']);
});

test('pre-fetch loads exactly the governing Denniston, Smyth, Buck and LSJ passages', async () => {
  const verse = await one('SELECT * FROM verses WHERE chapter_id = $1', [ch2.id]);
  const parsed = await (await import('../src/morph/index.js')).getMorph().analyzeText(verse.source);
  const triggers = detectTriggers(parsed, { dialect: 'attic' });
  const types = triggers.map((t) => `${t.type}:${t.value}`);
  for (const t of ['particle:γαρ', 'construction:genitive-absolute', 'dialect:doric', 'lemma:νουσ', 'lemma:αρετη']) assert.ok(types.includes(t), `trigger ${t}`);
  const works = await visibleWorks({ agentId: agents.a.id, dialects: ['attic'] });
  assert.ok(!works.some((w) => w.short === 'EVAL'), 'evaluation-only works are never visible to agents');
  const got = await prefetch({ project, verse, triggers, works, runId: null });
  const cites = got.map((g) => g.citation);
  for (const c of ['Denniston γάρ', 'Smyth §2070', 'Buck §41', 'LSJ νοῦς', 'LSJ ἀρετή']) assert.ok(cites.includes(c), `pre-fetched ${c} (got ${cites.join(', ')})`);
  assert.ok(!cites.includes('Smyth §1814'), 'no optative section without an optative');
  assert.ok(!cites.includes('Buck §42'), 'no Ionic section for a Doric form');
});

test('a fabricated citation is caught, returned to the agent, and cannot block', async () => {
  const script = (phase, ctx) => {
    if (ctx.verse === '2.1') {
      if (phase === 'B1' && ctx.attempt === 0 && !ctx.messages.length) {
        return {
          tool: { name: 'search', args: { query: 'genitive absolute' } },
          next: () => reply.B1('Since Intellect reigns, virtue …', [{ id: 'B1-1', kind: 'error', severity: 'major', category: 'syntax', greek: 'νοῦ βασιλεύοντος', point: 'This is a genitive absolute', evidence: [{ type: 'citation', work: 'Smyth', ref: '9999', quote: 'invented words' }] }]),
        };
      }
      if (phase === 'B1') return reply.B1('Since Intellect reigns, virtue …', [{ id: 'B1-1', kind: 'error', severity: 'major', category: 'syntax', greek: 'νοῦ βασιλεύοντος', point: 'This is a genitive absolute', evidence: [{ type: 'citation', work: 'Smyth', ref: '2070', quote: 'A participle in the genitive' }] }]);
      if (phase === 'A2') return { responses: [{ to: 'B1-1', action: 'accept' }], rendering: 'Since Intellect reigns, virtue …', signoff: true, critique: [{ id: 'A2-1', kind: 'error', severity: 'major', category: 'lexical', greek: 'ἀρετά', point: 'Doric must be marked', evidence: [{ type: 'citation', work: 'Buck', ref: '777' }] }] };
      if (phase === 'B2') return reply.B2('Since Intellect reigns, virtue …', true);
    }
    if (phase === 'A1') return reply.A1(ctx.verse === '1.1' ? 'Intellect is king.' : 'Intellect reigning, virtue …');
    if (phase === 'B1') return reply.B1('Intellect is king.');
    if (phase === 'A2') return reply.A2('Intellect is king.');
    if (phase === 'B2') return reply.B2('Intellect is king.');
    return { digest: 'd' };
  };
  mocks = { anthropic: mockProvider('anthropic', script), google: mockProvider('google', script) };
  useProviders(mocks);

  await runChapter((await makeRun(ch1.id, agents)).id);
  const run2 = await makeRun(ch2.id, agents);
  await runChapter(run2.id);

  const b1Calls = mocks.google.calls.filter((c) => c.verse === '2.1' && c.phase === 'B1');
  assert.equal(b1Calls.length, 2, 'the agent was asked to correct its citation');
  assert.match(b1Calls[1].messages.at(-1).text, /Smyth 9999.*could not|has no section/s);

  const turns = await all('SELECT phase, payload FROM turns WHERE run_id = $1 ORDER BY id', [run2.id]);
  const b1 = turns.find((t) => t.phase === 'B1').payload;
  assert.equal(b1.critique[0].evidence[0].verified, true, 'the corrected citation verified');
  const a2 = turns.find((t) => t.phase === 'A2').payload;
  assert.equal(a2.critique[0].unverified, true, 'an uncorrected fake stays flagged');
  const verse = await one('SELECT * FROM verses WHERE chapter_id = $1', [ch2.id]);
  assert.equal(verse.status, 'agreed', 'an unverified error cannot block agreement');
  const notes = await all(`SELECT * FROM apparatus_notes WHERE verse_id = $1 AND kind = 'citation'`, [verse.id]);
  assert.ok(notes.some((n) => /Buck 777/.test(n.text)));

  // the tool search was logged and, being cited, marked as such
  const log = await all(`SELECT rl.*, c.ref FROM retrieval_log rl JOIN reference_chunks c ON c.id = rl.chunk_id WHERE rl.run_id = $1 AND rl.source = 'tool'`, [run2.id]);
  assert.ok(log.some((l) => l.ref === '2070' && l.cited));
});

test('book memory: concordance returns earlier renderings from another chapter, once', async () => {
  const call = mocks.anthropic.calls.find((c) => c.verse === '2.1' && c.phase === 'A1');
  const l5 = call.blocks.find((b) => b.text.startsWith('LAYER 5')).text;
  const l6 = call.blocks.find((b) => b.text.startsWith('LAYER 6')).text;
  assert.ok(l5.includes('1.1 Intellect is king.'));
  assert.match(l6, /1\.1 \(shares [^)]*νοῦς[^)]*\): see layer 5/);
  assert.equal(call.blocks.map((b) => b.text).join('\n').split('Intellect is king.').length - 1, 1);

  const verse = await one('SELECT * FROM verses WHERE chapter_id = $1', [ch2.id]);
  const exec = makeToolExecutor({ works: await visibleWorks({ agentId: agents.a.id }), projectId: project.id, runId: null, verseId: verse.id, phase: 'A1', agent: 'A', morph: (await import('../src/morph/index.js')).getMorph() });
  const out = await exec('concordance', { lemma: 'νοῦς' });
  assert.match(out, /1\.1 \(νοῦς\): ὁ νοῦς βασιλεύει\n {2}→ Intellect is king\./);
  assert.match(await exec('section', { work: 'Smyth', ref: '2070' }), /^\[Smyth §2070\]/);
  assert.match(await exec('lookup', { lemma: 'ἀρετή' }), /goodness, excellence/);
});
