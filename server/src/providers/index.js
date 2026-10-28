// One adapter interface for every model provider.
//
// complete({ model, system, blocks, messages, tools, executeTool, maxTokens, temperature })
//   system: string (layer 1, the charter and the agent's own instructions)
//   blocks: [{ text, cache }]  the ordered context layers; `cache` marks a cache breakpoint
//   messages: extra conversational turns [{ role: 'user'|'assistant', text }] (repairs)
//   tools: [{ name, description, parameters }]
//   executeTool: async (name, args) => string
// returns { text, usage: { input, output, cachedRead, cacheWrite }, toolCalls: [{ name, args, result }] }
import { anthropicAdapter } from './anthropic.js';
import { googleAdapter } from './google.js';
import { openaiAdapter } from './openai.js';
import { config } from '../config.js';

const registry = {};
let overrides = null; // tests inject mock providers here

export function setProviderOverrides(map) { overrides = map; }

export function getProvider(name) {
  if (overrides?.[name]) return overrides[name];
  if (!registry[name]) {
    if (name === 'anthropic') registry[name] = anthropicAdapter(config.keys.anthropic);
    else if (name === 'google') registry[name] = googleAdapter(config.keys.google);
    else if (name === 'openai') registry[name] = openaiAdapter(config.keys.openai);
    else throw new Error(`Unknown provider: ${name}`);
  }
  return registry[name];
}

export function configuredProviders() {
  return ['anthropic', 'google', 'openai'].filter((p) => (overrides && overrides[p]) || config.keys[p]);
}

export async function listModels(name) {
  try { return await getProvider(name).listModels(); } catch (e) { return { error: e.message, models: [] }; }
}

export async function embed(texts) {
  const p = config.embeddings.provider;
  if (!p) return [];
  return getProvider(p).embed(texts, config.embeddings.model);
}

export { runToolLoop } from './loop.js';
