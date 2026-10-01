import { noteApiFailure } from '../lib/errorReporter';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    noteApiFailure(path, res.status, body.error);
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
