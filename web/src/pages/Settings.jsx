import { useState } from 'react';
import { api, form } from '../lib/api.js';
import { useLoad } from '../lib/hooks.js';
import { Select, useToast } from '../components/ui.jsx';

export default function SettingsPage() {
  const toast = useToast();
  const meta = useLoad('/meta');
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('syz-theme') || ''; } catch { return ''; } });
  const changeTheme = (t) => {
    setTheme(t);
    try { if (t) localStorage.setItem('syz-theme', t); else localStorage.removeItem('syz-theme'); } catch { /* ignore */ }
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  };
  const restore = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { await api.post('/backup/restore', form({ file })); toast('Backup restored. Reloading.'); setTimeout(() => window.location.reload(), 1200); }
    catch (x) { toast(x.message); }
  };
  const m = meta.data;
  const status = (on) => <span className={`tag ${on ? 'ok' : ''}`}>{on ? 'connected' : 'not set'}</span>;
  return (
    <div>
      <div className="page-head"><div className="grow"><h1>Settings</h1></div></div>

      <section className="section">
        <h2>Connections</h2>
        <p className="lede">Set these as environment variables on the server (on Railway, under the service's Variables).</p>
        <table className="list" style={{ maxWidth: 760 }}>
          <tbody>
            <tr><td>Anthropic</td><td><code>ANTHROPIC_API_KEY</code></td><td>{status(m?.providers.includes('anthropic'))}</td></tr>
            <tr><td>Google</td><td><code>GEMINI_API_KEY</code></td><td>{status(m?.providers.includes('google'))}</td></tr>
            <tr><td>OpenAI</td><td><code>OPENAI_API_KEY</code></td><td>{status(m?.providers.includes('openai'))}</td></tr>
            <tr><td>Morpheus parser</td><td><code>MORPHEUS_URL</code></td><td>{status(m?.parser)}</td></tr>
            <tr><td>Semantic search</td><td><code>EMBEDDINGS_PROVIDER</code></td><td>{m?.embeddings ? <span className="tag ok">{m.embeddings}</span> : status(false)}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2>Appearance</h2>
        <Select value={theme} onChange={changeTheme} options={[['', 'Follow the system'], ['light', 'Day'], ['dark', 'Night']]} aria-label="Theme" style={{ maxWidth: 240 }} />
      </section>

      <section className="section">
        <h2>Backup</h2>
        <p className="lede">Everything in one file: projects, Greek, translations and every version, the ledger, learned knowledge, agents and the library. Restore only into an empty installation.</p>
        <div className="btn-row">
          <a className="btn primary" href="/api/backup">Download a backup</a>
          <label className="btn">Restore from a backup<input type="file" accept="application/json,.json" onChange={restore} className="sr" /></label>
        </div>
      </section>

      <section className="section">
        <h2>The Charter</h2>
        <p className="lede">Every agent receives it first, above its own instructions.</p>
        <pre className="sheet" style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--serif)', fontSize: 'var(--t-sm)', maxWidth: 820 }}>{m?.charter}</pre>
      </section>

      <section className="section">
        <button className="btn quiet" onClick={async () => { await api.post('/logout'); window.location.reload(); }}>Sign out</button>
      </section>
    </div>
  );
}
