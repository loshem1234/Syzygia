import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Vesica, Modal, Field, Select, ErrorNote } from './ui.jsx';
import { DIALECTS } from '../lib/hooks.js';

function chapterState(c) {
  if (c.running) return 'AB';
  if (!c.done) return 'empty';
  if (c.done < c.verses) return 'A';
  return 'locked';
}

export function Shell({ children, projects, reloadProjects }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const currentProject = (loc.pathname.match(/^\/projects\/(\d+)/) || [])[1] || projects?.[0]?.id;

  return (
    <div className="shell">
      <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Projects and settings">
        <Link to="/" className="brand" aria-label="Syzygia home">
          <Vesica size={30} state="locked" title="Syzygia" />
          <span><span className="brand-name">Syzygia</span><span className="brand-greek">συζυγία</span></span>
        </Link>

        <div className="side-section">
          <div className="side-head"><span>Projects</span><button className="btn quiet small" onClick={() => setCreating(true)}>New</button></div>
          {(projects || []).map((p) => (
            <div key={p.id}>
              <NavLink to={`/projects/${p.id}`} end className={({ isActive }) => `side-link side-project${isActive ? ' active' : ''}`}>{p.title}</NavLink>
              {p.chapters.length > 0 && (
                <div className="side-chapters">
                  {p.chapters.map((c) => (
                    <NavLink key={c.id} to={`/chapters/${c.id}`} className={({ isActive }) => `side-link side-chapter${isActive ? ' active' : ''}`}>
                      <Vesica size={13} state={chapterState(c)} />
                      <span>{c.ord}. {c.title}</span>
                      <span className="count">{c.done}/{c.verses}</span>
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          ))}
          {projects && !projects.length && <p className="small muted" style={{ padding: '0 8px' }}>No projects yet.</p>}
        </div>

        <div className="side-foot">
          <NavLink to="/agents" className="side-link">Agents</NavLink>
          {currentProject && <NavLink to={`/projects/${currentProject}/ledger`} className="side-link">Ledger and style sheet</NavLink>}
          <NavLink to="/library" className="side-link">Library</NavLink>
          <NavLink to="/knowledge" className="side-link">Knowledge</NavLink>
          <NavLink to="/leaderboard" className="side-link">Leaderboard</NavLink>
          <NavLink to="/settings" className="side-link">Settings</NavLink>
        </div>
      </nav>
      <main className="main">
        <button className="btn menu-toggle" onClick={() => setOpen(true)} aria-label="Open projects">Projects</button>
        {children}
      </main>
      {creating && <NewProject onClose={() => setCreating(false)} onCreated={reloadProjects} />}
    </div>
  );
}

function NewProject({ onClose, onCreated }) {
  const nav = useNavigate();
  const [f, setF] = useState({ title: '', author: '', dialect: 'attic', corpus_profile_id: '' });
  const [profiles, setProfiles] = useState([]);
  const [err, setErr] = useState(null);
  useEffect(() => { api.get('/corpus-profiles').then(setProfiles).catch(() => {}); }, []);
  const save = async (e) => {
    e.preventDefault();
    try {
      const p = await api.post('/projects', f);
      await onCreated();
      onClose();
      nav(`/projects/${p.id}`);
    } catch (x) { setErr(x); }
  };
  return (
    <Modal title="New project" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Title"><input type="text" required autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="On the Pythagorean Life" /></Field>
        <div className="grid-2">
          <Field label="Author"><input type="text" value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })} placeholder="Iamblichus" /></Field>
          <Field label="Dialect"><Select value={f.dialect} onChange={(v) => setF({ ...f, dialect: v })} options={DIALECTS} /></Field>
        </div>
        <Field label="Corpus profile" hint="Books in the same profile share what Syzygia learns, such as terms and conventions.">
          <Select value={f.corpus_profile_id} onChange={(v) => setF({ ...f, corpus_profile_id: v })} options={[['', 'None'], ...profiles.map((p) => [String(p.id), p.name])]} />
        </Field>
        <ErrorNote error={err} />
        <div className="btn-row"><button className="btn primary" type="submit">Create project</button></div>
      </form>
    </Modal>
  );
}

export function useParamId(name = 'id') { return Number(useParams()[name]); }
