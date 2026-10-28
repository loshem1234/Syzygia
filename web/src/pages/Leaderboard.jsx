import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/hooks.js';
import { Field, Select, useToast, useAsync } from '../components/ui.jsx';

export default function LeaderboardPage({ projects }) {
  const toast = useToast();
  const board = useLoad('/leaderboard');
  const [projectId, setProjectId] = useState('');
  const [pair, setPair] = useState(undefined);
  const [busy, run] = useAsync(toast);
  useEffect(() => { if (!projectId && projects?.length) setProjectId(String(projects[0].id)); }, [projects, projectId]);
  const nextPair = async () => setPair(await api.get(`/projects/${projectId}/compare/next`));
  const choose = (winner) => run(async () => { await api.post(`/comparisons/${pair.comparisonId}`, { winner }); board.reload(); await nextPair(); });
  const project = projects?.find((p) => String(p.id) === projectId);

  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Leaderboard</h1>
          <p className="sub">Which pairings of agents translate best, measured by your blind judgments and your corrections. Benchmark chapters you have translated yourself give the clearest signal.</p>
        </div>
      </div>

      <div className="table-wrap">
        <table className="list" style={{ maxWidth: 820 }}>
          <thead><tr><th>Pairing</th><th>Rating</th><th>Judgments</th></tr></thead>
          <tbody>
            {(board.data || []).map((r, i) => (
              <tr key={r.id}><td>{i === 0 && <span className="tag solid-gold" style={{ marginRight: 8 }}>leading</span>}{r.label}</td><td>{Math.round(r.rating)}</td><td>{r.games}</td></tr>
            ))}
            {!board.data?.length && <tr><td colSpan={3} className="muted">No judgments yet. Judge a few verses below, or correct a verse on its chapter page.</td></tr>}
          </tbody>
        </table>
      </div>

      <section className="section">
        <h2>Judge blind</h2>
        <p className="lede">Two renderings of the same verse, without names, in random order. One may be your own reference translation.</p>
        <div className="btn-row">
          <Select value={projectId} onChange={(v) => { setProjectId(v); setPair(undefined); }} options={(projects || []).map((p) => [String(p.id), p.title])} aria-label="Project" />
          <button className="btn primary" disabled={!projectId} onClick={nextPair}>{pair ? 'Skip to another verse' : 'Show a verse'}</button>
        </div>
        {pair === null && <p className="muted" style={{ marginTop: 14 }}>Nothing left to judge. Run a benchmark, or add a reference translation below.</p>}
        {pair && (
          <div className="stack" style={{ marginTop: 18 }}>
            <p className="greek" style={{ fontSize: '1.25rem' }}><span className="faint num">{pair.chapter}.{pair.verse} </span>{pair.greek}</p>
            <div className="compare">
              <button className="choice" disabled={busy} onClick={() => choose('left')}>{pair.left}</button>
              <button className="choice" disabled={busy} onClick={() => choose('right')}>{pair.right}</button>
            </div>
            <div className="btn-row"><button className="btn quiet" disabled={busy} onClick={() => choose('tie')}>They are equal</button></div>
          </div>
        )}
      </section>

      {project && <Reference project={project} />}
    </div>
  );
}

function Reference({ project }) {
  const toast = useToast();
  const [chapterId, setChapterId] = useState(String(project.chapters[0]?.id || ''));
  const [text, setText] = useState('');
  const [source, setSource] = useState('Loshem');
  const save = async () => { const r = await api.post(`/chapters/${chapterId}/reference`, { text, source }); setText(''); toast(`${r.imported} verses of reference translation saved`); };
  if (!project.chapters.length) return null;
  return (
    <section className="section">
      <h2>Reference translations</h2>
      <p className="lede">Your own translation of a chapter, used only for judging. It is never shown to the agents, so it cannot be echoed.</p>
      <div className="grid-2" style={{ maxWidth: 720 }}>
        <Field label="Chapter"><Select value={chapterId} onChange={setChapterId} options={project.chapters.map((c) => [String(c.id), `${c.ord}. ${c.title}`])} /></Field>
        <Field label="Translator"><input type="text" value={source} onChange={(e) => setSource(e.target.value)} /></Field>
      </div>
      <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'1 Every sensible person, setting out on any philosophical inquiry…\n2 …'} style={{ marginTop: 12 }} aria-label="Reference translation" />
      <div className="btn-row" style={{ marginTop: 10 }}><button className="btn primary" disabled={!text.trim()} onClick={save}>Save reference</button></div>
    </section>
  );
}
