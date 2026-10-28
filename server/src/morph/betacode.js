// Unicode Greek <-> Beta Code, for talking to the Morpheus parser.
const L2B = {
  α: 'a', β: 'b', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'h', θ: 'q', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'c', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'u', φ: 'f', χ: 'x', ψ: 'y', ω: 'w',
  ϝ: 'v',
};
const B2L = Object.fromEntries(Object.entries(L2B).filter(([k]) => k !== 'ς').map(([k, v]) => [v, k]));
const MARK2B = { '̓': ')', '̔': '(', '́': '/', '̀': '\\', '͂': '=', '̈': '+', 'ͅ': '|' };
const B2MARK = Object.fromEntries(Object.entries(MARK2B).map(([k, v]) => [v, k]));
const ORDER = [')', '(', '+', '/', '\\', '=', '|'];

export function toBeta(word) {
  let out = '';
  // Normalization here only shapes the query sent to the parser; the source is untouched.
  for (const cluster of word.normalize('NFD').match(/\P{M}\p{M}*/gu) || []) {
    const base = cluster[0];
    const lower = base.toLowerCase();
    const letter = L2B[lower];
    if (!letter) continue;
    const marks = [...cluster.slice(1)].map((c) => MARK2B[c] || (c === '́' ? '/' : '')).filter(Boolean)
      .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    if (base !== lower) out += '*' + marks.filter((m) => m !== '|').join('') + letter + (marks.includes('|') ? '|' : '');
    else out += letter + marks.join('');
  }
  return out;
}

export function fromBeta(beta) {
  let out = '';
  let i = 0;
  const s = beta.replace(/s1/g, 's').replace(/s2/g, 's');
  while (i < s.length) {
    let ch = s[i];
    if (ch === '*') {
      i++;
      let pre = '';
      while (i < s.length && B2MARK[s[i]]) pre += s[i++];
      const L = B2L[s[i]];
      i++;
      if (!L) continue;
      let post = '';
      while (i < s.length && B2MARK[s[i]]) post += s[i++];
      out += (L.toUpperCase() + [...pre + post].map((m) => B2MARK[m]).join('')).normalize('NFC');
      continue;
    }
    const L = B2L[ch.toLowerCase()];
    if (L) {
      i++;
      let marks = '';
      while (i < s.length && B2MARK[s[i]]) marks += s[i++];
      out += (L + [...marks].map((m) => B2MARK[m]).join('')).normalize('NFC');
    } else { out += ch; i++; }
  }
  // final sigma
  return out.replace(/σ(?=$|[^\p{L}\p{M}])/gu, 'ς');
}
