// Admin simulation control (Phase 4A). Admin role only, enforced on the server.

import { Router } from 'express';
import { z } from 'zod';

import { parseOrThrow } from '../../lib/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
    { message: 'must be a real date' });

const StartBody = z.object({
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  start_date: ISO_DATE.optional(),
  total_days: z.number().int().min(31).max(366).optional(),
  speed_sim_minutes: z.number().int().min(1).max(1440).optional(),
  calendar: z.object({
    holidays: z.number().int().min(0).max(30),
    festivals: z.number().int().min(0).max(30),
    exam_days: z.number().int().min(0).max(30),
  }).strict().optional(),
}).strict();

const AdvanceBody = z.discriminatedUnion('to', [
  z.object({ to: z.literal('next_step') }).strict(),
  z.object({ to: z.literal('end_of_day') }).strict(),
  z.object({ to: z.literal('day'), day: z.number().int().min(1).max(366) }).strict(),
]);

const PlayBody = z.object({ speed_sim_minutes: z.number().int().min(1).max(1440).optional() }).strict();
const ResetBody = z.object({ confirm: z.string() }).strict();

export function createAdminSimulationRouter({ pool, config, simulation }) {
  const router = Router();
  router.use(requireAuth({ pool, config }), requireRole('admin'));

  router.get('/', async (req, res) => {
    res.json(await simulation.status());
  });

  router.post('/start', async (req, res) => {
    const body = parseOrThrow(StartBody, req.body ?? {});
    await simulation.start({
      seed: body.seed ?? Math.floor(Math.random() * 2_147_483_647),
      startDate: body.start_date,
      totalDays: body.total_days,
      speedSimMinutes: body.speed_sim_minutes,
      calendar: body.calendar,
    }, req.user.id);
    res.status(201).json(await simulation.status());
  });

  router.post('/advance', async (req, res) => {
    const spec = parseOrThrow(AdvanceBody, req.body);
    const result = await simulation.advance(spec);
    res.json({ ...result, ...(await simulation.status()) });
  });

  router.post('/play', async (req, res) => {
    const body = parseOrThrow(PlayBody, req.body ?? {});
    await simulation.play({ speedSimMinutes: body.speed_sim_minutes });
    res.json(await simulation.status());
  });

  router.post('/pause', async (req, res) => {
    await simulation.pause();
    res.json(await simulation.status());
  });

  router.post('/reset', async (req, res) => {
    const { confirm } = parseOrThrow(ResetBody, req.body);
    const result = await simulation.reset({ confirm, userId: req.user.id });
    res.json({ reset: true, summary: result.summary, audit_id: result.auditId });
  });

  return router;
}
