import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api.js';
import { Shell } from './components/Shell.jsx';
import { ToastProvider } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import ProjectPage from './pages/Project.jsx';
import ChapterPage from './pages/Chapter.jsx';
import AgentsPage from './pages/Agents.jsx';
import LedgerPage from './pages/Ledger.jsx';
import LibraryPage from './pages/Library.jsx';
import KnowledgePage from './pages/Knowledge.jsx';
import LeaderboardPage from './pages/Leaderboard.jsx';
import SettingsPage from './pages/Settings.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [projects, setProjects] = useState(null);
  const reloadProjects = useCallback(async () => {
    try { setProjects(await api.get('/projects')); } catch { /* handled by session */ }
  }, []);
  useEffect(() => { api.get('/session').then(setSession).catch(() => setSession({ authenticated: false, passwordRequired: true })); }, []);
  useEffect(() => { if (session?.authenticated) reloadProjects(); }, [session, reloadProjects]);
  useEffect(() => {
    if (!session?.authenticated) return undefined;
    const t = setInterval(reloadProjects, 15000);
    return () => clearInterval(t);
  }, [session, reloadProjects]);

  if (!session) return null;
  if (!session.authenticated) return <Login onDone={() => setSession({ authenticated: true })} />;
  const ctx = { projects, reloadProjects };
  return (
    <ToastProvider>
      <Shell projects={projects} reloadProjects={reloadProjects}>
        <Routes>
          <Route path="/" element={<Home {...ctx} />} />
          <Route path="/projects/:id" element={<ProjectPage {...ctx} />} />
          <Route path="/projects/:id/ledger" element={<LedgerPage />} />
          <Route path="/chapters/:id" element={<ChapterPage {...ctx} />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/knowledge" element={<KnowledgePage projects={projects} />} />
          <Route path="/leaderboard" element={<LeaderboardPage projects={projects} />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </ToastProvider>
  );
}
