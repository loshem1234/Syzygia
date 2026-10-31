// Pre-fetch: before a verse is debated, the parser's findings are mapped by
// rules to the exact references that govern them. Core rules are fixed and can
// never be removed; learned rules (book, corpus, global) add to them.
import { all, q } from '../db/pool.js';
import { byHeadword, byRef, search, citationOf } from './retrieval.js';
import { trimEntry } from '../library/ingest.js';
import { CONSTRUCTION_LABELS } from './constructions.js';
import { config } from '../config.js';

// Lemmas too common to spend context on; agents can still look them up.
// Particles so frequent that pre-fetching their overview for every verse would
// crowd out more useful references. Combinations (μὲν οὖν, καὶ δή, ἀλλὰ γάρ)
// still fetch, and the agents can call section() for any of these.
export const COMMON_PARTICLES = new Set((process.env.PREFETCH_SKIP_PARTICLES ?? 'και,δε,τε,μεν,γαρ,αλλα').split(',').map((s) => s.trim()).filter(Boolean));

export const COMMON_LEMMAS = new Set(['ο', 'και', 'δε', 'ειμι', 'αυτοσ', 'ου', 'ουκ', 'ουχ', 'εν', 'εισ', 'εκ', 'εξ', 'τε', 'μεν', 'γαρ', 'ουτοσ', 'τισ', 'οσ', 'εγω', 'συ', 'προσ', 'επι', 'κατα', 'δια', 'μετα', 'απο', 'περι', 'υπο', 'παρα', 'ωσ', 'η', 'μη', 'αλλα', 'αν', 'ει']);

const PRIORITY = { term: 0, variant: 1, particle: 2, construction: 3, dialect: 4, lemma: 5 };

export async function applicableRules({ project, learned = true }) {
  return all(
    `SELECT * FROM prefetch_rules
      WHERE status = 'active'
        AND (tier = 'core'
          OR ($1 AND tier = 'global')
          OR ($1 AND tier = 'corpus' AND corpus_profile_id = $2)
          OR ($1 AND tier = 'book' AND project_id = $3))
      ORDER BY CASE tier WHEN 'core' THEN 0 WHEN 'book' THEN 1 WHEN 'corpus' THEN 2 ELSE 3 END, id`,
    [learned, project.corpus_profile_id, project.id]);
}

function matches(rule, trigger) {
  return rule.trigger_type === trigger.type && (rule.trigger_value === '*' || rule.trigger_value === trigger.value);
}

async function resolve(rule, trigger, works) {
  const kindIds = (kind) => works.filter((w) => w.kind === kind).map((w) => w.id);
  const ids = rule.target_work_id ? works.filter((w) => w.id === rule.target_work_id).map((w) => w.id) : kindIds(rule.target_work_kind);
  if (!ids.length) return [];
  if (rule.target_kind === 'headword') return byHeadword(trigger.value, ids, rule.max_chunks);
  if (rule.target_kind === 'ref') { const c = await byRef(ids[0], rule.target_ref); return c ? [c] : []; }
  const label = CONSTRUCTION_LABELS[trigger.value] || trigger.value;
  const query = (rule.query || '{label}').replace('{value}', trigger.value).replace('{label}', label);
  return search(query, { workIds: ids, limit: rule.max_chunks });
}

export async function prefetch({ project, verse, triggers, works, runId, phase = 'prefetch', learned = true, lemmaFrequency = new Map(), budgetChars = Number(process.env.PREFETCH_BUDGET_CHARS || 30000) }) {
  const rules = await applicableRules({ project, learned });
  const ordered = [...triggers]
    .filter((t) => !(t.type === 'lemma' && COMMON_LEMMAS.has(t.value)))
    .filter((t) => !(t.type === 'particle' && COMMON_PARTICLES.has(t.value)))
    .sort((a, b) => (PRIORITY[a.type] - PRIORITY[b.type]) || ((lemmaFrequency.get(a.value) || 0) - (lemmaFrequency.get(b.value) || 0)));
  const seen = new Set();
  const out = [];
  let used = 0;
  for (const trigger of ordered) {
    for (const rule of rules.filter((r) => matches(r, trigger))) {
      const chunks = await resolve(rule, trigger, works);
      for (const c of chunks) {
        if (seen.has(c.id)) continue;
        const text = ['lexicon'].includes(c.work_kind) ? trimEntry(c.text, config.limits.lexiconEntryChars, [trigger.value]) : trimEntry(c.text, config.limits.lexiconEntryChars * 2, []);
        if (used + text.length > budgetChars && out.length) continue;
        seen.add(c.id);
        used += text.length;
        out.push({ chunk_id: c.id, citation: citationOf(c), text, rule_id: rule.id, rule_tier: rule.tier, trigger: `${trigger.type}:${trigger.value}` });
      }
      if (chunks.length) {
        await q('UPDATE prefetch_rules SET uses = uses + 1, last_used_seq = GREATEST(last_used_seq, $2) WHERE id = $1', [rule.id, verse.seq]);
      }
    }
  }
  for (const p of out) {
    await q(`INSERT INTO retrieval_log (run_id, verse_id, phase, source, rule_id, chunk_id, triggers) VALUES ($1,$2,$3,'prefetch',$4,$5,$6)`,
      [runId, verse.id, phase, p.rule_id, p.chunk_id, triggers.map((t) => `${t.type}:${t.value}`)]);
  }
  return out;
}
