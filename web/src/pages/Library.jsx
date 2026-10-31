import { useState } from 'react';
import { api, form } from '../lib/api.js';
import { useLoad, KINDS, SPLITS, DIALECTS } from '../lib/hooks.js';
import { Field, Select, Modal, useToast, useAsync } from '../components/ui.jsx';

const SCOPES = [['shared', 'Shared with both agents'], ['dialect', 'Dialect module'], ['evaluation', 'Evaluation only (never shown to agents)']];
const STARTER = [
  ['LSJ', 'Liddell–Scott–Jones, Greek-English Lexicon', 'lexicon', 'LSJ (Perseus XML) or JSONL'],
  ['CGL', 'Cambridge Greek Lexicon', 'lexicon', 'by headword'],
  ['Montanari', 'Brill Dictionary of Ancient Greek', 'lexicon', 'by headword'],
  ['Lampe', 'A Patristic Greek Lexicon', 'lexicon', 'by headword'],
  ['Peters', 'Greek Philosophical Terms', 'philosophical', 'by headword'],
  ['Beekes', 'Etymological Dictionary of Greek', 'lexicon', 'by headword'],
  ['Smyth', 'Greek Grammar', 'grammar', 'by numbered section'],
  ['CGCG', 'Cambridge Grammar of Classical Greek', 'grammar', 'by numbered section'],
  ['Goodwin', 'Syntax of the Moods and Tenses', 'grammar', 'by numbered section'],
  ['KG', 'Kühner–Gerth, Ausführliche Grammatik', 'grammar', 'by numbered section'],
  ['Denniston', 'The Greek Particles', 'particles', 'by particle'],
  ['Buck', 'The Greek Dialects', 'dialect', 'by numbered section'],
  ['Thesleff', 'Pythagorean Texts of the Hellenistic Period', 'edition', 'by heading'],
  ['Deubner', 'Teubner De vita Pythagorica, apparatus', 'edition', 'by heading'],
  ['Dillon–Hershbell', 'On the Pythagorean Way of Life', 'translation', 'evaluation only'],
];

