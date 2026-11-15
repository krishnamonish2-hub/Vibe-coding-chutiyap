// Small in-memory limit on failed logins per client IP (single-process prototype, decision Q1).
// After `maxFailures` failures within `windowMs`, further attempts get HTTP 429 until the window passes.
// A successful login clears the counter for that IP.

export function createLoginLimiter({ maxFailures = 10, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const failures = new Map(); // ip -> { count, resetAt }

  function current(ip) {
    const entry = failures.get(ip);
    if (entry && entry.resetAt <= now()) {
      failures.delete(ip);
      return null;
    }
    return entry ?? null;
  }

  return {
    isBlocked(ip) {
      const entry = current(ip);
      return entry !== null && entry.count >= maxFailures;
    },
    recordFailure(ip) {
      const entry = current(ip) ?? { count: 0, resetAt: now() + windowMs };
      entry.count += 1;
      failures.set(ip, entry);
    },
    recordSuccess(ip) {
      failures.delete(ip);
    },
  };
}
