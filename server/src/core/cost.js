// Cost accounting. Prices are entered by Loshem on the Agents page (per million
// tokens), because providers change them; the app never guesses a price.
import { one, q } from '../db/pool.js';

export async function pricing() {
  return (await one(`SELECT value FROM settings WHERE key = 'pricing'`))?.value || {};
}

export async function setPricing(map) {
  await q(`INSERT INTO settings (key, value) VALUES ('pricing', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(map)]);
}

export function costOf(price, usage) {
  if (!price) return 0;
  const m = 1e6;
  return ((usage.input || 0) * (price.input || 0)
    + (usage.output || 0) * (price.output || 0)
    + (usage.cachedRead || 0) * (price.cachedInput ?? (price.input || 0) * 0.1)
    + (usage.cacheWrite || 0) * (price.cacheWrite ?? (price.input || 0) * 1.25)) / m;
}

// Rough estimate for the run setup page: verses × expected turns × context size.
export function estimateRun({ verses, contextTokens, priceA, priceB, synthesisRate = 0.15 }) {
  const turnsA = 2 + 1 * synthesisRate;
  const turnsB = 2 + 1 * synthesisRate;
  const perTurn = (price) => {
    if (!price) return null;
    // first call of a run writes the cache; later calls mostly read it
    const cached = contextTokens * 0.85;
    const fresh = contextTokens * 0.15;
    return (cached * (price.cachedInput ?? price.input * 0.1) + fresh * price.input + 1200 * price.output) / 1e6;
  };
  const a = perTurn(priceA);
  const b = perTurn(priceB);
  if (a == null || b == null) return null;
  return Number((verses * (turnsA * a + turnsB * b)).toFixed(2));
}
