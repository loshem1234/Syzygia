// The orchestrator: runs one chapter through the debate, verse by verse.
// Every turn is saved the moment it completes, so a crash or redeploy resumes
// at the exact turn. The source text is verified before the run starts.
import { all, one, q, tx } from '../db/pool.js';
import { assertIntact } from '../core/integrity.js';
import { detectTriggers } from '../core/constructions.js';
import { next } from '../core/protocol.js';
import { normalizeReply, settledPoints, dropReopened, extractJson } from '../core/critique.js';
import { REPAIR_TASK, citationRepairTask, DIGEST_TASK } from '../core/charter.js';
import { assembleContext } from '../core/context.js';
import { visibleWorks } from '../core/retrieval.js';
import { prefetch } from '../core/prefetch.js';
import { makeToolExecutor, TOOL_DEFS } from '../core/tools.js';
import { verifyPayload } from '../core/citations.js';
import { ledgerFor, processVerseProposals } from '../core/ledger.js';
import { styleSheetFor, approvedStudyNotes, translationSoFar, digestsFor, concordanceFor, indexVerseLemmas, lemmaFrequency, quotationsIn, recordQuotations } from '../core/memory.js';
import { markCited, learnFromVerse, decay } from '../core/learning.js';
import { pricing, costOf } from '../core/cost.js';
import { getProvider } from '../providers/index.js';
import { getMorph } from '../morph/index.js';
import { emit } from '../events.js';
import { config } from '../config.js';

export class PausedError extends Error {}

export async function workTextFor(project) {
  if (project.work_raw) {
    assertIntact(project.work_raw, project.work_hash, 'the full work');
    return project.work_raw;
  }
  const chapters = await all('SELECT * FROM chapters WHERE project_id = $1 ORDER BY ord', [project.id]);
  return chapters.map((c) => { assertIntact(c.source_raw, c.source_hash, `chapter ${c.ord}`); return `[Chapter ${c.ord} — ${c.title}]\n${c.source_raw}`; }).join('\n\n');
}

async function loadAgent(versionId) {
  return one('SELECT v.*, a.name FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE v.id = $1', [versionId]);
}

async function runStatus(runId) {
  return (await one('SELECT status FROM runs WHERE id = $1', [runId]))?.status;
}

export async function runChapter(runId, { morph = getMorph() } = {}) {
  let run = await one('SELECT * FROM runs WHERE id = $1', [runId]);
  if (!run || ['done', 'cancelled'].includes(run.status)) return { skipped: true };
  await q(`UPDATE runs SET status = 'running', pause_reason = NULL, started_at = coalesce(started_at, now()) WHERE id = $1`, [runId]);
  const chapter = await one('SELECT * FROM chapters WHERE id = $1', [run.chapter_id]);
  const project = await one('SELECT * FROM projects WHERE id = $1', [chapter.project_id]);
  try {
    assertIntact(chapter.source_raw, chapter.source_hash, `chapter ${chapter.ord}`);
    const workText = await workTextFor(project);
    const agents = { A: await loadAgent(run.agent_a_version_id), B: await loadAgent(run.agent_b_version_id) };
    const verses = await all('SELECT * FROM verses WHERE chapter_id = $1 ORDER BY ord', [chapter.id]);
    const prices = await pricing();
    await emit({ type: 'run', runId, status: 'running' });

    for (const verse of verses) {
      if (verse.locked_by_user) continue;
      if (run.verse_filter?.length && !run.verse_filter.includes(verse.id)) continue;
      const done = await one('SELECT id FROM verse_versions WHERE verse_id = $1 AND run_id = $2', [verse.id, runId]);
      if (done) continue;
      const status = await runStatus(runId);
      if (status !== 'running') throw new PausedError(status);
      await debateVerse({ run, project, chapter, verse, agents, workText, morph, prices });
      run = await one('SELECT * FROM runs WHERE id = $1', [runId]);
    }

    await finishChapter({ run, project, chapter, agents });
    await q(`UPDATE runs SET status = 'done', finished_at = now() WHERE id = $1 AND status = 'running'`, [runId]);
    await emit({ type: 'run', runId, status: 'done' });
    return { done: true };
  } catch (e) {
    if (e instanceof PausedError) {
      await emit({ type: 'run', runId, status: e.message });
      return { paused: true };
    }
    await q(`UPDATE runs SET status = 'failed', error = $2 WHERE id = $1`, [runId, String(e.stack || e.message).slice(0, 4000)]);
    await emit({ type: 'run', runId, status: 'failed', error: e.message });
    throw e;
  }
}

