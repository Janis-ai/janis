// Dialogflow intent mutation layer — the write half of training.js.
// Legacy operated on v1 intent docs with apiai developer tokens; this module
// keeps the same v1-doc operations and translates each to v2 REST calls so
// the training-menu callbacks behave identically against a migrated agent.
import {
  createIntentV2,
  deleteIntentV2,
  detectIntentV1,
  getIntentV1,
  listIntentsV2,
  patchIntentV2,
  v2IntentToV1Doc,
  type ServiceAccount,
} from '../dialogflow.js';
import { removeFormatting } from './profiles.js';
import { followupTemplates } from './followups.js';

export interface AgentDf {
  project: string;
  sa: ServiceAccount;
}

function v2Platform(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const up = p.toUpperCase();
  const known = ['FACEBOOK', 'SLACK', 'SLACK_TEST_BETA', 'SKYPE', 'LINE', 'VIBER', 'ACTIONS_ON_GOOGLE', 'TELEGRAM', 'KIK', 'TWILIO', 'TWILIO_SMS', 'TANGO', 'SPARK', 'GOOGLE_HANGOUTS', 'TELEPHONY'];
  return known.includes(up) ? up : undefined;
}

/** v1 intent doc → v2 intent PATCH/POST body. Inverse of v2IntentToV1Doc. */
export function v1DocToV2(project: string, intent: any): any {
  const messages = (intent.responses?.[0]?.messages ?? [])
    .filter(Boolean)
    .map((m: any) => {
      const platform = v2Platform(m.platform);
      if (m.type === 0) {
        const speech = Array.isArray(m.speech) ? m.speech : m.speech ? [m.speech] : [];
        return { ...(platform ? { platform } : {}), text: { text: speech } };
      }
      if (m.type === 2) {
        return {
          ...(platform ? { platform } : {}),
          quickReplies: { title: m.title ?? '', quickReplies: m.replies ?? [] },
        };
      }
      if (m.type === 4) return { ...(platform ? { platform } : {}), payload: m.payload ?? {} };
      return { ...(platform ? { platform } : {}), payload: m.payload ?? m };
    });
  const body: any = {
    displayName: intent.name,
    isFallback: intent.fallbackIntent === true,
    events: (intent.events ?? []).map((e: any) => e.name),
    trainingPhrases: (intent.userSays ?? []).map((u: any) => ({
      type: 'EXAMPLE',
      parts: (u.data ?? []).map((d: any) => ({ text: d.text ?? '' })),
    })),
    inputContextNames: (intent.contexts ?? []).map((c: string) => `projects/${project}/agent/contexts/${c}`),
    messages,
  };
  if (intent.action) body.action = intent.action;
  if (intent.priority != null) body.priority = intent.priority;
  if (intent.webhookUsed) body.webhookState = 'WEBHOOK_STATE_ENABLED';
  if (intent.responses?.[0]?.parameters) body.parameters = intent.responses[0].parameters;
  if (intent.responses?.[0]?.affectedContexts?.length) {
    body.outputContexts = intent.responses[0].affectedContexts.map((c: any) => ({
      name: `projects/${project}/agent/sessions/-/contexts/${c.name}`,
      ...(c.lifespan != null ? { lifespanCount: c.lifespan } : {}),
      ...(c.parameters ? { parameters: c.parameters } : {}),
    }));
  }
  if (intent.parentId) body.parentFollowupIntentName = `projects/${project}/agent/intents/${intent.parentId}`;
  if (intent.rootParentId) body.rootFollowupIntentName = `projects/${project}/agent/intents/${intent.rootParentId}`;
  return body;
}

export function findIntent(df: AgentDf, intentId: string, opts: { withFollowups?: boolean } = {}) {
  return getIntentV1(df.project, intentId, df.sa, { withFollowups: opts.withFollowups ?? true });
}

/** dialogflow.patchIntent — PUT the mutated v1 doc back, return the updated doc. */
export async function patchIntent(df: AgentDf, intent: any): Promise<any> {
  const body = v1DocToV2(df.project, intent);
  if (intent.resourceName) body.name = intent.resourceName;
  const patched = await patchIntentV2(df.project, intent.resourceName, body, df.sa);
  return v2IntentToV1Doc(String(patched.name ?? '').split('/intents/').pop() ?? intent.id, patched);
}

