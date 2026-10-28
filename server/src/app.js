import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { apiRouter } from './routes/api.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: false, limit: '50mb' }));
  app.use(cookieParser(config.sessionSecret));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', apiRouter());
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  return app;
}
