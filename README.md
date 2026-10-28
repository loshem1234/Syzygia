# Syzygia

*συζυγία, a yoked pair.*

Two Greek-scholar agents translate Ancient Greek verse by verse. One drafts, the other critiques and revises, the first answers and refines, the second gives the final version. If they agree, the verse is locked. If they do not, two rounds of synthesis seek the true middle ground; where real divergence remains, the last joint rendering stands and the dissent is kept as apparatus. Literal fidelity is King; elegant prose is Queen.

Built for the Archivum Universale & Scriptorium.

---

## What is inside

| Part | Where |
| --- | --- |
| The Charter (King and Queen, evidence, disposition) | `server/src/core/charter.js` |
| Debate protocol (A1, B1, A2, B2, S1, S2; never more than six turns) | `server/src/core/protocol.js` |
| Errors vs preferences, convergence rules | `server/src/core/critique.js` |
| Seven-layer context stack, de-duplication, pressure valve | `server/src/core/context.js` |
| Source integrity: raw storage, SHA-256, no normalization, lossless verse slicing | `server/src/core/integrity.js` and database triggers |
| Pre-fetch rules (parser findings → exact references) | `server/src/core/prefetch.js`, `constructions.js`, `seed.js` |
| Agent tools: lookup, section, search, concordance, parse | `server/src/core/tools.js` |
| Citation verification | `server/src/core/citations.js` |
| Ledger governance (locks, evidence, no reverting, two changes per chapter) | `server/src/core/ledger.js` |
| Book memory: style sheet, concordance, quotations, digests | `server/src/core/memory.js` |
| Learning tiers (book, corpus, global), promotion, decay | `server/src/core/learning.js` |
| Orchestrator, resumable at the exact turn | `server/src/jobs/runChapter.js` |
| Postgres-backed job queue (no Redis) | `server/src/jobs/queue.js` |
| Providers: Anthropic, Google, OpenAI with caching and tool loops | `server/src/providers/` |
| Morpheus parser client and Beta Code | `server/src/morph/` |
| Exports: PDF, DOCX, Markdown, TXT, TEI XML | `server/src/export/` |
| Interface | `web/src/` |

---

## Deploy on Railway

1. **Push this folder to a new GitHub repository.**

2. **Create the project.** In Railway: *New Project → Deploy from GitHub repo*, choose the repository. Railway reads `railway.json`: it builds with `npm ci && npm run build` and starts with `npm start`. The first start creates every table.

3. **Add Postgres.** *New → Database → PostgreSQL*. On the Syzygia service, add the variable
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}`

4. **Add the Morpheus parser.** *New → Docker Image* → `perseidsproject/morpheus-api:v1.0.15`. Name the service `morpheus`. It listens on port 1315. On the Syzygia service add
   `MORPHEUS_URL = http://${{morpheus.RAILWAY_PRIVATE_DOMAIN}}:1315`
   Without the parser Syzygia still works, but the pre-fetch can only match exact word forms, so this service matters.

5. **Set the remaining variables on the Syzygia service:**

   | Variable | Value |
   | --- | --- |
   | `SYZYGIA_PASSWORD` | the password you will sign in with |
   | `SESSION_SECRET` | a long random string |
   | `ANTHROPIC_API_KEY` | your Anthropic key |
   | `GEMINI_API_KEY` | your Google AI Studio key |
   | `OPENAI_API_KEY` | optional, for a third contender |
   | `EMBEDDINGS_PROVIDER` | optional: `openai` or `google`, for semantic search over grammars |

6. **Generate a domain** under the service's *Settings → Networking*, open it and sign in.

The worker runs inside the web service, so runs continue with the browser closed. To separate them, set `RUN_WORKER=false` on the web service and add a second service from the same repo with start command `npm run worker -w server`.

---

## First steps in the app