async function verseData({ project, chapter, verse, morph, agentLetter, agents, runId, learned, cache }) {
  if (!cache.parsed) {
    cache.parsed = await morph.analyzeText(verse.source);
    await indexVerseLemmas(verse, cache.parsed);
  }
  const ledger = await ledgerFor(project);
  const dialect = verse.dialect_override || chapter.dialect || project.dialect;
  if (!cache.triggers) cache.triggers = detectTriggers(cache.parsed, { ledgerKeys: new Set(ledger.map((e) => e.lemma_key)), dialect });
  const agent = agents[agentLetter];
  const works = await visibleWorks({ agentId: agent.agent_id, dialects: [dialect] });
  if (!cache[`prefetch${agentLetter}`]) {
    cache[`prefetch${agentLetter}`] = await prefetch({ project, verse, triggers: cache.triggers, works, runId, learned, lemmaFrequency: cache.freq || (cache.freq = await lemmaFrequency(project.id)) });
  }
  const translation = await translationSoFar(project, { excludeVerseId: verse.id });
  const layer5Ids = new Set(translation.map((r) => r.id));
  const lemmaKeys = [...new Set(cache.triggers.filter((t) => t.type === 'lemma').map((t) => t.value))];
  const concordance = await concordanceFor({ project, verse, lemmaKeys: lemmaKeys.filter((k) => !['ο', 'και', 'δε', 'ειμι'].includes(k)), skip: layer5Ids });
  return {
    works,
    ledger,
    translation,
    packet: {
      dialect,
      parses: cache.parsed.filter((t) => t.analyses.length),
      parserMissing: !morph.available,
      prefetched: cache[`prefetch${agentLetter}`],
      concordance,
      quotations: await quotationsIn(project, verse),
      userNote: verse.needs_review && verse.review_reason ? verse.review_reason : null,
    },
  };
}

async function debateVerse({ run, project, chapter, verse, agents, workText, morph, prices }) {
  const cache = {};
  const turns = (await all('SELECT * FROM turns WHERE run_id = $1 AND verse_id = $2 ORDER BY id', [run.id, verse.id]));
  const studyNotes = await approvedStudyNotes(project.id);
  const style = await styleSheetFor(project);
  const digests = await digestsFor(project.id);
  await emit({ type: 'verse', runId: run.id, verseId: verse.id, status: 'debating' });

  let decision = next(turns, { escalateMode: run.escalate_mode });
  while (decision.action === 'turn') {
    if (turns.length >= 6) throw new Error('Protocol invariant broken: more than six turns');
    const status = await runStatus(run.id);
    if (status !== 'running') throw new PausedError(status);
    const turn = await takeTurn({ run, project, chapter, verse, agents, workText, morph, prices, cache, studyNotes, style, digests, turns, decision });
    turns.push(turn);
    decision = next(turns, { escalateMode: run.escalate_mode });
  }
  await lockVerse({ run, project, chapter, verse, decision, turns, triggers: cache.triggers || [] });
}

