import { createSign } from 'node:crypto';

/**
 * Minimal Dialogflow ES client for migrated legacy bots — no googleapis dep.
 * Auth: service-account JWT bearer grant (RS256) → oauth2 access token,
 * cached in-process until ~1min before expiry.
 *
 * The query path mirrors wordhopapi's dialogflow_v2.api().query() +
 * dialogflow_conversion: POST v2beta1 detectIntent with v1-style contexts
 * (converted to session-scoped v2 paths), event input, resetContexts,
 * geoLocation, payload, auto-attached knowledge bases, and the janis-context
 * merge (read existing janis context → merge params → delete it → send the
 * merged copy inline). Responses come back normalized to the v1 shape the
 * legacy formatters expect ({result:{fulfillment:{speech,messages}}}).
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const tokenCache = new Map<string, { token: string; exp: number }>();

async function googleAccessToken(sa: ServiceAccount): Promise<string> {
  const hit = tokenCache.get(sa.client_email);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned =
    `${b64({ alg: 'RS256', typ: 'JWT' })}.` +
    b64({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/dialogflow',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    });
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`google oauth HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(sa.client_email, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

const dfFetch = async (sa: ServiceAccount, path: string, init?: RequestInit) => {
  const token = await googleAccessToken(sa);
  const res = await fetch(`https://dialogflow.googleapis.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  return res;
};

// ---------------------------------------------------------------------------
// v1 ⇄ v2 shapes
// ---------------------------------------------------------------------------

export interface LegacyContext {
  name: string;
  lifespan?: number;
  parameters?: Record<string, unknown>;
}

export interface LegacyQuery {
  text?: string;
  event?: { name: string; data?: Record<string, unknown> };
  lang?: string;
  contexts?: LegacyContext[];
  resetContexts?: boolean;
  location?: { latitude: number; longitude: number };
  originalRequest?: { source: string; data?: unknown };
}

/** v1-style fulfillment message after convertMessagesFromQuery:
 *  type 0=text(speech) 1=card 2=quick replies 3=image 4=custom payload */
export interface V1Message {
  type?: number;
  speech?: string;
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  replies?: string[];
  buttons?: { text?: string; postback?: string }[];
  payload?: Record<string, unknown>;
  platform?: string;
}

export interface V1Result {
  resolvedQuery?: string;
  action?: string;
  parameters?: Record<string, unknown>;
  fulfillment: {
    speech?: string;
    messages: V1Message[];
    webhookPayload?: Record<string, unknown>;
  };
  metadata: { intentId?: string | null; intentName?: string | null; isFallback?: boolean };
  contexts?: LegacyContext[];
  score?: number;
}

interface V2Message {
  text?: { text?: string[] | string };
  card?: { title?: string; subtitle?: string; imageUri?: string; buttons?: { text?: string; postback?: string }[] };
  quickReplies?: { title?: string; quickReplies?: string[] };
  image?: { imageUri?: string };
  payload?: Record<string, unknown>;
  platform?: string;
}

function convertMessagesFromQuery(messages: V2Message[] | undefined): V1Message[] {
  const out: V1Message[] = [];
  for (const m of messages ?? []) {
    const v1: V1Message = { ...m };
    if (m.text) {
      v1.type = 0;
      v1.speech = typeof m.text.text === 'string' ? m.text.text : m.text.text?.[0];
    }
    if (m.card) {
      v1.type = 1;
      v1.imageUrl = m.card.imageUri;
      v1.buttons = m.card.buttons;
      v1.title = m.card.title;
      v1.subtitle = m.card.subtitle;
    }
    if (m.quickReplies) {
      v1.type = 2;
      v1.replies = m.quickReplies.quickReplies;
      v1.title = m.quickReplies.title;
    }
    if (m.image) {
      v1.type = 3;
      v1.imageUrl = m.image.imageUri;
    }
    if (m.payload) v1.type = 4;
    if (v1.platform) v1.platform = v1.platform.toLowerCase();
    delete (v1 as Record<string, unknown>).text;
    delete (v1 as Record<string, unknown>).card;
    delete (v1 as Record<string, unknown>).quickReplies;
    delete (v1 as Record<string, unknown>).image;
    out.push(v1);
  }
  return out;
}

const ctxId = (fullName: string) => fullName.split('/contexts/')[1] ?? '';
const intentId = (fullName: string) => fullName.split('/intents/')[1] ?? '';

interface V2QueryResult {
  queryText?: string;
  action?: string;
  parameters?: Record<string, unknown>;
  fulfillmentText?: string;
  fulfillmentMessages?: V2Message[];
  webhookPayload?: Record<string, unknown>;
  intent?: { name?: string; displayName?: string; isFallback?: boolean };
  outputContexts?: { name: string; lifespanCount?: number; parameters?: Record<string, unknown> }[];
  intentDetectionConfidence?: number;
  languageCode?: string;
  knowledgeAnswers?: { answers?: { answer?: string; matchConfidence?: number }[] };
}

