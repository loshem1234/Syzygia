import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad, fmtUsd } from '../lib/hooks.js';
import { Modal, Field, Select, ErrorNote, useToast } from './ui.jsx';

const ESCALATION = [
  ['auto', 'Automatic: premium models only for synthesis on disputed verses'],
  ['off', 'Off: primary models throughout'],
  ['premium', 'Premium: escalation models for every turn (hard texts)'],
];

export default function RunSetup({ chapter, onClose, onStarted }) {
  const toast = useToast();
  const agents = useLoad('/agents');
  const [f, setF] = useState({ agentA: '', agentB: '', escalateMode: 'auto', budgetUsd: '', utilityProvider: '', utilityModel: '', benchmark: false, learnedRules: true });
  const [est, setEst] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    const list = agents.data || [];
    if (list.length >= 2 && !f.agentA) {
      const last = chapter.runs?.[0];
      setF((x) => ({ ...x, agentA: String(last?.a_agent_id || list[0].id), agentB: String(last?.b_agent_id || list[1].id) }));
    }
  }, [agents.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!f.agentA || !f.agentB) return;
    api.post('/runs/estimate', { chapterId: chapter.id, agentA: f.agentA, agentB: f.agentB }).then(setEst).catch(() => setEst(null));
  }, [f.agentA, f.agentB, chapter.id]);
  const opts = (agents.data || []).map((a) => [String(a.id), `${a.name}, ${a.current?.model}${a.current?.escalation_model ? ` (escalates to ${a.current.escalation_model})` : ''}`]);
  const start = async (e) => {
    e.preventDefault();
    if (f.agentA === f.agentB) { setErr(new Error('Choose two different agents.')); return; }
    try { await api.post('/runs', { ...f, chapterId: chapter.id }); toast('The debate has begun. It runs in the background; you can close this page.'); onStarted(); }
    catch (x) { setErr(x); }
  };
  if (agents.data && agents.data.length < 2) {
    return <Modal title="Start the debate" onClose={onClose}><p>Create two agents first: a literal-first translator and a critic.</p><a className="btn primary" href="/agents">Create agents</a></Modal>;
  }
  return (
    <Modal title={`Debate chapter ${chapter.ord}`} onClose={onClose}>
      <form className="stack" onSubmit={start}>
        <div className="grid-2">
          <Field label="Agent A, the translator"><Select value={f.agentA} onChange={(v) => setF({ ...f, agentA: v })} options={opts} /></Field>
          <Field label="Agent B, the critic"><Select value={f.agentB} onChange={(v) => setF({ ...f, agentB: v })} options={opts} /></Field>
        </div>
        <Field label="Escalation"><Select value={f.escalateMode} onChange={(v) => setF({ ...f, escalateMode: v })} options={ESCALATION} /></Field>
        <div className="grid-2">
          <Field label="Spending cap in dollars" hint="The run pauses when it reaches the cap."><input type="number" min="0" step="0.5" value={f.budgetUsd} onChange={(e) => setF({ ...f, budgetUsd: e.target.value })} /></Field>
          <Field label="Model for chapter digests" hint="Optional; a small model is enough. Defaults to Agent A's.">
            <div className="btn-row" style={{ flexWrap: 'nowrap' }}>
              <Select value={f.utilityProvider} onChange={(v) => setF({ ...f, utilityProvider: v })} options={[['', 'Agent A'], ['anthropic', 'Anthropic'], ['google', 'Google'], ['openai', 'OpenAI']]} style={{ width: 130, flex: 'none' }} />
              <input type="text" style={{ flex: 1, minWidth: 0 }} value={f.utilityModel} onChange={(e) => setF({ ...f, utilityModel: e.target.value })} placeholder="claude-haiku-5-5" disabled={!f.utilityProvider} />
            </div>
          </Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.benchmark} onChange={(e) => setF({ ...f, benchmark: e.target.checked })} /> Benchmark run: keep its versions for comparison without changing the current translation</label>
        <label className="check"><input type="checkbox" checked={!f.learnedRules} onChange={(e) => setF({ ...f, learnedRules: !e.target.checked })} /> Switch learned pre-fetch rules off (measures whether learning helps)</label>
        {est && (
          <div className="notice calm">
            {est.verses} verses. Each call carries about {est.contextTokens.toLocaleString()} tokens of context ({est.measured ? 'measured' : 'estimated'}), mostly cached.
            {' '}{est.priced ? <>Estimated cost {fmtUsd(est.usd)}.</> : <>Enter model prices on the Agents page to see a cost estimate.</>}
          </div>
        )}
        <ErrorNote error={err} />
        <div className="btn-row"><button className="btn primary" type="submit">Begin the debate</button><button type="button" className="btn quiet" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}
