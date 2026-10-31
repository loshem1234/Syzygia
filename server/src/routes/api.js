import express from 'express';
import multer from 'multer';
import { all, one, q } from '../db/pool.js';
import { config } from '../config.js';
import { CHARTER, PHASES } from '../core/charter.js';
import { codepoints, encodingWarnings, verifyHash, lookupKey, sha256 } from '../core/integrity.js';
import { importWork, importChapter, suggestDialect } from '../core/importer.js';
import { enqueue } from '../jobs/queue.js';
import { configuredProviders, listModels } from '../providers/index.js';
import { getMorph } from '../morph/index.js';
import { pricing, setPricing, estimateRun } from '../core/cost.js';
import { splitWork, SPLIT_MODES } from '../library/ingest.js';
import { search, citationOf } from '../core/retrieval.js';
import { ledgerFor, userUpsert, acceptPending, rollback } from '../core/ledger.js';
import { promotionProposals, promote } from '../core/learning.js';
import { nextComparison, judge, manualEdit } from '../core/review.js';
import { repeatedPassages } from '../core/memory.js';
import { exportChapter } from '../export/index.js';
import { bus } from '../events.js';
import { estimateTokens } from '../core/context.js';
import { greekWords } from '../core/integrity.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
// Uploaded text is decoded as UTF-8 and never normalized.
const fileText = (req) => (req.file ? req.file.buffer.toString('utf8') : null);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const int = (v) => (v == null || v === '' ? null : Number(v));


// Insert chunks in batches of 500, so a large lexicon file loads in seconds.
async function insertChunks(workId, chunks, startOrd) {
  for (let i = 0; i < chunks.length; i += 500) {
    const b = chunks.slice(i, i + 500);
    await q(`INSERT INTO reference_chunks (work_id, ord, ref, ref_key, heading, text, search_key, lemma_keys, topics)
             SELECT $1, o, r, rk, h, t, sk, string_to_array(lk, '|'), string_to_array(tp, '|')
               FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]) AS x(o, r, rk, h, t, sk, lk, tp)`,
      [workId, b.map((_, j) => startOrd + i + j + 1), b.map((c) => c.ref), b.map((c) => c.ref_key), b.map((c) => c.heading), b.map((c) => c.text),
        b.map((c) => c.search_key), b.map((c) => c.lemma_keys.join('|')), b.map((c) => c.topics.join('|'))]);
  }
}