function convertV2toV1Query(j: { responseId?: string; queryResult?: V2QueryResult }, sessionId: string) {
  const qr = j.queryResult ?? {};
  if (
    qr.fulfillmentText == null &&
    qr.knowledgeAnswers?.answers?.[0]?.answer &&
    (qr.knowledgeAnswers.answers[0].matchConfidence ?? 0) > 0.6
  ) {
    qr.fulfillmentText = qr.knowledgeAnswers.answers[0].answer;
  }
  const v1: { id?: string; result: V1Result; lang?: string; sessionId: string } = {
    id: j.responseId,
    sessionId,
    lang: qr.languageCode,
    result: {
      resolvedQuery: qr.queryText,
      action: qr.action,
      parameters: qr.parameters,
      fulfillment: {
        speech: qr.fulfillmentText,
        messages: convertMessagesFromQuery(qr.fulfillmentMessages),
        ...(qr.webhookPayload ? { webhookPayload: qr.webhookPayload } : {}),
      },
      metadata: {
        intentId: qr.intent?.name ? intentId(qr.intent.name) : null,
        intentName: qr.intent?.displayName ?? null,
        isFallback: !!qr.intent?.isFallback,
      },
      score: qr.intentDetectionConfidence,
    },
  };
  if (qr.outputContexts) {
    v1.result.contexts = qr.outputContexts.map((c) => ({
      name: ctxId(c.name),
      parameters: c.parameters ?? {},
      lifespan: c.lifespanCount ?? 0,
    }));
  }
  return v1;
}

// ---------------------------------------------------------------------------
// The query — wordhopapi dfapi.query() port
// ---------------------------------------------------------------------------

const kbCache = new Map<string, { names: string[]; at: number }>();

async function knowledgeBaseNames(project: string, sa: ServiceAccount): Promise<string[]> {
  const hit = kbCache.get(project);
  if (hit && hit.at > Date.now() - 5 * 60_000) return hit.names;
  try {
    const res = await dfFetch(sa, `/v2/projects/${project}/knowledgeBases`);
    const j = (await res.json()) as { knowledgeBases?: { name: string }[] };
    const names = res.ok ? (j.knowledgeBases ?? []).map((k) => k.name) : [];
    kbCache.set(project, { names, at: Date.now() });
    return names;
  } catch {
    return [];
  }
}

const VALID_CTX = /^[A-Za-z\d_%-]+$/;
const stripDiacritics = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Legacy janis-context merge: read the stored janis context, fold the
 *  incoming params over it (diacritics-normalized keys), delete the stored
 *  one so only the merged inline copy applies. */
async function mergeJanisContext(
  project: string,
  sessionId: string,
  contexts: { name: string; lifespanCount?: number; parameters?: Record<string, unknown> }[],
  sa: ServiceAccount,
): Promise<void> {
  const janis = contexts.find((c) => c.name.endsWith('/contexts/janis'));
  if (!janis) return;
  const path = `/v2/projects/${project}/agent/sessions/${sessionId}/contexts/janis`;
  try {
    const res = await dfFetch(sa, path);
    if (res.ok) {
      const stored = (await res.json()) as { parameters?: Record<string, unknown> };
      const params = { ...(stored.parameters ?? {}) };
      for (const k of Object.keys(params)) {
        const norm = stripDiacritics(k).toLowerCase();
        const incoming = janis.parameters ?? {};
        const hit = Object.keys(incoming).find((ik) => stripDiacritics(ik).toLowerCase() === norm);
        if (hit) params[k] = incoming[hit];
      }
      // incoming-only params land on the janis context too
      for (const [k, v] of Object.entries(janis.parameters ?? {})) {
        if (params[k] === undefined) params[k] = v;
      }
      janis.parameters = params;
      await dfFetch(sa, path, { method: 'DELETE' });
    }
  } catch {}
}

