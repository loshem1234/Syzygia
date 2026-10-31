// Library ingestion: split each work along its own structure, so retrieval can
// return one lexicon entry or one numbered grammar section, never a volume.
import { lookupKey, greekWords } from '../core/integrity.js';

export const SPLIT_MODES = ['headword', 'section', 'particle', 'heading', 'paragraph', 'jsonl', 'lsj-xml'];

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export function refKey(ref) {
  return lookupKey(String(ref).replace(/^§\s*/, '').replace(/^s\.\s*/i, '').replace(/\s+/g, ' ').trim());
}

function chunk(ref, text, { heading = '', lemmas = [], topics = [] } = {}) {
  const body = text.trim();
  return {
    ref: String(ref).trim(),
    ref_key: refKey(ref),
    heading: heading.trim(),
    text: body,
    search_key: lookupKey(`${heading} ${ref} ${body}`),
    lemma_keys: [...new Set(lemmas.map((l) => lookupKey(l)).filter(Boolean))],
    topics: [...new Set(topics.map((t) => t.toLowerCase().trim()).filter(Boolean))],
  };
}

export function splitWork(raw, mode) {
  const text = raw.replace(/\r\n?/g, '\n');
  switch (mode) {
    case 'jsonl':
      return text.split('\n').filter((l) => l.trim()).map((l) => {
        const o = JSON.parse(l);
        return chunk(o.ref, o.text, { heading: o.heading || '', lemmas: o.lemmas || (o.headword ? [o.headword] : []), topics: o.topics || [] });
      });
    case 'lsj-xml': {
      // Two layouts: Perseus (<entryFree key="…">, Unicode Greek) and the
      // Logeion edition (<div2 key="betacode"> with a Unicode <head>).
      const out = [];
      const greek = /[Ͱ-Ͽἀ-῿]/;
      const re = /<(entryFree|div2)\b([^>]*)>([\s\S]*?)<\/\1>/g;
      let m;
      while ((m = re.exec(text))) {
        const body = m[3];
        const headTag = body.match(/<head\b[^>]*>([\s\S]*?)<\/head>/);
        const key = (m[2].match(/\bkey="([^"]+)"/) || [])[1] || '';
        let head = headTag ? strip(headTag[1]) : key;
        head = head.replace(/\d+$/, '').replace(/[\s,]+$/, '').trim();
        if (!head || !greek.test(head)) continue; // front matter, abbreviations
        out.push(chunk(head, strip(body).replace(/\s*\n\s*/g, ' '), { heading: head, lemmas: [head] }));
      }
      return out;
    }
    case 'headword':
    case 'particle': {
      // Entries begin at a line starting with a Greek headword (optionally
      // numbered or bracketed) followed by a comma, colon, period or space-dash.
      const parts = text.split(/\n(?=[\[(]?[\p{Script=Greek}][\p{Script=Greek}\p{M}᾽᾿' ]{0,40}[,.:]|[\[(]?[\p{Script=Greek}][\p{Script=Greek}\p{M}]{0,30} [—–-])/u);
      return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
        const head = (p.match(/^[\[(]?([\p{Script=Greek}][\p{Script=Greek}\p{M}᾽᾿' ]{0,40}?)[,.:—–-]/u) || [])[1]?.trim() || p.slice(0, 30);
        return chunk(head, p, { heading: head, lemmas: [head], topics: mode === 'particle' ? ['particle'] : [] });
      });
    }
    case 'section': {
      // Numbered sections at line start: "1982.", "§ 1982", "1982 a."
      const parts = text.split(/\n(?=\s*(?:§\s*)?\d{1,4}[a-z]?\.\s|\s*§\s*\d{1,4}[a-z]?\s)/);
      return parts.map((p) => p.trim()).filter(Boolean).map((p, i) => {
        const n = (p.match(/^(?:§\s*)?(\d{1,4}[a-z]?)[.\s]/) || [])[1] || `p${i + 1}`;
        const firstLine = p.split('\n')[0].slice(0, 160);
        return chunk(n, p, { heading: firstLine, lemmas: greekWords(firstLine).slice(0, 6), topics: topicsFrom(firstLine) });
      });
    }
    case 'heading': {
      const parts = text.split(/\n(?=#{1,4} |[A-Z][A-Z0-9 ,.'’:;-]{6,}\n)/);
      return parts.map((p) => p.trim()).filter(Boolean).map((p, i) => {
        const h = p.split('\n')[0].replace(/^#+\s*/, '').slice(0, 160);
        return chunk(h || `part ${i + 1}`, p, { heading: h, lemmas: greekWords(h).slice(0, 6), topics: topicsFrom(h) });
      });
    }
    default: {
      const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const out = [];
      let buf = '';
      for (const p of paras) {
        if ((buf + '\n\n' + p).length > 1800 && buf) { out.push(buf); buf = p; } else buf = buf ? `${buf}\n\n${p}` : p;
      }
      if (buf) out.push(buf);
      return out.map((p, i) => chunk(`¶${i + 1}`, p, { heading: p.split('\n')[0].slice(0, 120), topics: topicsFrom(p.slice(0, 200)) }));
    }
  }
}

const STOP = new Set(['the', 'and', 'of', 'in', 'a', 'to', 'with', 'for', 'on', 'or', 'as', 'by', 'its', 'is', 'are', 'from']);
function topicsFrom(s) {
  return (s.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOP.has(w)).slice(0, 12);
}

// Trim a long lexicon entry, keeping the head and the senses that mention the
// form being translated. Always honest that it was trimmed.
export function trimEntry(text, maxChars, focusKeys = []) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.55));
  const rest = text.slice(head.length);
  const senses = rest.split(/(?=\s(?:[IVX]+\.|\d+\.|[a-z]\.)\s)/);
  const keyed = senses.filter((s) => focusKeys.some((k) => k && lookupKey(s).includes(k)));
  let extra = '';
  for (const s of keyed) { if ((extra + s).length > maxChars * 0.4) break; extra += s; }
  return `${head}${extra ? ' … ' + extra.trim() : ''} … [entry trimmed; call lookup() for the full entry]`;
}
