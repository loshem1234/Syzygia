-- Syzygia schema. Source Greek is stored raw and is immutable once written.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS corpus_profiles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT DEFAULT '',
  work TEXT DEFAULT '',
  dialect TEXT NOT NULL DEFAULT 'attic',
  corpus_profile_id INT REFERENCES corpus_profiles(id) ON DELETE SET NULL,
  work_raw TEXT,              -- the full Greek work, byte for byte as imported
  work_hash TEXT,             -- SHA-256 of work_raw (UTF-8)
  work_tokens INT,            -- measured token count of the work, when available
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chapters (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ord INT NOT NULL,
  title TEXT NOT NULL,
  source_raw TEXT NOT NULL,   -- immutable
  source_hash TEXT NOT NULL,  -- immutable
  dialect TEXT,
  imported_via TEXT NOT NULL DEFAULT 'paste',
  warnings JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, ord)
);

-- Guard: the source text can never be altered after import.
CREATE OR REPLACE FUNCTION syzygia_guard_source() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chapters' THEN
    IF NEW.source_raw IS DISTINCT FROM OLD.source_raw OR NEW.source_hash IS DISTINCT FROM OLD.source_hash THEN
      RAISE EXCEPTION 'Source text is immutable once imported';
    END IF;
  ELSIF TG_TABLE_NAME = 'projects' THEN
    IF OLD.work_raw IS NOT NULL AND (NEW.work_raw IS DISTINCT FROM OLD.work_raw OR NEW.work_hash IS DISTINCT FROM OLD.work_hash) THEN
      RAISE EXCEPTION 'The full work is immutable once imported';
    END IF;
  ELSIF TG_TABLE_NAME = 'verses' THEN
    IF NEW.source IS DISTINCT FROM OLD.source THEN
      RAISE EXCEPTION 'Verse source is immutable once imported';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chapters_guard ON chapters;
CREATE TRIGGER chapters_guard BEFORE UPDATE ON chapters FOR EACH ROW EXECUTE FUNCTION syzygia_guard_source();
DROP TRIGGER IF EXISTS projects_guard ON projects;
CREATE TRIGGER projects_guard BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION syzygia_guard_source();

CREATE TABLE IF NOT EXISTS verses (
  id SERIAL PRIMARY KEY,
  chapter_id INT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  num TEXT NOT NULL,
  ord INT NOT NULL,
  seq INT NOT NULL,                        -- position in the whole book, for decay windows
  source TEXT NOT NULL,                    -- exact slice of chapters.source_raw
  src_start INT NOT NULL,
  src_end INT NOT NULL,
  dialect_override TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | agreed | synthesized | disputed
  final_rendering TEXT,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT,
  locked_by_user BOOLEAN NOT NULL DEFAULT false,
  current_version_id INT,
  UNIQUE (chapter_id, ord)
);
DROP TRIGGER IF EXISTS verses_guard ON verses;
CREATE TRIGGER verses_guard BEFORE UPDATE ON verses FOR EACH ROW EXECUTE FUNCTION syzygia_guard_source();

CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  current_version_id INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_versions (
  id SERIAL PRIMARY KEY,
  agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  escalation_provider TEXT,
  escalation_model TEXT,
  instructions TEXT NOT NULL DEFAULT '',
  temperament TEXT NOT NULL DEFAULT '',
  temperature REAL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (agent_id, version)
);

CREATE TABLE IF NOT EXISTS library_works (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  short TEXT NOT NULL,               -- citation siglum, e.g. LSJ, Smyth, Denniston
  kind TEXT NOT NULL,                -- lexicon | grammar | particles | dialect | philosophical | edition | translation | other
  scope TEXT NOT NULL DEFAULT 'shared', -- shared | agent | dialect | evaluation
  agent_id INT REFERENCES agents(id) ON DELETE CASCADE,
  dialect TEXT,
  split_mode TEXT NOT NULL DEFAULT 'heading',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (short)
);

