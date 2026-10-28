// The three provider adapters against a local stub of each API: request shape,
// cache breakpoints, and the tool loop round trip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { anthropicAdapter } from '../src/providers/anthropic.js';
import { openaiAdapter } from '../src/providers/openai.js';
import { googleAdapter } from '../src/providers/google.js';

const seen = [];
let server, url;
const count = { a: 0, o: 0, g: 0 };

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      seen.push({ path: req.url, json });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/v1/messages')) {
        const first = count.a++ === 0;
        return res.end(JSON.stringify(first
          ? { id: 'm1', type: 'message', role: 'assistant', model: json.model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'lookup', input: { lemma: 'νοῦς' } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } }
          : { id: 'm2', type: 'message', role: 'assistant', model: json.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"rendering":"Intellect"}' }], usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } }));
      }
      if (req.url.startsWith('/v1/chat/completions')) {
        const first = count.o++ === 0;
        const message = first
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"lemma":"νοῦς"}' } }] }
          : { role: 'assistant', content: '{"rendering":"Intellect"}' };
        return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: json.model, choices: [{ index: 0, message, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } } }));
      }
      if (req.url.includes(':generateContent')) {
        const first = count.g++ === 0;
        const parts = first ? [{ functionCall: { name: 'lookup', args: { lemma: 'νοῦς' } } }] : [{ text: '{"rendering":"Intellect"}' }];
        return res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 5, cachedContentTokenCount: 30 } }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const request = {
  model: 'test-model',
  system: 'THE CHARTER',
  blocks: [{ text: 'L2', cache: true }, { text: 'L3', cache: false }, { text: 'L4', cache: true }, { text: 'L5', cache: true }, { text: 'L6', cache: false }, { text: 'L7 TASK', cache: false }],
  tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object', properties: { lemma: { type: 'string' } }, required: ['lemma'] } }],
};
const executed = [];
const executeTool = async (name, args) => { executed.push([name, args]); return 'νοῦς, ὁ, mind'; };

test('Anthropic: cache breakpoints and tool loop', async () => {
  const p = anthropicAdapter('sk-test', { baseURL: url });
  const out = await p.complete({ ...request, executeTool });
  assert.equal(out.text, '{"rendering":"Intellect"}');
  assert.equal(out.usage.cachedRead, 200);
  const reqs = seen.filter((s) => s.path.startsWith('/v1/messages'));
  assert.equal(reqs.length, 2);
  const first = reqs[0].json;
  assert.equal(first.system[0].cache_control.type, 'ephemeral');
  const marks = first.messages[0].content.filter((c) => c.cache_control).length;
  assert.ok(1 + marks <= 4, 'no more than four cache breakpoints');
  assert.equal(first.tools[0].input_schema.type, 'object');
  const second = reqs[1].json.messages;
  assert.equal(second.at(-1).content[0].type, 'tool_result');
  assert.equal(second.at(-1).content[0].tool_use_id, 'tu1');
});

test('OpenAI: developer message, ordered context, tool loop', async () => {
  const p = openaiAdapter('sk-test', { baseURL: `${url}/v1` });
  const out = await p.complete({ ...request, executeTool });
  assert.equal(out.text, '{"rendering":"Intellect"}');
  assert.equal(out.usage.cachedRead, 80);
  const reqs = seen.filter((s) => s.path.startsWith('/v1/chat/completions'));
  assert.equal(reqs[0].json.messages[0].role, 'developer');
  assert.equal(reqs[0].json.messages[1].content, 'L2\n\nL3\n\nL4\n\nL5\n\nL6\n\nL7 TASK');
  assert.equal(reqs[1].json.messages.at(-1).role, 'tool');
});

test('Gemini: system instruction, function call round trip', async () => {
  const p = googleAdapter('test-key', { httpOptions: { baseUrl: url } });
  const out = await p.complete({ ...request, executeTool });
  assert.equal(out.text, '{"rendering":"Intellect"}');
  const reqs = seen.filter((s) => s.path.includes(':generateContent'));
  assert.equal(reqs.length, 2);
  const sys = reqs[0].json.systemInstruction || reqs[0].json.system_instruction;
  assert.ok(JSON.stringify(sys).includes('THE CHARTER'));
  const lastTurn = reqs[1].json.contents.at(-1);
  assert.ok(lastTurn.parts[0].functionResponse, 'the tool result is sent back');
  assert.equal(executed.length, 3);
});
