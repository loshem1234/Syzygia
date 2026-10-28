import { useEffect, useMemo, useState } from 'react';
import { api, form } from '../lib/api.js';
import { useLoad, KINDS, SPLITS } from '../lib/hooks.js';
import { Field, Select, ErrorNote, useToast, useAsync } from '../components/ui.jsx';

const PROVIDERS = [['anthropic', 'Anthropic'], ['google', 'Google'], ['openai', 'OpenAI']];
const BLANK = { name: '', provider: 'anthropic', model: '', escalation_provider: '', escalation_model: '', temperament: '', instructions: '', temperature: '' };

export default function AgentsPage() {
  const toast = useToast();
  const agents = useLoad('/agents');
  const meta = useLoad('/meta');
  const [sel, setSel] = useState('new');
  const [f, setF] = useState(BLANK);
  const [err, setErr] = useState(null);
  const [busy, run] = useAsync(toast);
  const [showCharter, setShowCharter] = useState(false);

  useEffect(() => {
    if (sel === 'new') { setF(BLANK); return; }
    const a = agents.data?.find((x) => x.id === sel);
    if (a?.current) setF({ name: a.name, ...a.current, escalation_provider: a.current.escalation_provider || '', escalation_model: a.current.escalation_model || '', temperature: a.current.temperature ?? '' });
  }, [sel, agents.data]);

  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      if (sel === 'new') { const a = await api.post('/agents', f); await agents.reload(); setSel(a.id); toast('Agent created'); }
      else { await api.put(`/agents/${sel}`, f); await agents.reload(); toast('Saved as a new version; earlier runs keep the version they used'); }
    } catch (x) { setErr(x); }
  };
  const remove = () => run(async () => { await api.del(`/agents/${sel}`); setSel('new'); agents.reload(); }, 'Agent removed');
  const current = agents.data?.find((x) => x.id === sel);

  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Agents</h1>
          <p className="sub">Each agent brings its own model, temperament, instructions and private files. Every one of them works under the same Charter, which no instruction can override.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) minmax(0, 1fr)', gap: 28 }} className="agents-layout">
        <nav aria-label="Agents" className="stack" style={{ gap: 2 }}>
          {(agents.data || []).map((a) => (
            <button key={a.id} className={`side-link${sel === a.id ? ' active' : ''}`} style={{ border: 'none', background: sel === a.id ? 'var(--sheet)' : 'transparent', cursor: 'pointer', textAlign: 'left', flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => setSel(a.id)}>
              <span style={{ fontFamily: 'var(--serif)', fontSize: 'var(--t-md)' }}>{a.name}</span>
              <span className="faint small">{a.current?.model}, version {a.versions?.[0]?.version}</span>
            </button>
          ))}
          <button className="btn" style={{ marginTop: 10 }} onClick={() => setSel('new')}>New agent</button>
        </nav>

        <form className="stack" onSubmit={save}>
          <div className="grid-2">
            <Field label="Name"><input type="text" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Philologos" /></Field>
            <Field label="Temperament" hint="A line on how this scholar works."><input type="text" value={f.temperament} onChange={(e) => setF({ ...f, temperament: e.target.value })} placeholder="Literal-first, patient with particles" /></Field>
          </div>
          <div className="grid-2">
            <ModelPicker label="Primary model" provider={f.provider} model={f.model} providers={meta.data?.providers} onChange={(provider, model) => setF({ ...f, provider, model })} required />
            <ModelPicker label="Escalation model" hint="Used for synthesis when a verse is disputed, or for every turn in a premium run." provider={f.escalation_provider || f.provider} model={f.escalation_model} providers={meta.data?.providers} onChange={(provider, model) => setF({ ...f, escalation_provider: provider, escalation_model: model })} />
          </div>
          <Field label="Instructions" hint="Your guidance for this agent: its scholarship, priorities, voice. It sits beneath the Charter.">
            <textarea rows={10} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
          </Field>
          <div className="grid-2">
            <Field label="Temperature" hint="Leave empty for the model's default."><input type="number" step="0.1" min="0" max="2" value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })} /></Field>
          </div>
          <ErrorNote error={err} />
          <div className="btn-row">
            <button className="btn primary" type="submit">{sel === 'new' ? 'Create agent' : 'Save as a new version'}</button>
            <button type="button" className="btn quiet" onClick={() => setShowCharter(!showCharter)}>{showCharter ? 'Hide the Charter' : 'Read the Charter'}</button>
            {sel !== 'new' && <button type="button" className="btn quiet danger" disabled={busy} onClick={remove}>Remove agent</button>}
          </div>
          {showCharter && <pre className="sheet" style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--serif)', fontSize: 'var(--t-sm)' }}>{meta.data?.charter}</pre>}

          {current && (
            <>
              <section className="section">
                <h2>Private files</h2>
                <p className="lede">Reference works only this agent can read. Shared works belong in the library.</p>
                <ul>{(current.files || []).map((w) => <li key={w.id}>{w.title} <span className="faint">({w.short})</span></li>)}</ul>
                {!current.files?.length && <p className="muted small">None yet.</p>}
                <PrivateUpload agentId={current.id} onDone={agents.reload} />
              </section>
              <section className="section">
                <h2>Versions</h2>
                <p className="lede">Every save makes a new version, so each translation records exactly which agent produced it.</p>
                <table className="list"><tbody>{current.versions.map((v) => <tr key={v.id}><td>Version {v.version}</td><td>{v.model}</td><td className="muted">{new Date(v.created_at).toLocaleString()}</td></tr>)}</tbody></table>
              </section>
            </>
          )}
        </form>
      </div>

      <Pricing agents={agents.data || []} />
      <style>{`@media (max-width: 760px) { .agents-layout { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function ModelPicker({ label, hint, provider, model, providers = [], onChange, required }) {
  const [models, setModels] = useState([]);
  const listId = `models-${label.replace(/\W/g, '')}`;
  useEffect(() => {
    if (!provider || !providers.includes(provider)) { setModels([]); return; }
    api.get(`/models/${provider}`).then((r) => setModels(r.models || [])).catch(() => setModels([]));
  }, [provider, providers]);
  return (
    <Field label={label} hint={hint}>
      <div className="btn-row" style={{ flexWrap: 'nowrap' }}>
        <Select value={provider} onChange={(p) => onChange(p, model)} options={PROVIDERS.map(([k, l]) => [k, providers.includes(k) ? l : `${l} (no key)`])} style={{ width: 150, flex: 'none' }} />
        <input type="text" style={{ flex: 1, minWidth: 0 }} list={listId} value={model || ''} required={required} onChange={(e) => onChange(provider, e.target.value)} placeholder={provider === 'anthropic' ? 'claude-sonnet-5-5' : provider === 'google' ? 'gemini-3.1-pro' : 'gpt-6-sol'} />
        <datalist id={listId}>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
      </div>
    </Field>
  );
}

function PrivateUpload({ agentId, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ title: '', short: '', kind: 'other', split_mode: 'paragraph', file: null });
  const [busy, run] = useAsync(toast);
  const submit = (e) => {
    e.preventDefault();
    run(async () => { await api.post('/library', form({ ...f, scope: 'agent', agent_id: agentId })); setF({ title: '', short: '', kind: 'other', split_mode: 'paragraph', file: null }); e.target.reset(); onDone(); }, 'Private file added');
  };
  return (
    <form className="sheet stack" onSubmit={submit} style={{ marginTop: 10 }}>
      <div className="grid-2">
        <Field label="Title"><input type="text" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Short name for citations"><input type="text" required value={f.short} onChange={(e) => setF({ ...f, short: e.target.value })} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={KINDS} /></Field>
        <Field label="Split by"><Select value={f.split_mode} onChange={(v) => setF({ ...f, split_mode: v })} options={SPLITS} /></Field>
      </div>
      <Field label="Text file (UTF-8)"><input type="file" required accept=".txt,.jsonl,.xml,text/plain" onChange={(e) => setF({ ...f, file: e.target.files[0] })} /></Field>
      <div className="btn-row"><button className="btn" disabled={busy}>Add private file</button></div>
    </form>
  );
}

function Pricing({ agents }) {
  const toast = useToast();
  const { data, reload } = useLoad('/pricing');
  const [p, setP] = useState({});
  useEffect(() => { if (data) setP(data); }, [data]);
  const models = useMemo(() => [...new Set(agents.flatMap((a) => [a.current?.model, a.current?.escalation_model]).filter(Boolean).concat(Object.keys(p)))], [agents, p]);
  const set = (m, k, v) => setP({ ...p, [m]: { ...(p[m] || {}), [k]: v === '' ? undefined : Number(v) } });
  const save = async () => { await api.put('/pricing', p); reload(); toast('Prices saved'); };
  return (
    <section className="section">
      <h2>Prices</h2>
      <p className="lede">Dollars per million tokens, from each provider's pricing page. They drive cost estimates, spending caps and the cost shown on every turn. Cached input defaults to a tenth of the input price.</p>
      <div className="table-wrap">
        <table className="list" style={{ maxWidth: 820 }}>
          <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached input</th></tr></thead>
          <tbody>
            {models.map((m) => (
              <tr key={m}>
                <td>{m}</td>
                {['input', 'output', 'cachedInput'].map((k) => <td key={k}><input type="number" step="0.01" min="0" value={p[m]?.[k] ?? ''} onChange={(e) => set(m, k, e.target.value)} aria-label={`${m} ${k}`} style={{ maxWidth: 110 }} /></td>)}
              </tr>
            ))}
            {!models.length && <tr><td colSpan={4} className="muted">Create an agent to price its models.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}><button className="btn primary" onClick={save}>Save prices</button></div>
    </section>
  );
}