export function apiRouter() {
  const r = express.Router();

  // ---------- session ----------
  r.post('/login', (req, res) => {
    if (!config.password || req.body?.password === config.password) {
      res.cookie('syz', sha256(config.sessionSecret + config.password), { httpOnly: true, sameSite: 'lax', signed: true, maxAge: 1000 * 60 * 60 * 24 * 60 });
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Wrong password' });
  });
  r.post('/logout', (req, res) => { res.clearCookie('syz'); res.json({ ok: true }); });
  r.use((req, res, next) => {
    if (!config.password) return next();
    if (req.signedCookies?.syz === sha256(config.sessionSecret + config.password)) return next();
    if (req.path === '/session') return res.json({ authenticated: false, passwordRequired: true });
    res.status(401).json({ error: 'Sign in required' });
  });
  r.get('/session', (req, res) => res.json({ authenticated: true, passwordRequired: Boolean(config.password) }));

  // ---------- meta ----------
  r.get('/meta', wrap(async (req, res) => {
    res.json({
      providers: configuredProviders(),
      parser: getMorph().available,
      embeddings: config.embeddings.provider || null,
      charter: CHARTER,
      phases: Object.fromEntries(Object.entries(PHASES).map(([k, v]) => [k, { agent: v.agent, title: v.title }])),
      splitModes: SPLIT_MODES,
      limits: config.limits,
    });
  }));
  r.get('/models/:provider', wrap(async (req, res) => res.json(await listModels(req.params.provider))));
  r.get('/pricing', wrap(async (req, res) => res.json(await pricing())));
  r.put('/pricing', wrap(async (req, res) => { await setPricing(req.body || {}); res.json(await pricing()); }));
  r.post('/inspect', (req, res) => res.json({ codepoints: codepoints(String(req.body?.text || '')), warnings: encodingWarnings(String(req.body?.text || '')) }));

  // ---------- corpus profiles ----------
  r.get('/corpus-profiles', wrap(async (req, res) => res.json(await all('SELECT * FROM corpus_profiles ORDER BY name'))));
  r.post('/corpus-profiles', wrap(async (req, res) => res.json(await one('INSERT INTO corpus_profiles (name, description) VALUES ($1,$2) RETURNING *', [req.body.name, req.body.description || '']))));

  // ---------- projects ----------
  r.get('/projects', wrap(async (req, res) => {
    const projects = await all(`SELECT p.id, p.title, p.author, p.dialect, p.corpus_profile_id, p.work_hash IS NOT NULL AS has_work, p.created_at,
        (SELECT json_agg(json_build_object('id', c.id, 'ord', c.ord, 'title', c.title,
           'verses', (SELECT count(*) FROM verses v WHERE v.chapter_id = c.id),
           'done', (SELECT count(*) FROM verses v WHERE v.chapter_id = c.id AND v.final_rendering IS NOT NULL),
           'running', EXISTS (SELECT 1 FROM runs r WHERE r.chapter_id = c.id AND r.status IN ('queued','running')))
           ORDER BY c.ord) FROM chapters c WHERE c.project_id = p.id) AS chapters
      FROM projects p ORDER BY p.created_at DESC`);
    res.json(projects.map((p) => ({ ...p, chapters: p.chapters || [] })));
  }));
  r.post('/projects', wrap(async (req, res) => {
    const { title, author = '', work = '', dialect = 'attic', corpus_profile_id = null } = req.body;
    res.json(await one('INSERT INTO projects (title, author, work, dialect, corpus_profile_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, title, author, dialect, corpus_profile_id', [title, author, work, dialect, int(corpus_profile_id)]));
  }));
  r.get('/projects/:id', wrap(async (req, res) => {
    const p = await one(`SELECT id, title, author, work, dialect, corpus_profile_id, work_hash, work_tokens, length(work_raw) AS work_chars, created_at FROM projects WHERE id = $1`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    p.chapters = await all(`SELECT c.id, c.ord, c.title, c.source_hash, c.dialect, c.warnings,
        (SELECT count(*)::int FROM verses v WHERE v.chapter_id = c.id) AS verses,
        (SELECT count(*)::int FROM verses v WHERE v.chapter_id = c.id AND v.final_rendering IS NOT NULL) AS done,
        (SELECT count(*)::int FROM verses v WHERE v.chapter_id = c.id AND v.status = 'disputed') AS disputed,
        (SELECT count(*)::int FROM verses v WHERE v.chapter_id = c.id AND v.needs_review) AS review
      FROM chapters c WHERE c.project_id = $1 ORDER BY c.ord`, [req.params.id]);
    p.work_tokens_estimate = p.work_chars ? estimateTokens((await one('SELECT work_raw FROM projects WHERE id = $1', [p.id])).work_raw) : null;
    if (p.work_hash) {
      const raw = (await one('SELECT work_raw FROM projects WHERE id = $1', [p.id])).work_raw;
      p.work_verified = verifyHash(raw, p.work_hash);
    }
    res.json(p);
  }));
  r.patch('/projects/:id', wrap(async (req, res) => {
    const cur = await one('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    const b = { ...cur, ...req.body };
    res.json(await one('UPDATE projects SET title=$2, author=$3, work=$4, dialect=$5, corpus_profile_id=$6 WHERE id=$1 RETURNING id, title, author, work, dialect, corpus_profile_id',
      [cur.id, b.title, b.author, b.work, b.dialect, int(b.corpus_profile_id)]));
  }));
  r.delete('/projects/:id', wrap(async (req, res) => { await q('DELETE FROM projects WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
  r.post('/projects/:id/work', upload.single('file'), wrap(async (req, res) => {
    const raw = fileText(req) ?? req.body.raw;
    if (!raw?.trim()) return res.status(400).json({ error: 'No text received' });
    const out = await importWork(Number(req.params.id), raw, req.file ? 'upload' : 'paste');
    await enqueue('index_project', { projectId: Number(req.params.id) });
    res.json(out);
  }));
  r.get('/projects/:id/work', wrap(async (req, res) => {
    const p = await one('SELECT work_raw, work_hash FROM projects WHERE id = $1', [req.params.id]);
    res.json({ raw: p.work_raw, hash: p.work_hash, verified: p.work_raw ? verifyHash(p.work_raw, p.work_hash) : null });
  }));
  r.post('/projects/:id/chapters', upload.single('file'), wrap(async (req, res) => {
    const raw = fileText(req) ?? req.body.raw;
    if (!raw?.trim()) return res.status(400).json({ error: 'No text received' });
    const out = await importChapter(Number(req.params.id), { title: req.body.title, ord: int(req.body.ord), raw, via: req.file ? 'upload' : 'paste', dialect: req.body.dialect || null });
    await enqueue('index_project', { projectId: Number(req.params.id) });
    res.json(out);
  }));
  r.post('/projects/:id/dialect-suggest', wrap(async (req, res) => {
    const verses = await all('SELECT v.source FROM verses v JOIN chapters c ON c.id = v.chapter_id WHERE c.project_id = $1 LIMIT 400', [req.params.id]);
    const p = await one('SELECT work_raw FROM projects WHERE id = $1', [req.params.id]);
    const texts = verses.length ? verses.map((v) => v.source) : [p?.work_raw || ''];
    const parses = [];
    if (getMorph().available) for (const t of texts.slice(0, 40)) parses.push(await getMorph().analyzeText(t));
    res.json(suggestDialect(texts, parses));
  }));
  r.post('/projects/:id/index', wrap(async (req, res) => res.json(await enqueue('index_project', { projectId: Number(req.params.id) }))));

  // ---------- study notes / reading pass ----------
  r.post('/projects/:id/reading-pass', wrap(async (req, res) => {
    const ids = [];
    for (const agentId of req.body.agentIds || []) ids.push((await one('SELECT current_version_id FROM agents WHERE id = $1', [agentId])).current_version_id);
    res.json(await enqueue('reading_pass', { projectId: Number(req.params.id), agentVersionIds: ids }));
  }));
  r.get('/projects/:id/study-notes', wrap(async (req, res) => res.json(await all('SELECT * FROM study_notes WHERE project_id = $1 ORDER BY id DESC', [req.params.id]))));
  r.post('/study-notes/:id/:action', wrap(async (req, res) => {
    if (!['approve', 'reject'].includes(req.params.action)) return res.status(404).json({ error: 'Unknown action' });
    const n = await one('SELECT * FROM study_notes WHERE id = $1', [req.params.id]);
    if (req.params.action === 'reject') { await q(`UPDATE study_notes SET status = 'rejected' WHERE id = $1`, [n.id]); return res.json({ ok: true }); }
    const notes = req.body?.notes || n.notes;
    await q(`UPDATE study_notes SET status = 'approved', notes = $2 WHERE id = $1`, [n.id, JSON.stringify(notes)]);
    let terms = 0, styles = 0;
    for (const t of notes.terms || []) {
      if (!t.lemma || !t.proposed) continue;
      const key = lookupKey(t.lemma);
      const exists = await one(`SELECT id FROM ledger_entries WHERE project_id = $1 AND lemma_key = $2`, [n.project_id, key]);
      if (!exists) { await q(`INSERT INTO ledger_entries (tier, project_id, lemma, lemma_key, rendering, note, created_by) VALUES ('book',$1,$2,$3,$4,$5,'agent')`, [n.project_id, t.lemma, key, t.proposed, t.note || '']); terms++; }
    }
    for (const s of notes.style_conventions || []) { await q(`INSERT INTO style_sheet_entries (tier, project_id, rule, status, proposer) VALUES ('book',$1,$2,'active','reading pass')`, [n.project_id, s]); styles++; }
    for (const qt of notes.quotations || []) {
      const gk = greekWords(qt.greek || '').join(' ');
      if (gk.split(' ').length >= 3) await q(`INSERT INTO quotations (project_id, source_ref, greek_key, marked_by) VALUES ($1,$2,$3,'reading pass')`, [n.project_id, qt.source, gk]);
    }
    res.json({ ok: true, terms, styles });
  }));

  // ---------- chapters & verses ----------
  r.get('/chapters/:id', wrap(async (req, res) => {
    const chapter = await one('SELECT id, project_id, ord, title, source_hash, dialect, warnings, imported_via, created_at FROM chapters WHERE id = $1', [req.params.id]);
    if (!chapter) return res.status(404).json({ error: 'Not found' });
    const raw = (await one('SELECT source_raw FROM chapters WHERE id = $1', [chapter.id])).source_raw;
    chapter.verified = verifyHash(raw, chapter.source_hash);
    chapter.verses = await all(`SELECT v.id, v.num, v.ord, v.source, v.status, v.final_rendering, v.needs_review, v.review_reason, v.locked_by_user, v.dialect_override, v.current_version_id,
        (SELECT count(*)::int FROM verse_versions vv WHERE vv.verse_id = v.id) AS versions
      FROM verses v WHERE v.chapter_id = $1 ORDER BY v.ord`, [chapter.id]);
    chapter.runs = await all(`SELECT r.*, aa.name AS a_name, va.model AS a_model, ab.name AS b_name, vb.model AS b_model, aa.id AS a_agent_id, ab.id AS b_agent_id,
        (SELECT count(*)::int FROM verse_versions vv WHERE vv.run_id = r.id) AS verses_done FROM runs r
        JOIN agent_versions va ON va.id = r.agent_a_version_id JOIN agents aa ON aa.id = va.agent_id
        JOIN agent_versions vb ON vb.id = r.agent_b_version_id JOIN agents ab ON ab.id = vb.agent_id
       WHERE r.chapter_id = $1 ORDER BY r.id DESC`, [chapter.id]);
    chapter.synthesisRate = (await one(`SELECT count(*) FILTER (WHERE status IN ('synthesized','disputed'))::float / greatest(count(*),1) AS r FROM verses WHERE chapter_id = $1 AND final_rendering IS NOT NULL`, [chapter.id])).r;
    res.json(chapter);
  }));
  r.get('/chapters/:id/source', wrap(async (req, res) => {
    const c = await one('SELECT source_raw, source_hash FROM chapters WHERE id = $1', [req.params.id]);
    res.json({ raw: c.source_raw, hash: c.source_hash, verified: verifyHash(c.source_raw, c.source_hash) });
  }));
  r.get('/chapters/:id/versions', wrap(async (req, res) => {
    res.json(await all(`SELECT v.id AS verse_id, v.num, v.source, json_agg(json_build_object('id', vv.id, 'origin', vv.origin, 'status', vv.status, 'rendering', vv.rendering, 'run_id', vv.run_id, 'created_at', vv.created_at, 'current', vv.id = v.current_version_id) ORDER BY vv.id) AS versions
      FROM verses v JOIN verse_versions vv ON vv.verse_id = v.id WHERE v.chapter_id = $1 GROUP BY v.id ORDER BY v.ord`, [req.params.id]));
  }));
  r.post('/chapters/:id/reference', wrap(async (req, res) => {
    // Evaluation-only reference translation: numbered lines "1 text". Never shown to agents.
    let n = 0;
    for (const line of String(req.body.text || '').split('\n')) {
      const m = line.match(/^\s*(?:\[(\d+[a-z]?)\]|(\d+[a-z]?)[.)]?)\s+(.+)$/);
      if (!m) continue;
      await q(`INSERT INTO reference_translations (chapter_id, verse_num, rendering, source) VALUES ($1,$2,$3,$4) ON CONFLICT (chapter_id, verse_num, source) DO UPDATE SET rendering = $3`,
        [req.params.id, m[1] || m[2], m[3].trim(), req.body.source || 'Loshem']);
      n++;
    }
    res.json({ imported: n });
  }));
  r.get('/chapters/:id/export', wrap(async (req, res) => {
    const b = (k, d) => (req.query[k] == null ? d : req.query[k] === '1' || req.query[k] === 'true');
    const out = await exportChapter(Number(req.params.id), req.query.format || 'pdf', {
      layout: req.query.layout || 'facing',
      apparatus: { dissent: b('dissent', true), preference: b('preference', false), ledger: b('ledger', true), variant: b('variant', true), citation: b('citation', false) },
      glossary: b('glossary', true), provenance: b('provenance', true),
    });
    res.setHeader('Content-Type', out.type);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.name)}`);
    res.send(out.body);
  }));

  r.get('/verses/:id', wrap(async (req, res) => {
    const verse = await one('SELECT v.*, c.ord AS chapter_ord, c.project_id FROM verses v JOIN chapters c ON c.id = v.chapter_id WHERE v.id = $1', [req.params.id]);
    verse.versions = await all('SELECT * FROM verse_versions WHERE verse_id = $1 ORDER BY id DESC', [verse.id]);
    verse.apparatus = await all('SELECT * FROM apparatus_notes WHERE verse_id = $1 ORDER BY id', [verse.id]);
    const runId = req.query.runId || (await one('SELECT run_id FROM turns WHERE verse_id = $1 ORDER BY id DESC LIMIT 1', [verse.id]))?.run_id;
    verse.turns = runId ? await all('SELECT * FROM turns WHERE verse_id = $1 AND run_id = $2 ORDER BY id', [verse.id, runId]) : [];
    verse.lemmas = await all('SELECT lemma, form FROM verse_lemmas WHERE verse_id = $1', [verse.id]);
    verse.retrievals = runId ? await all(`SELECT rl.source, rl.phase, rl.agent, rl.query, rl.cited, rl.triggers, c.ref, w.short FROM retrieval_log rl JOIN reference_chunks c ON c.id = rl.chunk_id JOIN library_works w ON w.id = c.work_id WHERE rl.verse_id = $1 AND rl.run_id = $2 ORDER BY rl.id`, [verse.id, runId]) : [];
    res.json(verse);
  }));
  r.patch('/verses/:id', wrap(async (req, res) => {
    const cur = await one('SELECT * FROM verses WHERE id = $1', [req.params.id]);
    const b = { ...cur, ...req.body };
    res.json(await one('UPDATE verses SET dialect_override = $2, locked_by_user = $3 WHERE id = $1 RETURNING id, dialect_override, locked_by_user', [cur.id, b.dialect_override || null, Boolean(b.locked_by_user)]));
  }));
  r.post('/verses/:id/edit', wrap(async (req, res) => res.json(await manualEdit(Number(req.params.id), req.body.rendering, req.body.note || ''))));
  r.post('/verses/:id/version/:versionId/restore', wrap(async (req, res) => {
    const v = await one('SELECT * FROM verse_versions WHERE id = $1 AND verse_id = $2', [req.params.versionId, req.params.id]);
    await q('UPDATE verses SET final_rendering = $2, current_version_id = $3, status = coalesce($4, status) WHERE id = $1', [req.params.id, v.rendering, v.id, ['agreed', 'synthesized', 'disputed'].includes(v.status) ? v.status : null]);
    res.json({ ok: true });
  }));

  // ---------- runs ----------
  const currentVersion = async (agentId) => (await one('SELECT current_version_id FROM agents WHERE id = $1', [agentId]))?.current_version_id;
  r.post('/runs', wrap(async (req, res) => {
    const b = req.body;
    const va = await currentVersion(b.agentA);
    const vb = await currentVersion(b.agentB);
    if (!va || !vb) return res.status(400).json({ error: 'Choose two agents' });
    let verseFilter = null;
    if (b.verseIds?.length) {
      verseFilter = b.verseIds.map(Number);
      if (b.note) for (const id of verseFilter) await q('UPDATE verses SET needs_review = true, review_reason = $2 WHERE id = $1', [id, b.note]);
    }
    const run = await one(`INSERT INTO runs (chapter_id, agent_a_version_id, agent_b_version_id, utility_provider, utility_model, escalate_mode, learned_rules, benchmark, budget_usd, verse_filter, rerun_note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.chapterId, va, vb, b.utilityProvider || null, b.utilityModel || null, b.escalateMode || 'auto', b.learnedRules !== false, Boolean(b.benchmark), b.budgetUsd ? Number(b.budgetUsd) : null, verseFilter, b.note || null]);
    await enqueue('run_chapter', { runId: run.id });
    res.json(run);
  }));
  r.post('/runs/estimate', wrap(async (req, res) => {
    const b = req.body;
    const ch = await one('SELECT c.*, p.work_raw, p.work_tokens FROM chapters c JOIN projects p ON p.id = c.project_id WHERE c.id = $1', [b.chapterId]);
    const verses = (await one('SELECT count(*)::int AS n FROM verses WHERE chapter_id = $1', [ch.id])).n;
    const workTokens = ch.work_tokens || estimateTokens(ch.work_raw || ch.source_raw);
    const done = (await one(`SELECT coalesce(sum(length(final_rendering)),0)::int AS c FROM verses v JOIN chapters c ON c.id = v.chapter_id WHERE c.project_id = $1`, [ch.project_id])).c;
    const contextTokens = workTokens + Math.ceil(done / 3.8) + 9000;
    const prices = await pricing();
    const aModel = b.agentA ? (await one('SELECT v.model FROM agents a JOIN agent_versions v ON v.id = a.current_version_id WHERE a.id = $1', [b.agentA]))?.model : null;
    const bModel = b.agentB ? (await one('SELECT v.model FROM agents a JOIN agent_versions v ON v.id = a.current_version_id WHERE a.id = $1', [b.agentB]))?.model : null;
    res.json({ verses, workTokens, measured: Boolean(ch.work_tokens), contextTokens, usd: estimateRun({ verses, contextTokens, priceA: prices[aModel], priceB: prices[bModel] }), priced: Boolean(prices[aModel] && prices[bModel]) });
  }));
  r.get('/runs/:id', wrap(async (req, res) => {
    const run = await one('SELECT * FROM runs WHERE id = $1', [req.params.id]);
    run.turns = await all('SELECT id, verse_id, phase, agent, model, escalated, cost_usd, tokens_in, tokens_out, tokens_cached, context_meter, created_at FROM turns WHERE run_id = $1 ORDER BY id', [run.id]);
    res.json(run);
  }));
  r.post('/runs/:id/:action', wrap(async (req, res) => {
    const { action } = req.params;
    if (!['pause', 'resume', 'cancel'].includes(action)) return res.status(404).json({ error: 'Unknown action' });
    if (action === 'pause') await q(`UPDATE runs SET status = 'paused', pause_reason = 'Paused by Loshem' WHERE id = $1 AND status IN ('queued','running')`, [req.params.id]);
    if (action === 'cancel') await q(`UPDATE runs SET status = 'cancelled' WHERE id = $1 AND status <> 'done'`, [req.params.id]);
    if (action === 'resume') {
      const run = await one(`UPDATE runs SET status = 'queued', pause_reason = NULL, error = NULL WHERE id = $1 AND status IN ('paused','failed') RETURNING *`, [req.params.id]);
      if (run) await enqueue('run_chapter', { runId: run.id });
    }
    res.json(await one('SELECT * FROM runs WHERE id = $1', [req.params.id]));
  }));
  r.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const runId = req.query.runId ? Number(req.query.runId) : null;
    const send = (e) => { if (!runId || e.runId === runId) res.write(`data: ${JSON.stringify(e)}\n\n`); };
    bus.on('event', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { bus.off('event', send); clearInterval(ping); });
  });

  // ---------- agents ----------
  r.get('/agents', wrap(async (req, res) => {
    res.json(await all(`SELECT a.id, a.name, a.created_at, row_to_json(v) AS current,
        (SELECT json_agg(json_build_object('id', x.id, 'version', x.version, 'model', x.model, 'created_at', x.created_at) ORDER BY x.version DESC) FROM agent_versions x WHERE x.agent_id = a.id) AS versions,
        (SELECT json_agg(json_build_object('id', w.id, 'title', w.title, 'short', w.short)) FROM library_works w WHERE w.agent_id = a.id) AS files
      FROM agents a LEFT JOIN agent_versions v ON v.id = a.current_version_id ORDER BY a.id`));
  }));
  const saveVersion = async (agentId, b) => {
    const n = (await one('SELECT coalesce(max(version),0)+1 AS n FROM agent_versions WHERE agent_id = $1', [agentId])).n;
    const v = await one(`INSERT INTO agent_versions (agent_id, version, provider, model, escalation_provider, escalation_model, instructions, temperament, temperature)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [agentId, n, b.provider, b.model, b.escalation_provider || null, b.escalation_model || null, b.instructions || '', b.temperament || '', b.temperature === '' || b.temperature == null ? null : Number(b.temperature)]);
    await q('UPDATE agents SET current_version_id = $2, name = coalesce($3, name) WHERE id = $1', [agentId, v.id, b.name || null]);
    return v;
  };
  r.post('/agents', wrap(async (req, res) => {
    const a = await one('INSERT INTO agents (name) VALUES ($1) RETURNING *', [req.body.name]);
    await saveVersion(a.id, req.body);
    res.json(a);
  }));
  r.put('/agents/:id', wrap(async (req, res) => res.json(await saveVersion(Number(req.params.id), req.body))));
  r.delete('/agents/:id', wrap(async (req, res) => {
    const used = await one('SELECT 1 FROM runs r JOIN agent_versions v ON v.id IN (r.agent_a_version_id, r.agent_b_version_id) WHERE v.agent_id = $1 LIMIT 1', [req.params.id]);
    if (used) return res.status(400).json({ error: 'This agent has runs on record; it is kept for provenance.' });
    await q('DELETE FROM agents WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- library ----------
  r.get('/library', wrap(async (req, res) => {
    res.json(await all(`SELECT w.*, (SELECT count(*)::int FROM reference_chunks c WHERE c.work_id = w.id) AS chunks,
        (SELECT count(*)::int FROM reference_chunks c WHERE c.work_id = w.id AND c.verified) AS verified,
        (SELECT count(*)::int FROM reference_chunks c WHERE c.work_id = w.id AND c.embedding IS NOT NULL) AS embedded
      FROM library_works w ORDER BY w.scope, w.kind, w.title`));
  }));
  r.post('/library', upload.single('file'), wrap(async (req, res) => {
    const raw = fileText(req) ?? req.body.raw;
    if (!raw?.trim()) return res.status(400).json({ error: 'No text received' });
    const b = req.body;
    const chunks = splitWork(raw, b.split_mode || 'paragraph');
    if (!chunks.length) return res.status(400).json({ error: 'Nothing could be split from that text with the chosen mode.' });
    const work = await one(`INSERT INTO library_works (title, short, kind, scope, agent_id, dialect, split_mode) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [String(b.title || '').trim(), String(b.short || '').trim(), b.kind, b.scope || 'shared', int(b.agent_id), b.dialect || null, b.split_mode || 'paragraph']);
    await insertChunks(work.id, chunks, 0);
    if (config.embeddings.provider && !['lexicon'].includes(work.kind)) await enqueue('embed_work', { workId: work.id });
    res.json({ work, chunks: chunks.length, sample: chunks.slice(0, 3).map((c) => ({ ref: c.ref, text: c.text.slice(0, 300) })) });
  }));
  // Add another file to an existing work, e.g. LSJ's 27 files, one letter each.
  r.post('/library/:id/append', upload.single('file'), wrap(async (req, res) => {
    const work = await one('SELECT * FROM library_works WHERE id = $1', [req.params.id]);
    if (!work) return res.status(404).json({ error: 'Not found' });
    const raw = fileText(req) ?? req.body.raw;
    if (!raw?.trim()) return res.status(400).json({ error: 'No text received' });
    const chunks = splitWork(raw, work.split_mode);
    if (!chunks.length) return res.status(400).json({ error: 'Nothing could be split from that text with this work\'s split mode.' });
    const start = (await one('SELECT coalesce(max(ord),0)::int AS n FROM reference_chunks WHERE work_id = $1', [work.id])).n;
    await insertChunks(work.id, chunks, start);
    if (config.embeddings.provider && !['lexicon'].includes(work.kind)) await enqueue('embed_work', { workId: work.id });
    const total = (await one('SELECT count(*)::int AS n FROM reference_chunks WHERE work_id = $1', [work.id])).n;
    res.json({ work, chunks: chunks.length, total, sample: chunks.slice(0, 3).map((c) => ({ ref: c.ref, text: c.text.slice(0, 300) })) });
  }));
  r.patch('/library/:id', wrap(async (req, res) => {
    const cur = await one('SELECT * FROM library_works WHERE id = $1', [req.params.id]);
    const b = { ...cur, ...req.body };
    res.json(await one('UPDATE library_works SET title=$2, short=$3, kind=$4, scope=$5, agent_id=$6, dialect=$7 WHERE id=$1 RETURNING *', [cur.id, b.title, b.short, b.kind, b.scope, int(b.agent_id), b.dialect || null]));
  }));
  r.delete('/library/:id', wrap(async (req, res) => { await q('DELETE FROM library_works WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
  r.get('/library/:id/chunks', wrap(async (req, res) => {
    const off = Number(req.query.offset || 0);
    const rows = req.query.q
      ? await all(`SELECT id, ord, ref, heading, left(text, 600) AS text, verified FROM reference_chunks WHERE work_id = $1 AND search_key LIKE '%' || $2 || '%' ORDER BY ord LIMIT 50`, [req.params.id, lookupKey(req.query.q)])
      : await all(`SELECT id, ord, ref, heading, left(text, 600) AS text, verified FROM reference_chunks WHERE work_id = $1 ORDER BY ord OFFSET $2 LIMIT 50`, [req.params.id, off]);
    res.json(rows);
  }));
  r.get('/library/:id/spotcheck', wrap(async (req, res) => res.json(await all(`SELECT id, ref, heading, text FROM reference_chunks WHERE work_id = $1 AND NOT verified ORDER BY random() LIMIT 5`, [req.params.id]))));
  r.patch('/chunks/:id', wrap(async (req, res) => {
    const c = await one('SELECT * FROM reference_chunks WHERE id = $1', [req.params.id]);
    const text = req.body.text ?? c.text;
    res.json(await one(`UPDATE reference_chunks SET text = $2, search_key = $3, verified = $4 WHERE id = $1 RETURNING id, ref, verified`,
      [c.id, text, lookupKey(`${c.heading} ${c.ref} ${text}`), req.body.verified ?? c.verified]));
  }));
  r.post('/library/search', wrap(async (req, res) => {
    const works = await all(`SELECT id FROM library_works WHERE scope <> 'evaluation'`);
    const hits = await search(req.body.query, { workIds: works.map((w) => w.id), limit: 10 });
    res.json(hits.map((h) => ({ id: h.id, citation: citationOf(h), heading: h.heading, text: h.text.slice(0, 1200) })));
  }));

  // ---------- ledger & style ----------
  r.get('/projects/:id/ledger', wrap(async (req, res) => {
    const project = await one('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    const entries = await ledgerFor(project);
    const changes = await all(`SELECT lc.*, ch.ord AS chapter_ord, v.num AS verse_num FROM ledger_changes lc LEFT JOIN chapters ch ON ch.id = lc.chapter_id LEFT JOIN verses v ON v.id = lc.verse_id
      WHERE lc.entry_id IN (SELECT id FROM ledger_entries WHERE project_id = $1) OR ch.project_id = $1 ORDER BY lc.id DESC LIMIT 300`, [project.id]);
    res.json({ entries, changes });
  }));
  r.post('/projects/:id/ledger', wrap(async (req, res) => res.json(await userUpsert({ projectId: Number(req.params.id), ...req.body }))));
  r.post('/projects/:id/ledger/import', wrap(async (req, res) => {
    // one entry per line: "λόγος = reason; account | note"
    let n = 0;
    for (const line of String(req.body.text || '').split('\n')) {
      const m = line.match(/^\s*([^=]+?)\s*=\s*([^|]+?)\s*(?:\|\s*(.*))?$/);
      if (!m) continue;
      const [first, ...alts] = m[2].split(';').map((s) => s.trim()).filter(Boolean);
      await userUpsert({ projectId: Number(req.params.id), lemma: m[1], rendering: first, alternatives: alts, note: m[3] || '', locked: req.body.locked !== false });
      n++;
    }
    res.json({ imported: n });
  }));
  r.patch('/ledger/:id', wrap(async (req, res) => {
    const e = await one('SELECT * FROM ledger_entries WHERE id = $1', [req.params.id]);
    if (req.body.rendering && req.body.rendering !== e.rendering) {
      await q(`INSERT INTO ledger_changes (entry_id, lemma, old_rendering, new_rendering, proposer, status, reason) VALUES ($1,$2,$3,$4,'user','applied','Edited by Loshem')`, [e.id, e.lemma, e.rendering, req.body.rendering]);
    }
    const b = { ...e, ...req.body };
    res.json(await one('UPDATE ledger_entries SET rendering=$2, alternatives=$3, note=$4, locked=$5, status=$6 WHERE id=$1 RETURNING *', [e.id, b.rendering, b.alternatives, b.note, b.locked, b.status === 'suggestion' && req.body.adopt ? 'active' : b.status]));
  }));
  r.delete('/ledger/:id', wrap(async (req, res) => { await q('DELETE FROM ledger_entries WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
  r.post('/ledger/changes/:id/:action', wrap(async (req, res) => {
    if (!['accept', 'rollback', 'reject'].includes(req.params.action)) return res.status(404).json({ error: 'Unknown action' });
    if (req.params.action === 'accept') return res.json(await acceptPending(Number(req.params.id)));
    if (req.params.action === 'rollback') return res.json(await rollback(Number(req.params.id)));
    res.json(await one(`UPDATE ledger_changes SET status = 'refused', reason = 'Rejected by Loshem' WHERE id = $1 AND status = 'pending' RETURNING *`, [req.params.id]));
  }));
  r.get('/projects/:id/style', wrap(async (req, res) => {
    const p = await one('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    res.json(await all(`SELECT * FROM style_sheet_entries WHERE (tier = 'book' AND project_id = $1) OR (tier = 'corpus' AND corpus_profile_id = $2) OR tier = 'global' ORDER BY status, id`, [p.id, p.corpus_profile_id]));
  }));
  r.post('/projects/:id/style', wrap(async (req, res) => res.json(await one(`INSERT INTO style_sheet_entries (tier, project_id, rule, status, proposer) VALUES ('book',$1,$2,'active','user') RETURNING *`, [req.params.id, req.body.rule]))));
  r.patch('/style/:id', wrap(async (req, res) => {
    const s = await one('SELECT * FROM style_sheet_entries WHERE id = $1', [req.params.id]);
    const b = { ...s, ...req.body };
    res.json(await one('UPDATE style_sheet_entries SET rule = $2, status = $3 WHERE id = $1 RETURNING *', [s.id, b.rule, b.status]));
  }));
  r.delete('/style/:id', wrap(async (req, res) => { await q('DELETE FROM style_sheet_entries WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));

  // ---------- quotations ----------
  r.get('/projects/:id/quotations', wrap(async (req, res) => res.json(await all(`SELECT qt.*, v.num AS verse_num, ch.ord AS chapter_ord FROM quotations qt LEFT JOIN verses v ON v.id = qt.first_verse_id LEFT JOIN chapters ch ON ch.id = v.chapter_id WHERE qt.project_id = $1 ORDER BY qt.id`, [req.params.id]))));
  r.post('/projects/:id/quotations', wrap(async (req, res) => {
    const gk = greekWords(req.body.greek || '').join(' ');
    res.json(await one(`INSERT INTO quotations (project_id, source_ref, greek_key, rendering, marked_by) VALUES ($1,$2,$3,$4,'user') RETURNING *`, [req.params.id, req.body.source, gk, req.body.rendering || null]));
  }));
  r.delete('/quotations/:id', wrap(async (req, res) => { await q('DELETE FROM quotations WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
  r.post('/projects/:id/quotations/detect', wrap(async (req, res) => {
    const verses = await all('SELECT v.id, v.num, v.source, ch.ord FROM verses v JOIN chapters ch ON ch.id = v.chapter_id WHERE ch.project_id = $1 ORDER BY ch.ord, v.ord', [req.params.id]);
    const hits = repeatedPassages(verses, Number(req.body?.n || 5));
    const byId = new Map(verses.map((v) => [v.id, `${v.ord}.${v.num}`]));
    const seen = new Set();
    res.json(hits.filter((h) => (seen.has(h.greek) ? false : seen.add(h.greek))).slice(0, 100).map((h) => ({ greek: h.greek, first: byId.get(h.first), again: byId.get(h.again) })));
  }));

  // ---------- knowledge ----------
  r.get('/knowledge', wrap(async (req, res) => {
    const projectId = int(req.query.projectId);
    const rules = await all(`SELECT r.*, w.short AS work_short, p.title AS project_title, cp.name AS corpus_name FROM prefetch_rules r
        LEFT JOIN library_works w ON w.id = r.target_work_id LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN corpus_profiles cp ON cp.id = r.corpus_profile_id
       WHERE r.tier IN ('core','global','corpus') OR r.project_id = $1 ORDER BY CASE r.tier WHEN 'core' THEN 0 WHEN 'global' THEN 1 WHEN 'corpus' THEN 2 ELSE 3 END, r.status, r.cites DESC, r.id`, [projectId]);
    const proposals = projectId ? await promotionProposals(await one('SELECT * FROM projects WHERE id = $1', [projectId])) : [];
    const ledgerTiers = await all(`SELECT e.*, cp.name AS corpus_name FROM ledger_entries e LEFT JOIN corpus_profiles cp ON cp.id = e.corpus_profile_id WHERE e.tier IN ('corpus','global') ORDER BY e.tier, e.lemma`);
    const styleTiers = await all(`SELECT s.*, cp.name AS corpus_name FROM style_sheet_entries s LEFT JOIN corpus_profiles cp ON cp.id = s.corpus_profile_id WHERE s.tier IN ('corpus','global') ORDER BY s.tier, s.id`);
    res.json({ rules, proposals, ledgerTiers, styleTiers });
  }));
  r.post('/knowledge/promote', wrap(async (req, res) => res.json(await promote({ ...req.body, corpusProfileId: int(req.body.corpusProfileId) }))));
  r.post('/rules', wrap(async (req, res) => {
    const b = req.body;
    res.json(await one(`INSERT INTO prefetch_rules (tier, project_id, corpus_profile_id, trigger_type, trigger_value, target_kind, target_work_kind, target_work_id, target_ref, query, max_chunks, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Written by Loshem') RETURNING *`,
      [b.tier || 'book', int(b.projectId), int(b.corpusProfileId), b.trigger_type, b.trigger_value, b.target_kind, b.target_work_kind || null, int(b.target_work_id), b.target_ref || null, b.query || null, Number(b.max_chunks || 2)]));
  }));
  r.patch('/rules/:id', wrap(async (req, res) => {
    const rule = await one('SELECT * FROM prefetch_rules WHERE id = $1', [req.params.id]);
    if (rule.tier === 'core' && req.body.status && req.body.status !== 'active') return res.status(400).json({ error: 'Core rules are fixed; learning can add to the pre-fetch, never remove the core.' });
    res.json(await one('UPDATE prefetch_rules SET status = coalesce($2, status), query = coalesce($3, query), max_chunks = coalesce($4, max_chunks) WHERE id = $1 RETURNING *', [rule.id, req.body.status, req.body.query, req.body.max_chunks]));
  }));
  r.delete('/rules/:id', wrap(async (req, res) => {
    const rule = await one('SELECT tier FROM prefetch_rules WHERE id = $1', [req.params.id]);
    if (rule?.tier === 'core') return res.status(400).json({ error: 'Core rules cannot be deleted.' });
    await q('DELETE FROM prefetch_rules WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- leaderboard ----------
  r.get('/leaderboard', wrap(async (req, res) => res.json(await all('SELECT * FROM pairing_ratings ORDER BY rating DESC'))));
  r.get('/projects/:id/compare/next', wrap(async (req, res) => res.json(await nextComparison(Number(req.params.id)))));
  r.post('/comparisons/:id', wrap(async (req, res) => res.json(await judge(Number(req.params.id), req.body.winner))));

  // ---------- backup ----------
  const TABLES = ['settings', 'corpus_profiles', 'projects', 'chapters', 'verses', 'agents', 'agent_versions', 'library_works', 'reference_chunks', 'runs', 'turns', 'verse_versions', 'apparatus_notes', 'ledger_entries', 'ledger_changes', 'style_sheet_entries', 'study_notes', 'chapter_digests', 'verse_lemmas', 'quotations', 'prefetch_rules', 'retrieval_log', 'reference_translations', 'comparisons', 'pairing_ratings'];
  r.get('/backup', wrap(async (req, res) => {
    const out = { app: 'syzygia', version: 1, exported_at: new Date().toISOString(), tables: {} };
    for (const t of TABLES) out.tables[t] = await all(`SELECT * FROM ${t}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="syzygia-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(out));
  }));
  r.post('/backup/restore', upload.single('file'), wrap(async (req, res) => {
    const data = JSON.parse(fileText(req) || '{}');
    if (data.app !== 'syzygia') return res.status(400).json({ error: 'Not a Syzygia backup' });
    const count = (await one('SELECT count(*)::int AS n FROM projects')).n;
    if (count > 0) return res.status(400).json({ error: 'Restore only into an empty installation.' });
    await q('ALTER TABLE chapters DISABLE TRIGGER chapters_guard');
    await q('ALTER TABLE verses DISABLE TRIGGER verses_guard');
    await q('ALTER TABLE projects DISABLE TRIGGER projects_guard');
    await q(`DELETE FROM prefetch_rules; DELETE FROM settings;`);
    const jsonCols = new Set((await all(`SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'jsonb'`)).map((r) => r.k));
    try {
      for (const t of TABLES) {
        for (const row of data.tables[t] || []) {
          const cols = Object.keys(row);
          await q(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
            cols.map((c) => (jsonCols.has(`${t}.${c}`) && row[c] !== null ? JSON.stringify(row[c]) : row[c])));
        }
        await q(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), coalesce((SELECT max(id) FROM ${t}), 1)) WHERE pg_get_serial_sequence('${t}', 'id') IS NOT NULL`).catch(() => {});
      }
    } finally {
      await q('ALTER TABLE chapters ENABLE TRIGGER chapters_guard');
      await q('ALTER TABLE verses ENABLE TRIGGER verses_guard');
      await q('ALTER TABLE projects ENABLE TRIGGER projects_guard');
    }
    res.json({ ok: true });
  }));

  r.use((err, req, res, next) => {
    void next;
    console.error('[api]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  });
  return r;
}
