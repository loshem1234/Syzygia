import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad, KINDS } from '../lib/hooks.js';
import { Field, Select, useToast, useAsync } from '../components/ui.jsx';

const TIERS = [['core', 'Core'], ['global', 'Global'], ['corpus', 'Corpus'], ['book', 'Book']];
const TRIGGERS = [['lemma', 'Lemma'], ['particle', 'Particle'], ['construction', 'Construction'], ['dialect', 'Dialect form'], ['term', 'Ledger term']];

export default function KnowledgePage({ projects }) {
  const toast = useToast();
  const [projectId, setProjectId] = useState('');
  useEffect(() => { if (!projectId && projects?.length) setProjectId(String(projects[0].id)); }, [projects, projectId]);
  const k = useLoad(`/knowledge${projectId ? `?projectId=${projectId}` : ''}`, [projectId]);
  const profiles = useLoad('/corpus-profiles');
  const lib = useLoad('/library');
  const [busy, run] = useAsync(toast);
  const [filter, setFilter] = useState('all');
  const [target, setTarget] = useState({});
  const project = projects?.find((p) => String(p.id) === projectId);

  const rules = (k.data?.rules || []).filter((r) => filter === 'all' || r.tier === filter);
  const promote = (p) => run(async () => {
    const t = target[`${p.kind}${p.id}`] || {};
    await api.post('/knowledge/promote', { kind: p.kind, id: p.id, to: t.to || p.to, corpusProfileId: t.corpus || project?.corpus_profile_id });
    k.reload();
  }, 'Promoted');
  const setStatus = (r, status) => run(async () => { await api.patch(`/rules/${r.id}`, { status }); k.reload(); }, `Rule ${status}`);

  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Knowledge</h1>
          <p className="sub">What Syzygia learns, in three tiers. Global rules about Greek serve every book; corpus profiles carry an author's idioms and terms to related books; book knowledge stays with its project until you promote it.</p>
        </div>
        <Field label="Project"><Select value={projectId} onChange={setProjectId} options={(projects || []).map((p) => [String(p.id), p.title])} /></Field>
      </div>

      <section className="section">
        <h2>Ready to outlive this book</h2>
        <p className="lede">Terms used consistently, conventions that held, and pre-fetch rules that proved their worth. Each needs your approval; promoted terms reach later books as suggestions, not rulings.</p>
        {!k.data?.proposals?.length && <p className="muted">Nothing proposed yet. Proposals appear as chapters are translated.</p>}
        {(k.data?.proposals || []).map((p) => {
          const key = `${p.kind}${p.id}`;
          const t = target[key] || {};
          return (
            <div key={key} className="btn-row sheet" style={{ marginBottom: 8, justifyContent: 'space-between' }}>
              <div><span className="tag">{p.kind}</span> <span className={p.kind === 'ledger' ? 'greek' : ''}>{p.label}</span> <span className="small muted">{p.evidence}</span></div>
              <div className="btn-row">
                <Select value={t.to || p.to} onChange={(v) => setTarget({ ...target, [key]: { ...t, to: v } })} options={[['corpus', 'Corpus'], ['global', 'Global']]} />
                {(t.to || p.to) === 'corpus' && <Select value={t.corpus || project?.corpus_profile_id || ''} onChange={(v) => setTarget({ ...target, [key]: { ...t, corpus: v } })} options={[['', 'Choose a profile'], ...(profiles.data || []).map((x) => [String(x.id), x.name])]} />}
                <button className="btn primary" disabled={busy} onClick={() => promote(p)}>Promote</button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="section">
        <h2>Pre-fetch rules</h2>
        <p className="lede">Rules decide what reaches a verse before the debate. The core is fixed and never shrinks. Learned rules are kept only while they are used and cited; unused ones are demoted, then retired.</p>
        <div className="tabs" role="tablist">
          {[['all', 'All'], ...TIERS].map(([v, l]) => <button key={v} role="tab" aria-selected={filter === v} onClick={() => setFilter(v)}>{l}</button>)}
        </div>
        <div className="table-wrap">
          <table className="list">
            <thead><tr><th>Tier</th><th>When the verse has</th><th>Load</th><th>Used</th><th>Cited</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.tier}{r.corpus_name ? `: ${r.corpus_name}` : ''}{r.project_title && r.tier === 'book' ? <div className="small faint">{r.project_title}</div> : null}</td>
                  <td>{r.trigger_type} <span className="greek">{r.trigger_value === '*' ? '(any)' : r.trigger_value}</span></td>
                  <td>{r.target_kind === 'ref' ? `${r.work_short} ${r.target_ref}` : r.target_kind === 'headword' ? `its entry in every ${r.target_work_kind || 'work'}` : `search ${r.target_work_kind || ''} for “${r.query}”`}<div className="small faint">{r.note}</div></td>
                  <td>{r.uses}</td>
                  <td>{r.cites}</td>
                  <td><span className={`tag ${r.status === 'active' ? 'ok' : r.status === 'candidate' ? 'gold' : ''}`}>{r.status}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.tier !== 'core' && r.status !== 'active' && <button className="btn quiet" onClick={() => setStatus(r, 'active')}>Activate</button>}
                    {r.tier !== 'core' && r.status === 'active' && <button className="btn quiet" onClick={() => setStatus(r, 'demoted')}>Demote</button>}
                    {r.tier !== 'core' && <button className="btn quiet danger" onClick={() => run(async () => { await api.del(`/rules/${r.id}`); k.reload(); }, 'Rule deleted')}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <AddRule works={lib.data || []} projectId={projectId} profiles={profiles.data || []} onAdded={k.reload} />
      </section>

      <section className="section">
        <h2>Corpus and global terms</h2>
        <table className="list">
          <tbody>
            {(k.data?.ledgerTiers || []).map((e) => <tr key={e.id}><td className="greek">{e.lemma}</td><td>{e.rendering}</td><td><span className="tag gold">{e.tier}{e.corpus_name ? `: ${e.corpus_name}` : ''}</span></td></tr>)}
            {(k.data?.styleTiers || []).map((s) => <tr key={`s${s.id}`}><td colSpan={2}>{s.rule}</td><td><span className="tag gold">{s.tier}{s.corpus_name ? `: ${s.corpus_name}` : ''}</span></td></tr>)}
            {!k.data?.ledgerTiers?.length && !k.data?.styleTiers?.length && <tr><td className="muted">Nothing promoted yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <Profiles profiles={profiles} />
    </div>
  );
}

function AddRule({ works, projectId, profiles, onAdded }) {
  const toast = useToast();
  const [f, setF] = useState({ tier: 'book', trigger_type: 'lemma', trigger_value: '', target_kind: 'ref', target_work_id: '', target_ref: '', query: '', target_work_kind: 'grammar', corpusProfileId: '' });
  const submit = async (e) => {
    e.preventDefault();
    await api.post('/rules', { ...f, projectId: f.tier === 'book' ? projectId : null });
    toast('Rule added'); onAdded();
  };
  return (
    <details style={{ marginTop: 16 }}>
      <summary className="sans small" style={{ cursor: 'pointer' }}>Write a rule yourself</summary>
      <form className="sheet stack" onSubmit={submit} style={{ marginTop: 10 }}>
        <div className="grid-2">
          <Field label="Tier"><Select value={f.tier} onChange={(v) => setF({ ...f, tier: v })} options={TIERS.filter(([t]) => t !== 'core')} /></Field>
          {f.tier === 'corpus' && <Field label="Corpus profile"><Select value={f.corpusProfileId} onChange={(v) => setF({ ...f, corpusProfileId: v })} options={[['', 'Choose'], ...profiles.map((p) => [String(p.id), p.name])]} /></Field>}
          <Field label="When the verse has a"><Select value={f.trigger_type} onChange={(v) => setF({ ...f, trigger_type: v })} options={TRIGGERS} /></Field>
          <Field label="Value" hint="Unaccented lowercase for Greek, e.g. μεν ουν; a construction name, e.g. genitive-absolute."><input type="text" className="greek" required value={f.trigger_value} onChange={(e) => setF({ ...f, trigger_value: e.target.value })} /></Field>
          <Field label="Load"><Select value={f.target_kind} onChange={(v) => setF({ ...f, target_kind: v })} options={[['ref', 'A specific section'], ['query', 'The best matches for a search'], ['headword', 'The entry for the word']]} /></Field>
          {f.target_kind === 'ref' ? (
            <>
              <Field label="From"><Select value={f.target_work_id} onChange={(v) => setF({ ...f, target_work_id: v })} options={[['', 'Choose a work'], ...works.filter((w) => w.scope !== 'evaluation').map((w) => [String(w.id), w.short])]} /></Field>
              <Field label="Section or entry"><input type="text" required value={f.target_ref} onChange={(e) => setF({ ...f, target_ref: e.target.value })} placeholder="2070" /></Field>
            </>
          ) : (
            <>
              <Field label="In works of kind"><Select value={f.target_work_kind} onChange={(v) => setF({ ...f, target_work_kind: v })} options={KINDS} /></Field>
              {f.target_kind === 'query' && <Field label="Search for"><input type="text" required value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} /></Field>}
            </>
          )}
        </div>
        <div className="btn-row"><button className="btn primary">Add rule</button></div>
      </form>
    </details>
  );
}

function Profiles({ profiles }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', description: '' });
  const add = async (e) => { e.preventDefault(); await api.post('/corpus-profiles', f); setF({ name: '', description: '' }); profiles.reload(); toast('Profile created'); };
  return (
    <section className="section">
      <h2>Corpus profiles</h2>
      <p className="lede">Group related books, such as everything by Iamblichus, or Neoplatonic prose, so they share learned terms, conventions and rules. Assign a profile on the project page.</p>
      <ul>{(profiles.data || []).map((p) => <li key={p.id}><strong>{p.name}</strong>{p.description && <span className="muted"> — {p.description}</span>}</li>)}</ul>
      <form className="btn-row" onSubmit={add}>
        <input type="text" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Iamblichus" style={{ maxWidth: 220 }} aria-label="Profile name" />
        <input type="text" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Description (optional)" style={{ maxWidth: 360 }} aria-label="Profile description" />
        <button className="btn">Create profile</button>
      </form>
    </section>
  );
}
