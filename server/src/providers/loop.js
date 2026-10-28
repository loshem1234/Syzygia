// Shared tool loop helper: providers call it with their own request/parse functions.
export async function runToolLoop({ maxToolCalls, step }) {
  const toolCalls = [];
  const usage = { input: 0, output: 0, cachedRead: 0, cacheWrite: 0 };
  for (let i = 0; i <= maxToolCalls + 1; i++) {
    const r = await step({ allowTools: toolCalls.length < maxToolCalls, toolCalls });
    usage.input += r.usage.input || 0;
    usage.output += r.usage.output || 0;
    usage.cachedRead += r.usage.cachedRead || 0;
    usage.cacheWrite += r.usage.cacheWrite || 0;
    if (r.done) return { text: r.text, usage, toolCalls };
    toolCalls.push(...r.calls);
  }
  throw new Error('Tool loop did not finish');
}
