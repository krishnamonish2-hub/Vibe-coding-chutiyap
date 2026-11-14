// Thin wrapper around fetch for the MessMind backend. All paths are relative (/api/...).

export class ApiRequestError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function apiGet(path, { signal } = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiRequestError(0, 'network_error', 'Backend is not reachable');
  }
  const body = await res.json().catch(() => null);
  // /api/health answers 503 with a useful body when the database is down; keep that body for the caller.
  if (!res.ok && !(path === '/api/health' && body)) {
    throw new ApiRequestError(res.status, body?.error?.code ?? 'http_error',
      body?.error?.message ?? `Request failed with status ${res.status}`, body);
  }
  return body;
}
