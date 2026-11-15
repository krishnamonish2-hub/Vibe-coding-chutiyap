// Student voting API (backend from Phase 4A; pages in frontend/src/pages/student). Student role only, enforced here.

import { Router } from 'express';
import { z } from 'zod';

import { parseOrThrow } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listMyResponses, listUpcomingMeals, submitResponse } from '../services/voting.js';

const DISH_ID = z.string().regex(/^D[0-9]{3}$/);

const ResponseBody = z.discriminatedUnion('response', [
  z.object({ response: z.literal('eating'), dish_ids: z.array(DISH_ID).min(1).max(30) }).strict()
    .refine((b) => new Set(b.dish_ids).size === b.dish_ids.length, { message: 'dish_ids must be unique', path: ['dish_ids'] }),
  z.object({ response: z.literal('not_eating') }).strict(),
]);

export function createStudentRouter({ pool, config }) {
  const router = Router();
  router.use(requireAuth({ pool, config }), requireRole('student'));

  router.get('/meals/upcoming', async (req, res) => {
    res.json(await listUpcomingMeals(pool, req.user.studentId));
  });

  // Phase 6: the student's own responses (read-only).
  router.get('/meals/responses', async (req, res) => {
    res.json(await listMyResponses(pool, req.user.studentId));
  });

  router.put('/meals/:id/response', async (req, res) => {
    const body = parseOrThrow(ResponseBody, req.body);
    const saved = await submitResponse(pool, req.user.studentId, req.params.id,
      { response: body.response, dishIds: body.dish_ids ?? [] });
    res.json({ meal_id: req.params.id, my_response: saved });
  });

  return router;
}
