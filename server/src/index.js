import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { startListening } from './events.js';
import { registerAll } from './jobs/handlers.js';
import { startWorker } from './jobs/queue.js';

await migrate();
await startListening();
registerAll();
if (config.runWorker) startWorker();
createApp().listen(config.port, () => console.log(`[syzygia] listening on :${config.port}`));
