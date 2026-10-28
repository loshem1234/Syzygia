// Exports: PDF, DOCX, Markdown, TXT and TEI XML. Every export re-checks the
// source fingerprint, and the Greek is written exactly as stored.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, FootnoteReferenceRun, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType } from 'docx';
import { all, one } from '../db/pool.js';
import { assertIntact } from '../core/integrity.js';
import { ledgerFor } from '../core/ledger.js';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fonts');
const DEFAULTS = { layout: 'facing', apparatus: { dissent: true, preference: false, ledger: true, variant: true, citation: false }, glossary: true, provenance: true, versionId: null };

export async function chapterExportData(chapterId, opts = {}) {
  const o = { ...DEFAULTS, ...opts, apparatus: { ...DEFAULTS.apparatus, ...(opts.apparatus || {}) } };
  const chapter = await one('SELECT * FROM chapters WHERE id = $1', [chapterId]);
  assertIntact(chapter.source_raw, chapter.source_hash, `chapter ${chapter.ord}`);
  const project = await one('SELECT * FROM projects WHERE id = $1', [chapter.project_id]);
  const verses = await all('SELECT * FROM verses WHERE chapter_id = $1 ORDER BY ord', [chapterId]);
  const kinds = Object.entries(o.apparatus).filter(([, v]) => v).map(([k]) => k);
  for (const v of verses) {
    // every verse slice must still be the exact text of the source
    if (chapter.source_raw.slice(v.src_start, v.src_end) !== v.source) throw new Error(`Verse ${v.num} no longer matches its source slice`);
    v.notes = v.current_version_id
      ? await all(`SELECT kind, agent, text FROM apparatus_notes WHERE version_id = $1 AND kind = ANY($2::text[]) ORDER BY id`, [v.current_version_id, kinds])
      : [];
  }
  const runs = await all(`SELECT DISTINCT r.id, aa.name AS a_name, va.model AS a_model, ab.name AS b_name, vb.model AS b_model, r.finished_at
      FROM verse_versions vv JOIN runs r ON r.id = vv.run_id
      JOIN agent_versions va ON va.id = r.agent_a_version_id JOIN agents aa ON aa.id = va.agent_id
      JOIN agent_versions vb ON vb.id = r.agent_b_version_id JOIN agents ab ON ab.id = vb.agent_id
     WHERE vv.id IN (SELECT current_version_id FROM verses WHERE chapter_id = $1)`, [chapterId]);
  let glossary = [];
  if (o.glossary) {
    const ledger = await ledgerFor(project);
    const used = new Set((await all(`SELECT DISTINCT vl.lemma_key FROM verse_lemmas vl JOIN verses v ON v.id = vl.verse_id WHERE v.chapter_id = $1`, [chapterId])).map((r) => r.lemma_key));
    glossary = ledger.filter((e) => used.has(e.lemma_key));
  }
  return { project, chapter, verses, runs, glossary, options: o };
}

export function toTxt(d) {
  const L = [`${d.project.title}${d.project.author ? ` — ${d.project.author}` : ''}`, `Chapter ${d.chapter.ord}: ${d.chapter.title}`, ''];
  const endnotes = [];
  for (const v of d.verses) {
    if (d.options.layout === 'facing') L.push(`${v.num}  ${v.source}`);
    const marks = v.notes.map((n) => { endnotes.push(`${v.num}: ${n.text}`); return `[${endnotes.length}]`; }).join('');
    L.push(`${v.num}  ${v.final_rendering || '[not yet translated]'}${marks}`, '');
  }
  if (endnotes.length) L.push('NOTES', ...endnotes.map((n, i) => `[${i + 1}] ${n}`), '');
  if (d.glossary.length) L.push('GLOSSARY', ...d.glossary.map((e) => `${e.lemma} — ${e.rendering}`), '');
  if (d.options.provenance) L.push(...provenance(d));
  return L.join('\n');
}