async function takeTurn({ run, project, chapter, verse, agents, workText, morph, prices, cache, studyNotes, style, digests, turns, decision }) {
  const { phase, agent: letter } = decision;
  const agent = agents[letter];
  const useEscalation = decision.escalate && agent.escalation_model;
  const providerName = useEscalation ? (agent.escalation_provider || agent.provider) : agent.provider;
  const model = useEscalation ? agent.escalation_model : agent.model;
  const data = await verseData({ project, chapter, verse, morph, agentLetter: letter, agents, runId: run.id, learned: run.learned_rules, cache });
  const ctx = assembleContext({
    agent, project, workText, studyNotes, style, ledger: data.ledger, translation: data.translation, digests, works: data.works,
    chapter, verse, packet: data.packet, turns, phase, budgetTokens: config.limits.contextBudgetTokens,
  });
  const executeTool = makeToolExecutor({ works: data.works, projectId: project.id, runId: run.id, verseId: verse.id, phase, agent: letter, morph, triggers: cache.triggers });
  const provider = getProvider(providerName);
  const call = (messages) => provider.complete({
    model, system: ctx.system, blocks: ctx.blocks, messages, tools: TOOL_DEFS, executeTool,
    maxTokens: config.limits.maxOutputTokens, temperature: agent.temperature ?? undefined, maxToolCalls: config.limits.toolCallsPerTurn,
  });

  const usage = { input: 0, output: 0, cachedRead: 0, cacheWrite: 0 };
  const toolCalls = [];
  const add = (r) => { for (const k of Object.keys(usage)) usage[k] += r.usage[k] || 0; toolCalls.push(...r.toolCalls); };

  let r = await call([]);
  add(r);
  let payload = normalizeReply(phase, r.text);
  if (!payload) {
    r = await call([{ role: 'assistant', text: r.text || '(empty)' }, { role: 'user', text: REPAIR_TASK }]);
    add(r);
    payload = normalizeReply(phase, r.text);
  }
  if (!payload) {
    await q(`UPDATE runs SET status = 'paused', pause_reason = $2 WHERE id = $1`, [run.id, `Agent ${letter} (${model}) did not return a usable reply at ${phase}, chapter ${chapter.ord} verse ${verse.num}.`]);
    throw new PausedError('paused');
  }

  // Citations are verified; a failed one is returned once to the agent to correct.
  const verifyCtx = { works: data.works, parses: cache.parsed };
  let check = await verifyPayload(payload, verifyCtx);
  if (check.failures.length) {
    const retry = await call([{ role: 'assistant', text: r.text }, { role: 'user', text: citationRepairTask(check.failures) }]);
    add(retry);
    const repaired = normalizeReply(phase, retry.text);
    if (repaired) {
      payload = repaired;
      check = await verifyPayload(payload, verifyCtx);
    }
    payload.citation_failures = check.failures;
  }

  // Disposition: no reopening of settled points.
  const { payload: kept, dropped } = dropReopened(payload, settledPoints(turns));
  payload = kept;
  if (dropped.length) payload.dropped_reopened = dropped.map((d) => d.id);

  await markCited({ runId: run.id, verseId: verse.id, chunkIds: check.verifiedChunkIds });
  const cost = costOf(prices[model], usage);
  const row = await one(
    `INSERT INTO turns (run_id, verse_id, phase, agent, provider, model, escalated, rendering, payload, tool_calls, context_meter, tokens_in, tokens_out, tokens_cached, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (run_id, verse_id, phase) DO UPDATE SET phase = EXCLUDED.phase RETURNING *`,
    [run.id, verse.id, phase, letter, providerName, model, Boolean(useEscalation), payload.rendering, JSON.stringify(payload), JSON.stringify(toolCalls), JSON.stringify(ctx.meter),
      usage.input, usage.output, usage.cachedRead, cost]);
  const updated = await one('UPDATE runs SET cost_usd = cost_usd + $2 WHERE id = $1 RETURNING cost_usd, budget_usd', [run.id, cost]);
  await emit({ type: 'turn', runId: run.id, verseId: verse.id, phase, agent: letter, escalated: Boolean(useEscalation), turnId: row.id });
  if (updated.budget_usd && updated.cost_usd >= updated.budget_usd) {
    await q(`UPDATE runs SET status = 'paused', pause_reason = 'Spending cap reached' WHERE id = $1`, [run.id]);
  }
  return row;
}

