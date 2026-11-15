import cookieParser from 'cookie-parser';
import express from 'express';

import { requireJsonForWrites } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { createAdminDishesRouter } from './routes/admin/dishes.js';
import { createAdminMealsRouter } from './routes/admin/meals.js';
import { createAdminSimulationRouter } from './routes/admin/simulation.js';
import { createAuthRouter } from './routes/auth.js';
import { createHealthRouter, fetchMlHealth } from './routes/health.js';
import { createStudentRouter } from './routes/student.js';
import { createSimulationController } from './simulation/controller.js';

// Builds the Express app. Dependencies are injected so tests can replace the database, the ML check and the
// login limiter and the simulation controller. `config` comes from loadConfig() (see src/config.js).
// The simulation controller is exposed as app.locals.simulation (the server calls recoverOnStartup/shutdown).
export function createApp({ pool, config, getMlHealth, loginLimiter, simulation } = {}) {
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

  const sim = simulation ?? createSimulationController({ pool });
  app.locals.simulation = sim;
  app.use('/api/admin/simulation', createAdminSimulationRouter({ pool, config, simulation: sim }));
  app.use('/api/admin/meals', createAdminMealsRouter({ pool, config }));
  app.use('/api/student', createStudentRouter({ pool, config }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
