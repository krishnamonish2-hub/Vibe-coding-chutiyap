import { ApiError } from '../middleware/error-handler.js';

// Parses `value` with a Zod schema; on failure throws a 400 with one entry per problem.
export function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  throw new ApiError(400, 'validation_error', 'Request is invalid', details);
}
