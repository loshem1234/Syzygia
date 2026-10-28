// Central configuration. Every value can be set by environment variable.
export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/syzygia',
  password: process.env.SYZYGIA_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || 'syzygia-dev-secret-change-me',
  runWorker: (process.env.RUN_WORKER ?? 'true') !== 'false',
  morpheusUrl: process.env.MORPHEUS_URL || '',
  keys: {
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    google: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
  },
  embeddings: {
    provider: process.env.EMBEDDINGS_PROVIDER || '', // openai | google | '' (off)
    model: process.env.EMBEDDINGS_MODEL || '',
  },
  limits: {
    toolCallsPerTurn: Number(process.env.TOOL_CALLS_PER_TURN || 8),
    maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 4000),
    contextBudgetTokens: Number(process.env.CONTEXT_BUDGET_TOKENS || 180000),
    lexiconEntryChars: Number(process.env.LEXICON_ENTRY_CHARS || 2400),
    decayWindowVerses: Number(process.env.DECAY_WINDOW_VERSES || 250),
    synthesisAlertRate: Number(process.env.SYNTHESIS_ALERT_RATE || 0.3),
  },
};
