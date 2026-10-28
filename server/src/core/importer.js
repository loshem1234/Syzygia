// Importing the Greek. The text is stored byte for byte, fingerprinted, and
// segmented into verses whose slices are proven lossless.
import { one, all, q, tx } from '../db/pool.js';
import { sha256, encodingWarnings, segmentVerses, segmentationLossless, greekWords } from './integrity.js';
import { getProvider, configuredProviders } from '../providers/index.js';

export async function importWork(projectId, raw, via = 'paste') {
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (project.work_raw) throw new Error('This project already has its full work. The work is immutable once imported.');
  const hash = sha256(raw);
  await q('UPDATE projects SET work_raw = $2, work_hash = $3 WHERE id = $1', [projectId, raw, hash]);
  const tokens = await measureTokens(raw);
  if (tokens) await q('UPDATE projects SET work_tokens = $2 WHERE id = $1', [projectId, tokens]);
  return { hash, tokens, warnings: encodingWarnings(raw), via };
}

async function measureTokens(text) {
  if (!configuredProviders().includes('anthropic')) return null;
  try {
    const p = getProvider('anthropic');
    if (!p.countTokens) return null;
    return await p.countTokens({ model: process.env.TOKEN_COUNT_MODEL || 'claude-sonnet-5-5', system: 'count', text });
  } catch { return null; }
}

export async function importChapter(projectId, { title, ord, raw, via = 'paste', dialect = null }) {
  const verses = segmentVerses(raw);
  if (!verses.length) throw new Error('No verses found. Number each verse at the start of its line (1, 2, 3 …).');
  if (!segmentationLossless(raw, verses)) throw new Error('Segmentation would lose characters; the chapter was not imported. Check the verse numbering.');
  const hash = sha256(raw);
  const warnings = encodingWarnings(raw);
  return tx(async (t) => {
    const nextOrd = ord ?? ((await t.one('SELECT coalesce(max(ord),0)+1 AS n FROM chapters WHERE project_id = $1', [projectId])).n);
    const ch = await t.one(`INSERT INTO chapters (project_id, ord, title, source_raw, source_hash, dialect, imported_via, warnings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [projectId, nextOrd, title || `Chapter ${nextOrd}`, raw, hash, dialect, via, JSON.stringify(warnings)]);
    for (const [i, v] of verses.entries()) {
      await t.q(`INSERT INTO verses (chapter_id, num, ord, seq, source, src_start, src_end) VALUES ($1,$2,$3,0,$4,$5,$6)`, [ch.id, v.num, i + 1, v.source, v.start, v.end]);
    }
    // book-wide sequence numbers, for decay windows and ordering
    await t.q(`UPDATE verses v SET seq = s.rn FROM (
                 SELECT v2.id, row_number() OVER (ORDER BY c.ord, v2.ord) AS rn FROM verses v2 JOIN chapters c ON c.id = v2.chapter_id WHERE c.project_id = $1
               ) s WHERE s.id = v.id`, [projectId]);
    return { chapter: ch, verses: verses.length, warnings, hash };
  });
}

// Dialect suggestion: from parser tags when available, otherwise from
// characteristic forms. Only a suggestion; Loshem confirms.
const DORIC = ['εντι', 'φατι', 'τοι', 'ταν', 'τασ', 'ἁ', 'αμεσ', 'ποτι', 'ακα', 'κα', 'ωνθρωποι'];
const IONIC = ['εων', 'κωσ', 'κοτε', 'ιστοριη', 'ιησι', 'ηυ'];
export function suggestDialect(texts, parses = []) {
  const counts = {};
  for (const p of parses) for (const t of p) for (const a of t.analyses) for (const d of a.dialects || []) counts[d] = (counts[d] || 0) + 1;
  const words = texts.flatMap((t) => greekWords(t));
  const doric = words.filter((w) => DORIC.includes(w) || /οντι$|αντι$/.test(w)).length;
  const ionic = words.filter((w) => IONIC.includes(w) || /εων$|ηισ$/.test(w)).length;
  counts.doric = (counts.doric || 0) + doric;
  counts.ionic = (counts.ionic || 0) + ionic;
  const total = words.length || 1;
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || ['attic', 0];
  if (n / total < 0.01) return { dialect: 'attic', confidence: 'default', evidence: 'No characteristic non-Attic forms detected.' };
  return { dialect: best, confidence: n / total > 0.04 ? 'strong' : 'weak', evidence: `${n} characteristic ${best} forms in ${total} words.` };
}

export async function chapterWithVerses(chapterId) {
  const chapter = await one('SELECT * FROM chapters WHERE id = $1', [chapterId]);
  const verses = await all('SELECT * FROM verses WHERE chapter_id = $1 ORDER BY ord', [chapterId]);
  return { chapter, verses };
}
