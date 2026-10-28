import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/hooks.js';
import { useParamId } from '../components/Shell.jsx';
import { Field, useToast, useAsync } from '../components/ui.jsx';

export default function LedgerPage() {
  const id = useParamId();
  const toast = useToast();
  const project = useLoad(`/projects/${id}`, [id]);
  const ledger = useLoad(`/projects/${id}/ledger`, [id]);
  const style = useLoad(`/projects/${id}/style`, [id]);
  const [tab, setTab] = useState('terms');
  const [busy, run] = useAsync(toast);
  const pending = (ledger.data?.changes || []).filter((c) => c.status === 'pending');
  const pendingStyle = (style.data || []).filter((s) => s.status === 'pending');

  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <p className="small muted" style={{ marginBottom: 4 }}><Link to={`/projects/${id}`}>{project.data?.title}</Link></p>
          <h1>Ledger and style sheet</h1>
          <p className="sub">The shared medium both agents stand in. Your entries are locked; agents may refine their own entries with evidence, never reverting and at most twice a chapter.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[['terms', 'Terms'], ['review', `Review${pending.length ? ` (${pending.length})` : ''}`], ['history', 'History'], ['style', `Style sheet${pendingStyle.length ? ` (${pendingStyle.length})` : ''}`]].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'terms' && <Terms projectId={id} ledger={ledger} run={run} busy={busy} />}
      {tab === 'review' && (
        <div>
          {!pending.length && <p className="muted">Nothing waiting for you.</p>}
          {pending.map((c) => (
            <div key={c.id} className="sheet" style={{ marginBottom: 12 }}>
              <p><span className="greek">{c.lemma}</span>: <span className="muted">{c.old_rendering || '(new term)'}</span> → <strong>{c.new_rendering}</strong></p>
              <p className="small muted">Proposed by Agent {c.proposer}{c.chapter_ord ? ` at ${c.chapter_ord}.${c.verse_num}` : ''}. {c.reason}</p>
              {c.evidence?.length > 0 && <ul className="small">{c.evidence.map((e, i) => <li key={i}>{e.type === 'citation' ? `${e.work} ${e.ref}` : e.note || e.analysis}</li>)}</ul>}
              <div className="btn-row">
                <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api.post(`/ledger/changes/${c.id}/accept`); ledger.reload(); }, 'Change applied')}>Apply</button>
                <button className="btn quiet" disabled={busy} onClick={() => run(async () => { await api.post(`/ledger/changes/${c.id}/reject`); ledger.reload(); }, 'Change rejected')}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === 'history' && (
        <div className="table-wrap">
          <table className="list">
            <thead><tr><th>Term</th><th>Change</th><th>By</th><th>Where</th><th>Outcome</th><th /></tr></thead>
            <tbody>
              {(ledger.data?.changes || []).map((c) => (
                <tr key={c.id}>
                  <td className="greek">{c.lemma}</td>
                  <td>{c.old_rendering || '—'} → {c.new_rendering}</td>
                  <td>{c.proposer === 'user' ? 'You' : `Agent ${c.proposer}`}</td>
                  <td>{c.chapter_ord ? `${c.chapter_ord}.${c.verse_num}` : '—'}</td>
                  <td><span className={`tag ${c.status === 'applied' ? 'ok' : c.status === 'refused' ? 'b' : ''}`}>{c.status}</span><div className="small faint">{c.reason}</div></td>
                  <td>{c.status === 'applied' && c.old_rendering && c.proposer !== 'user' && <button className="btn quiet" onClick={() => run(async () => { await api.post(`/ledger/changes/${c.id}/rollback`); ledger.reload(); }, 'Rolled back')}>Roll back</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'style' && <Style projectId={id} style={style} run={run} busy={busy} />}
    </div>
  );
}

function Terms({ projectId, ledger, run, busy }) {
  const [f, setF] = useState({ lemma: '', rendering: '', alternatives: '', note: '' });
  const [bulk, setBulk] = useState('');
  const [editing, setEditing] = useState({});
  const entries = ledger.data?.entries || [];
  const add = (e) => {
    e.preventDefault();
    run(async () => { await api.post(`/projects/${projectId}/ledger`, { ...f, alternatives: f.alternatives.split(';').map((s) => s.trim()).filter(Boolean) }); setF({ lemma: '', rendering: '', alternatives: '', note: '' }); ledger.reload(); }, 'Term added and locked');
  };
  const importBulk = () => run(async () => { const r = await api.post(`/projects/${projectId}/ledger/import`, { text: bulk }); setBulk(''); ledger.reload(); return r; }, 'Terms imported and locked');
  const save = (e) => run(async () => { await api.patch(`/ledger/${e.id}`, { rendering: editing[e.id] }); setEditing({ ...editing, [e.id]: undefined }); ledger.reload(); }, 'Saved');
  return (
    <div>
      <div className="table-wrap">
        <table className="list">
          <thead><tr><th>Term</th><th>Rendering</th><th>In context also</th><th>Source</th><th /></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="greek">{e.lemma}</td>
                <td>
                  {editing[e.id] !== undefined
                    ? <div className="btn-row" style={{ flexWrap: 'nowrap' }}><input type="text" value={editing[e.id]} onChange={(x) => setEditing({ ...editing, [e.id]: x.target.value })} /><button className="btn" onClick={() => save(e)}>Save</button></div>
                    : <button className="btn quiet" style={{ color: 'var(--ink)', padding: 0 }} onClick={() => setEditing({ ...editing, [e.id]: e.rendering })} title="Edit">{e.rendering}</button>}
                  {e.note && <div className="small faint">{e.note}</div>}
                </td>
                <td className="small">{(e.alternatives || []).join(', ')}</td>
                <td>
                  {e.tier !== 'book' && <span className="tag gold">{e.tier}</span>}{' '}
                  {e.status === 'suggestion' ? <span className="tag gold">suggestion</span> : e.locked ? <span className="tag">locked, yours</span> : <span className="tag a">agents' entry</span>}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {e.tier === 'book' && <button className="btn quiet" disabled={busy} onClick={() => run(async () => { await api.patch(`/ledger/${e.id}`, { locked: !e.locked }); ledger.reload(); }, e.locked ? 'Unlocked: agents may refine it' : 'Locked')}>{e.locked ? 'Unlock' : 'Lock'}</button>}
                  {e.status === 'suggestion' && e.tier === 'book' && <button className="btn quiet" onClick={() => run(async () => { await api.patch(`/ledger/${e.id}`, { adopt: true }); ledger.reload(); }, 'Adopted')}>Adopt</button>}
                  {e.tier !== 'book' && <button className="btn quiet" onClick={() => run(async () => { await api.post(`/projects/${projectId}/ledger`, { lemma: e.lemma, rendering: e.rendering, alternatives: e.alternatives, note: e.note }); ledger.reload(); }, 'Adopted for this book and locked')}>Adopt for this book</button>}
                  {e.tier === 'book' && <button className="btn quiet danger" onClick={() => run(async () => { await api.del(`/ledger/${e.id}`); ledger.reload(); }, 'Removed')}>Remove</button>}
                </td>
              </tr>
            ))}
            {!entries.length && <tr><td colSpan={5} className="muted">The ledger is empty. Start it with your own list below.</td></tr>}
          </tbody>
        </table>
      </div>

      <section className="section">
        <h2>Add a term</h2>
        <form className="sheet stack" onSubmit={add}>
          <div className="grid-2">
            <Field label="Greek lemma"><input type="text" className="greek" required value={f.lemma} onChange={(e) => setF({ ...f, lemma: e.target.value })} placeholder="νοῦς" /></Field>
            <Field label="Rendering"><input type="text" required value={f.rendering} onChange={(e) => setF({ ...f, rendering: e.target.value })} placeholder="Intellect" /></Field>
            <Field label="Also allowed in context" hint="Separate with semicolons."><input type="text" value={f.alternatives} onChange={(e) => setF({ ...f, alternatives: e.target.value })} placeholder="mind; intelligence" /></Field>
            <Field label="Note"><input type="text" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Capitalized when it names the hypostasis" /></Field>
          </div>
          <div className="btn-row"><button className="btn primary" disabled={busy}>Add term</button></div>
        </form>
      </section>

      <section className="section">
        <h2>Import your list</h2>
        <p className="lede">One term per line: the lemma, an equals sign, the rendering, any alternatives after semicolons, and an optional note after a bar.</p>
        <textarea className="greek" rows={8} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'νοῦς = Intellect; mind | the hypostasis\nψυχή = soul\nἀρετή = virtue; excellence'} />
        <div className="btn-row" style={{ marginTop: 10 }}><button className="btn primary" disabled={busy || !bulk.trim()} onClick={importBulk}>Import terms</button></div>
      </section>
    </div>
  );
}

function Style({ projectId, style, run, busy }) {
  const [rule, setRule] = useState('');
  const rules = style.data || [];
  const add = (e) => { e.preventDefault(); run(async () => { await api.post(`/projects/${projectId}/style`, { rule }); setRule(''); style.reload(); }, 'Convention added'); };
  const setStatus = (s, status, msg) => run(async () => { await api.patch(`/style/${s.id}`, { status }); style.reload(); }, msg);
  return (
    <div>
      <p>Conventions every agent follows: how particles are handled, spellings of names, capitalization of divine names, tense in narrative. Agents propose additions as they work; you approve them.</p>
      <table className="list">
        <tbody>
          {rules.map((s) => (
            <tr key={s.id}>
              <td>{s.rule}{s.tier !== 'book' && <span className="tag gold" style={{ marginLeft: 8 }}>{s.tier}</span>}</td>
              <td className="small muted">{s.proposer === 'user' ? 'You' : s.proposer === 'A' || s.proposer === 'B' ? `Agent ${s.proposer}` : s.proposer}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {s.status === 'pending' ? (
                  <>
                    <button className="btn quiet" disabled={busy} onClick={() => setStatus(s, 'active', 'Convention approved')}>Approve</button>
                    <button className="btn quiet danger" disabled={busy} onClick={() => setStatus(s, 'rejected', 'Convention rejected')}>Reject</button>
                  </>
                ) : s.status === 'rejected' ? <span className="faint small">rejected</span> : (
                  s.tier === 'book' && <button className="btn quiet danger" onClick={() => run(async () => { await api.del(`/style/${s.id}`); style.reload(); }, 'Removed')}>Remove</button>
                )}
              </td>
            </tr>
          ))}
          {!rules.length && <tr><td className="muted">No conventions yet.</td></tr>}
        </tbody>
      </table>
      <form className="btn-row" onSubmit={add} style={{ marginTop: 14 }}>
        <input type="text" value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Render μὲν … δέ by sentence balance, not by “on the one hand”" style={{ flex: 1, minWidth: 240 }} aria-label="New convention" />
        <button className="btn primary" disabled={!rule.trim()}>Add convention</button>
      </form>
    </div>
  );
}
