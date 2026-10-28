import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, form } from '../lib/api.js';
import { useLoad, DIALECTS } from '../lib/hooks.js';
import { useParamId } from '../components/Shell.jsx';
import { Field, Select, ErrorNote, Fingerprint, Vesica, useToast, useAsync } from '../components/ui.jsx';

export default function ProjectPage({ reloadProjects }) {
  const id = useParamId();
  const { data: p, error, reload } = useLoad(`/projects/${id}`, [id]);
  const [tab, setTab] = useState('chapters');
  if (error) return <ErrorNote error={error} />;
  if (!p) return null;
  const refresh = async () => { await reload(); await reloadProjects(); };
  return (
    <div>
      <ProjectHead p={p} onSaved={refresh} />
      <div className="tabs" role="tablist">
        {[['chapters', 'Chapters'], ['work', 'The whole work'], ['reading', 'Reading pass'], ['quotations', 'Quotations']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'chapters' && <Chapters p={p} onChange={refresh} />}
      {tab === 'work' && <Work p={p} onChange={refresh} />}
      {tab === 'reading' && <ReadingPass p={p} />}
      {tab === 'quotations' && <Quotations p={p} />}
    </div>
  );
}

function ProjectHead({ p, onSaved }) {
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(p);
  const [profiles, setProfiles] = useState([]);
  const [suggestion, setSuggestion] = useState(null);
  useEffect(() => setF(p), [p]);
  useEffect(() => { api.get('/corpus-profiles').then(setProfiles).catch(() => {}); }, []);
  const save = async () => { await api.patch(`/projects/${p.id}`, f); setEdit(false); toast('Project saved'); onSaved(); };
  const suggest = async () => setSuggestion(await api.post(`/projects/${p.id}/dialect-suggest`));
  const dialectName = DIALECTS.find(([k]) => k === p.dialect)?.[1] || p.dialect;
  const profile = profiles.find((x) => x.id === p.corpus_profile_id);
  if (!edit) {
    return (
      <div className="page-head">
        <div className="grow">
          <h1>{p.title}</h1>
          <p className="sub">{p.author ? `${p.author}. ` : ''}{dialectName}{profile ? `, corpus profile ${profile.name}` : ''}.</p>
        </div>
        <div className="btn-row">
          <Link className="btn" to={`/projects/${p.id}/ledger`}>Ledger and style sheet</Link>
          <button className="btn quiet" onClick={() => setEdit(true)}>Edit details</button>
        </div>
      </div>
    );
  }
  return (
    <div className="sheet stack" style={{ marginBottom: 24 }}>
      <div className="grid-2">
        <Field label="Title"><input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Author"><input type="text" value={f.author || ''} onChange={(e) => setF({ ...f, author: e.target.value })} /></Field>
        <Field label="Dialect" hint="Loads that dialect's handbook sections into the shared medium. Verses can override it.">
          <Select value={f.dialect} onChange={(v) => setF({ ...f, dialect: v })} options={DIALECTS} />
        </Field>
        <Field label="Corpus profile"><Select value={f.corpus_profile_id ?? ''} onChange={(v) => setF({ ...f, corpus_profile_id: v || null })} options={[['', 'None'], ...profiles.map((x) => [x.id, x.name])]} /></Field>
      </div>
      {suggestion && <div className="notice calm">Suggested dialect: <strong>{DIALECTS.find(([k]) => k === suggestion.dialect)?.[1] || suggestion.dialect}</strong> ({suggestion.confidence}). {suggestion.evidence} {suggestion.dialect !== f.dialect && <button className="btn quiet" onClick={() => setF({ ...f, dialect: suggestion.dialect })}>Use it</button>}</div>}
      <div className="btn-row">
        <button className="btn primary" onClick={save}>Save details</button>
        <button className="btn" onClick={suggest}>Suggest dialect from the text</button>
        <button className="btn quiet" onClick={() => setEdit(false)}>Cancel</button>
      </div>
    </div>
  );
}

function Chapters({ p, onChange }) {
  const toast = useToast();
  const [busy, run] = useAsync(toast);
  const [f, setF] = useState({ title: '', raw: '', file: null, dialect: '' });
  const [result, setResult] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post(`/projects/${p.id}/chapters`, form({ title: f.title, raw: f.file ? undefined : f.raw, file: f.file, dialect: f.dialect })));
    if (r) { setResult(r); setF({ title: '', raw: '', file: null, dialect: '' }); e.target.reset(); onChange(); }
  };
  return (
    <div>
      {p.chapters.length > 0 ? (
        <div className="table-wrap">
          <table className="list">
            <thead><tr><th style={{ width: 34 }} /><th>Chapter</th><th>Translated</th><th>Needs attention</th><th>Source</th></tr></thead>
            <tbody>
              {p.chapters.map((c) => (
                <tr key={c.id}>
                  <td><Vesica size={14} state={c.done === 0 ? 'empty' : c.done < c.verses ? 'A' : 'locked'} /></td>
                  <td><Link to={`/chapters/${c.id}`}>{c.ord}. {c.title}</Link></td>
                  <td>{c.done} of {c.verses}</td>
                  <td>{[c.disputed && `${c.disputed} with dissent`, c.review && `${c.review} to review`].filter(Boolean).join(', ') || <span className="faint">None</span>}</td>
                  <td><Fingerprint hash={c.source_hash} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty"><h2>No chapters yet</h2><p className="muted">Paste or upload a chapter with each verse numbered at the start of its line. The text is stored exactly as you give it.</p></div>
      )}

      <section className="section">
        <h2>Import a chapter</h2>
        <p className="lede">Number each verse at the start of its line: 1, 2, 3, or [1], (1), §1. Uploading the .txt file is the safest path, since no clipboard is involved.</p>
        <form className="sheet stack" onSubmit={submit}>
          <div className="grid-2">
            <Field label="Title"><input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={`Chapter ${p.chapters.length + 1}`} /></Field>
            <Field label="Dialect for this chapter" hint="Leave as the project's unless the chapter differs.">
              <Select value={f.dialect} onChange={(v) => setF({ ...f, dialect: v })} options={[['', 'Same as project'], ...DIALECTS]} />
            </Field>
          </div>
          <Field label="Upload a .txt file"><input type="file" accept=".txt,text/plain" onChange={(e) => setF({ ...f, file: e.target.files[0] || null })} /></Field>
          {!f.file && <Field label="Or paste the numbered Greek"><textarea className="greek" rows={10} value={f.raw} onChange={(e) => setF({ ...f, raw: e.target.value })} spellCheck={false} /></Field>}
          <div className="btn-row"><button className="btn primary" disabled={busy || (!f.file && !f.raw.trim())}>Import chapter</button></div>
          {result && (
            <div className="notice calm">
              Imported {result.verses} verses. <Fingerprint hash={result.hash} verified />
              {result.warnings?.map((w) => <div key={w} className="small">{w}</div>)}
            </div>
          )}
        </form>
      </section>
    </div>
  );
}

function Work({ p, onChange }) {
  const toast = useToast();
  const [busy, run] = useAsync(toast);
  const [raw, setRaw] = useState('');
  const [file, setFile] = useState(null);
  const [text, setText] = useState(null);
  const [probe, setProbe] = useState('');
  const [cps, setCps] = useState(null);
  const load = async () => setText((await api.get(`/projects/${p.id}/work`)).raw);
  const submit = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post(`/projects/${p.id}/work`, form({ raw: file ? undefined : raw, file })), 'The whole work is imported and fingerprinted');
    if (r) onChange();
  };
  const inspect = async () => setCps(await api.post('/inspect', { text: probe }));
  return (
    <div>
      {p.work_hash ? (
        <div className="stack">
          <p>The whole Greek work sits in every agent's context for the entire book, so each verse is translated knowing the author's patterns, idioms and terms.</p>
          <div className="btn-row"><Fingerprint hash={p.work_hash} verified={p.work_verified} /></div>
          <p className="small muted">
            {p.work_tokens ? `${p.work_tokens.toLocaleString()} tokens, measured on import.` : `About ${Number(p.work_tokens_estimate || 0).toLocaleString()} tokens (estimate; set ANTHROPIC_API_KEY to measure exactly).`}
            {' '}This layer is cached, so after the first call of a run it is billed at a fraction of the normal input price.
          </p>
          <div className="btn-row"><button className="btn" onClick={load}>Show the text</button></div>
          {text && <pre className="sheet greek" style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' }}>{text}</pre>}
        </div>
      ) : (
        <form className="sheet stack" onSubmit={submit}>
          <p>Import the complete Greek text before any debate. It cannot be changed afterwards, so check it is the edition you want.</p>
          <Field label="Upload a .txt file"><input type="file" accept=".txt,text/plain" onChange={(e) => setFile(e.target.files[0] || null)} /></Field>
          {!file && <Field label="Or paste it"><textarea className="greek" rows={12} value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} /></Field>}
          <div className="btn-row"><button className="btn primary" disabled={busy || (!file && !raw.trim())}>Import the whole work</button></div>
        </form>
      )}

      <section className="section">
        <h2>Character inspector</h2>
        <p className="lede">Paste any word to see exactly which characters it is made of, including whether its accents are oxia or tonos, precomposed or combining.</p>
        <div className="btn-row" style={{ maxWidth: 560 }}>
          <input type="text" className="greek" value={probe} onChange={(e) => setProbe(e.target.value)} style={{ flex: 1 }} aria-label="Word to inspect" />
          <button className="btn" onClick={inspect} disabled={!probe}>Inspect</button>
        </div>
        {cps && (
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="codepoints">
              {cps.codepoints.map((c, i) => (
                <div key={i} className={`cp${c.combining ? ' combining' : ''}`}>
                  <span className="ch">{c.combining ? `◌${c.char}` : c.char}</span>
                  <span className="code">{c.cp}</span>
                  {c.name && <span className="nm">{c.name}</span>}
                </div>
              ))}
            </div>
            {cps.warnings.map((w) => <div key={w} className="notice">{w}</div>)}
          </div>
        )}
      </section>
    </div>
  );
}

