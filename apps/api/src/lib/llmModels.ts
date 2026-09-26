import { env } from '../env.js';
import { meteredAccounts } from './llm.js';

export interface LlmModelsResult {
  status: number;
  body: Record<string, unknown>;
}

/** Shared /llm-models logic: metered mode lists every provider account
 *  Janis can serve; otherwise fetches base_url/models with the caller's key —
 *  or `stored.api_key` when the endpoint matches what's saved (write-only
 *  keys can't be echoed back, so the stored one fills in). The env key is
 *  never sent to a non-env base_url. */
export async function llmModelsResult(
  stored: { base_url?: string; api_key?: string },
  body: { base_url?: string; api_key?: string; metered?: boolean },
): Promise<LlmModelsResult> {
  let baseUrl = (body.base_url ?? '').replace(/\/+$/, '');
  let apiKey = body.api_key ?? '';
  if (body.metered || (!baseUrl && !apiKey)) {
    const accs = meteredAccounts();
    if (!accs.length) {
      return { status: 200, body: { accounts: [], models: [], error: 'no metered provider configured' } };
    }
    const accounts = await Promise.all(
      accs.map(async (a) => {
        try {
          const res = await fetch(`${a.baseUrl}/models`, {
            headers: {
              ...(a.apiKey ? { authorization: `Bearer ${a.apiKey}` } : {}),
              ...(a.headers ?? {}),
            },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) {
            console.warn(`metered /models failed for ${a.vendor}: ${res.status}`);
            return {
              vendor: a.vendor,
              base_url: a.baseUrl,
              models: [] as string[],
              error: `${a.vendor}: provider returned ${res.status}`,
            };
          }
          const data = (await res.json()) as { data?: { id?: string }[] };
          return {
            vendor: a.vendor,
            base_url: a.baseUrl,
            models: (data.data ?? [])
              .map((m) => m.id)
              .filter((s): s is string => Boolean(s))
              .sort(),
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'fetch failed';
          console.warn(`metered /models failed for ${a.vendor}: ${msg}`);
          return {
            vendor: a.vendor,
            base_url: a.baseUrl,
            models: [] as string[],
            error: `${a.vendor}: ${msg}`,
          };
        }
      }),
    );
    // models/base_url kept for older clients — the default account's
    return {
      status: 200,
      body: {
        accounts,
        models: accounts[0].models,
        base_url: accounts[0].base_url,
        default_model: env.llmModel,
      },
    };
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { status: 400, body: { models: [], error: 'base_url must be an http(s) URL' } };
  }
  if (!apiKey && stored.base_url === body.base_url && stored.api_key) {
    apiKey = stored.api_key;
  }
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { status: 200, body: { models: [], error: `provider returned ${res.status}` } };
    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((s): s is string => Boolean(s))
      .sort();
    // base_url tells the UI which provider catalog applies to 'metered'
    return { status: 200, body: { models, base_url: baseUrl } };
  } catch (e) {
    return { status: 200, body: { models: [], error: e instanceof Error ? e.message : 'fetch failed' } };
  }
}
