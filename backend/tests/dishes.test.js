// Dish renaming: only display_name may change; id and ml_dish_name are immutable; every rename is audited.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp, createUser, signedIn } from './helpers/app.js';
import { DATABASE_URL, createTestSchema } from './helpers/db.js';

describe.skipIf(!DATABASE_URL)('admin dish catalogue', () => {
  let ctx;
  let db;
  let admin;
  let adminUser;

  beforeAll(async () => {
    ctx = await createTestSchema('p3_dishes', { seeded: true });
    db = ctx.pool;
    adminUser = await createUser(db, { email: 'admin@example.test', role: 'admin' });
    admin = await signedIn(buildApp(db), 'admin@example.test');
  });
  afterAll(async () => ctx?.drop());

  // Restore the seeded display names before every test (dish.rename audit rows are append-only and stay).
  beforeEach(async () => {
    await db.query('UPDATE dishes SET display_name = ml_dish_name WHERE display_name <> ml_dish_name');
  });

  const patch = (id, body) => admin.patch(`/api/admin/dishes/${id}`).set('Content-Type', 'application/json').send(body);
  const dish = async (id) => (await db.query('SELECT id, display_name, ml_dish_name FROM dishes WHERE id = $1', [id])).rows[0];
  const renameAudits = async (id) => (await db.query(
    "SELECT user_id, action, entity, before, after FROM audit_log WHERE action = 'dish.rename' AND entity = $1 ORDER BY id",
    [`dish:${id}`],
  )).rows;

  it('lists all 38 dishes with stable IDs and ML names', async () => {
    const res = await admin.get('/api/admin/dishes');
    expect(res.status).toBe(200);
    expect(res.body.dishes).toHaveLength(38);
    expect(res.body.dishes[11]).toMatchObject({ id: 'D012', display_name: 'Rice', ml_dish_name: 'Rice', category: 'staple_rice' });
  });

  it('renames the display name only, trims it, and writes one audit entry', async () => {
    const res = await patch('D012', { display_name: '  Steamed Rice ' });
    expect(res.status).toBe(200);
    expect(res.body.dish).toMatchObject({ id: 'D012', display_name: 'Steamed Rice', ml_dish_name: 'Rice' });
    expect(await dish('D012')).toEqual({ id: 'D012', display_name: 'Steamed Rice', ml_dish_name: 'Rice' });

    const audits = await renameAudits('D012');
    expect(audits.at(-1)).toEqual({
      user_id: String(adminUser.id), action: 'dish.rename', entity: 'dish:D012',
      before: { display_name: 'Rice', ml_dish_name: 'Rice' },
      after: { display_name: 'Steamed Rice', ml_dish_name: 'Rice' },
    });
  });

  it('renaming to the current name changes nothing and is not audited', async () => {
    const before = (await renameAudits('D013')).length;
    const res = await patch('D013', { display_name: 'Chapati' });
    expect(res.status).toBe(200);
    expect((await renameAudits('D013')).length).toBe(before);
  });

  it.each([
    ['id', { id: 'D999' }],
    ['ml_dish_name', { ml_dish_name: 'Chai' }],
    ['ml_dish_name together with display_name', { display_name: 'Chai', ml_dish_name: 'Chai' }],
  ])('rejects changing %s (400 immutable_field) and changes nothing', async (_, body) => {
    const before = (await renameAudits('D001')).length;
    const res = await patch('D001', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('immutable_field');
    expect(await dish('D001')).toEqual({ id: 'D001', display_name: 'Tea', ml_dish_name: 'Tea' });
    expect((await renameAudits('D001')).length).toBe(before);
  });

  it.each([
    ['active', { active: false }],
    ['category', { category: 'dessert' }],
    ['is_veg', { is_veg: false }],
    ['portion_kg', { portion_kg: 1 }],
    ['an unknown field', { colour: 'red' }],
    ['an empty name', { display_name: '   ' }],
    ['a name over 100 characters', { display_name: 'x'.repeat(101) }],
    ['a non-string name', { display_name: 42 }],
    ['an empty body', {}],
    ['an array body', []],
  ])('rejects %s (400) and changes nothing', async (_, body) => {
    const res = await patch('D001', body);
    expect(res.status).toBe(400);
    const { rows } = await db.query("SELECT display_name, active, category, is_veg, portion_kg FROM dishes WHERE id = 'D001'");
    expect(rows[0]).toEqual({ display_name: 'Tea', active: true, category: 'beverage', is_veg: true, portion_kg: 0.15 });
  });

  it('returns 404 for an unknown or malformed dish id', async () => {
    expect((await patch('D999', { display_name: 'X' })).status).toBe(404);
    expect((await patch('rice', { display_name: 'X' })).status).toBe(404);
  });

  it('rejects a display name already used by another dish, ignoring case (409), without an audit entry', async () => {
    const before = (await renameAudits('D002')).length;
    const res = await patch('D002', { display_name: 'TEA' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('display_name_taken');
    expect(await dish('D002')).toMatchObject({ display_name: 'Coffee' });
    expect((await renameAudits('D002')).length).toBe(before);
  });

  it('allows changing only the letter case of a dish\'s own name', async () => {
    const res = await patch('D001', { display_name: 'TEA' });
    expect(res.status).toBe(200);
    expect(await dish('D001')).toMatchObject({ display_name: 'TEA', ml_dish_name: 'Tea' });
  });

  it('a rename that fails after the update rolls back together with its audit entry', async () => {
    // Make audit inserts fail for this schema only, then confirm the rename did not persist.
    await db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`);
    await db.query('CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      const res = await patch('D003', { display_name: 'Kanda Poha' });
      expect(res.status).toBe(500);
      expect(await dish('D003')).toMatchObject({ display_name: 'Poha' });
    } finally {
      await db.query('DROP TRIGGER fail_audit ON audit_log');
      await db.query('DROP FUNCTION fail_audit()');
    }
  });
});
