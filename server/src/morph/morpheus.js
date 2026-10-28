// Client for the Perseus Morpheus parser (perseids-tools/morpheus-api, run as
// its own Railway service from the Docker image). Every analysis lists lemma,
// part of speech, full morphology and any dialect tags Morpheus reports.
import { toBeta, fromBeta } from './betacode.js';
import { lookupKey, tokenize } from '../core/integrity.js';
import { config } from '../config.js';

const MOODS = new Set(['ind', 'subj', 'opt', 'imperat', 'inf', 'part']);
const TENSES = new Set(['pres', 'imperf', 'fut', 'aor', 'perf', 'plup', 'futperf']);
const VOICES = new Set(['act', 'mid', 'pass', 'mp']);
const CASES = new Set(['nom', 'gen', 'dat', 'acc', 'voc']);
const NUMBERS = new Set(['sg', 'pl', 'dual']);
const GENDERS = new Set(['masc', 'fem', 'neut']);
const PERSONS = new Set(['1st', '2nd', '3rd']);
const DIALECTS = new Set(['attic', 'doric', 'ionic', 'aeolic', 'epic', 'homeric', 'parad_form', 'poetic', 'later', 'koine']);
const POS = { N: 'noun', V: 'verb', A: 'adjective', P: 'participle' };

export function parseMorpheusOutput(text) {
  const out = [];
  const re = /<NL>([\s\S]*?)<\/NL>/g;
  let m;
  while ((m = re.exec(text))) {
    const parts = m[1].trim().split(/\s+/);
    if (parts.length < 2) continue;
    const posCode = parts[0];
    const [formBeta, lemmaBetaRaw] = parts[1].split(',');
    const lemmaBeta = (lemmaBetaRaw || formBeta).replace(/[_^]/g, '').replace(/\d+$/, '');
    const a = { pos: POS[posCode] || posCode.toLowerCase(), lemma: fromBeta(lemmaBeta), form: fromBeta(formBeta.replace(/[_^]/g, '')), features: [], dialects: [] };
    for (const t of parts.slice(2)) {
      if (MOODS.has(t)) a.mood = t;
      else if (TENSES.has(t)) a.tense = t;
      else if (VOICES.has(t)) a.voice = t;
      else if (CASES.has(t)) a.case = t;
      else if (NUMBERS.has(t)) a.number = t;
      else if (GENDERS.has(t)) a.gender = t;
      else if (PERSONS.has(t)) a.person = t;
      else if (t.includes('/')) {
        // combined values such as "masc/neut" or "nom/voc/acc"
        const vals = t.split('/');
        if (vals.every((v) => CASES.has(v))) a.case = t;
        else if (vals.every((v) => GENDERS.has(v))) a.gender = t;
        else a.features.push(t);
      } else if (DIALECTS.has(t)) a.dialects.push(t === 'homeric' ? 'epic' : t);
      else a.features.push(t);
    }
    if (a.mood === 'part') a.pos = 'participle';
    if (a.mood === 'inf') a.pos = 'infinitive';
    if (['prep', 'conj', 'particle', 'adverb', 'adverbial', 'article', 'pron', 'indeclform'].some((f) => a.features.includes(f))) {
      a.pos = a.features.find((f) => ['prep', 'conj', 'particle', 'adverb', 'adverbial', 'article', 'pron'].includes(f)) || a.pos;
    }
    out.push(a);
  }
  return out;
}

export function createMorpheusClient(url = config.morpheusUrl, { fetchImpl = fetch } = {}) {
  const cache = new Map();
  const available = Boolean(url);
  async function analyze(form) {
    const key = lookupKey(form);
    if (cache.has(key)) return cache.get(key);
    if (!available) return [];
    const beta = toBeta(form);
    if (!beta) return [];
    try {
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/greek/${encodeURIComponent(beta)}`);
      const text = res.ok ? await res.text() : '';
      const parsed = parseMorpheusOutput(text);
      cache.set(key, parsed);
      return parsed;
    } catch {
      return [];
    }
  }
  async function analyzeText(text) {
    const tokens = tokenize(text);
    const results = [];
    // modest concurrency, the parser is a small service
    for (let i = 0; i < tokens.length; i += 8) {
      const batch = tokens.slice(i, i + 8);
      const analyses = await Promise.all(batch.map((t) => analyze(t.form)));
      batch.forEach((t, j) => results.push({ ...t, analyses: analyses[j] }));
    }
    return results;
  }
  return { available, analyze, analyzeText };
}

// For tests and for a run without a parser: a fixed table of analyses.
export function createStaticMorph(table = {}) {
  return {
    available: true,
    async analyze(form) { return table[lookupKey(form)] || []; },
    async analyzeText(text) {
      return tokenize(text).map((t) => ({ ...t, analyses: table[lookupKey(t.form)] || [] }));
    },
  };
}
