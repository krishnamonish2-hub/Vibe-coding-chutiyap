// Audit log service. audit_log is append-only in the database (trigger) and has no foreign key to simulation
// runs, so entries survive a reset (D6). Entries are written with the same client as the change they describe,
// inside the same transaction, so a change and its audit entry are committed (or rolled back) together.

const MAX_ACTION = 100;
const MAX_ENTITY = 200;

export async function recordAudit(db, { userId = null, action, entity, before = null, after = null }) {
  if (typeof action !== 'string' || action.length === 0 || action.length > MAX_ACTION) {
    throw new TypeError('audit action must be a non-empty string of at most 100 characters');
  }
  if (typeof entity !== 'string' || entity.length === 0 || entity.length > MAX_ENTITY) {
    throw new TypeError('audit entity must be a non-empty string of at most 200 characters');
  }
  const { rows } = await db.query(
    `INSERT INTO audit_log (user_id, action, entity, before, after)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, at, user_id, action, entity, before, after`,
    [userId, action, entity, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)],
  );
  return rows[0];
}

export async function listAudit(db, { limit = 50 } = {}) {
  const { rows } = await db.query(
    'SELECT id, at, user_id, action, entity, before, after FROM audit_log ORDER BY id DESC LIMIT $1',
    [Math.min(Math.max(limit, 1), 500)],
  );
  return rows;
}
