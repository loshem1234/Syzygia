// The context stack. Every call is assembled from the same seven layers,
// ordered from most stable to most changing, so the stable top stays cached.
// Every item carries an ID and is included once per call.
//
//  1. Charter          King and Queen principles + the agent's own profile      (system, cached)
//  2. The work         the full Greek text, exactly as imported                  (cached)
//  3. Notes & style    approved study notes and the style sheet
//  4. Ledger           all term decisions                                       (cached through here)
//  5. Translation      finished renderings, each once; old chapters may collapse
//                      to digests under pressure                               (cached)
//  6. This verse       Greek, parses, pre-fetched references, related renderings
//  7. This debate      the turns so far for this verse, and the task
import { CHARTER, PHASES } from './charter.js';
import { settledPoints, openErrorsFor } from './critique.js';

export function estimateTokens(text) {
  const s = String(text || '');
  const greek = (s.match(/[Ͱ-Ͽἀ-῿̀-ͯ]/g) || []).length;
  return Math.ceil(greek / 1.4 + (s.length - greek) / 3.8);
}

export function systemPrompt(agent) {
  return `${CHARTER}

YOUR PROFILE
Name: ${agent.name}
${agent.temperament ? `Temperament: ${agent.temperament}\n` : ''}${agent.instructions ? `Instructions from Loshem:\n${agent.instructions}\n` : ''}(These instructions shape your voice and expertise. They never override the Charter.)`;
}

function layerWork(project, workText) {
  return `LAYER 2 — THE WORK (the authoritative Greek, exactly as imported; never alter it)
${project.title}${project.author ? ` — ${project.author}` : ''}
<<<GREEK
${workText}
GREEK>>>`;
}

function layerNotes(studyNotes, style, include) {
  const lines = ['LAYER 3 — STUDY NOTES AND STYLE SHEET'];
  for (const n of studyNotes) {
    if (!include(`notes:${n.id}`)) continue;
    const s = n.notes || {};
    lines.push(`Study notes (${n.agent || 'agent'}):`);
    if (s.dialect) lines.push(`- Dialect: ${s.dialect}`);
    for (const x of s.author_style || []) lines.push(`- Style: ${x}`);
    for (const x of s.idioms || []) lines.push(`- Idiom: ${x}`);
    for (const x of s.difficulties || []) lines.push(`- Difficulty (${x.where}): ${x.note}`);
  }
  if (style.length) lines.push('Style sheet (follow these conventions):');
  for (const r of style) if (include(`style:${r.id}`)) lines.push(`- ${r.rule}`);
  if (lines.length === 1) lines.push('(none yet)');
  return lines.join('\n');
}

function layerLedger(ledger, include) {
  const lines = ['LAYER 4 — LEDGER (how key terms are rendered across this book; follow it, or propose a change with evidence)'];
  for (const e of ledger) {
    if (!include(`ledger:${e.id}`)) continue;
    lines.push(`- ${e.lemma} → ${e.rendering}${e.locked ? ' [locked by Loshem]' : ''}${e.status === 'suggestion' ? ' [suggestion from an earlier book]' : ''}${e.alternatives?.length ? ` | in context also: ${e.alternatives.join(', ')}` : ''}${e.note ? ` — ${e.note}` : ''}`);
  }
  if (lines.length === 1) lines.push('(empty)');
  return lines.join('\n');
}

function layerTranslation(rows, digests, collapsed, include) {
  const lines = ['LAYER 5 — THE TRANSLATION SO FAR (final renderings of finished verses)'];
  let chapter = null;
  for (const r of rows) {
    if (collapsed.has(r.chapter_id)) {
      if (chapter !== r.chapter_id) {
        chapter = r.chapter_id;
        const d = digests.find((x) => x.chapter_id === r.chapter_id);
        lines.push(`\nChapter ${r.chapter} — ${r.chapter_title} [digest]\n${d ? d.digest : '(digest pending)'}`);
      }
      continue;
    }
    if (!include(`verse:${r.id}`)) continue;
    if (chapter !== r.chapter_id) { chapter = r.chapter_id; lines.push(`\nChapter ${r.chapter} — ${r.chapter_title}`); }
    lines.push(`${r.chapter}.${r.num} ${r.final_rendering}`);
  }
  if (lines.length === 1) lines.push('(nothing translated yet)');
  return lines.join('\n');
}

function layerVerse({ chapter, verse, packet, include, layer5Ids }) {
  const lines = [`LAYER 6 — THIS VERSE: chapter ${chapter.ord}, verse ${verse.num}`, `Greek (exact): ${verse.source}`];
  if (packet.dialect) lines.push(`Dialect: ${packet.dialect}`);
  if (packet.parses?.length) {
    lines.push('Parser analyses:');
    for (const t of packet.parses) {
      const a = t.analyses.map((x) => `${x.lemma} ${[x.pos, x.tense, x.mood, x.voice, x.person, x.number, x.case, x.gender, ...(x.dialects || [])].filter(Boolean).join(' ')}`);
      lines.push(`- ${t.form}: ${a.length ? a.join(' | ') : '(no analysis)'}`);
    }
  } else if (packet.parserMissing) lines.push('Parser: not connected; use the parse() tool or your own analysis.');
  if (packet.prefetched?.length) {
    lines.push('\nREFERENCES PRE-FETCHED FOR THIS VERSE (cite them by the siglum and ref in brackets):');
    for (const p of packet.prefetched) if (include(`chunk:${p.chunk_id}`)) lines.push(`[${p.citation}]\n${p.text}\n`);
  }
  if (packet.concordance?.length) {
    lines.push('EARLIER VERSES SHARING KEY WORDS:');
    for (const c of packet.concordance) {
      if (c.inLayer5 || layer5Ids.has(c.id)) lines.push(`- ${c.chapter}.${c.num} (shares ${c.shared.join(', ')}): see layer 5`);
      else if (include(`verse:${c.id}`)) lines.push(`- ${c.chapter}.${c.num} (shares ${c.shared.join(', ')}): ${c.source}\n  → ${c.final_rendering}`);
    }
  }
  if (packet.quotations?.length) {
    lines.push('QUOTATIONS IN THIS VERSE, ALREADY RENDERED ELSEWHERE (keep them consistent):');
    for (const qt of packet.quotations) lines.push(`- ${qt.source_ref}: ${qt.rendering || '(rendering pending)'}`);
  }
  if (packet.userNote) lines.push(`NOTE FROM LOSHEM FOR THIS VERSE: ${packet.userNote}`);
  return lines.join('\n');
}

