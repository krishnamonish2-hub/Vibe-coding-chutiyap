// Thin wrapper around fetch for the MessMind backend. All paths are relative (/api/...).
// The session is an httpOnly cookie set by the backend; JavaScript never sees the token.

export class ApiRequestError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function send(method, path, { body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      signal,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiRequestError(0, 'network_error', 'Backend is not reachable');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  // /api/health answers 503 with a useful body when the database is down; keep that body for the caller.
  if (!res.ok && !(path === '/api/health' && data)) {
    throw new ApiRequestError(res.status, data?.error?.code ?? 'http_error',
      data?.error?.message ?? `Request failed with status ${res.status}`, data);
  }
  return data;
}

export const apiGet = (path, options) => send('GET', path, options);
export const apiPost = (path, body, options) => send('POST', path, { ...options, body });
export const apiPatch = (path, body, options) => send('PATCH', path, { ...options, body });
export const apiPut = (path, body, options) => send('PUT', path, { ...options, body });