export function deleteIntent(df: AgentDf, intentId: string) {
  return deleteIntentV2(df.project, intentId, df.sa);
}

export async function addUserSaysToIntent(df: AgentDf, intent: any, userSays: string): Promise<any> {
  userSays = String(removeFormatting(userSays));
  if (intent.userSays == null) intent.userSays = [];
  intent.userSays.push({ data: [{ text: userSays }], isTemplate: false, count: 0 });
  return patchIntent(df, intent);
}

export async function removeUserSaysToIntent(df: AgentDf, intent: any, userSays: string): Promise<any> {
  userSays = String(removeFormatting(userSays));
  if (intent == null || intent.id == null || intent.userSays == null) {
    throw new Error('no intent');
  }
  const wanted = userSays.toLowerCase().trim();
  const userSaysArr: any[] = [];
  const templates: string[] = [];
  for (const u of intent.userSays) {
    let text = '';
    for (const d of u.data ?? []) text += d.text;
    if (text.toLowerCase().trim() !== wanted) userSaysArr.push(u);
  }
  if (intent.templates) {
    for (const t of intent.templates) {
      if (String(t).toLowerCase().trim() !== wanted) templates.push(t);
    }
  }
  intent.userSays = userSaysArr;
  intent.templates = templates;
  return patchIntent(df, intent);
}

/** removeResponseToIntent — delete is by type: payload/chatfuel/manychat
 *  match the payload JSON, otherwise the first type-0 message's speech list. */
export async function removeResponseToIntent(
  df: AgentDf,
  intent: any,
  response: string,
  userSaysType?: string,
): Promise<any> {
  response = String(removeFormatting(response));
  const isPayload = userSaysType === 'payloads';
  const isChatfuel = userSaysType === 'chatfuelblock';
  const isManychat = userSaysType === 'manychatflow';

  if ((isChatfuel || isPayload || isManychat) && response.length > 6 && response.substring(0, 3) === '```' && response.substring(response.length - 3) === '```') {
    response = response.substring(3, response.length - 3);
  }

  const messages = intent.responses[0].messages ?? [];
  if (isPayload || isChatfuel || isManychat) {
    let parsed: any;
    try {
      parsed = JSON.parse(response);
    } catch {
      parsed = null;
    }
    for (let r = 0; r < messages.length; r++) {
      const m = messages[r];
      if (!m?.payload) continue;
      const match =
        (isPayload && JSON.stringify(m.payload) === JSON.stringify(parsed)) ||
        (isChatfuel && m.payload.redirect_to_blocks && JSON.stringify(m.payload.redirect_to_blocks) === JSON.stringify(parsed)) ||
        (isManychat && m.payload.flow && JSON.stringify(m.payload.flow) === JSON.stringify(parsed));
      if (match) {
        delete intent.responses[0].messages[r];
        break;
      }
    }
  } else {
    let i = -1;
    let msg: any;
    for (let k = 0; k < messages.length; k++) {
      if (messages[k]?.type === 0) {
        msg = messages[k];
        i = k;
        break;
      }
    }
    if (msg != null) {
      const speech = msg.speech;
      if (typeof speech === 'string' || speech instanceof String) {
        if (String(speech).toLowerCase().trim() === response.toLowerCase().trim()) {
          delete intent.responses[0].messages[i].speech;
        }
      } else if (speech) {
        const responseArr: string[] = [];
        for (const s0 of speech) {
          if (s0 === '' || s0 === null) break;
          const s = String(removeFormatting(s0));
          if (s.toLowerCase().trim() !== response.toLowerCase().trim()) responseArr.push(s);
        }
        intent.responses[0].messages[i].speech = responseArr;
      }
    }
  }
  return patchIntent(df, intent);
}

export async function removeQuickReply(df: AgentDf, intent: any, response: string): Promise<any> {
  response = String(removeFormatting(response));
  const messages = intent.responses[0].messages ?? [];
  const wanted = response.toLowerCase().trim();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.type === 2 && msg.replies) {
      msg.replies = msg.replies.filter((r: string) => r.toLowerCase().trim() !== wanted);
      intent.responses[0].messages[i] = msg;
      break;
    }
  }
  return patchIntent(df, intent);
}

/** modifyIntent — add an input training phrase and/or a response of the
 *  selected trainingType (chatfuel / manychat / payload / quickreply / text),
 *  or attach affectedContexts when the call is only wiring follow-ups. */