CREATE TABLE IF NOT EXISTS reference_chunks (
  id SERIAL PRIMARY KEY,
  work_id INT NOT NULL REFERENCES library_works(id) ON DELETE CASCADE,
  ord INT NOT NULL,
  ref TEXT NOT NULL,                 -- headword, § number or heading
  ref_key TEXT NOT NULL,             -- normalized ref for exact lookup
  heading TEXT DEFAULT '',
  text TEXT NOT NULL,
  search_key TEXT NOT NULL,          -- accent-insensitive lookup copy
  lemma_keys TEXT[] NOT NULL DEFAULT '{}',
  topics TEXT[] NOT NULL DEFAULT '{}',
  embedding REAL[],
  verified BOOLEAN NOT NULL DEFAULT false   -- OCR spot-checked
);
CREATE INDEX IF NOT EXISTS reference_chunks_ref ON reference_chunks (work_id, ref_key);
CREATE INDEX IF NOT EXISTS reference_chunks_lemmas ON reference_chunks USING GIN (lemma_keys);
CREATE INDEX IF NOT EXISTS reference_chunks_fts ON reference_chunks USING GIN (to_tsvector('simple', search_key));

CREATE TABLE IF NOT EXISTS runs (
  id SERIAL PRIMARY KEY,
  chapter_id INT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  agent_a_version_id INT NOT NULL REFERENCES agent_versions(id),
  agent_b_version_id INT NOT NULL REFERENCES agent_versions(id),
  utility_provider TEXT,
  utility_model TEXT,
  escalate_mode TEXT NOT NULL DEFAULT 'auto',  -- auto | off | premium
  learned_rules BOOLEAN NOT NULL DEFAULT true, -- false = ablation run
  benchmark BOOLEAN NOT NULL DEFAULT false,
  verse_filter INT[],                          -- re-run only these verses
  rerun_note TEXT,
  status TEXT NOT NULL DEFAULT 'queued',       -- queued | running | paused | done | failed | cancelled
  pause_reason TEXT,
  budget_usd REAL,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS turns (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  verse_id INT NOT NULL REFERENCES verses(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,              -- A1 B1 A2 B2 S1 S2
  agent TEXT NOT NULL,              -- A | B
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  escalated BOOLEAN NOT NULL DEFAULT false,
  rendering TEXT,
  payload JSONB NOT NULL,
  tool_calls JSONB NOT NULL DEFAULT '[]',
  context_meter JSONB NOT NULL DEFAULT '{}',
  tokens_in INT DEFAULT 0,
  tokens_out INT DEFAULT 0,
  tokens_cached INT DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (run_id, verse_id, phase)
);

CREATE TABLE IF NOT EXISTS verse_versions (
  id SERIAL PRIMARY KEY,
  verse_id INT NOT NULL REFERENCES verses(id) ON DELETE CASCADE,
  run_id INT REFERENCES runs(id) ON DELETE SET NULL,
  origin TEXT NOT NULL,             -- run | manual
  status TEXT,
  rendering TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS apparatus_notes (
  id SERIAL PRIMARY KEY,
  verse_id INT NOT NULL REFERENCES verses(id) ON DELETE CASCADE,
  run_id INT REFERENCES runs(id) ON DELETE CASCADE,
  version_id INT REFERENCES verse_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- dissent | variant | ledger | preference | citation
  agent TEXT,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id SERIAL PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'book',   -- book | corpus | global
  project_id INT REFERENCES projects(id) ON DELETE CASCADE,
  corpus_profile_id INT REFERENCES corpus_profiles(id) ON DELETE CASCADE,
  lemma TEXT NOT NULL,
  lemma_key TEXT NOT NULL,
  rendering TEXT NOT NULL,
  alternatives TEXT[] NOT NULL DEFAULT '{}',
  note TEXT DEFAULT '',
  locked BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL DEFAULT 'user',  -- user | agent | promotion
  status TEXT NOT NULL DEFAULT 'active',    -- active | frozen | suggestion
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_lemma ON ledger_entries (lemma_key);

CREATE TABLE IF NOT EXISTS ledger_changes (
  id SERIAL PRIMARY KEY,
  entry_id INT REFERENCES ledger_entries(id) ON DELETE CASCADE,
  lemma TEXT,
  old_rendering TEXT,
  new_rendering TEXT NOT NULL,
  proposer TEXT NOT NULL,            -- A | B | user
  evidence JSONB NOT NULL DEFAULT '[]',
  verse_id INT REFERENCES verses(id) ON DELETE SET NULL,
  chapter_id INT REFERENCES chapters(id) ON DELETE SET NULL,
  run_id INT REFERENCES runs(id) ON DELETE SET NULL,
  accepted_by TEXT,
  status TEXT NOT NULL,              -- applied | pending | refused | rolled_back
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS style_sheet_entries (
  id SERIAL PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'book',
  project_id INT REFERENCES projects(id) ON DELETE CASCADE,
  corpus_profile_id INT REFERENCES corpus_profiles(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active | pending | rejected | suggestion
  proposer TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS study_notes (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_version_id INT REFERENCES agent_versions(id) ON DELETE SET NULL,
  agent TEXT,
  notes JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chapter_digests (
  id SERIAL PRIMARY KEY,
  chapter_id INT NOT NULL UNIQUE REFERENCES chapters(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verse_lemmas (
  verse_id INT NOT NULL REFERENCES verses(id) ON DELETE CASCADE,
  lemma_key TEXT NOT NULL,
  lemma TEXT NOT NULL,
  form TEXT NOT NULL,
  PRIMARY KEY (verse_id, lemma_key, form)
);
CREATE INDEX IF NOT EXISTS verse_lemmas_key ON verse_lemmas (lemma_key);

CREATE TABLE IF NOT EXISTS quotations (
  id SERIAL PRIMARY KEY,
  project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,          -- e.g. Plato, Timaeus 29e
  greek_key TEXT NOT NULL,           -- normalized Greek of the quoted words
  first_verse_id INT REFERENCES verses(id) ON DELETE SET NULL,
  rendering TEXT,
  marked_by TEXT NOT NULL DEFAULT 'agent',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prefetch_rules (
  id SERIAL PRIMARY KEY,
  tier TEXT NOT NULL,                -- core | global | corpus | book
  project_id INT REFERENCES projects(id) ON DELETE CASCADE,
  corpus_profile_id INT REFERENCES corpus_profiles(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,        -- lemma | particle | construction | dialect | term | variant
  trigger_value TEXT NOT NULL,       -- '*' matches any value of the type
  target_kind TEXT NOT NULL,         -- headword | query | ref
  target_work_kind TEXT,             -- lexicon | grammar | ... (for generic core rules)
  target_work_id INT REFERENCES library_works(id) ON DELETE CASCADE,
  target_ref TEXT,
  query TEXT,
  max_chunks INT NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'active',  -- active | candidate | demoted | retired
  uses INT NOT NULL DEFAULT 0,
  cites INT NOT NULL DEFAULT 0,
  books TEXT[] NOT NULL DEFAULT '{}',     -- project ids where it proved useful
  last_used_seq INT NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id SERIAL PRIMARY KEY,
  run_id INT REFERENCES runs(id) ON DELETE CASCADE,
  verse_id INT REFERENCES verses(id) ON DELETE CASCADE,
  phase TEXT,
  agent TEXT,
  source TEXT NOT NULL,             -- prefetch | tool
  rule_id INT REFERENCES prefetch_rules(id) ON DELETE SET NULL,
  chunk_id INT REFERENCES reference_chunks(id) ON DELETE CASCADE,
  query TEXT,
  triggers TEXT[] NOT NULL DEFAULT '{}',
  cited BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_translations (
  id SERIAL PRIMARY KEY,
  chapter_id INT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  verse_num TEXT NOT NULL,
  rendering TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'Loshem',
  UNIQUE (chapter_id, verse_num, source)
);

CREATE TABLE IF NOT EXISTS comparisons (
  id SERIAL PRIMARY KEY,
  verse_id INT NOT NULL REFERENCES verses(id) ON DELETE CASCADE,
  left_kind TEXT NOT NULL,   -- run | reference | manual
  left_id INT NOT NULL,
  right_kind TEXT NOT NULL,
  right_id INT NOT NULL,
  winner TEXT,               -- left | right | tie | NULL (pending)
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pairing_ratings (
  id SERIAL PRIMARY KEY,
  pairing TEXT NOT NULL UNIQUE,     -- "a:<versionId>|b:<versionId>" or "reference" or "manual"
  label TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 1500,
  games INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | cancelled
  attempts INT NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  heartbeat_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);
