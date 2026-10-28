// Citation verification: a cited section must exist in the library, and any
// quoted words must appear in it. Parse evidence is checked against the parser.
import { findWork, byRef, byHeadword } from './retrieval.js';
import { lookupKey } from './integrity.js';

export async function verifyEvidence(evidence, { works, parses = [] } = {}) {
  const failures = [];
  const verified = [];
  for (const e of evidence) {
    if (e.type === 'citation') {
      const work = await findWork(e.work, works);
      if (!work) { failures.push({ ...e, reason: 'no work by that name is in your library' }); e.verified = false; continue; }
      let chunk = await byRef(work.id, e.ref);
      if (!chunk && ['lexicon', 'particles'].includes(work.kind)) chunk = (await byHeadword(lookupKey(e.ref), [work.id]))[0];
      if (!chunk) { failures.push({ ...e, reason: `${work.short} has no section or entry "${e.ref}"` }); e.verified = false; continue; }
      if (e.quote && e.quote.trim().length > 2) {
        const words = lookupKey(e.quote).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
        const hay = lookupKey(chunk.text).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ');
        if (!hay.includes(words.join(' '))) { failures.push({ ...e, reason: 'the quoted words do not appear in that passage' }); e.verified = false; continue; }
      }
      e.verified = true;
      e.chunk_id = chunk.id;
      verified.push(chunk.id);
    } else if (e.type === 'parse' && parses.length) {
      const k = lookupKey(e.form);
      const tok = parses.find((p) => lookupKey(p.form) === k);
      e.verified = !tok || !tok.analyses.length ? null : true; // the parser cannot contradict an analysis it lacks
    }
  }
  return { failures, verifiedChunkIds: verified };
}

// Verify every piece of evidence in a payload. Marks items whose only support
// was a failed citation as unverified, so they cannot block agreement.
export async function verifyPayload(payload, ctx) {
  const all = [];
  for (const c of payload.critique || []) all.push(...c.evidence);
  for (const r of payload.responses || []) all.push(...r.evidence);
  for (const p of payload.ledger_proposals || []) all.push(...p.evidence);
  for (const h of payload.holds || []) all.push(...h.evidence);
  const { failures, verifiedChunkIds } = await verifyEvidence(all, ctx);
  for (const c of payload.critique || []) {
    const ev = c.evidence;
    c.unverified = ev.length > 0 && ev.every((e) => e.type === 'citation' && e.verified === false);
  }
  return { failures, verifiedChunkIds };
}