async function lockVerse({ run, project, chapter, verse, decision, turns, triggers }) {
  await tx(async (t) => {
    const version = await t.one(`INSERT INTO verse_versions (verse_id, run_id, origin, status, rendering) VALUES ($1,$2,'run',$3,$4) RETURNING id`,
      [verse.id, run.id, decision.outcome, decision.rendering]);
    for (const a of decision.apparatus) {
      await t.q(`INSERT INTO apparatus_notes (verse_id, run_id, version_id, kind, agent, text) VALUES ($1,$2,$3,$4,$5,$6)`, [verse.id, run.id, version.id, a.kind, a.agent || null, a.text]);
    }
    for (const tr of turns) {
      for (const f of tr.payload.citation_failures || []) {
        await t.q(`INSERT INTO apparatus_notes (verse_id, run_id, version_id, kind, agent, text) VALUES ($1,$2,$3,'citation',$4,$5)`, [verse.id, run.id, version.id, tr.agent, `Unverified citation withdrawn from the argument: ${f.work} ${f.ref}`]);
      }
    }
    if (!run.benchmark) {
      await t.q(`UPDATE verses SET final_rendering = $2, status = $3, current_version_id = $4, needs_review = false, review_reason = NULL WHERE id = $1`,
        [verse.id, decision.rendering, decision.outcome, version.id]);
    }
  });
  if (!run.benchmark) {
    await processVerseProposals({ project, chapter, verse, run, turns });
    for (const tr of turns) for (const rule of tr.payload.style_proposals || []) {
      await q(`INSERT INTO style_sheet_entries (tier, project_id, rule, status, proposer) VALUES ('book',$1,$2,'pending',$3)`, [project.id, rule, tr.agent]);
    }
    const quotations = turns.flatMap((tr) => tr.payload.quotations || []);
    await recordQuotations(project, verse, quotations, decision.rendering);
    await learnFromVerse({ project, verse, runId: run.id, triggers });
  }
  await emit({ type: 'verse', runId: run.id, verseId: verse.id, status: decision.outcome, rendering: decision.rendering });
}

async function finishChapter({ run, project, chapter, agents }) {
  if (run.benchmark) return;
  const rows = await all('SELECT num, final_rendering FROM verses WHERE chapter_id = $1 ORDER BY ord', [chapter.id]);
  if (rows.some((r) => !r.final_rendering)) return;
  const providerName = run.utility_provider || agents.A.provider;
  const model = run.utility_model || agents.A.model;
  try {
    const res = await getProvider(providerName).complete({
      model, system: 'You summarize a translated chapter for the translators of later chapters. Reply with JSON only.',
      blocks: [{ text: `Chapter ${chapter.ord} — ${chapter.title}\n${rows.map((r) => `${r.num} ${r.final_rendering}`).join('\n')}\n\n${DIGEST_TASK}`, cache: false }],
      tools: [], executeTool: async () => '', maxTokens: 800,
    });
    const digest = extractJson(res.text)?.digest || res.text.trim();
    if (digest) await q(`INSERT INTO chapter_digests (chapter_id, digest) VALUES ($1,$2) ON CONFLICT (chapter_id) DO UPDATE SET digest = $2, created_at = now()`, [chapter.id, digest]);
  } catch (e) {
    console.warn('[digest] skipped:', e.message);
  }
  const seq = (await one('SELECT max(seq)::int AS s FROM verses WHERE chapter_id = $1', [chapter.id])).s || 0;
  await decay({ project, currentSeq: seq });
  const stats = await one(`SELECT count(*) FILTER (WHERE status IN ('synthesized','disputed'))::float / greatest(count(*),1) AS rate FROM verse_versions WHERE run_id = $1`, [run.id]);
  if (stats.rate > config.limits.synthesisAlertRate) {
    await emit({ type: 'alert', runId: run.id, message: `Synthesis rate ${(stats.rate * 100).toFixed(0)}% — the agents may be quarrelling over taste. Review their instructions.` });
  }
}
