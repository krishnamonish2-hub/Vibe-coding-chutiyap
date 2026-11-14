import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db/pool.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const pool = createPool(config.databaseUrl);
const app = createApp({ pool, config });

const server = app.listen(config.port, () => {
  console.log(`MessMind backend listening on http://localhost:${config.port} (ML service: ${config.mlApiUrl})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
