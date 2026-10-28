import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export function useLoad(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try { const d = await api.get(path); if (n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (n === seq.current) setError(e); }
    finally { if (n === seq.current) setLoading(false); }
  }, [path]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [reload, ...deps]);
  return { data, error, loading, reload, setData };
}

export const DIALECTS = [
  ['attic', 'Attic'], ['ionic', 'Ionic'], ['doric', 'Doric'], ['aeolic', 'Aeolic'], ['epic', 'Epic'], ['koine', 'Koine'], ['late-antique', 'Late Antique philosophical prose'],
];
export const KINDS = [
  ['lexicon', 'Lexicon'], ['grammar', 'Grammar'], ['particles', 'Particles'], ['dialect', 'Dialect handbook'], ['philosophical', 'Philosophical terms'], ['edition', 'Edition or apparatus'], ['translation', 'Translation'], ['other', 'Other'],
];
export const SPLITS = [
  ['jsonl', 'Structured lines (JSONL)'], ['lsj-xml', 'LSJ (Perseus XML)'], ['headword', 'Lexicon: by headword'], ['particle', 'Particles: by particle'], ['section', 'Grammar: by numbered section'], ['heading', 'By heading'], ['paragraph', 'By paragraph'],
];
export const fmtUsd = (n) => (n == null ? '—' : `$${Number(n).toFixed(n < 1 ? 3 : 2)}`);