function ReadingPass({ p }) {
  const toast = useToast();
  const agents = useLoad('/agents');
  const notes = useLoad(`/projects/${p.id}/study-notes`, [p.id]);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, run] = useAsync(toast);
  useEffect(() => {
    if (agents.data?.length >= 2 && !a) { setA(String(agents.data[0].id)); setB(String(agents.data[1].id)); }
  }, [agents.data, a]);
  useEffect(() => {
    if (!notes.data?.some((n) => n.status === 'pending')) return undefined;
    const t = setInterval(notes.reload, 8000);
    return () => clearInterval(t);
  }, [notes.data, notes.reload]);
  const start = () => run(async () => { await api.post(`/projects/${p.id}/reading-pass`, { agentIds: [a, b].filter(Boolean) }); setTimeout(notes.reload, 1500); }, 'Reading pass started. Notes appear here when the agents finish.');
  const decide = (n, action) => run(async () => { const r = await api.post(`/study-notes/${n.id}/${action}`); notes.reload(); return r; }, action === 'approve' ? 'Approved: terms added to the ledger, conventions to the style sheet' : 'Rejected');
  const opts = (agents.data || []).map((x) => [String(x.id), `${x.name} (${x.current?.model})`]);
  return (
    <div>
      <p>Before chapter 1, each agent reads the whole work once and writes study notes: dialect features, the author's habits, recurring terms, quotations, difficult places. Approving a set of notes seeds the ledger and the style sheet.</p>
      {!p.work_hash && <div className="notice">Import the whole work first; the reading pass reads it.</div>}
      <div className="grid-2" style={{ maxWidth: 720, margin: '16px 0' }}>
        <Field label="Agent A"><Select value={a} onChange={setA} options={[['', 'Choose'], ...opts]} /></Field>
        <Field label="Agent B"><Select value={b} onChange={setB} options={[['', 'Choose'], ...opts]} /></Field>
      </div>
      <button className="btn primary" disabled={busy || !p.work_hash || !a || !b} onClick={start}>Start the reading pass</button>

      <section className="section">
        <h2>Study notes</h2>
        {!notes.data?.length && <p className="muted">No notes yet.</p>}
        {(notes.data || []).map((n) => (
          <div key={n.id} className="sheet" style={{ marginBottom: 14 }}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <h3>{n.agent}</h3>
              <span className={`tag ${n.status === 'approved' ? 'ok' : n.status === 'rejected' ? 'b' : 'gold'}`}>{n.status}</span>
            </div>
            <StudyNotes notes={n.notes} />
            {n.status === 'pending' && (
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button className="btn primary" onClick={() => decide(n, 'approve')}>Approve and seed the ledger</button>
                <button className="btn quiet" onClick={() => decide(n, 'reject')}>Reject</button>
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

function StudyNotes({ notes }) {
  if (notes.raw) return <pre style={{ whiteSpace: 'pre-wrap' }}>{notes.raw}</pre>;
  const list = (title, items, render) => items?.length ? (<div style={{ marginTop: 10 }}><strong className="sans small">{title}</strong><ul>{items.map((x, i) => <li key={i}>{render(x)}</li>)}</ul></div>) : null;
  return (
    <div>
      {notes.dialect && <p><strong className="sans small">Dialect. </strong>{notes.dialect}</p>}
      {list("The author's style", notes.author_style, (x) => x)}
      {list('Idioms', notes.idioms, (x) => x)}
      {list('Terms', notes.terms, (t) => <><span className="greek">{t.lemma}</span>: {t.proposed}{t.note && <span className="muted"> — {t.note}</span>}</>)}
      {list('Quotations', notes.quotations, (q) => <><span className="greek">{q.greek}</span> <span className="muted">({q.source})</span></>)}
      {list('Difficulties', notes.difficulties, (d) => <><strong>{d.where}</strong>: {d.note}</>)}
      {list('Conventions for the style sheet', notes.style_conventions, (x) => x)}
    </div>
  );
}

function Quotations({ p }) {
  const toast = useToast();
  const { data, reload } = useLoad(`/projects/${p.id}/quotations`, [p.id]);
  const [f, setF] = useState({ greek: '', source: '', rendering: '' });
  const [found, setFound] = useState(null);
  const add = async (e) => { e.preventDefault(); await api.post(`/projects/${p.id}/quotations`, f); setF({ greek: '', source: '', rendering: '' }); reload(); toast('Quotation marked'); };
  const detect = async () => setFound(await api.post(`/projects/${p.id}/quotations/detect`, { n: 5 }));
  return (
    <div>
      <p>When a quotation recurs, its earlier rendering is loaded into the debate so it reads the same everywhere. Agents flag quotations they recognize; you can mark them too.</p>
      <div className="table-wrap">
        <table className="list">
          <thead><tr><th>Greek</th><th>Source</th><th>Rendering</th><th>First seen</th><th /></tr></thead>
          <tbody>
            {(data || []).map((q) => (
              <tr key={q.id}>
                <td className="greek">{q.greek_key}</td><td>{q.source_ref}</td><td>{q.rendering || <span className="faint">Pending</span>}</td>
                <td>{q.chapter_ord ? `${q.chapter_ord}.${q.verse_num}` : '—'}</td>
                <td><button className="btn quiet danger" onClick={async () => { await api.del(`/quotations/${q.id}`); reload(); }}>Remove</button></td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={5} className="muted">No quotations marked yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <section className="section">
        <h2>Mark a quotation</h2>
        <form className="sheet stack" onSubmit={add}>
          <Field label="The quoted Greek, as it stands in the text"><input type="text" className="greek" required value={f.greek} onChange={(e) => setF({ ...f, greek: e.target.value })} /></Field>
          <div className="grid-2">
            <Field label="Source"><input type="text" required value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="Plato, Timaeus 29e" /></Field>
            <Field label="Rendering to keep (optional)"><input type="text" value={f.rendering} onChange={(e) => setF({ ...f, rendering: e.target.value })} /></Field>
          </div>
          <div className="btn-row"><button className="btn primary">Mark quotation</button><button type="button" className="btn" onClick={detect}>Find repeated passages</button></div>
        </form>
        {found && (
          <div style={{ marginTop: 14 }}>
            {found.length ? <table className="list"><thead><tr><th>Repeated words</th><th>First</th><th>Again</th></tr></thead><tbody>{found.map((h) => <tr key={h.greek}><td className="greek">{h.greek}</td><td>{h.first}</td><td>{h.again}</td></tr>)}</tbody></table> : <p className="muted">No passage of five or more words repeats.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
