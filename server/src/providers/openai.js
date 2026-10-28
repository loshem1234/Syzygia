import OpenAI from 'openai';
import { runToolLoop } from './loop.js';

// OpenAI: automatic prompt caching applies to the repeated prefix.
export function openaiAdapter(apiKey, opts = {}) {
  const client = apiKey ? new OpenAI({ apiKey, ...opts }) : null;
  const need = () => { if (!client) throw new Error('OPENAI_API_KEY is not set'); return client; };

  return {
    name: 'openai',
    async complete({ model, system, blocks, messages = [], tools = [], executeTool, maxTokens = 4000, temperature, maxToolCalls = 8 }) {
      const c = need();
      const convo = [
        { role: 'developer', content: system },
        { role: 'user', content: blocks.map((b) => b.text).join('\n\n') },
        ...messages.map((m) => ({ role: m.role, content: m.text })),
      ];
      const toolDefs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

      return runToolLoop({
        maxToolCalls,
        step: async ({ allowTools }) => {
          const req = { model, messages: convo, max_completion_tokens: maxTokens };
          if (toolDefs.length) { req.tools = toolDefs; if (!allowTools) req.tool_choice = 'none'; }
          if (temperature != null) req.temperature = temperature;
          const res = await c.chat.completions.create(req);
          const cached = res.usage?.prompt_tokens_details?.cached_tokens || 0;
          const usage = { input: (res.usage?.prompt_tokens || 0) - cached, output: res.usage?.completion_tokens || 0, cachedRead: cached, cacheWrite: 0 };
          const msg = res.choices[0].message;
          if (msg.tool_calls?.length && allowTools) {
            convo.push(msg);
            const calls = [];
            for (const tc of msg.tool_calls) {
              let args = {};
              try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep empty */ }
              const result = await executeTool(tc.function.name, args);
              calls.push({ name: tc.function.name, args, result: result.slice(0, 4000) });
              convo.push({ role: 'tool', tool_call_id: tc.id, content: result });
            }
            return { done: false, calls, usage };
          }
          return { done: true, text: msg.content || '', usage };
        },
      });
    },
    async listModels() {
      const c = need();
      const out = [];
      for await (const m of c.models.list()) if (/^(gpt|o\d|chatgpt)/.test(m.id)) out.push({ id: m.id, name: m.id });
      return { models: out.sort((a, b) => a.id.localeCompare(b.id)) };
    },
    async embed(texts, model = 'text-embedding-3-large') {
      const c = need();
      const res = await c.embeddings.create({ model: model || 'text-embedding-3-large', input: texts });
      return res.data.map((d) => d.embedding);
    },
  };
}