export default function LibraryPage() {
  const toast = useToast();
  const lib = useLoad('/library');
  const agents = useLoad('/agents');
  const [browse, setBrowse] = useState(null);
  const [check, setCheck] = useState(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [busy, run] = useAsync(toast);
  const search = async (e) => { e.preventDefault(); setHits(await api.post('/library/search', { query: q })); };
  const works = lib.data || [];
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Library</h1>
          <p className="sub">Each work is split along its own structure, so an agent receives one lexicon entry or one numbered section, never a whole volume.</p>
        </div>
      </div>

      <form className="btn-row" onSubmit={search} style={{ maxWidth: 680, marginBottom: 18 }}>
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search as the agents do: genitive absolute, μὲν οὖν, Doric ā" aria-label="Search the library" style={{ flex: 1 }} />
        <button className="btn" disabled={!q.trim()}>Search</button>
      </form>
      {hits && (
        <div className="stack" style={{ marginBottom: 24 }}>
          {!hits.length && <p className="muted">Nothing found.</p>}
          {hits.map((h) => <div key={h.id} className="sheet"><strong className="sans small">{h.citation}</strong><p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{h.text}</p></div>)}
        </div>
      )}

      <div className="table-wrap">
        <table className="list">
          <thead><tr><th>Work</th><th>Kind</th><th>Visible to</th><th>Pieces</th><th>Spot-checked</th><th /></tr></thead>
          <tbody>
            {works.map((w) => (
              <tr key={w.id}>
                <td><strong>{w.short}</strong> <span className="muted">{w.title}</span></td>
                <td>{KINDS.find(([k]) => k === w.kind)?.[1] || w.kind}</td>
                <td>{w.scope === 'agent' ? `Only ${agents.data?.find((a) => a.id === w.agent_id)?.name || 'one agent'}` : w.scope === 'dialect' ? `Dialect: ${w.dialect || 'any'}` : w.scope === 'evaluation' ? 'Leaderboard only' : 'Both agents'}</td>
                <td>{w.chunks.toLocaleString()}{w.embedded ? <span className="faint small"> ({w.embedded} embedded)</span> : null}</td>
                <td>{w.verified} of {w.chunks}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <label className="btn quiet" title="Add another file to this work, such as the next letter of a lexicon">Add a file
                    <input type="file" multiple className="sr" accept=".txt,.jsonl,.xml,text/plain" onChange={(e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) run(async () => { for (const file of files) { toast(`Adding ${file.name} to ${w.short}…`); await api.post(`/library/${w.id}/append`, form({ file })); } lib.reload(); }, `Added ${files.length} file${files.length > 1 ? 's' : ''} to ${w.short}`); }} />
                  </label>
                  <button className="btn quiet" onClick={() => setBrowse(w)}>Browse</button>
                  <button className="btn quiet" onClick={() => setCheck(w)}>Spot-check</button>
                  <button className="btn quiet danger" disabled={busy} onClick={() => window.confirm(`Remove ${w.title} from the library?`) && run(async () => { await api.del(`/library/${w.id}`); lib.reload(); }, 'Removed')}>Remove</button>
                </td>
              </tr>
            ))}
            {!works.length && <tr><td colSpan={6} className="muted">The library is empty. Start with a lexicon and a grammar.</td></tr>}
          </tbody>
        </table>
      </div>

      <AddWork onAdded={lib.reload} agents={agents.data || []} />

      <section className="section">
        <h2>A starting library</h2>
        <p className="lede">Together these settle every class of decision: form, syntax, particles, word sense, philosophical sense, dialect and text. Comparison translations stay evaluation only, so the agents cannot echo them.</p>
        <div className="table-wrap">
          <table className="list">
            <thead><tr><th>Short name</th><th>Work</th><th>Kind</th><th>Split by</th><th>In your library</th></tr></thead>
            <tbody>
              {STARTER.map(([s, t, k, split]) => (
                <tr key={s}><td>{s}</td><td>{t}</td><td>{KINDS.find(([x]) => x === k)?.[1]}</td><td className="muted">{split}</td><td>{works.some((w) => w.short.trim().toLowerCase() === s.toLowerCase() || w.title.toLowerCase().includes(t.toLowerCase().split(',')[0])) ? <span className="tag ok">present</span> : <span className="faint">—</span>}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {browse && <Browse work={browse} onClose={() => setBrowse(null)} />}
      {check && <SpotCheck work={check} onClose={() => { setCheck(null); lib.reload(); }} />}
    </div>
  );
}

function AddWork({ onAdded, agents }) {
  const toast = useToast();
  const [f, setF] = useState({ title: '', short: '', kind: 'lexicon', scope: 'shared', split_mode: 'headword', dialect: '', agent_id: '', file: null, raw: '' });
  const [result, setResult] = useState(null);
  const [busy, run] = useAsync(toast);
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api.post('/library', form({ ...f, raw: f.file ? undefined : f.raw, scope: f.agent_id ? 'agent' : f.scope }));
      setResult(r); onAdded(); e.target.reset(); setF({ ...f, title: '', short: '', file: null, raw: '' });
    });
  };
  const kindDefault = (k) => ({ lexicon: 'headword', philosophical: 'headword', grammar: 'section', particles: 'particle', dialect: 'section', edition: 'heading', translation: 'paragraph', other: 'paragraph' }[k]);
  return (
    <section className="section">
      <h2>Add a work</h2>
      <p className="lede">Bring the text in as UTF-8 plain text, after OCR if needed. For LSJ, the Perseus or Logeion XML can be loaded directly. Spot-check a sample afterwards: a misread accent in a lexicon becomes a wrong argument in a debate.</p>
      <form className="sheet stack" onSubmit={submit}>
        <div className="grid-2">
          <Field label="Title"><input type="text" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="The Greek Particles" /></Field>
          <Field label="Short name for citations" hint="Agents cite by it, as in Denniston γάρ or Smyth §2070."><input type="text" required value={f.short} onChange={(e) => setF({ ...f, short: e.target.value })} placeholder="Denniston" /></Field>
          <Field label="Kind"><Select value={f.kind} onChange={(v) => setF({ ...f, kind: v, split_mode: kindDefault(v) })} options={KINDS} /></Field>
          <Field label="Split by"><Select value={f.split_mode} onChange={(v) => setF({ ...f, split_mode: v })} options={SPLITS} /></Field>
          <Field label="Visible to"><Select value={f.scope} onChange={(v) => setF({ ...f, scope: v })} options={SCOPES} /></Field>
          {f.scope === 'dialect' && <Field label="Dialect"><Select value={f.dialect} onChange={(v) => setF({ ...f, dialect: v })} options={[['', 'Any'], ...DIALECTS]} /></Field>}
          {f.scope === 'shared' && <Field label="Or private to one agent"><Select value={f.agent_id} onChange={(v) => setF({ ...f, agent_id: v })} options={[['', 'No, shared'], ...agents.map((a) => [String(a.id), a.name])]} /></Field>}
        </div>
        <Field label="File"><input type="file" accept=".txt,.jsonl,.xml,text/plain" onChange={(e) => setF({ ...f, file: e.target.files[0] || null })} /></Field>
        {!f.file && <Field label="Or paste the text"><textarea rows={6} value={f.raw} onChange={(e) => setF({ ...f, raw: e.target.value })} /></Field>}
        <div className="btn-row"><button className="btn primary" disabled={busy || (!f.file && !f.raw.trim())}>Add to the library</button></div>
        {result && (
          <div className="notice calm">
            Split into {result.chunks.toLocaleString()} pieces. The first ones:
            {result.sample.map((s) => <div key={s.ref} className="small" style={{ marginTop: 6 }}><strong>{s.ref}</strong> {s.text}</div>)}
            <div className="small" style={{ marginTop: 6 }}>If these do not start where entries or sections start, remove the work and try another split.</div>
          </div>
        )}
      </form>
    </section>
  );
}

