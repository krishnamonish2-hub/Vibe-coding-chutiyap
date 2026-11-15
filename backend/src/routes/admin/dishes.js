// Admin dish catalogue. Only display_name can be changed (R-08, Phase 3 decision): id and ml_dish_name are
// immutable (also enforced by a database trigger), and every other field is read-only through the API.
// Each rename is audited in the same transaction.

import { Router } from 'express';
import { z } from 'zod';

import { withTransaction } from '../../db/transaction.js';
import { parseOrThrow } from '../../lib/validate.js';
import { ApiError } from '../../middleware/error-handler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { recordAudit } from '../../services/audit.js';

const DISH_ID = /^D[0-9]{3}$/;
const IMMUTABLE_FIELDS = ['id', 'ml_dish_name'];

const RenameBody = z.object({
  display_name: z.string().trim().min(1).max(100),
}).strict();

const COLUMNS = 'id, display_name, ml_dish_name, category, is_veg, portion_kg, active, updated_at';

export function createAdminDishesRouter({ pool, config }) {
  const router = Router();
  router.use(requireAuth({ pool, config }), requireRole('admin'));

  router.get('/', async (req, res) => {
    const { rows } = await pool.query(`SELECT ${COLUMNS} FROM dishes ORDER BY id`);
    res.json({ dishes: rows });
  });

  router.patch('/:id', async (req, res) => {
    const { id } = req.params;
    if (!DISH_ID.test(id)) throw new ApiError(404, 'dish_not_found', `No dish ${id}`);

    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'validation_error', 'Request body must be a JSON object');
    }
    const immutable = IMMUTABLE_FIELDS.filter((f) => Object.hasOwn(body, f));
    if (immutable.length) {
      throw new ApiError(400, 'immutable_field', `${immutable.join(', ')} cannot be changed`, { fields: immutable });
    }
    const { display_name: displayName } = parseOrThrow(RenameBody, body);

    const dish = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(`SELECT ${COLUMNS} FROM dishes WHERE id = $1 FOR UPDATE`, [id]);
      if (rows.length === 0) throw new ApiError(404, 'dish_not_found', `No dish ${id}`);
      const current = rows[0];
      if (current.display_name === displayName) return current; // nothing to change, nothing to audit

      let updated;
      try {
        ({ rows: [updated] } = await client.query(
          `UPDATE dishes SET display_name = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, displayName],
        ));
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'dishes_display_name_unique') {
          throw new ApiError(409, 'display_name_taken', `Another dish is already called "${displayName}"`);
        }
        throw err;
      }
      await recordAudit(client, {
        userId: req.user.id,
        action: 'dish.rename',
        entity: `dish:${id}`,
        before: { display_name: current.display_name, ml_dish_name: current.ml_dish_name },
        after: { display_name: updated.display_name, ml_dish_name: updated.ml_dish_name },
      });
      return updated;
    });
    res.json({ dish });
  });

  return router;
}
