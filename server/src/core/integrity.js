// Source integrity. The Greek the user imports is the authority: it is stored
// byte for byte, fingerprinted, and never normalized. A separate *lookup copy*
// (accent-insensitive, lowercased) exists only for searching and matching.
import crypto from 'node:crypto';

export function sha256(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export function verifyHash(text, expected) {
  return sha256(text) === expected;
}

export class IntegrityError extends Error {
  constructor(message) { super(message); this.name = 'IntegrityError'; }
}

export function assertIntact(text, expected, label = 'source text') {
  if (!verifyHash(text, expected)) {
    throw new IntegrityError(`Integrity check failed for ${label}: its fingerprint no longer matches the imported original.`);
  }
}

// Lookup copy: never displayed, never exported, never sent as "the source".
export function lookupKey(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ͂̓̈́ͅ]/g, (m) => (m === 'ͅ' ? 'ι' : ''))
    .replace(/[᾽᾿῀῁῍῎῏῝῞῟῭΅`´῾΄΅ʼ’]/g, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[;]/g, ';')
    .replace(/[··]/g, '·')
    .normalize('NFC');
}

// Words in a Greek string, for indexing (lookup copy).
export function greekWords(text) {
  return (lookupKey(text).match(/[Ͱ-Ͽἀ-῿]+/g) || []);
}

// Original-form tokens with offsets (no normalization), for parsing and display.
export function tokenize(text) {
  const out = [];
  const re = /[\p{Script=Greek}̀-ͯ᾽᾿’ʼ]+/gu;
  let m;
  while ((m = re.exec(text))) out.push({ form: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

const NAMES = {
  0x0300: 'combining grave', 0x0301: 'combining acute', 0x0313: 'combining smooth breathing',
  0x0314: 'combining rough breathing', 0x0342: 'combining perispomeni', 0x0345: 'combining ypogegrammeni',
  0x0308: 'combining diaeresis', 0x037e: 'Greek question mark', 0x0387: 'Greek ano teleia',
  0x003b: 'semicolon', 0x00b7: 'middle dot', 0x1f71: 'alpha with oxia', 0x03ac: 'alpha with tonos',
  0x1f73: 'epsilon with oxia', 0x03ad: 'epsilon with tonos', 0x1f75: 'eta with oxia', 0x03ae: 'eta with tonos',
  0x1f77: 'iota with oxia', 0x03af: 'iota with tonos', 0x1f79: 'omicron with oxia', 0x03cc: 'omicron with tonos',
  0x1f7b: 'upsilon with oxia', 0x03cd: 'upsilon with tonos', 0x1f7d: 'omega with oxia', 0x03ce: 'omega with tonos',
};

export function codepoints(text) {
  return Array.from(text).map((ch) => {
    const cp = ch.codePointAt(0);
    return { char: ch, cp: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'), name: NAMES[cp] || null, combining: cp >= 0x300 && cp <= 0x36f };
  });
}

// Warnings that help the user notice mixed encodings. They never change the text.
export function encodingWarnings(text) {
  const w = [];
  const hasTonos = /[άέήίόύώΐΰ]/.test(text);
  const hasOxia = /[άέήίόύώΆΈΉΊΎΌΏ]/.test(text);
  const hasCombining = /[̀-ͯ]/.test(text);
  const hasPrecomposedPolytonic = /[ἀ-῿]/.test(text);
  if (hasTonos && hasOxia) w.push('Mixed acute encodings: both tonos (U+03AC…) and oxia (U+1F71…) forms appear. The text is kept exactly as imported.');
  if (hasCombining && hasPrecomposedPolytonic) w.push('Mixed precomposed and combining diacritics appear. The text is kept exactly as imported.');
  if (/;/.test(text) && /[;]/.test(text)) w.push('Both Latin semicolons and Greek question marks appear.');
  if (/�/.test(text)) w.push('Replacement characters (U+FFFD) found: something was lost before import. Check the source file.');
  return w;
}

// Split numbered body text into verses. Each verse's `source` is an exact slice
// of the raw text (the marker and surrounding whitespace excluded), so that
// joining markers + verses reproduces every non-whitespace character.
// Accepted markers at line start: "12", "12.", "12)", "[12]", "(12)", "§12", "12a".
const MARKER = /(^|\n)[ \t]*(?:\[(\d+[a-z]?)\]|\((\d+[a-z]?)\)|§\s*(\d+[a-z]?)|(\d+[a-z]?)(?:[.)])?)(?=[ \t\n])/g;

export function segmentVerses(raw) {
  const marks = [];
  let m;
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(raw))) {
    const num = m[2] || m[3] || m[4] || m[5];
    const markerStart = m.index + m[1].length;
    marks.push({ num, markerStart, markerEnd: MARKER.lastIndex });
  }
  if (!marks.length) {
    const s = raw.search(/\S/);
    const e = raw.length - (raw.length - raw.trimEnd().length);
    return s < 0 ? [] : [{ num: '1', source: raw.slice(s, e), start: s, end: e }];
  }
  const verses = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].markerEnd;
    const to = i + 1 < marks.length ? marks[i + 1].markerStart : raw.length;
    let s = from, e = to;
    while (s < e && /\s/.test(raw[s])) s++;
    while (e > s && /\s/.test(raw[e - 1])) e--;
    if (e > s) verses.push({ num: marks[i].num, source: raw.slice(s, e), start: s, end: e });
  }
  return verses;
}

// Proof that segmentation lost nothing: every non-whitespace character outside
// the verse slices belongs to a verse marker.
export function segmentationLossless(raw, verses) {
  let rest = '';
  let pos = 0;
  for (const v of verses) { rest += raw.slice(pos, v.start); pos = v.end; }
  rest += raw.slice(pos);
  const stripped = rest.replace(/(\[\d+[a-z]?\]|\(\d+[a-z]?\)|§\s*\d+[a-z]?|\d+[a-z]?[.)]?)/g, '').replace(/\s+/g, '');
  return stripped.length === 0 && verses.every((v) => raw.slice(v.start, v.end) === v.source);
}
