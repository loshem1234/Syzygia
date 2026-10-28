// Optional separate worker service. By default the web service runs the worker
// in-process (RUN_WORKER=true); set RUN_WORKER=false there and run this instead
// to separate them.
import { migrate } from './db/migrate.js';
import { registerAll } from './jobs/handlers.js';
import { startWorker } from './jobs/queue.js';

await migrate();
registerAll();
startWorker();