function Browse({ work, onClose }) {
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const { data } = useLoad(`/library/${work.id}/chunks?offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`, [work.id, offset, q]);
  return (
    <Modal title={work.title} onClose={onClose} wide>
      <input type="text" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="Filter" aria-label="Filter pieces" />
      <div className="stack" style={{ marginTop: 12 }}>
        {(data || []).map((c) => <div key={c.id}><strong className="sans small">{work.short} {c.ref}</strong> {c.verified && <span className="tag ok">checked</span>}<p className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.text}</p></div>)}
      </div>
      {!q && <div className="btn-row"><button className="btn" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button className="btn" disabled={(data || []).length < 50} onClick={() => setOffset(offset + 50)}>Next</button></div>}
    </Modal>
  );
}

function SpotCheck({ work, onClose }) {
  const toast = useToast();
  const { data, reload } = useLoad(`/library/${work.id}/spotcheck`, [work.id]);
  const [edits, setEdits] = useState({});
  const mark = async (c) => { await api.patch(`/chunks/${c.id}`, { verified: true, text: edits[c.id] ?? c.text }); toast(edits[c.id] ? 'Corrected and marked checked' : 'Marked checked'); reload(); };
  return (
    <Modal title={`Spot-check ${work.short}`} onClose={onClose} wide>
      <p className="small muted">Compare each piece with the page it came from. Correct any OCR error, then mark it checked.</p>
      {data && !data.length && <p>Every piece has been checked.</p>}
      <div className="stack">
        {(data || []).map((c) => (
          <div key={c.id} className="sheet stack">
            <strong className="sans small">{work.short} {c.ref}</strong>
            <textarea className="greek" rows={6} value={edits[c.id] ?? c.text} onChange={(e) => setEdits({ ...edits, [c.id]: e.target.value })} />
            <div className="btn-row"><button className="btn primary" onClick={() => mark(c)}>{edits[c.id] ? 'Save correction' : 'Matches the page'}</button></div>
          </div>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}><button className="btn" onClick={reload}>Another sample</button></div>
    </Modal>
  );
}
