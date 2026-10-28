import { all, one, q } from '../db/pool.js';
import { registerHandler } from './queue.js';
import { runChapter, workTextFor } from './runChapter.js';
import { READING_PASS_TASK } from '../core/charter.js';
import { systemPrompt } from '../core/context.js';
import { extractJson } from '../core/critique.js';
import { getProvider, embed } from '../providers/index.js';
import { getMorph } from '../morph/index.js';
import { indexVerseLemmas } from '../core/memory.js';
import { config } from '../config.js';

// Reading pass: each agent reads the whole work once and writes study notes.
export async function readingPass({ projectId, agentVersionIds }) {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  const workText = await workTextFor(project);
  const results = [];
  for (const [i, vid] of agentVersionIds.entries()) {
    const agent = await one('SELECT v.*, a.name FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE v.id = $1', [vid]);
    const res = await getProvider(agent.provider).complete({
      model: agent.model,
      system: systemPrompt(agent),
      blocks: [
        { text: `THE WORK (authoritative Greek, exactly as imported)\n${project.title}${project.author ? ` — ${project.author}` : ''}\n<<<GREEK\n${workText}\nGREEK>>>`, cache: true },
        { text: READING_PASS_TASK, cache: false },
      ],
      tools: [], executeTool: async () => '', maxTokens: Math.max(config.limits.maxOutputTokens, 6000),
    });
    const notes = extractJson(res.text) || { raw: res.text };
    const row = await one(`INSERT INTO study_notes (project_id, agent_version_id, agent, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [projectId, vid, `${i === 0 ? 'Agent A' : 'Agent B'} (${agent.name})`, JSON.stringify(notes)]);
    results.push(row);
  }
  return results;
}

// Parse and index every verse of a project, so frequencies and the concordance exist before translation.
export async function indexProject({ projectId }) {
  const morph = getMorph();
  const verses = await all('SELECT v.* FROM verses v JOIN chapters ch ON ch.id = v.chapter_id WHERE ch.project_id = $1 ORDER BY ch.ord, v.ord', [projectId]);
  for (const v of verses) await indexVerseLemmas(v, await morph.analyzeText(v.source));
  return { indexed: verses.length };
}

// Embeddings for prose works (grammars, particle studies, dialect handbooks), for semantic search.
export async function embedWork({ workId }) {
  if (!config.embeddings.provider) return { skipped: 'EMBEDDINGS_PROVIDER not set' };
  const chunks = await all(`SELECT id, heading, text FROM reference_chunks WHERE work_id = $1 AND embedding IS NULL ORDER BY ord`, [workId]);
  for (let i = 0; i < chunks.length; i += 64) {
    const batch = chunks.slice(i, i + 64);
    const vectors = await embed(batch.map((c) => `${c.heading}\n${c.text}`.slice(0, 6000)));
    for (const [j, v] of vectors.entries()) await q('UPDATE reference_chunks SET embedding = $2 WHERE id = $1', [batch[j].id, v]);
  }
  return { embedded: chunks.length };
}

export function registerAll() {
  registerHandler('run_chapter', (p) => runChapter(p.runId));
  registerHandler('reading_pass', readingPass);
  registerHandler('index_project', indexProject);
  registerHandler('embed_work', embedWork);
}
