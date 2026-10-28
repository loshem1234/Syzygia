// The debate protocol as a pure state machine. Given the turns already taken
// for a verse, it says what happens next. The longest path is six turns, and
// every path ends with the verse locked.
import { agreed } from './critique.js';

export const ORDER = ['A1', 'B1', 'A2', 'B2', 'S1', 'S2'];
export const MAX_TURNS = 6;

// Returns { action: 'turn', phase, agent, escalate } or { action: 'lock', outcome, rendering, apparatus }.
export function next(turns, { escalateMode = 'auto' } = {}) {
  const by = Object.fromEntries(turns.map((t) => [t.phase, t]));
  const premium = escalateMode === 'premium';
  for (const phase of ['A1', 'B1', 'A2', 'B2']) {
    if (!by[phase]) return { action: 'turn', phase, agent: phase[0], escalate: premium };
  }
  if (agreed(by.A2.payload, by.B2.payload)) {
    return { action: 'lock', outcome: 'agreed', rendering: by.B2.payload.rendering, apparatus: preferenceNotes(turns) };
  }
  const escalate = premium || escalateMode === 'auto';
  if (!by.S1) return { action: 'turn', phase: 'S1', agent: 'A', escalate };
  if (!by.S2) return { action: 'turn', phase: 'S2', agent: 'B', escalate };
  const s1 = by.S1.payload;
  const s2 = by.S2.payload;
  if (s2.accept) {
    return { action: 'lock', outcome: 'synthesized', rendering: s1.rendering, apparatus: [...concessionNotes(s1, s2), ...preferenceNotes(turns)] };
  }
  // True divergence: the last joint version stands and both positions go to the apparatus.
  const apparatus = [
    ...s1.holds.map((h) => ({ kind: 'dissent', agent: 'A', text: h.point })),
    ...s2.holds.map((h) => ({ kind: 'dissent', agent: 'B', text: h.point })),
    { kind: 'dissent', agent: 'A', text: `Agent A's joint rendering: ${s1.rendering}` },
  ];
  return { action: 'lock', outcome: 'disputed', rendering: s2.rendering, apparatus };
}

function preferenceNotes(turns) {
  // Preferences offered and declined are kept as optional apparatus, never lost.
  const declined = new Set(turns.flatMap((t) => (t.payload?.responses || []).filter((r) => r.action === 'decline').map((r) => r.to)));
  return turns.flatMap((t) => (t.payload?.critique || [])
    .filter((c) => c.kind === 'preference' && declined.has(c.id) && c.suggestion)
    .map((c) => ({ kind: 'preference', agent: t.agent, text: `${c.greek ? c.greek + ': ' : ''}${c.suggestion}` })));
}

function concessionNotes(s1, s2) {
  return [...(s1.holds || []).map((h) => ({ kind: 'dissent', agent: 'A', text: `Held in synthesis: ${h.point}` })),
    ...(s2.holds || []).map((h) => ({ kind: 'dissent', agent: 'B', text: `Held in synthesis: ${h.point}` }))]
    .filter((n) => n.text.length > 'Held in synthesis: '.length);
}
