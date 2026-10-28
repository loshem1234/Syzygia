import { createContext, useCallback, useContext, useEffect, useId, useState } from 'react';

// The emblem and status glyph: two circles, each through the other's centre.
// state: 'empty' | 'A' (drafted) | 'AB' (debated) | 'locked' | 'disputed'
export function Vesica({ size = 22, state = 'locked', title }) {
  const h = size;
  const w = size * 1.6;
  const r = h * 0.4;
  const cy = h / 2;
  const ax = w / 2 - r / 2;
  const bx = w / 2 + r / 2;
  const id = `v${useId().replace(/:/g, '')}`;
  const showA = state !== 'empty';
  const showB = ['AB', 'locked', 'disputed'].includes(state);
  const gold = state === 'locked';
  return (
    <svg className="vesica" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title || statusLabel(state)}>
      <title>{title || statusLabel(state)}</title>
      <defs><clipPath id={id}><circle cx={ax} cy={cy} r={r} /></clipPath></defs>
      <circle className={showA ? 'a' : 'o'} cx={ax} cy={cy} r={r} opacity={showA ? 0.9 : 1} />
      <circle className={showB ? 'b' : 'o'} cx={bx} cy={cy} r={r} opacity={showB ? 0.9 : 1} />
      {gold && <circle className="g" cx={bx} cy={cy} r={r} clipPath={`url(#${id})`} />}
      {state === 'disputed' && <circle className="o" cx={bx} cy={cy} r={r} clipPath={`url(#${id})`} style={{ stroke: 'var(--gold)', strokeDasharray: '2 2' }} />}
    </svg>
  );
}

export function statusLabel(s) {
  return { empty: 'Not yet translated', A: 'Drafted', AB: 'Under debate', locked: 'Locked', disputed: 'Locked with dissent' }[s] || s;
}

export function verseState(v, live) {
  if (live === 'debating') return 'AB';
  if (!v.final_rendering) return 'empty';
  if (v.status === 'disputed') return 'disputed';
  return 'locked';
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: 'min(900px, 96vw)' } : undefined}>
        <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <h2>{title}</h2>
          <button className="btn quiet" onClick={onClose} aria-label="Close">Close</button>
        </div>
        {children}
      </div>
    </>
  );
}

export function Drawer({ onClose, children, label }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label}>{children}</aside>
    </>
  );
}

const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [msg, setMsg] = useState(null);
  const show = useCallback((m) => { setMsg(m); setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 3800); }, []);
  return <ToastCtx.Provider value={show}>{children}{msg && <div className="toast" role="status">{msg}</div>}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

export function Field({ label, hint, children }) {
  return <label className="field">{label}{children}{hint && <span className="hint">{hint}</span>}</label>;
}

export function Select({ value, onChange, options, ...rest }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="notice error" role="alert">{error.message || String(error)}</div>;
}

export function Fingerprint({ hash, verified }) {
  if (!hash) return null;
  return (
    <span className={`fingerprint ${verified === false ? 'bad' : 'ok'}`} title={hash}>
      {verified === false ? 'Fingerprint does not match' : 'Source intact'} <code>{hash.slice(0, 12)}</code>
    </span>
  );
}

export function useAsync(toast) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, done) => {
    setBusy(true);
    try { const r = await fn(); if (done) toast?.(done); return r; }
    catch (e) { toast?.(e.message); return undefined; }
    finally { setBusy(false); }
  }, [toast]);
  return [busy, run];
}