1. **Agents.** Create Agent A (the literal-first translator, for example `claude-sonnet-5-5`) and Agent B (the critic, for example `gemini-3.1-pro`). Give each an escalation model (`claude-opus-5-5`, `claude-fable-5-1`) for disputed verses. Model IDs change often: the model field suggests the IDs your keys can currently use. Enter prices per million tokens at the bottom of the page.
2. **Library.** Add reference works (see *Loading the library* below). Spot-check a sample of each.
3. **Project.** Create *On the Pythagorean Life*, give it a corpus profile such as *Iamblichus*, then import the whole work, followed by each numbered chapter.
4. **Ledger.** Import your starting list: one term per line, `νοῦς = Intellect; mind | the hypostasis`.
5. **Reading pass.** On the project's *Reading pass* tab, let both agents read the whole work and review their study notes. Approving seeds the ledger and style sheet.
6. **Debate.** Open a chapter and start the debate. Watch it live, or close the tab and come back.
7. **Leaderboard.** Paste your own translation of chapters 1 to 3 as reference translations (evaluation only, never shown to the agents) and judge renderings blind.

### Importing Greek safely

The Greek is stored byte for byte and fingerprinted (SHA-256); the database refuses any change to it. Uploading the `.txt` file is the safest route because no clipboard is involved. Copying from a plain text editor and pasting is also safe; word processors and some PDF viewers are not. The *Character inspector* on the project page shows the exact code points of any word: oxia or tonos, precomposed or combining.

Number each verse at the start of its line: `1`, `1.`, `[1]`, `(1)` or `§1`. Import is refused if slicing would lose a single character.

---

## Loading the library

Each work is split along its own structure so that agents receive one entry or one section at a time. Choose the split when you add the work:

| Split | Use for | How the text should look |
| --- | --- | --- |
| LSJ (Perseus XML) | LSJ from Perseus or the Logeion edition (`helmadik/LSJLogeion` on GitHub; check its licence) | `<entryFree key="…">` elements |
| Structured lines (JSONL) | anything you pre-process yourself | one `{"ref": "...", "text": "...", "lemmas": ["..."]}` per line |
| By headword | lexica, Peters | each entry starts a line with the Greek headword and a comma |
| By particle | Denniston | each article starts a line with the particle |
| By numbered section | Smyth, CGCG, Goodwin, Kühner–Gerth, Buck | each section starts a line with its number: `2070.` |
| By heading / paragraph | editions, commentaries, notes | Markdown headings, or blank lines |

Set *Kind* correctly: the core pre-fetch rules work by kind (every lemma brings its *lexicon* entry, every particle its *particles* article, every construction its *grammar* sections, every non-Attic form its *dialect* handbook section). Put Dillon–Hershbell and your own translation under *Evaluation only*.

---

## Development

```bash
docker compose up -d          # Postgres and Morpheus
cp .env.example .env          # then edit
npm install
npm run dev                   # API on :8080, interface on :5173
```

### Tests

The acceptance suite runs against a real Postgres with scripted model replies:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm test
```

It covers the twelve acceptance tests in the spec: polytonic round trip through prompts and every export, the context stack, disposition, all three protocol paths, escalation, pre-fetch, citation verification, ledger governance, book memory, learning tiers, resume after a crash, the full workflow through the API, and all three provider adapters against local stubs.

The **golden run** (acceptance test 12) uses real models on your own text. Put three numbered verses of your Nauck text in a file and run:

```bash
GOLDEN_FILE=./golden.txt ANTHROPIC_API_KEY=… GEMINI_API_KEY=… npm test
```

---

## Notes

- **Cost.** Every call carries the whole work, cached. Caches stay warm while a run is continuous; a pause of more than about an hour means one uncached call to rebuild. Set a spending cap per run.
- **Benchmark runs** create versions for comparison without changing the current translation. **Learned rules off** runs measure whether learning helps.
- **Backup.** *Settings → Download a backup* writes everything to one JSON file. Restore only into an empty installation.
- **Fonts.** GFS Didot (Greek), EB Garamond (PDF English), Alegreya and Alegreya Sans (interface). All SIL Open Font License; bundled, so the app makes no third-party requests.
