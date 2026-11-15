import cookieParser from 'cookie-parser';
import express from 'express';

import { requireJsonForWrites } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { createAdminDishesRouter } from './routes/admin/dishes.js';
import { createAuthRouter } from './routes/auth.js';
import { createHealthRouter, fetchMlHealth } from './routes/health.js';

// Builds the Express app. Dependencies are injected so tests can replace the database, the ML check and the
// login limiter. `config` comes from loadConfig() (see src/config.js).
export function createApp({ pool, config, getMlHealth, loginLimiter } = {}) {
  if (!config?.jwtSecret) throw new Error('createApp needs a config with jwtSecret');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use('/api', requireJsonForWrites);

  const mlHealth = getMlHealth ?? (() => fetchMlHealth(config.mlApiUrl, config.mlTimeoutMs));
  app.use('/api', createHealthRouter({ pool, getMlHealth: mlHealth }));
  app.use('/api/auth', createAuthRouter({ pool, config, ...(loginLimiter ? { limiter: loginLimiter } : {}) }));
  app.use('/api/admin/dishes', createAdminDishesRouter({ pool, config }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
