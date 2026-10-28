import { useState } from 'react';
import { Modal, Field, Select } from './ui.jsx';

const FORMATS = [['pdf', 'PDF'], ['docx', 'Word (.docx)'], ['md', 'Markdown'], ['txt', 'Plain text'], ['tei', 'TEI XML']];

export default function ExportDialog({ chapter, onClose }) {
  const [f, setF] = useState({ format: 'pdf', layout: 'facing', dissent: true, preference: false, ledger: true, variant: true, citation: false, glossary: true, provenance: true });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.checked });
  const qs = new URLSearchParams(Object.entries(f).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : v])).toString();
  return (
    <Modal title="Export the chapter" onClose={onClose}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Format"><Select value={f.format} onChange={(v) => setF({ ...f, format: v })} options={FORMATS} /></Field>
          <Field label="Layout"><Select value={f.layout} onChange={(v) => setF({ ...f, layout: v })} options={[['facing', 'Greek and English facing'], ['english', 'English only']]} /></Field>
        </div>
        <fieldset className="stack" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="sans small muted" style={{ marginBottom: 6 }}>Apparatus</legend>
          <label className="check"><input type="checkbox" checked={f.dissent} onChange={set('dissent')} /> Dissent where the agents could not agree</label>
          <label className="check"><input type="checkbox" checked={f.ledger} onChange={set('ledger')} /> Ledger notes</label>
          <label className="check"><input type="checkbox" checked={f.variant} onChange={set('variant')} /> Variant readings</label>
          <label className="check"><input type="checkbox" checked={f.preference} onChange={set('preference')} /> Declined alternative renderings</label>
          <label className="check"><input type="checkbox" checked={f.citation} onChange={set('citation')} /> Withdrawn citations</label>
        </fieldset>
        <label className="check"><input type="checkbox" checked={f.glossary} onChange={set('glossary')} /> Glossary of ledger terms used</label>
        <label className="check"><input type="checkbox" checked={f.provenance} onChange={set('provenance')} /> Provenance: agents, models, dates, source fingerprint</label>
        <p className="small muted">The source fingerprint is checked again before the file is written, and the Greek is copied exactly as stored.</p>
        <div className="btn-row"><a className="btn primary" href={`/api/chapters/${chapter.id}/export?${qs}`} download>Download</a></div>
      </div>
    </Modal>
  );
}
