// Detect what the Greek of a verse contains, from parser analyses, so the
// pre-fetch can load the references that govern it. Every trigger carries a
// stable value used by prefetch rules and the learning log.
import { lookupKey } from './integrity.js';

// Particles and fixed combinations treated in Denniston. Keys are lookup forms.
export const PARTICLES = [
  'αλλα', 'αρα', 'αρ', 'αταρ', 'αυ', 'αυτε', 'γαρ', 'γε', 'γουν', 'δαι', 'δε', 'δη', 'δηθεν', 'δηπου', 'δητα',
  'ει μην', 'η', 'η μην', 'ητοι', 'καιτοι', 'μεν', 'μεντοι', 'μην', 'μων', 'νυ', 'ουκουν', 'ουν',
  'περ', 'που', 'τε', 'τοι', 'τοιγαρ', 'τοιγαρουν', 'τοινυν', 'ως', 'αλλα μην', 'και δη', 'και μην', 'γαρ δη',
  'μεν ουν', 'δ ουν', 'γε μην', 'τε και', 'ου μην αλλα', 'μεν δη', 'αλλα γαρ', 'και γαρ', 'ουδε μην',
];
const PARTICLE_SET = new Set(PARTICLES.filter((p) => !p.includes(' ')));
const COMBOS = PARTICLES.filter((p) => p.includes(' '));

const CONSTRUCTIONS = {
  'optative': 'Uses of the optative mood',
  'potential-optative': 'Potential optative with ἄν',
  'subjunctive': 'Uses of the subjunctive mood',
  'genitive-absolute': 'Genitive absolute',
  'articular-infinitive': 'Articular infinitive',
  'infinitive': 'Uses of the infinitive, including indirect discourse',
  'conditional': 'Conditional sentences (εἰ, ἐάν, ἄν)',
  'purpose-clause': 'Purpose clauses (ἵνα, ὅπως, ὡς)',
  'result-clause': 'Result clauses with ὥστε',
  'verbal-adjective': 'Verbal adjectives in -τέος and -τός',
  'circumstantial-participle': 'Circumstantial and supplementary participles',
  'middle-voice': 'The middle voice',
  'dual': 'The dual number',
  'relative-clause': 'Relative clauses and attraction',
};
export const CONSTRUCTION_LABELS = CONSTRUCTIONS;

export function detectTriggers(parsedTokens, { ledgerKeys = new Set(), dialect = 'attic', variantFlag = false } = {}) {
  const triggers = [];
  const add = (type, value, detail = {}) => {
    if (!triggers.some((t) => t.type === type && t.value === value)) triggers.push({ type, value, ...detail });
  };
  const keys = parsedTokens.map((t) => lookupKey(t.form).replace(/[^Ͱ-Ͽ]/g, ''));

  parsedTokens.forEach((t, i) => {
    const lemmas = [...new Set((t.analyses.length ? t.analyses : [{ lemma: t.form }]).map((a) => a.lemma))];
    for (const lemma of lemmas) {
      const key = lookupKey(lemma);
      add('lemma', key, { lemma, form: t.form });
      if (ledgerKeys.has(key)) add('term', key, { lemma });
    }
    if (PARTICLE_SET.has(keys[i])) add('particle', keys[i], { form: t.form });
    for (const a of t.analyses) {
      if (a.mood === 'opt') add('construction', 'optative');
      if (a.mood === 'subj') add('construction', 'subjunctive');
      if (a.mood === 'inf') add('construction', 'infinitive');
      if (a.mood === 'part') add('construction', 'circumstantial-participle');
      if (a.voice === 'mid') add('construction', 'middle-voice');
      if (a.number === 'dual') add('construction', 'dual');
      if (/τεος$|τεον$|τεα$/.test(keys[i]) || a.features?.includes('verbal_adj')) add('construction', 'verbal-adjective');
      for (const d of a.dialects || []) {
        if (d !== 'attic' && d !== dialect) add('dialect', d, { form: t.form });
      }
    }
  });

  // multi-word particle combinations
  const joined = ' ' + keys.join(' ') + ' ';
  for (const c of COMBOS) if (joined.includes(' ' + c + ' ')) add('particle', c);

  const has = (k) => keys.includes(k);
  const optative = parsedTokens.some((t) => t.analyses.some((a) => a.mood === 'opt'));
  if (optative && has('αν')) add('construction', 'potential-optative');
  if (has('ει') || has('εαν') || has('ην') || has('αν')) add('construction', 'conditional');
  if (has('ινα') || has('οπωσ')) add('construction', 'purpose-clause');
  if (has('ωστε')) add('construction', 'result-clause');

  // genitive absolute: a genitive participle plus another genitive noun/pronoun
  const genPart = parsedTokens.some((t) => t.analyses.some((a) => a.mood === 'part' && /gen/.test(a.case || '')));
  const genNoun = parsedTokens.some((t) => t.analyses.some((a) => a.mood !== 'part' && /gen/.test(a.case || '') && ['noun', 'pron', 'adjective'].includes(a.pos)));
  if (genPart && genNoun) add('construction', 'genitive-absolute');

  // articular infinitive: article directly before an infinitive
  parsedTokens.forEach((t, i) => {
    if (i === 0) return;
    const prevIsArticle = ['το', 'του', 'τω', 'τῳ'].includes(keys[i - 1]) || parsedTokens[i - 1].analyses.some((a) => a.pos === 'article');
    if (prevIsArticle && t.analyses.some((a) => a.mood === 'inf')) add('construction', 'articular-infinitive');
  });

  if (parsedTokens.some((t) => t.analyses.some((a) => a.features?.includes('relative')))) add('construction', 'relative-clause');
  if (variantFlag) add('variant', 'flagged');
  if (dialect && dialect !== 'attic') add('dialect', dialect);
  return triggers;
}