export async function modifyIntent(
  df: AgentDf,
  intent: any,
  opts: {
    input?: string | null;
    reply?: string | null;
    trainingType?: string;
    affectedContexts?: { name: string; parameters?: any; lifespan?: number }[];
  },
): Promise<any> {
  const { trainingType } = opts;
  const affectedContexts = opts.affectedContexts ?? [];
  const reply = (opts.reply ? removeFormatting(opts.reply) : opts.reply) as string | null | undefined;
  const input = (opts.input ? removeFormatting(opts.input) : opts.input) as string | null | undefined;

  if (input) {
    if (intent.userSays == null) intent.userSays = [];
    intent.userSays.push({ data: [{ text: input }] });
  }
  if (intent.responses[0].messages == null) {
    intent.responses[0].messages = [{ type: 0, speech: [] }];
  } else if (intent.responses[0].messages[0] == null) {
    intent.responses[0].messages[0] = { type: 0, speech: [] };
  }

  const messages = intent.responses[0].messages;

  if (affectedContexts.length > 0) {
    if (intent.responses[0].affectedContexts == null) {
      intent.responses[0].affectedContexts = affectedContexts;
    } else {
      for (const ctx of affectedContexts) {
        const exists = intent.responses[0].affectedContexts.some(
          (c: any) => JSON.stringify(c) === JSON.stringify(ctx),
        );
        if (!exists) intent.responses[0].affectedContexts.push(ctx);
      }
    }
  } else if (trainingType === 'chatfuel') {
    const blocks = String(reply ?? '')
      .split(',')
      .map((s) => s.trim());
    const msg = { type: 4, payload: { redirect_to_blocks: blocks } };
    let existingRedirects = false;
    for (const usermsg of messages) {
      if (usermsg?.type === 4) {
        const keys = Object.keys(usermsg.payload ?? {});
        if (keys.length === 1 && keys[0] === 'redirect_to_blocks') {
          usermsg.payload.redirect_to_blocks = usermsg.payload.redirect_to_blocks.concat(blocks);
          existingRedirects = true;
          break;
        }
      }
    }
    if (!existingRedirects) messages.push(msg);
  } else if (trainingType === 'manychat') {
    const msg = { type: 4, payload: { flow: reply } };
    let existingRedirects = false;
    for (const usermsg of messages) {
      if (usermsg?.type === 4) {
        const keys = Object.keys(usermsg.payload ?? {});
        if (keys.length === 1 && keys[0] === 'flow') {
          usermsg.payload.flow = reply;
          existingRedirects = true;
          break;
        }
      }
    }
    if (!existingRedirects) messages.push(msg);
  } else if (trainingType === 'payload' && isJson(reply)) {
    messages.push({ type: 4, payload: JSON.parse(String(reply)) });
  } else if (trainingType === 'quickreply') {
    let i = -1;
    let msg: any;
    for (let k = 0; k < messages.length; k++) {
      if (messages[k]?.type === 2) {
        msg = messages[k];
        i = k;
        break;
      }
    }
    if (i === -1) {
      i = messages.length;
      msg = { type: 2, platform: 'facebook', title: '' };
    }
    if (msg.replies == null) msg.replies = [];
    if (msg.replies.length < 5) msg.replies.push(reply);
    intent.responses[0].messages[i] = msg;
  } else {
    let i = -1;
    let msg: any;
    for (let k = 0; k < messages.length; k++) {
      if (messages[k]?.type === 0) {
        msg = messages[k];
        i = k;
        break;
      }
    }
    if (i === -1) {
      i = messages.length;
      msg = { type: 0, speech: [] };
    }
    if (typeof msg.speech === 'string' || msg.speech instanceof String) {
      msg.speech = [msg.speech];
    }
    if (msg.speech == null) msg.speech = [];
    if (reply) msg.speech.push(reply);
    intent.responses[0].messages[i] = msg;
  }

  return patchIntent(df, intent);
}

