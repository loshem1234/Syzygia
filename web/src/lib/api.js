// Thin client for the Syzygia API.
async function request(method, path, body, { raw = false } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(`/api${path}`, opts);
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
  raw: (p) => request('GET', p, undefined, { raw: true }),
};

export function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') fd.append(k, v);
  return fd;
}

// Live events (turns, verses, runs) over server-sent events.
export function subscribe(runId, onEvent) {
  const es = new EventSource(`/api/events${runId ? `?runId=${runId}` : ''}`);
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
  return () => es.close();
}
