import { noteApiFailure } from '../lib/errorReporter';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The full error body — carries UI hints like google_connect flags. */
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'include',
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch (err) {
    noteApiFailure(path, undefined, err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: unknown;
    };
    // body.error is usually a string but some paths return a structured
    // object (e.g. validation issues) — pass it through verbatim and the
    // UI shows "[object Object]" where a message belongs.
    const errText =
      typeof body.error === 'string'
        ? body.error
        : ((body.error as { message?: string } | undefined)?.message ??
          `HTTP ${res.status}`);
    noteApiFailure(path, res.status, typeof body.error === 'string' ? body.error : errText);
    throw new ApiError(res.status, errText, body);
  }
  return (await res.json()) as T;
}
