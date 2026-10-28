import { useState } from 'react';
import { api } from '../lib/api.js';
import { Vesica } from '../components/ui.jsx';

export default function Login({ onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { await api.post('/login', { password }); onDone(); } catch (x) { setError(x.message); }
  };
  return (
    <div className="emblem-wrap">
      <form className="emblem-card stack" onSubmit={submit}>
        <div><Vesica size={64} state="locked" title="Syzygia" /></div>
        <div>
          <h1>Syzygia</h1>
          <div className="greek">συζυγία</div>
        </div>
        <label className="field" style={{ textAlign: 'left' }}>Password
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="notice error" role="alert">{error}</div>}
        <button className="btn primary" type="submit">Enter</button>
      </form>
    </div>
  );
}
