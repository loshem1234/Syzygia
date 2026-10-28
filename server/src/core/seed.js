// Core pre-fetch rules. These are generic by kind of work, so they start
// working as soon as a lexicon, grammar, particle study or dialect handbook is
// in the library. They are fixed: learning can add rules, never remove these.
import { q, one } from '../db/pool.js';

export const CORE_RULES = [
  { trigger_type: 'lemma', trigger_value: '*', target_kind: 'headword', target_work_kind: 'lexicon', max_chunks: 1, note: "Every lemma brings its lexicon entry, trimmed to the senses relevant to the form" },
  { trigger_type: 'term', trigger_value: '*', target_kind: 'headword', target_work_kind: 'philosophical', max_chunks: 1, note: 'A ledger term brings its philosophical-terms entry' },
  { trigger_type: 'particle', trigger_value: '*', target_kind: 'headword', target_work_kind: 'particles', max_chunks: 1, note: 'A particle or combination brings its article on particles' },
  { trigger_type: 'construction', trigger_value: '*', target_kind: 'query', target_work_kind: 'grammar', query: '{label}', max_chunks: 2, note: 'A construction brings the grammar sections that treat it' },
  { trigger_type: 'dialect', trigger_value: '*', target_kind: 'query', target_work_kind: 'dialect', query: '{value}', max_chunks: 2, note: 'A non-Attic form brings the dialect handbook section on that feature' },
];

export async function seedCore() {
  const existing = await one(`SELECT count(*)::int AS n FROM prefetch_rules WHERE tier = 'core'`);
  if (existing.n === 0) {
    for (const r of CORE_RULES) {
      await q(`INSERT INTO prefetch_rules (tier, trigger_type, trigger_value, target_kind, target_work_kind, query, max_chunks, note) VALUES ('core',$1,$2,$3,$4,$5,$6,$7)`,
        [r.trigger_type, r.trigger_value, r.target_kind, r.target_work_kind, r.query || null, r.max_chunks, r.note]);
    }
  }
  await q(`INSERT INTO settings (key, value) VALUES ('pricing', '{}'::jsonb) ON CONFLICT (key) DO NOTHING`);
}