function isJson(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/** trainApiAi — create a new intent from a typed name; falls back to
 *  findIntentAndModify when the name collides (409/400), same as legacy. */
export async function trainApiAi(
  df: AgentDf,
  opts: {
    input: string;
    userSays?: string;
    reply?: string | null;
    trainingType?: string;
    clientKey: string;
    isOneclick?: boolean;
  },
): Promise<any> {
  let name = opts.input;
  let contexts: string[] = [];
  if (opts.isOneclick) {
    name = `${opts.clientKey} ${opts.input}`;
    contexts = [opts.clientKey];
  }
  const intent: any = {
    name,
    contexts,
    userSays: [{ data: opts.userSays ? [{ text: opts.userSays }] : [], isTemplate: false, count: 0 }],
    responses: [{ messages: [] }],
  };
  if (opts.reply) {
    intent.responses[0].messages = [{ type: 0, speech: opts.reply }];
  }
  try {
    const created = await createIntentV2(df.project, v1DocToV2(df.project, intent), df.sa);
    return v2IntentToV1Doc(String(created.name ?? '').split('/intents/').pop() ?? '', created);
  } catch (err: any) {
    if (err?.statusCode === 409 || err?.statusCode === 400) {
      return findIntentAndModify(df, opts.input, opts.reply ?? null, opts.trainingType, opts.clientKey);
    }
    throw err;
  }
}

async function findIntentAndModify(
  df: AgentDf,
  input: string,
  reply: string | null,
  trainingType: string | undefined,
  clientKey: string,
): Promise<any> {
  const all = await listIntentsV2(df.project, df.sa);
  for (const i of all) {
    if (i.displayName === input || i.displayName === `${clientKey} ${input}`) {
      const intentId = String(i.name ?? '').split('/intents/').pop() ?? '';
      const intent = await findIntent(df, intentId, { withFollowups: false });
      if (!intent) return null;
      return modifyIntent(df, intent, { input, reply, trainingType });
    }
  }
  return null;
}

/** addFollowUpIntent — attach a `{name}-followup` output context to the parent
 *  (lifespan 2, verbatim) then create the child intent from the template. */
export async function addFollowUpIntent(df: AgentDf, intentId: string, type: string, clientKey: string): Promise<any> {
  const parent = await findIntent(df, intentId, { withFollowups: false });
  if (!parent) throw new Error('no intent');
  const contextName = `${parent.name}-followup`
    .replace(`${clientKey} `, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '');
  const modified = await modifyIntent(df, parent, {
    affectedContexts: [{ name: contextName, parameters: {}, lifespan: 2 }],
  });
  return createFollowUp(df, modified, contextName, type, 0, clientKey);
}

async function createFollowUp(
  df: AgentDf,
  parentIntent: any,
  contextName: string,
  type: string,
  index: number,
  clientKey: string,
): Promise<any> {
  const suffix = index > 0 ? `-${index}` : '';
  const template = JSON.parse(JSON.stringify(followupTemplates[type] ?? followupTemplates.custom));
  template.name = `${String(parentIntent.name).replace(`${clientKey} `, '')} - ${type}${suffix}`;
  template.contexts = [contextName];
  template.parentId = parentIntent.id;
  template.rootParentId = parentIntent.rootParentId ?? parentIntent.id;
  try {
    const body = v1DocToV2(df.project, template);
    body.parentFollowupIntentName = parentIntent.resourceName;
    body.followupIntentInfo = [{ followupIntentName: parentIntent.resourceName }];
    if (parentIntent.rootParentId) {
      body.rootFollowupIntentName = `projects/${df.project}/agent/intents/${parentIntent.rootParentId}`;
    }
    const created = await createIntentV2(df.project, body, df.sa);
    return v2IntentToV1Doc(String(created.name ?? '').split('/intents/').pop() ?? '', created);
  } catch (err: any) {
    if (err?.statusCode === 409 || err?.statusCode === 400) {
      return createFollowUp(df, parentIntent, contextName, type, index + 1, clientKey);
    }
    throw err;
  }
}

/** findApiAiResponse — detectIntent on the customer agent with the janis
 *  context pinned (lifespan 1), sessionId = Slack channel id. */
export async function findApiAiResponse(
  df: AgentDf,
  sessionId: string,
  options: { userSays?: string; contexts?: { name: string; lifespan?: number; parameters?: any }[]; lang?: string },
): Promise<any> {
  const contexts = [...(options.contexts ?? [])];
  if (!contexts.some((c) => c.name === 'janis')) {
    contexts.push({ name: 'janis', lifespan: 1 });
  }
  return detectIntentV1(df.project, sessionId, {
    text: String(removeFormatting(options.userSays ?? '')),
    contexts: contexts as any,
    lang: options.lang,
  }, df.sa);
}
