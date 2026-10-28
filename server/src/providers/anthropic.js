import Anthropic from '@anthropic-ai/sdk';
import { runToolLoop } from './loop.js';

// Claude: explicit prompt caching. Breakpoints are placed after the system
// prompt and after each stable context layer (at most four).
export function anthropicAdapter(apiKey, opts = {}) {
  const client = apiKey ? new Anthropic({ apiKey, ...opts }) : null;
  const need = () => { if (!client) throw new Error('ANTHROPIC_API_KEY is not set'); return client; };

  return {
    name: 'anthropic',
    async complete({ model, system, blocks, messages = [], tools = [], executeTool, maxTokens = 4000, temperature, maxToolCalls = 8 }) {
      const c = need();
      let breakpoints = 1;
      const content = blocks.map((b) => {
        const part = { type: 'text', text: b.text };
        if (b.cache && breakpoints < 4) { part.cache_control = { type: 'ephemeral' }; breakpoints++; }
        return part;
      });
      const convo = [{ role: 'user', content }];
      for (const m of messages) convo.push({ role: m.role, content: m.text });
      const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

      return runToolLoop({
        maxToolCalls,
        step: async ({ allowTools }) => {
          const req = {
            model,
            max_tokens: maxTokens,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            messages: convo,
          };
          if (toolDefs.length) {
            req.tools = toolDefs;
            if (!allowTools) req.tool_choice = { type: 'none' };
          }
          if (temperature != null) req.temperature = temperature;
          const res = await c.messages.create(req);
          const usage = {
            input: res.usage?.input_tokens || 0,
            output: res.usage?.output_tokens || 0,
            cachedRead: res.usage?.cache_read_input_tokens || 0,
            cacheWrite: res.usage?.cache_creation_input_tokens || 0,
          };
          const uses = res.content.filter((p) => p.type === 'tool_use');
          if (res.stop_reason === 'tool_use' && uses.length) {
            convo.push({ role: 'assistant', content: res.content });
            const results = [];
            const calls = [];
            for (const u of uses) {
              const result = await executeTool(u.name, u.input || {});
              calls.push({ name: u.name, args: u.input, result: result.slice(0, 4000) });
              results.push({ type: 'tool_result', tool_use_id: u.id, content: result });
            }
            convo.push({ role: 'user', content: results });
            return { done: false, calls, usage };
          }
          const text = res.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
          return { done: true, text, usage };
        },
      });
    },
    async countTokens({ model, system, text }) {
      const c = need();
      const r = await c.messages.countTokens({ model, system, messages: [{ role: 'user', content: text }] });
      return r.input_tokens;
    },
    async listModels() {
      const c = need();
      const out = [];
      for await (const m of c.models.list({ limit: 100 })) out.push({ id: m.id, name: m.display_name || m.id });
      return { models: out };
    },
    async embed() { throw new Error('Anthropic does not provide embeddings; set EMBEDDINGS_PROVIDER to openai or google'); },
  };
}
