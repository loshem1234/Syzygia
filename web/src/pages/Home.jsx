import { Link } from 'react-router-dom';
import { useLoad } from '../lib/hooks.js';
import { Vesica } from '../components/ui.jsx';

export default function Home({ projects }) {
  const meta = useLoad('/meta');
  const agents = useLoad('/agents');
  const library = useLoad('/library');
  if (!projects) return null;
  const steps = [
    { done: (meta.data?.providers || []).length > 0, text: 'Connect at least two model providers by setting their API keys on the server.', link: '/settings', action: 'See settings' },
    { done: (agents.data || []).length >= 2, text: 'Create two agents: a literal-first translator and a critic, each on its own model.', link: '/agents', action: 'Create agents' },
    { done: (library.data || []).length > 0, text: 'Add reference works to the shared library: a lexicon, a grammar, Denniston, a dialect handbook.', link: '/library', action: 'Open the library' },
    { done: projects.length > 0, text: 'Start a project, import the whole work, then paste or upload each numbered chapter.', link: null, action: 'Use “New” beside Projects' },
  ];
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Two voices, one translation</h1>
          <p className="sub">Each verse is drafted by one agent, examined by the other, and refined until they agree. Where they cannot, the dissent is kept as apparatus.</p>
        </div>
        <Vesica size={56} state="locked" />
      </div>

      <section className="section">
        <h2>Getting ready</h2>
        <table className="list" style={{ maxWidth: 820 }}>
          <tbody>
            {steps.map((s, i) => (
              <tr key={i}>
                <td style={{ width: 30 }}><Vesica size={14} state={s.done ? 'locked' : 'empty'} title={s.done ? 'Done' : 'To do'} /></td>
                <td>{s.text}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{s.link ? <Link to={s.link}>{s.action}</Link> : <span className="faint">{s.action}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {meta.data && !meta.data.parser && <p className="small muted" style={{ marginTop: 12 }}>The Morpheus parser is not connected, so the pre-fetch works from exact word forms only. Set <code>MORPHEUS_URL</code> to enable full lemma and construction detection.</p>}
      </section>

      {projects.length > 0 && (
        <section className="section">
          <h2>Projects</h2>
          <table className="list" style={{ maxWidth: 820 }}>
            <thead><tr><th>Work</th><th>Chapters</th><th>Verses translated</th></tr></thead>
            <tbody>
              {projects.map((p) => {
                const total = p.chapters.reduce((a, c) => a + Number(c.verses), 0);
                const done = p.chapters.reduce((a, c) => a + Number(c.done), 0);
                return (
                  <tr key={p.id}>
                    <td><Link to={`/projects/${p.id}`}>{p.title}</Link>{p.author && <span className="muted"> — {p.author}</span>}</td>
                    <td>{p.chapters.length}</td>
                    <td>{done} of {total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