export async function detectIntentV1(
  project: string,
  sessionId: string,
  body: LegacyQuery,
  sa: ServiceAccount,
): Promise<{ id?: string; result: V1Result; lang?: string; sessionId: string } | null> {
  const lang = body.lang ?? 'en';
  const obj: Record<string, unknown> = {};
  if (body.event?.name) {
    obj.queryInput = {
      event: { name: body.event.name, ...(body.event.data ? { parameters: body.event.data } : {}), languageCode: lang },
    };
  } else if (body.text != null) {
    obj.queryInput = { text: { text: body.text.length > 255 ? body.text.slice(0, 254) : body.text, languageCode: lang } };
  } else {
    return null;
  }

  const contexts = (body.contexts ?? [])
    .filter((c) => VALID_CTX.test(c.name))
    .map((c) => ({
      name: `projects/${project}/agent/sessions/${sessionId}/contexts/${stripDiacritics(c.name)}`,
      ...(c.lifespan != null ? { lifespanCount: c.lifespan } : {}),
      ...(c.parameters ? { parameters: c.parameters } : {}),
    }));

  const queryParams: Record<string, unknown> = {};
  if (contexts.length) queryParams.contexts = contexts;
  if (body.resetContexts) queryParams.resetContexts = true;
  if (body.location) queryParams.geoLocation = body.location;
  if (body.originalRequest) queryParams.payload = body.originalRequest;
  const kbs = await knowledgeBaseNames(project, sa);
  if (kbs.length) queryParams.knowledgeBaseNames = kbs;
  if (Object.keys(queryParams).length) obj.queryParams = queryParams;

  await mergeJanisContext(project, sessionId, contexts, sa);

  const res = await dfFetch(sa, `/v2beta1/projects/${project}/agent/sessions/${encodeURIComponent(sessionId)}:detectIntent`, {
    method: 'POST',
    body: JSON.stringify(obj),
  });
  if (!res.ok) throw new Error(`dialogflow HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return convertV2toV1Query((await res.json()) as { responseId?: string; queryResult?: V2QueryResult }, sessionId);
}

/** Recursive event-chaining: if the response carries parameters.event, fire
 *  a follow-up query for that event and merge fulfillment messages, output
 *  contexts and parameters (wordhopapi detectEventAndQueryForIntent). */
export async function detectIntentChain(
  project: string,
  sessionId: string,
  body: LegacyQuery,
  sa: ServiceAccount,
  consolidated?: Awaited<ReturnType<typeof detectIntentV1>>,
  depth = 0,
): Promise<Awaited<ReturnType<typeof detectIntentV1>>> {
  const res = consolidated ?? (await detectIntentV1(project, sessionId, body, sa));
  const eventName = res?.result?.parameters?.event;
  if (!res || typeof eventName !== 'string' || !eventName || depth >= 5) return res;

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(res.result.parameters ?? {})) {
    if (k.startsWith('eventparam_')) data[k.slice(11)] = v;
  }
  const next = await detectIntentV1(
    project,
    sessionId,
    { event: { name: eventName, data }, lang: body.lang, contexts: body.contexts },
    sa,
  );
  if (!next) return res;

  // merge: messages append, contexts union by name, parameters merge (new wins)
  const merged = next;
  merged.result.fulfillment.messages = [
    ...(res.result.fulfillment.messages ?? []),
    ...(next.result.fulfillment.messages ?? []),
  ];
  const seen = new Set((next.result.contexts ?? []).map((c) => c.name));
  merged.result.contexts = [
    ...(next.result.contexts ?? []),
    ...(res.result.contexts ?? []).filter((c) => c.name !== '__system_counters__' && !seen.has(c.name)),
  ];
  const params = { ...(res.result.parameters ?? {}) };
  delete params.event;
  merged.result.parameters = { ...params, ...(next.result.parameters ?? {}) };
  merged.result.resolvedQuery = res.result.resolvedQuery;
  return detectIntentChain(project, sessionId, body, sa, merged, depth + 1);
}

// ---------------------------------------------------------------------------
// Simple path used by the webhook-driven legacy responder
// ---------------------------------------------------------------------------

export interface DfFulfillment {
  /** plain text replies, in order */
  texts: string[];
  /** raw Messenger message objects from payload.facebook — sent verbatim */
  fbPayloads: Record<string, unknown>[];
  isFallback: boolean;
  intentName?: string;
}

export async function detectIntent(
  project: string,
  sessionId: string,
  text: string,
  lang: string,
  sa: ServiceAccount,
): Promise<DfFulfillment> {
  const res = await detectIntentV1(project, sessionId, { text, lang }, sa);
  const texts: string[] = [];
  const fbPayloads: Record<string, unknown>[] = [];
  for (const m of res?.result.fulfillment.messages ?? []) {
    if (m.payload?.facebook && typeof m.payload.facebook === 'object') {
      fbPayloads.push(m.payload.facebook as Record<string, unknown>);
    } else if (m.speech) {
      texts.push(m.speech);
    }
  }
  if (!texts.length && !fbPayloads.length && res?.result.fulfillment.speech) {
    texts.push(res.result.fulfillment.speech);
  }
  return {
    texts,
    fbPayloads,
    isFallback: !!res?.result.metadata.isFallback,
    intentName: res?.result.metadata.intentName ?? undefined,
  };
}
