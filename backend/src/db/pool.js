import pg from 'pg';

// DATE (OID 1082) is returned as the plain 'YYYY-MM-DD' string stored in PostgreSQL.
// The default parser builds a JavaScript Date in the local time zone, which can shift the day
// when it is serialised again. Meal dates are sent to the ML service as strings, so they must not move.
const DATE_OID = 1082;
pg.types.setTypeParser(DATE_OID, (value) => value);

export function createPool(databaseUrl, options = {}) {
  return new pg.Pool({ connectionString: databaseUrl, max: 10, ...options });
}
