import { GoogleGenAI } from '@google/genai';
import { runToolLoop } from './loop.js';

// Gemini: implicit context caching applies automatically to the repeated
// prefix, which the stable ordering of the context layers is designed for.
export function googleAdapter(apiKey, opts = {}) {
  const ai = apiKey ? new GoogleGenAI({ apiKey, ...opts }) : null;
  const need = () => { if (!ai) throw new Error('GEMINI_API_KEY is not set'); return ai; };

  return {
    name: 'google',
    async complete({ model, system, blocks, messages = [], tools = [], executeTool, maxTokens = 4000, temperature, maxToolCalls = 8 }) {
      const g = need();
      const contents = [{ role: 'user', parts: blocks.map((b) => ({ text: b.text })) }];
      for (const m of messages) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] });
      const functionDeclarations = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

      return runToolLoop({
        maxToolCalls,
        step: async ({ allowTools }) => {
          const cfg = { systemInstruction: system, maxOutputTokens: maxTokens };
          if (temperature != null) cfg.temperature = temperature;
          if (functionDeclarations.length && allowTools) cfg.tools = [{ functionDeclarations }];
          const res = await g.models.generateContent({ model, contents, config: cfg });
          const um = res.usageMetadata || {};
          const usage = {
            input: (um.promptTokenCount || 0) - (um.cachedContentTokenCount || 0),
            output: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
            cachedRead: um.cachedContentTokenCount || 0,
            cacheWrite: 0,
          };
          const calls = res.functionCalls || [];
          if (calls.length && allowTools) {
            contents.push(res.candidates?.[0]?.content || { role: 'model', parts: calls.map((fc) => ({ functionCall: fc })) });
            const parts = [];
            const made = [];
            for (const fc of calls) {
              const result = await executeTool(fc.name, fc.args || {});
              made.push({ name: fc.name, args: fc.args, result: result.slice(0, 4000) });
              parts.push({ functionResponse: { id: fc.id, name: fc.name, response: { result } } });
            }
            contents.push({ role: 'user', parts });
            return { done: false, calls: made, usage };
          }
          return { done: true, text: res.text || '', usage };
        },
      });
    },
    async listModels() {
      const g = need();
      const out = [];
      const pager = await g.models.list();
      for await (const m of pager) {
        if ((m.supportedActions || ['generateContent']).includes('generateContent')) out.push({ id: (m.name || '').replace(/^models\//, ''), name: m.displayName || m.name });
      }
      return { models: out };
    },
    async embed(texts, model = 'gemini-embedding-001') {
      const g = need();
      const res = await g.models.embedContent({ model: model || 'gemini-embedding-001', contents: texts });
      return (res.embeddings || []).map((e) => e.values);
    },
  };
}