export function toMarkdown(d) {
  const L = [`# ${d.project.title}`, d.project.author ? `*${d.project.author}*` : '', '', `## Chapter ${d.chapter.ord}: ${d.chapter.title}`, ''];
  const endnotes = [];
  for (const v of d.verses) {
    const marks = v.notes.map((n) => { endnotes.push(`${v.num}: ${n.text}`); return `[^${endnotes.length}]`; }).join('');
    if (d.options.layout === 'facing') L.push(`**${v.num}** ${v.source}`, '', `> ${v.final_rendering || '*not yet translated*'}${marks}`, '');
    else L.push(`**${v.num}** ${v.final_rendering || '*not yet translated*'}${marks}`, '');
  }
  if (endnotes.length) L.push(...endnotes.map((n, i) => `[^${i + 1}]: ${n}`), '');
  if (d.glossary.length) L.push('## Glossary', '', ...d.glossary.map((e) => `- **${e.lemma}** — ${e.rendering}`), '');
  if (d.options.provenance) L.push('## Provenance', '', ...provenance(d).map((p) => `- ${p}`));
  return L.join('\n');
}

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toTei(d) {
  const body = d.verses.map((v) => {
    const notes = v.notes.map((n) => `\n        <note type="${xml(n.kind)}"${n.agent ? ` resp="#agent${xml(n.agent)}"` : ''}>${xml(n.text)}</note>`).join('');
    return `      <div type="verse" n="${xml(v.num)}">
        <ab xml:lang="grc">${xml(v.source)}</ab>
        <ab xml:lang="en" type="translation">${xml(v.final_rendering || '')}</ab>${notes}
      </div>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>${xml(d.project.title)}, chapter ${d.chapter.ord}: ${xml(d.chapter.title)}</title><author>${xml(d.project.author)}</author><respStmt><resp>Translated with Syzygia</resp><name>Loshem</name></respStmt></titleStmt>
      <publicationStmt><p>Archivum Universale &amp; Scriptorium</p></publicationStmt>
      <sourceDesc><p>Greek text as imported. SHA-256: ${xml(d.chapter.source_hash)}</p></sourceDesc>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <div type="chapter" n="${d.chapter.ord}">
${body}
      </div>
    </body>
  </text>
</TEI>
`;
}

function provenance(d) {
  return [
    `Source fingerprint (SHA-256): ${d.chapter.source_hash}`,
    ...d.runs.map((r) => `Run ${r.id}: Agent A ${r.a_name} (${r.a_model}), Agent B ${r.b_name} (${r.b_model})${r.finished_at ? `, finished ${new Date(r.finished_at).toISOString().slice(0, 10)}` : ''}`),
    `Exported ${new Date().toISOString().slice(0, 10)} with Syzygia`,
  ];
}

export async function toDocx(d) {
  const footnotes = {};
  let fn = 1;
  const greek = (t) => new TextRun({ text: t, font: 'GFS Didot', size: 24 });
  const eng = (t, extra = {}) => new TextRun({ text: t, font: 'EB Garamond', size: 24, ...extra });
  const noteRuns = (v) => v.notes.map((n) => { footnotes[fn] = { children: [new Paragraph({ children: [eng(`${n.kind}: ${n.text}`, { size: 18 })] })] }; return new FootnoteReferenceRun(fn++); });
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [eng(d.project.title, { size: 40 })] }),
    new Paragraph({ children: [eng(d.project.author || '', { italics: true })] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [eng(`Chapter ${d.chapter.ord}: ${d.chapter.title}`, { size: 30, color: '8E2A1B' })] }),
  ];
  if (d.options.layout === 'facing') {
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
      rows: d.verses.map((v) => new TableRow({ children: [
        new TableCell({ width: { size: 48, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [eng(`${v.num} `, { bold: true, color: '8E2A1B' }), greek(v.source)] })] }),
        new TableCell({ width: { size: 52, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [eng(`${v.num} `, { bold: true, color: '8E2A1B' }), eng(v.final_rendering || '[not yet translated]'), ...noteRuns(v)] })] }),
      ] })),
    }));
  } else {
    for (const v of d.verses) children.push(new Paragraph({ spacing: { after: 120 }, children: [eng(`${v.num} `, { bold: true, color: '8E2A1B' }), eng(v.final_rendering || '[not yet translated]'), ...noteRuns(v)] }));
  }
  if (d.glossary.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [eng('Glossary', { size: 26 })] }));
    for (const e of d.glossary) children.push(new Paragraph({ children: [greek(e.lemma), eng(` — ${e.rendering}`)] }));
  }
  if (d.options.provenance) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [eng('Provenance', { size: 26 })] }));
    for (const p of provenance(d)) children.push(new Paragraph({ alignment: AlignmentType.LEFT, children: [eng(p, { size: 18 })] }));
  }
  const doc = new Document({ footnotes, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export function toPdf(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 64, left: 60, right: 60 }, info: { Title: `${d.project.title} ${d.chapter.ord}`, Author: d.project.author || '' } });
    doc.registerFont('greek', path.join(FONT_DIR, 'GFSDidot-Regular.ttf'));
    doc.registerFont('roman', path.join(FONT_DIR, 'EBGaramond-Regular.ttf'));
    doc.registerFont('italic', path.join(FONT_DIR, 'EBGaramond-Italic.ttf'));
    const bufs = [];
    doc.on('data', (b) => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);
    const rubric = '#8E2A1B';
    const ink = '#241A12';
    doc.fillColor(ink).font('roman').fontSize(22).text(d.project.title, { align: 'center' });
    if (d.project.author) doc.font('italic').fontSize(13).text(d.project.author, { align: 'center' });
    doc.moveDown(0.6).fillColor(rubric).font('roman').fontSize(15).text(`Chapter ${d.chapter.ord} · ${d.chapter.title}`, { align: 'center' });
    doc.moveDown(1).fillColor(ink);
    const notes = [];
    const width = doc.page.width - 120;
    for (const v of d.verses) {
      const marks = v.notes.map((n) => { notes.push(`${v.num}: ${n.text}`); return notes.length; });
      const sup = marks.length ? ` [${marks.join(',')}]` : '';
      if (d.options.layout === 'facing') {
        const colW = (width - 24) / 2;
        const y = doc.y;
        doc.font('greek').fontSize(11.5).fillColor(ink);
        const hG = doc.heightOfString(`${v.num}  ${v.source}`, { width: colW });
        doc.font('roman').fontSize(11.5);
        const hE = doc.heightOfString(`${v.num}  ${v.final_rendering || ''}${sup}`, { width: colW });
        if (y + Math.max(hG, hE) > doc.page.height - 70) doc.addPage();
        const top = doc.y;
        doc.fillColor(rubric).font('roman').text(v.num, 60, top, { continued: true }).fillColor(ink).font('greek').text(`  ${v.source}`, { width: colW });
        doc.fillColor(rubric).font('roman').text(v.num, 60 + colW + 24, top, { continued: true }).fillColor(ink).text(`  ${v.final_rendering || '[not yet translated]'}${sup}`, { width: colW });
        doc.x = 60;
        doc.y = top + Math.max(hG, hE) + 8;
      } else {
        doc.fillColor(rubric).font('roman').fontSize(11.5).text(`${v.num}  `, { continued: true }).fillColor(ink).text(`${v.final_rendering || '[not yet translated]'}${sup}`, { width });
        doc.moveDown(0.4);
      }
    }
    if (notes.length) {
      doc.moveDown(1).fillColor(rubric).font('roman').fontSize(13).text('Notes', 60);
      doc.fillColor(ink).fontSize(9.5);
      notes.forEach((n, i) => doc.font('roman').text(`[${i + 1}] `, { continued: true }).font('greek').text(n, { width }));
    }
    if (d.glossary.length) {
      doc.moveDown(1).fillColor(rubric).font('roman').fontSize(13).text('Glossary', 60);
      doc.fillColor(ink).fontSize(10.5);
      for (const e of d.glossary) doc.font('greek').text(e.lemma, { continued: true }).font('roman').text(` — ${e.rendering}`);
    }
    if (d.options.provenance) {
      doc.moveDown(1).fillColor(rubric).font('roman').fontSize(13).text('Provenance', 60);
      doc.fillColor(ink).fontSize(8.5);
      for (const p of provenance(d)) doc.font('roman').text(p, { width });
    }
    doc.end();
  });
}

export async function exportChapter(chapterId, format, opts) {
  const d = await chapterExportData(chapterId, opts);
  const base = `${d.project.title}-ch${d.chapter.ord}`.replace(/[^\p{L}\p{N}-]+/gu, '_');
  switch (format) {
    case 'txt': return { body: Buffer.from(toTxt(d), 'utf8'), type: 'text/plain; charset=utf-8', name: `${base}.txt` };
    case 'md': return { body: Buffer.from(toMarkdown(d), 'utf8'), type: 'text/markdown; charset=utf-8', name: `${base}.md` };
    case 'tei': return { body: Buffer.from(toTei(d), 'utf8'), type: 'application/tei+xml; charset=utf-8', name: `${base}.tei.xml` };
    case 'docx': return { body: await toDocx(d), type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: `${base}.docx` };
    case 'pdf': return { body: await toPdf(d), type: 'application/pdf', name: `${base}.pdf` };
    default: throw new Error(`Unknown format ${format}`);
  }
}
