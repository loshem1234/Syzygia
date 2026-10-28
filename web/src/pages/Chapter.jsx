import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, subscribe } from '../lib/api.js';
import { useLoad, fmtUsd } from '../lib/hooks.js';
import { useParamId } from '../components/Shell.jsx';
import { Vesica, verseState, Fingerprint, ErrorNote, Modal, useToast, useAsync } from '../components/ui.jsx';
import VerseDrawer from '../components/VerseDrawer.jsx';
import RunSetup from '../components/RunSetup.jsx';
import ExportDialog from '../components/ExportDialog.jsx';

export default function ChapterPage({ reloadProjects }) {
  const id = useParamId();
  const toast = useToast();
  const { data: ch, error, reload } = useLoad(`/chapters/${id}`, [id]);
  const [selected, setSelected] = useState(null);
  const [live, setLive] = useState({});
  const [dialog, setDialog] = useState(null);
  const [alert, setAlert] = useState(null);
  const [busy, run] = useAsync(toast);
  const latest = ch?.runs?.[0];
  const active = latest && ['queued', 'running'].includes(latest.status);

  // live events: refresh the codex as verses lock, mark the verse under debate
  const timer = useRef(null);
  const softReload = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { reload(); reloadProjects(); }, 400);
  }, [reload, reloadProjects]);
  useEffect(() => {
    if (!latest) return undefined;
    return subscribe(latest.id, (e) => {
      if (e.type === 'verse') { setLive((l) => ({ ...l, [e.verseId]: e.status })); if (e.status !== 'debating') softReload(); }
      if (e.type === 'turn') setLive((l) => ({ ...l, [e.verseId]: 'debating', [`turn:${e.verseId}`]: (l[`turn:${e.verseId}`] || 0) + 1 }));
      if (e.type === 'run') softReload();
      if (e.type === 'alert') setAlert(e.message);
    });
  }, [latest?.id, softReload]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(reload, 20000);
    return () => clearInterval(t);
  }, [active, reload]);

  if (error) return <ErrorNote error={error} />;
  if (!ch) return null;
  const done = ch.verses.filter((v) => v.final_rendering).length;
  const runTarget = latest?.verse_filter?.length || ch.verses.filter((v) => !v.locked_by_user).length || 1;
  const control = (action) => run(async () => { await api.post(`/runs/${latest.id}/${action}`); reload(); reloadProjects(); }, { pause: 'Run paused', resume: 'Run resumed', cancel: 'Run cancelled' }[action]);

  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <p className="small muted" style={{ marginBottom: 4 }}><Link to={`/projects/${ch.project_id}`}>Back to the project</Link></p>
          <h1>{ch.ord}. {ch.title}</h1>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <Fingerprint hash={ch.source_hash} verified={ch.verified} />
            <span className="small muted">{done} of {ch.verses.length} verses translated</span>
            {done > 0 && <span className="small muted">Synthesis rate {(ch.synthesisRate * 100).toFixed(0)}%</span>}
          </div>
        </div>
        <div className="btn-row">
          <button className="btn primary" disabled={active} onClick={() => setDialog('run')}>{done ? 'Run again' : 'Start the debate'}</button>
          <button className="btn" disabled={!done} onClick={() => setDialog('export')}>Export</button>
          <button className="btn quiet" disabled={!done} onClick={() => setDialog('versions')}>Compare versions</button>
        </div>
      </div>

      {ch.warnings?.length > 0 && <div className="notice" style={{ marginBottom: 16 }}>{ch.warnings.map((w) => <div key={w}>{w}</div>)}</div>}
      {alert && <div className="notice" role="status" style={{ marginBottom: 16 }}>{alert}</div>}

      {latest && (
        <div className="sheet" style={{ marginBottom: 22, padding: '14px 18px' }}>
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <div className="sans small">
              <strong>Run {latest.id}</strong>{' '}
              <span className={`tag ${latest.status === 'done' ? 'ok' : latest.status === 'failed' ? 'b' : 'gold'}`}>{latest.status}</span>{' '}
              <span className="tag a">{latest.a_name}, {latest.a_model}</span>{' '}
              <span className="tag b">{latest.b_name}, {latest.b_model}</span>{' '}
              <span className="muted">{latest.verses_done} of {runTarget} verses locked. Escalation {latest.escalate_mode}. Cost so far {fmtUsd(latest.cost_usd)}{latest.budget_usd ? ` of ${fmtUsd(latest.budget_usd)}` : ''}.</span>
              {latest.benchmark && <span className="tag">benchmark</span>}
              {!latest.learned_rules && <span className="tag">learned rules off</span>}
            </div>
            <div className="btn-row">
              {active && <button className="btn" disabled={busy} onClick={() => control('pause')}>Pause</button>}
              {['paused', 'failed'].includes(latest.status) && <button className="btn primary" disabled={busy} onClick={() => control('resume')}>Resume</button>}
              {!['done', 'cancelled'].includes(latest.status) && <button className="btn quiet danger" disabled={busy} onClick={() => control('cancel')}>Cancel</button>}
            </div>
          </div>
          {active && <div className="meter" style={{ marginTop: 10 }} aria-label="Progress"><span style={{ width: `${(latest.verses_done / runTarget) * 100}%`, background: 'var(--gold)' }} /></div>}
          {latest.pause_reason && <p className="small" style={{ marginTop: 8 }}>{latest.pause_reason}</p>}
          {latest.status === 'failed' && <p className="small" style={{ marginTop: 8, color: 'var(--rubric)' }}>{(latest.error || '').split('\n')[0]}</p>}
        </div>
      )}

      <div className="codex" role="list">
        {ch.verses.map((v) => (
          <div key={v.id} role="listitem" className={`verse-row${selected === v.id ? ' selected' : ''}`} tabIndex={0}
            onClick={() => setSelected(v.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSelected(v.id))}>
            <span className="verse-num">{v.num}</span>
            <span className="greek">{v.source}</span>
            <span className={`verse-en${v.final_rendering ? '' : ' pending'}`}>
              {v.final_rendering || (live[v.id] === 'debating' ? 'Under debate…' : 'Not yet translated')}
              {v.needs_review && <span className="verse-flag">{v.review_reason || 'Needs review'}</span>}
              {v.locked_by_user && <span className="verse-flag" style={{ color: 'var(--gold)' }}>Locked by you</span>}
            </span>
            <Vesica size={20} state={verseState(v, live[v.id])} />
          </div>
        ))}
      </div>

      {selected && (
        <VerseDrawer verseId={selected} runId={latest?.id} chapter={ch} liveTick={live[`turn:${selected}`] || 0}
          onClose={() => setSelected(null)} onChanged={() => { reload(); reloadProjects(); }} />
      )}
      {dialog === 'run' && <RunSetup chapter={ch} onClose={() => setDialog(null)} onStarted={() => { setDialog(null); setLive({}); reload(); reloadProjects(); }} />}
      {dialog === 'export' && <ExportDialog chapter={ch} onClose={() => setDialog(null)} />}
      {dialog === 'versions' && <Versions chapterId={ch.id} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Versions({ chapterId, onClose }) {
  const { data } = useLoad(`/chapters/${chapterId}/versions`, [chapterId]);
  const max = useMemo(() => Math.max(0, ...(data || []).map((v) => v.versions.length)), [data]);
  return (
    <Modal title="Versions of each verse" onClose={onClose} wide>
      <p className="small muted">Every run, re-run and correction is kept. The current version is marked in gold.</p>
      <div className="table-wrap">
        <table className="list">
          <thead><tr><th>Verse</th>{Array.from({ length: max }, (_, i) => <th key={i}>Version {i + 1}</th>)}</tr></thead>
          <tbody>
            {(data || []).map((v) => (
              <tr key={v.verse_id}>
                <td>{v.num}</td>
                {v.versions.map((x) => (
                  <td key={x.id} style={x.current ? { boxShadow: 'inset 0 -2px 0 var(--gold)' } : undefined}>
                    <div className="small faint">{x.origin === 'manual' ? 'Your edit' : `Run ${x.run_id}, ${x.status}`}</div>
                    {x.rendering}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
