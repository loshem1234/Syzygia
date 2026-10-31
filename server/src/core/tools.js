// The research tools each agent can call mid-argument. Every call is logged so
// the system can learn which references this text actually needs.
import { all, q } from '../db/pool.js';
import { findWork, byRef, byHeadword, search, citationOf } from './retrieval.js';
import { lookupKey } from './integrity.js';
import { trimEntry } from '../library/ingest.js';
import { config } from '../config.js';

export const TOOL_DEFS = [
  {
    name: 'lookup',
    description: 'Look up a Greek word in a lexicon. Give the lemma (dictionary form). Optionally name the lexicon by its siglum (e.g. LSJ, CGL, Montanari, Lampe, Peters); otherwise every lexicon in your library is searched.',
    parameters: { type: 'object', properties: { lemma: { type: 'string' }, lexicon: { type: 'string' }, full: { type: 'boolean', description: 'Return the untrimmed entry' } }, required: ['lemma'] },
  },
  {
    name: 'section',
    description: 'Fetch one numbered section or entry from a named work, e.g. work "Smyth", ref "2253"; work "Denniston", ref "γάρ II.3" (or "γάρ" for the overview listing its uses); work "LSJ", ref a headword.',
    parameters: { type: 'object', properties: { work: { type: 'string' }, ref: { type: 'string' } }, required: ['work', 'ref'] },
  },
  {
    name: 'search',
    description: 'Search the whole library in Greek or English, e.g. "articular infinitive of purpose", "Doric ā for η", "μὲν οὖν". Optionally limit to a kind: lexicon, grammar, particles, dialect, philosophical, edition.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'concordance',
    description: 'Every occurrence of a Greek lemma in this work, with the chapter and verse, the Greek, and the English rendering where that verse is already translated.',
    parameters: { type: 'object', properties: { lemma: { type: 'string' } }, required: ['lemma'] },
  },
  {
    name: 'parse',
    description: 'All morphological analyses of a Greek form, from the parser.',
    parameters: { type: 'object', properties: { form: { type: 'string' } }, required: ['form'] },
  },
];

function render(chunks, maxChars, focus = []) {
  if (!chunks.length) return 'No matching passage was found in your library.';
  return chunks.map((c) => `[${citationOf(c)}]\n${maxChars ? trimEntry(c.text, maxChars, focus) : c.text}`).join('\n\n---\n\n');
}

export function makeToolExecutor(ctx) {
  // ctx: { works, projectId, runId, verseId, phase, agent, morph, triggers, onRetrieve }
  let calls = 0;
  const log = async (chunks, query) => {
    for (const c of chunks) {
      await q(`INSERT INTO retrieval_log (run_id, verse_id, phase, agent, source, chunk_id, query, triggers) VALUES ($1,$2,$3,$4,'tool',$5,$6,$7)`,
        [ctx.runId, ctx.verseId, ctx.phase, ctx.agent, c.id, query, (ctx.triggers || []).map((t) => `${t.type}:${t.value}`)]);
    }
    ctx.onRetrieve?.(chunks);
  };
  const workIds = (kind) => ctx.works.filter((w) => !kind || w.kind === kind).map((w) => w.id);

  return async function execute(name, args) {
    calls++;
    if (calls > config.limits.toolCallsPerTurn) return 'Tool budget for this turn is spent. Answer with what you have.';
    try {
      if (name === 'lookup') {
        const key = lookupKey(args.lemma || '');
        let ids = workIds('lexicon');
        if (args.lexicon) { const w = await findWork(args.lexicon, ctx.works); ids = w ? [w.id] : []; }
        const chunks = await byHeadword(key, ids, 1);
        await log(chunks, `lookup ${args.lemma}`);
        return render(chunks, args.full ? 0 : config.limits.lexiconEntryChars * 2, [key]);
      }
      if (name === 'section') {
        const w = await findWork(args.work, ctx.works);
        if (!w) return `No work called "${args.work}" is in your library. Available: ${ctx.works.map((x) => x.short).join(', ')}.`;
        let c = await byRef(w.id, args.ref);
        if (!c && ['lexicon', 'particles'].includes(w.kind)) c = (await byHeadword(lookupKey(args.ref), [w.id]))[0];
        const chunks = c ? [c] : [];
        await log(chunks, `section ${w.short} ${args.ref}`);
        return render(chunks, 0);
      }
      if (name === 'search') {
        const chunks = await search(args.query, { workIds: workIds(args.kind), limit: 4 });
        await log(chunks, `search ${args.query}`);
        return render(chunks, config.limits.lexiconEntryChars);
      }
      if (name === 'concordance') {
        const key = lookupKey(args.lemma || '');
        const rows = await all(
          `SELECT ch.ord AS chapter, v.num, v.source, v.final_rendering, vl.form
             FROM verse_lemmas vl JOIN verses v ON v.id = vl.verse_id JOIN chapters ch ON ch.id = v.chapter_id
            WHERE ch.project_id = $1 AND vl.lemma_key = $2 ORDER BY ch.ord, v.ord LIMIT 25`, [ctx.projectId, key]);
        if (!rows.length) return 'No occurrences indexed yet for that lemma.';
        return rows.map((r) => `${r.chapter}.${r.num} (${r.form}): ${r.source}${r.final_rendering ? `\n  → ${r.final_rendering}` : '\n  → not yet translated'}`).join('\n');
      }
      if (name === 'parse') {
        const a = await ctx.morph.analyze(args.form || '');
        if (!a.length) return ctx.morph.available ? 'The parser found no analysis for that form.' : 'The parser is not connected in this deployment.';
        return a.map((x) => `${x.lemma} — ${[x.pos, x.tense, x.mood, x.voice, x.person, x.number, x.case, x.gender, ...(x.dialects || [])].filter(Boolean).join(' ')}`).join('\n');
      }
      return `Unknown tool ${name}.`;
    } catch (e) {
      return `The tool failed: ${e.message}`;
    }
  };
}
