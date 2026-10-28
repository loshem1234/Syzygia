// Parsing and normalizing agent replies, and the disposition rules that decide
// what can block agreement.
export const SEVERITIES = ['minor', 'moderate', 'major'];
export const CATEGORIES = ['fidelity', 'syntax', 'lexical', 'register', 'rhythm'];

export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* next */ }
  }
  return null;
}

const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function normEvidence(list) {
  return arr(list).map((e) => {
    if (typeof e === 'string') return { type: 'text', note: e };
    const type = ['citation', 'parse', 'text'].includes(e?.type) ? e.type : e?.work ? 'citation' : e?.form ? 'parse' : 'text';
    return { type, work: str(e.work), ref: str(e.ref), quote: str(e.quote), form: str(e.form), analysis: str(e.analysis), note: str(e.note) };
  });
}

export function normCritique(list, phase) {
  return arr(list).map((c, i) => ({
    id: str(c.id) || `${phase}-${i + 1}`,
    category: CATEGORIES.includes(c.category) ? c.category : 'fidelity',
    kind: c.kind === 'error' ? 'error' : 'preference',
    severity: SEVERITIES.includes(c.severity) ? c.severity : 'minor',
    greek: str(c.greek),
    point: str(c.point),
    suggestion: str(c.suggestion),
    evidence: normEvidence(c.evidence),
  }));
}

const VALIDATORS = {
  A1: (o) => typeof o.rendering === 'string' && o.rendering.trim(),
  B1: (o) => typeof o.rendering === 'string' && o.rendering.trim(),
  A2: (o) => typeof o.rendering === 'string' && o.rendering.trim(),
  B2: (o) => typeof o.rendering === 'string' && o.rendering.trim(),
  S1: (o) => typeof o.rendering === 'string' && o.rendering.trim(),
  S2: (o) => typeof o.rendering === 'string' && o.rendering.trim(),
};

// Returns a normalized payload or null if the reply is unusable.
export function normalizeReply(phase, raw) {
  const o = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!o || !VALIDATORS[phase]?.(o)) return null;
  const out = {
    rendering: o.rendering.trim(),
    notes: arr(o.notes).map(str),
    critique: normCritique(o.critique, phase),
    responses: arr(o.responses).map((r) => ({ to: str(r.to), action: ['accept', 'decline', 'contest'].includes(r.action) ? r.action : 'accept', note: str(r.note), evidence: normEvidence(r.evidence) })),
    ledger_proposals: arr(o.ledger_proposals).map((p, i) => ({ id: str(p.id) || `${phase}-L${i + 1}`, lemma: str(p.lemma), rendering: str(p.rendering), note: str(p.note), evidence: normEvidence(p.evidence), verses: arr(p.verses).map(str) })).filter((p) => p.lemma && p.rendering),
    ledger_responses: arr(o.ledger_responses).map((r) => ({ proposal_id: str(r.proposal_id), accept: r.accept === true, note: str(r.note) })),
    style_proposals: arr(o.style_proposals).map(str).filter(Boolean),
    quotations: arr(o.quotations).map((q) => ({ greek: str(q.greek), source: str(q.source) })).filter((q) => q.greek && q.source),
    signoff: o.signoff === true,
  };
  if (phase === 'S1' || phase === 'S2') {
    out.concessions = arr(o.concessions).map(str);
    out.holds = arr(o.holds).map((h) => ({ point: str(h.point ?? h), evidence: normEvidence(h.evidence) }));
    out.accept = phase === 'S2' ? o.accept === true : true;
  }
  return out;
}

// Disposition rule 1: only verified-or-grounded errors of moderate or major severity block.
export function isBlocking(item) {
  if (item.kind !== 'error') return false;
  if (!(item.severity === 'moderate' || item.severity === 'major')) return false;
  if (item.unverified) return false; // its only support was a citation that failed verification
  return true;
}

export function blockingItems(payload) {
  return (payload?.critique || []).filter(isBlocking);
}

// Agreement after B2: both agents sign off and no blocking error remains.
export function agreed(a2, b2) {
  return Boolean(a2?.signoff && b2?.signoff && blockingItems(b2).length === 0);
}

// Disposition rule 3: an agent may not reopen a settled point. Items settled in
// earlier turns of the verse (accepted, or preferences declined) are recorded,
// and a later critique item restating one is dropped.
export function settledPoints(turns) {
  const settled = new Set();
  const byId = new Map();
  for (const t of turns) for (const c of t.payload?.critique || []) byId.set(c.id, c);
  for (const t of turns) {
    for (const r of t.payload?.responses || []) {
      const item = byId.get(r.to);
      if (!item) continue;
      if (r.action === 'accept' || (r.action === 'decline' && item.kind === 'preference')) settled.add(pointKey(item));
    }
  }
  return settled;
}

export function pointKey(item) {
  return `${(item.greek || '').trim().toLowerCase()}|${item.category}`;
}

export function dropReopened(payload, settled) {
  if (!payload?.critique?.length || !settled.size) return { payload, dropped: [] };
  const dropped = payload.critique.filter((c) => settled.has(pointKey(c)) && c.greek);
  return { payload: { ...payload, critique: payload.critique.filter((c) => !dropped.includes(c)) }, dropped };
}

// Open errors addressed to an agent: blocking items from the partner not yet answered.
export function openErrorsFor(turns, agent) {
  const answered = new Set(turns.filter((t) => t.agent === agent).flatMap((t) => (t.payload?.responses || []).map((r) => r.to)));
  return turns.filter((t) => t.agent !== agent).flatMap((t) => (t.payload?.critique || []).filter((c) => isBlocking(c) && !answered.has(c.id)));
}