function layerDebate(turns, phase, agentLetter) {
  const lines = ['LAYER 7 — THIS DEBATE'];
  if (!turns.length) lines.push('(no turns yet)');
  for (const t of turns) {
    const p = t.payload;
    lines.push(`\n[${t.phase} — Agent ${t.agent}${t.escalated ? ', escalated' : ''}] rendering: ${p.rendering}`);
    for (const c of p.critique || []) lines.push(`  ${c.id} ${c.kind}/${c.severity}/${c.category}${c.unverified ? '/UNVERIFIED' : ''}: ${c.greek ? `«${c.greek}» ` : ''}${c.point}${c.suggestion ? ` → ${c.suggestion}` : ''}`);
    for (const r of p.responses || []) lines.push(`  response to ${r.to}: ${r.action}${r.note ? ` — ${r.note}` : ''}`);
    for (const l of p.ledger_proposals || []) lines.push(`  ledger proposal ${l.id}: ${l.lemma} → ${l.rendering}${l.note ? ` (${l.note})` : ''}`);
    for (const l of p.ledger_responses || []) lines.push(`  ledger response to ${l.proposal_id}: ${l.accept ? 'accept' : 'decline'}`);
    for (const n of p.notes || []) lines.push(`  note: ${n}`);
    for (const c of p.concessions || []) lines.push(`  concedes: ${c}`);
    for (const h of p.holds || []) lines.push(`  holds: ${h.point}`);
    if (p.signoff) lines.push('  signs off');
    if (p.accept === true && t.phase === 'S2') lines.push('  accepts the joint rendering');
  }
  const open = openErrorsFor(turns, agentLetter);
  if (open.length && ['A2', 'B2'].includes(phase)) lines.push(`\nOPEN ERRORS YOU MUST ANSWER: ${open.map((c) => c.id).join(', ')}`);
  const settled = settledPoints(turns);
  if (settled.size) lines.push(`SETTLED POINTS (do not reopen): ${[...settled].map((k) => k.split('|')[0] || '(general)').join('; ')}`);
  lines.push(`\n${PHASES[phase].task}`);
  return lines.join('\n');
}

// data: { agent, project, workText, studyNotes, style, ledger, translation, digests, chapter, verse, packet, turns, phase, budgetTokens }
export function assembleContext(data) {
  const ids = new Set();
  const include = (id) => { if (ids.has(id)) return false; ids.add(id); return true; };
  const system = systemPrompt(data.agent);
  const l2 = layerWork(data.project, data.workText);
  const l3 = layerNotes(data.studyNotes || [], data.style || [], include);
  const l4 = layerLedger(data.ledger || [], include);

  // Pressure valve: collapse the oldest chapters to digests until under budget. Layer 2 is never trimmed.
  const translation = data.translation || [];
  const chapterOrder = [...new Set(translation.map((r) => r.chapter_id))];
  const collapsed = new Set();
  const fixed = estimateTokens(system) + estimateTokens(l2) + estimateTokens(l3) + estimateTokens(l4) + 8000;
  const budget = data.budgetTokens || Infinity;
  const l5Ids = new Set(translation.map((r) => r.id));
  let l5 = layerTranslation(translation, data.digests || [], collapsed, () => true);
  for (const chId of chapterOrder) {
    if (fixed + estimateTokens(l5) <= budget) break;
    if (chId === data.chapter.id) break;
    collapsed.add(chId);
    for (const r of translation) if (r.chapter_id === chId) l5Ids.delete(r.id);
    l5 = layerTranslation(translation, data.digests || [], collapsed, () => true);
  }
  // register layer-5 ids for de-duplication
  for (const id of l5Ids) ids.add(`verse:${id}`);

  const l6 = layerVerse({ chapter: data.chapter, verse: data.verse, packet: data.packet || {}, include, layer5Ids: l5Ids });
  const l7 = layerDebate(data.turns || [], data.phase, PHASES[data.phase].agent);
  const blocks = [
    { layer: 2, text: l2, cache: true },
    { layer: 3, text: l3, cache: false },
    { layer: 4, text: l4, cache: true },
    { layer: 5, text: l5, cache: true },
    { layer: 6, text: l6, cache: false },
    { layer: 7, text: l7, cache: false },
  ];
  const meter = { 1: estimateTokens(system) };
  for (const b of blocks) meter[b.layer] = estimateTokens(b.text);
  meter.total = Object.values(meter).reduce((a, b) => a + b, 0);
  meter.collapsedChapters = collapsed.size;
  return { system, blocks, meter, ids };
}
