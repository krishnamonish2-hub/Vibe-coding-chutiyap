import express from 'express';

import { errorHandler, notFound } from './middleware/error-handler.js';
import { createHealthRouter, fetchMlHealth } from './routes/health.js';

// Builds the Express app. Dependencies are injected so tests can replace the database and the ML check.
export function createApp({ pool, config, getMlHealth } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const mlHealth = getMlHealth ?? (() => fetchMlHealth(config.mlApiUrl, config.mlTimeoutMs));
  app.use('/api', createHealthRouter({ pool, getMlHealth: mlHealth }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
