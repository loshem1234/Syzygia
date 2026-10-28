// Test harness: a fresh Postgres database per test file, scripted mock
// providers, and a static parser table.
import pg from 'pg';
import { setPool, closePool, getPool, one, all, q } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { setProviderOverrides } from '../src/providers/index.js';
import { setMorph } from '../src/morph/index.js';
import { createStaticMorph } from '../src/morph/morpheus.js';
import { lookupKey } from '../src/core/integrity.js';

const BASE = process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:54329/postgres?host=/tmp';

export async function freshDb(name) {
  const admin = new pg.Client({ connectionString: BASE });
  await admin.connect();
  const db = `syz_test_${name}`;
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
  await closePool();
  const url = BASE.replace(/\/postgres(\?|$)/, `/${db}$1`);
  setPool(new pg.Pool({ connectionString: url, max: 5 }));
  await migrate();
  return url;
}

export async function teardown() { await closePool(); }

// A scripted provider. `script(phase, ctx)` returns a JSON-able object (the
// agent's reply) or { tool: {name, args}, next: (result) => reply } to call a tool first, or a string.
export function mockProvider(name, script) {
  const calls = [];
  return {
    name,
    calls,
    async complete({ model, system, blocks, messages = [], executeTool }) {
      const lastText = blocks[blocks.length - 1].text;
      const phase = (lastText.match(/TASK — (A1|B1|A2|B2|S1|S2)/) || [])[1] || (lastText.includes('READING PASS') ? 'READ' : 'OTHER');
      const verse = (blocks.map((b) => b.text).join('\n').match(/LAYER 6 — THIS VERSE: chapter (\d+), verse (\S+)/) || []).slice(1).join('.');
      const ctx = { model, system, blocks, messages, verse, attempt: calls.filter((c) => c.phase === phase && c.verse === verse).length };
      calls.push({ phase, verse, model, system, blocks, messages });
      let reply = await script(phase, ctx);
      const toolCalls = [];
      while (reply && reply.tool) {
        const result = await executeTool(reply.tool.name, reply.tool.args);
        toolCalls.push({ name: reply.tool.name, args: reply.tool.args, result });
        reply = await reply.next(result);
      }
      const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
      return { text, usage: { input: 1000, output: 200, cachedRead: 5000, cacheWrite: 0 }, toolCalls };
    },
    async listModels() { return { models: [{ id: 'mock-model', name: 'Mock' }] }; },
    async embed(texts) { return texts.map(() => [1, 0, 0]); },
  };
}

export function useProviders(map) { setProviderOverrides(map); }

export function useMorph(table) {
  const keyed = Object.fromEntries(Object.entries(table).map(([k, v]) => [lookupKey(k), v]));
  const m = createStaticMorph(keyed);
  setMorph(m);
  return m;
}

export async function makeAgents({ aProvider = 'anthropic', bProvider = 'google', aModel = 'primary-a', bModel = 'primary-b', aEsc = 'escalation-a', bEsc = 'escalation-b' } = {}) {
  const a = await one(`INSERT INTO agents (name) VALUES ('Philologos') RETURNING *`);
  const va = await one(`INSERT INTO agent_versions (agent_id, version, provider, model, escalation_provider, escalation_model, instructions, temperament) VALUES ($1,1,$2,$3,$2,$4,'Translate Iamblichus with care.','Literal-first') RETURNING *`, [a.id, aProvider, aModel, aEsc]);
  await q('UPDATE agents SET current_version_id = $2 WHERE id = $1', [a.id, va.id]);
  const b = await one(`INSERT INTO agents (name) VALUES ('Kritikos') RETURNING *`);
  const vb = await one(`INSERT INTO agent_versions (agent_id, version, provider, model, escalation_provider, escalation_model, instructions, temperament) VALUES ($1,1,$2,$3,$2,$4,'Find every error.','Exacting critic') RETURNING *`, [b.id, bProvider, bModel, bEsc]);
  await q('UPDATE agents SET current_version_id = $2 WHERE id = $1', [b.id, vb.id]);
  return { a, b, va, vb };
}

export async function makeRun(chapterId, { va, vb }, extra = {}) {
  return one(`INSERT INTO runs (chapter_id, agent_a_version_id, agent_b_version_id, escalate_mode, learned_rules, benchmark) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [chapterId, va.id, vb.id, extra.escalateMode || 'auto', extra.learnedRules ?? true, extra.benchmark ?? false]);
}

// Standard replies.
export const reply = {
  A1: (rendering) => ({ rendering, notes: [] }),
  B1: (rendering, critique = []) => ({ critique, rendering, signoff: false }),
  A2: (rendering, responses = [], signoff = true) => ({ responses, rendering, critique: [], signoff }),
  B2: (rendering, signoff = true, critique = []) => ({ responses: [], critique, rendering, signoff }),
  S1: (rendering) => ({ concessions: ['I give way on word order'], holds: [{ point: 'The genitive must stay causal', evidence: [{ type: 'text', note: 'the Greek' }] }], rendering }),
  S2: (rendering, accept = true) => ({ accept, concessions: [], holds: accept ? [] : [{ point: 'The participle is concessive, not causal', evidence: [{ type: 'text', note: 'καίπερ' }] }], rendering }),
};

export { one, all, q, getPool };
