import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad, fmtUsd, DIALECTS } from '../lib/hooks.js';
import { Drawer, Field, Select, Vesica, verseState, useToast, useAsync } from './ui.jsx';

const PHASE_TITLE = { A1: 'Draft', B1: 'Critique and revision', A2: 'Answer and refinement', B2: 'Final version', S1: 'Synthesis', S2: 'Second synthesis' };
const LAYER_COLORS = { 1: 'var(--ink)', 2: 'var(--lapis)', 3: 'var(--ink-faint)', 4: 'var(--gold)', 5: 'var(--ok)', 6: 'var(--rubric)', 7: 'var(--ink-soft)' };
const LAYER_NAMES = { 1: 'Charter', 2: 'The work', 3: 'Notes and style', 4: 'Ledger', 5: 'Translation so far', 6: 'This verse', 7: 'This debate' };

export default function VerseDrawer({ verseId, runId, chapter, liveTick, onClose, onChanged }) {
  const { data: v, reload } = useLoad(`/verses/${verseId}${runId ? `?runId=${runId}` : ''}`, [verseId, runId]);
  const [tab, setTab] = useState('debate');
  useEffect(() => { if (liveTick) reload(); }, [liveTick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <Drawer onClose={onClose} label="Verse" />;
  const refresh = () => { reload(); onChanged(); };
  return (
    <Drawer onClose={onClose} label={`Verse ${v.num}`}>
      <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <div className="btn-row"><Vesica size={22} state={verseState(v)} /><h2>Verse {chapter.ord}.{v.num}</h2></div>
        <button className="btn quiet" onClick={onClose}>Close</button>
      </div>
      <p className="greek" style={{ fontSize: '1.32rem', margin: '10px 0 18px' }}>{v.source}</p>
      <div className="tabs" role="tablist">
        {[['debate', 'Debate'], ['versions', `Versions (${v.versions.length})`], ['refs', 'References'], ['edit', 'Correct or re-run']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'debate' && <Debate v={v} />}
      {tab === 'versions' && <Versions v={v} onChanged={refresh} />}
      {tab === 'refs' && <References v={v} />}
      {tab === 'edit' && <Edit v={v} chapter={chapter} onChanged={refresh} />}
    </Drawer>
  );
}

function Debate({ v }) {
  const [meterFor, setMeterFor] = useState(null);
  if (!v.turns.length) return <p className="muted">No debate has been held on this verse yet.</p>;
  const current = v.versions.find((x) => x.id === v.current_version_id);
  const notes = v.apparatus.filter((a) => a.version_id === v.current_version_id);
  return (
    <div className="debate">
      {v.turns.map((t) => {
        const side = t.phase.startsWith('S') ? 'S' : t.agent;
        const p = t.payload;
        return (
          <article key={t.id} className={`turn ${side}`}>
            <header className="turn-head">
              <span className={`who ${t.agent}`}>Agent {t.agent}</span>
              <span>{PHASE_TITLE[t.phase]}</span>
              <span className="faint">{t.model}</span>
              {t.escalated && <span className="tag gold">escalated</span>}
              {p.signoff && <span className="tag ok">signs off</span>}
              {t.phase === 'S2' && p.accept && <span className="tag ok">accepts the joint rendering</span>}
            </header>
            <div className="rendering">{t.rendering}</div>
            <Marginalia p={p} />
            <div className="turn-meta">
              <span>{(t.tokens_in || 0).toLocaleString()} in, {(t.tokens_cached || 0).toLocaleString()} cached, {(t.tokens_out || 0).toLocaleString()} out</span>
              <span>{fmtUsd(t.cost_usd)}</span>
              {t.tool_calls?.length > 0 && <span>{t.tool_calls.length} {t.tool_calls.length === 1 ? 'search' : 'searches'}</span>}
              <button className="btn quiet small" style={{ padding: '0 4px' }} onClick={() => setMeterFor(meterFor === t.id ? null : t.id)}>Context</button>
            </div>
            {meterFor === t.id && <ContextMeter meter={t.context_meter} tools={t.tool_calls} />}
          </article>
        );
      })}
      {current && (
        <div className="seal">
          <div className="label">{{ agreed: 'Agreed', synthesized: 'Synthesized', disputed: 'Locked with dissent', edited: 'Your correction' }[current.status] || current.status}</div>
          <div className="rendering">{current.rendering}</div>
          {notes.length > 0 && (
            <ul className="marginalia" style={{ textAlign: 'left' }}>
              {notes.map((n) => <li key={n.id}><span className="mark">{n.kind}{n.agent ? `, ${n.agent}` : ''}</span><span>{n.text}</span></li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Evidence({ list }) {
  if (!list?.length) return null;
  return (
    <span className="ev">
      {list.map((e, i) => (
        <span key={i}>{i > 0 && '; '}
          {e.type === 'citation' ? <span className={e.verified === false ? 'bad' : ''} title={e.verified === false ? 'Could not be verified' : 'Verified'}>{e.work} {e.ref}{e.quote ? ` "${e.quote}"` : ''}</span>
            : e.type === 'parse' ? <span>parse: <span className="gk">{e.form}</span> {e.analysis}</span>
              : <span>{e.note}</span>}
        </span>
      ))}
    </span>
  );
}

function Marginalia({ p }) {
  const items = [];
  for (const c of p.critique || []) {
    items.push(
      <li key={c.id}>
        <span className={`mark ${c.kind}`}>{c.id} {c.kind}, {c.severity}{c.unverified ? ', unverified' : ''}</span>
        <span>{c.greek && <span className="gk">{c.greek} </span>}{c.point}{c.suggestion && <> Suggests: <em>{c.suggestion}</em></>}</span>
        <Evidence list={c.evidence} />
      </li>,
    );
  }
  for (const r of p.responses || []) items.push(<li key={`r${r.to}`}><span className="mark">{r.action}s {r.to}</span><span>{r.note}</span><Evidence list={r.evidence} /></li>);
  for (const l of p.ledger_proposals || []) items.push(<li key={l.id}><span className="mark" style={{ color: 'var(--gold)' }}>ledger</span><span><span className="gk">{l.lemma}</span> → {l.rendering}{l.note && ` (${l.note})`}</span><Evidence list={l.evidence} /></li>);
  for (const l of p.ledger_responses || []) items.push(<li key={`lr${l.proposal_id}`}><span className="mark">{l.accept ? 'accepts' : 'declines'} {l.proposal_id}</span><span>{l.note}</span></li>);
  for (const c of p.concessions || []) items.push(<li key={`c${c}`}><span className="mark">concedes</span><span>{c}</span></li>);
  for (const h of p.holds || []) items.push(<li key={`h${h.point}`}><span className="mark error">holds</span><span>{h.point}</span><Evidence list={h.evidence} /></li>);
  for (const n of p.notes || []) items.push(<li key={`n${n}`}><span className="mark">note</span><span>{n}</span></li>);
  for (const q of p.quotations || []) items.push(<li key={`q${q.greek}`}><span className="mark">quotation</span><span><span className="gk">{q.greek}</span> ({q.source})</span></li>);
  if (p.dropped_reopened?.length) items.push(<li key="dropped"><span className="mark">set aside</span><span>Reopened settled points: {p.dropped_reopened.join(', ')}</span></li>);
  return items.length ? <ul className="marginalia">{items}</ul> : null;
}

function ContextMeter({ meter, tools }) {
  const layers = [1, 2, 3, 4, 5, 6, 7].filter((k) => meter?.[k]);
  const total = meter?.total || 1;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="meter">{layers.map((k) => <span key={k} title={`${LAYER_NAMES[k]}: about ${meter[k].toLocaleString()} tokens`} style={{ width: `${(meter[k] / total) * 100}%`, background: LAYER_COLORS[k] }} />)}</div>
      <div className="legend">{layers.map((k) => <span key={k}><i style={{ background: LAYER_COLORS[k] }} />{LAYER_NAMES[k]} {meter[k].toLocaleString()}</span>)}{meter?.collapsedChapters ? <span>{meter.collapsedChapters} chapters collapsed to digests</span> : null}</div>
      {tools?.length > 0 && (
        <ul className="marginalia">{tools.map((t, i) => <li key={i}><span className="mark">{t.name}</span><span>{Object.values(t.args || {}).join(', ')}</span></li>)}</ul>
      )}
    </div>
  );
}

function Versions({ v, onChanged }) {
  const toast = useToast();
  const restore = async (x) => { await api.post(`/verses/${v.id}/version/${x.id}/restore`); toast('Version restored'); onChanged(); };
  return (
    <table className="list">
      <thead><tr><th>Version</th><th>Rendering</th><th /></tr></thead>
      <tbody>
        {v.versions.map((x) => (
          <tr key={x.id}>
            <td style={{ whiteSpace: 'nowrap' }}>{x.origin === 'manual' ? 'Your correction' : `Run ${x.run_id}`}<div className="faint small">{x.status}, {new Date(x.created_at).toLocaleDateString()}</div></td>
            <td className="verse-en">{x.rendering}</td>
            <td>{x.id === v.current_version_id ? <span className="tag solid-gold">current</span> : <button className="btn quiet" onClick={() => restore(x)}>Make current</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function References({ v }) {
  if (!v.retrievals.length) return <p className="muted">No references were loaded for this verse yet.</p>;
  return (
    <div className="table-wrap">
      <table className="list">
        <thead><tr><th>Reference</th><th>How it arrived</th><th>Why</th><th>Cited</th></tr></thead>
        <tbody>
          {v.retrievals.map((r, i) => (
            <tr key={i}>
              <td>{r.short} {/^\d/.test(r.ref) ? '§' : ''}<span className="greek">{r.ref}</span></td>
              <td>{r.source === 'prefetch' ? 'Pre-fetched' : `Searched by Agent ${r.agent} (${r.phase})`}</td>
              <td className="small muted">{r.source === 'tool' ? r.query : (r.triggers || []).slice(0, 3).join(', ')}</td>
              <td>{r.cited ? <span className="tag ok">cited</span> : <span className="faint">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Edit({ v, chapter, onChanged }) {
  const toast = useToast();
  const [busy, run] = useAsync(toast);
  const [text, setText] = useState(v.final_rendering || '');
  const [note, setNote] = useState('');
  const [implied, setImplied] = useState([]);
  const [newRender, setNewRender] = useState({});
  const latest = chapter.runs?.[0];
  const save = () => run(async () => { const r = await api.post(`/verses/${v.id}/edit`, { rendering: text }); setImplied(r.implied); onChanged(); }, 'Your correction is saved as a new version');
  const rerun = () => run(async () => {
    await api.post('/runs', { chapterId: chapter.id, agentA: latest.a_agent_id, agentB: latest.b_agent_id, escalateMode: latest.escalate_mode, verseIds: [v.id], note });
    onChanged();
  }, 'Re-run queued for this verse');
  const updateLedger = (i) => run(async () => { await api.patch(`/ledger/${i.entryId}`, { rendering: newRender[i.entryId] }); setImplied(implied.filter((x) => x !== i)); }, 'Ledger updated');
  const lock = () => run(async () => { await api.patch(`/verses/${v.id}`, { locked_by_user: !v.locked_by_user }); onChanged(); }, v.locked_by_user ? 'Verse unlocked' : 'Verse locked: runs will skip it');
  const dialect = (d) => run(async () => { await api.patch(`/verses/${v.id}`, { dialect_override: d }); onChanged(); }, 'Dialect for this verse saved');
  return (
    <div className="stack">
      <section className="stack">
        <h3>Correct the rendering</h3>
        <p className="small muted">Your correction becomes the current version, counts as a win over the agents' version on the leaderboard, and shows which ledger entries it implies changing.</p>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="Rendering" />
        <div className="btn-row"><button className="btn primary" disabled={busy || !text.trim()} onClick={save}>Save correction</button></div>
        {implied.map((i) => (
          <div key={i.entryId} className="notice">
            {i.message}
            <div className="btn-row" style={{ marginTop: 6 }}>
              <input type="text" placeholder={`New rendering of ${i.lemma}`} value={newRender[i.entryId] || ''} onChange={(e) => setNewRender({ ...newRender, [i.entryId]: e.target.value })} style={{ maxWidth: 280 }} />
              <button className="btn" disabled={!newRender[i.entryId]} onClick={() => updateLedger(i)}>Update ledger</button>
            </div>
          </div>
        ))}
      </section>
      <section className="stack">
        <h3>Re-run this verse</h3>
        <p className="small muted">The agents debate it again with your note in front of them. The current version is kept; the new one is added.</p>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: ἁρμονία here is the musical attunement, not concord." />
        <div className="btn-row"><button className="btn" disabled={busy || !latest} onClick={rerun}>Re-run with this note</button></div>
      </section>
      <section className="stack">
        <h3>This verse</h3>
        <div className="grid-2">
          <Field label="Dialect override"><Select value={v.dialect_override || ''} onChange={dialect} options={[['', 'Same as the chapter'], ...DIALECTS]} /></Field>
        </div>
        <div className="btn-row"><button className="btn" onClick={lock}>{v.locked_by_user ? 'Unlock this verse' : 'Lock this verse against re-runs'}</button></div>
      </section>
    </div>
  );
}
