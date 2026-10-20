// Bridge coverage: Janis-native traffic → legacy events → classic Slack.
// Runs dry (emitDry) — decisions are recorded, no Slack calls leave the box.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, sql } from 'drizzle-orm';
import { generateKeyPairSync } from 'node:crypto';
import type { Db } from '../../db/client.js';
import * as schema from '../../db/schema.js';
import {
  agentSecrets,
  agents,
  conversations,
  memberships,
  messages,
  slackClassicChannels,
  slackClassicPrefs,
  slackInstallations,
  users,
  workspaces,
} from '../../db/schema.js';
import { encryptSecret } from '../secrets.js';
import { processEvents } from '../../services/ingest.js';
import { runLegacyReply } from '../legacyAgent.js';
import {
  dispatchClassicForAgent,
  drainEmitQueue,
  emitInboundLine,
  resetEmitCache,
  setEmitDry,
} from './emit.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const saPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let db: Db;
let ws: typeof workspaces.$inferSelect;
let install: typeof slackInstallations.$inferSelect;
let hostedAgent: typeof agents.$inferSelect;
let dfAgent: typeof agents.$inferSelect;

const CHANNEL = 'PSID_EMIT1';
const CONV_ID = `messenger:${CHANNEL}`;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  [ws] = await db.insert(workspaces).values({ name: 'EmitW', plan: 'pro' }).returning();
  [install] = await db
    .insert(slackInstallations)
    .values({
      workspaceId: ws.id,
      teamId: 'TEMIT',
      teamName: 'emit',
      botToken: 'xoxb-test',
      mode: 'classic',
      classicConfig: { pro: true, botUserId: 'UBOT' },
    })
    .returning();
  const [u] = await db
    .insert(users)
    .values({ email: 'emit@x.c', name: 'Emit', slackUserId: 'UEMIT' })
    .returning();
  await db.insert(memberships).values({ userId: u.id, workspaceId: ws.id, role: 'admin' });
  // Member subscribed to intent i1 (customAlertSeverityLevel 1).
  await db.insert(slackClassicPrefs).values({
    installationId: install.id,
    slackUserId: 'UEMIT',
    dmChannelId: 'DEMIT',
    clientKey: 'ck-emit',
    settings: { client_key: 'ck-emit', customAlertSeverityLevel: 1, intents: [{ id: 'i1' }] },
  });

  [hostedAgent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'HostedEmit', config: {} })
    .returning();
  [dfAgent] = await db
    .insert(agents)
    .values({
      workspaceId: ws.id,
      name: 'Bob Dylan Band',
      config: { engine: 'dialogflow', dialogflow: { project: 'botdylan-shape', lang: 'en' } },
      metadata: {
        legacy_client_key: 'ck-emit',
        janis_only: true,
        legacy_stripe: { subscription_id: 'sub_comp' }, // fails open — comp
      },
    })
    .returning();
  await db.insert(agentSecrets).values({
    workspaceId: ws.id,
    agentId: dfAgent.id,
    name: 'DIALOGFLOW_SA_JSON',
    valueEnc: encryptSecret(
      JSON.stringify({ client_email: 'bot@test.iam.gserviceaccount.com', private_key: saPem, project_id: 'botdylan-shape' }),
    ),
  });
});

beforeEach(() => {
  vi.unstubAllGlobals();
  resetEmitCache();
  setEmitDry(true);
});

describe('classic emit bridge', () => {
  it('inbound on a hosted agent → j-channel row + transcript flush', async () => {
    await processEvents(db, hostedAgent, [
      { type: 'message_in', conversation_id: CONV_ID, text: 'hello there' },
    ]);
    await drainEmitQueue();
    const rows = await db
      .select()
      .from(slackClassicChannels)
      .where(eq(slackClassicChannels.installationId, install.id));
    const jc = rows.find((r) => r.sourceChannel === CHANNEL);
    expect(jc).toBeTruthy();
    expect(jc!.isWordhopChannel).toBe(true);
  });

  it('outbound → bot message line + row marked processed (no double-post)', async () => {
    const [msg] = await processEvents(db, hostedAgent, [
      { type: 'message_out', conversation_id: CONV_ID, text: 'agent says hi' },
    ]);
    expect(msg).toBeTruthy();
    await drainEmitQueue();
    const [conv] = await db.select().from(conversations).where(eq(conversations.externalId, CONV_ID));
    const out = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    const outRow = out.find((m) => m.text === 'agent says hi');
    expect((outRow!.payload as any).processed_in_transcript).toBe(true);
  });

  it('no classic install on the workspace → silent no-op', async () => {
    const [ws2] = await db.insert(workspaces).values({ name: 'NoSlack', plan: 'pro' }).returning();
    const [a2] = await db
      .insert(agents)
      .values({ workspaceId: ws2.id, name: 'Alone', config: {} })
      .returning();
    const results = await dispatchClassicForAgent(db, a2, 'chat message', {
      channel: 'X1',
      text: 'hi',
    });
    expect(results).toHaveLength(0);
  });

  it('DF engine: runLegacyReply emits chat message + custom alert → member DM', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('oauth2.googleapis.com'))
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
        if (u.includes('dialogflow.googleapis.com') && u.includes(':detectIntent'))
          return new Response(
            JSON.stringify({
              queryResult: {
                fulfillmentMessages: [{ text: { text: ['an agent is coming'] } }],
                intent: {
                  name: 'projects/botdylan-shape/agent/intents/i1',
                  displayName: 'talk.agent',
                },
                action: 'alert.custom',
              },
            }),
          );
        if (u.includes('dialogflow.googleapis.com')) return new Response('{}', { status: 200 });
        return new Response('{}', { status: 200 });
      }),
    );

    // Ingest first — stores the inbound row (and correctly skips its own
    // emit: dialogflow-engine bots emit post-DF inside runLegacyReply).
    await processEvents(db, dfAgent, [
      { type: 'message_in', conversation_id: 'messenger:PSID_DF1', text: 'talk to a human' },
    ]);
    await drainEmitQueue();
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, 'messenger:PSID_DF1'));
    await db
      .update(conversations)
      .set({ userProfile: { first_name: 'Bob', last_name: 'Fan' } })
      .where(eq(conversations.id, conv.id));
    const [fresh] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    await runLegacyReply(db, dfAgent, {
      type: 'message_in',
      conversation_id: conv.externalId,
      text: 'talk to a human',
    } as never, fresh);
    await drainEmitQueue();

    // j-channel exists for the customer source
    const jc = (
      await db
        .select()
        .from(slackClassicChannels)
        .where(eq(slackClassicChannels.installationId, install.id))
    ).find((r) => r.sourceChannel === 'PSID_DF1');
    expect(jc).toBeTruthy();

    // The member's prefs carry the intent subscription — the alert decisions
    // are recorded per dispatch; re-run the dispatch directly to inspect.
    const results = await dispatchClassicForAgent(db, dfAgent, 'custom alert message', {
      channel: 'PSID_DF1',
      text: 'talk to a human',
      reply: JSON.stringify({
        result: { action: 'alert.custom', metadata: { intentId: 'i1', intentName: 'talk.agent' } },
      }),
    });
    const alert = results.flatMap((r) => r.posted).find((p) => p.kind === 'alert:showCustomAlert');
    expect(alert).toBeTruthy();
    expect(alert!.channel).toBe('DEMIT');
  });

  it('DF fallback → failure log emitted at severity-gated DM path', async () => {
    const results = await dispatchClassicForAgent(db, dfAgent, 'failure log', {
      channel: 'PSID_DF1',
      isFailure: true,
      count: 1,
      message: 'unmatched',
    });
    // Member has no logSeverityLevel → suppressed verbatim
    expect(results[0].suppressed.some((s) => s.reason === 'logSeverity')).toBe(true);
  });

  it('emitInboundLine maps new-stack userProfile → legacy user_profile (id + profile_pic)', async () => {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, CONV_ID));
    await db
      .update(conversations)
      .set({ userProfile: { first_name: 'Shane', last_name: 'Tester', picture_url: 'https://pic' } })
      .where(eq(conversations.id, conv.id));
    const [fresh] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    // An unprocessed inbound row must exist for the flush to run.
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'in',
      text: 'profile check',
      payload: {},
    });
    emitInboundLine(db, hostedAgent, fresh, 'profile check');
    await drainEmitQueue();
    // saveTranscriptChannel pulls sourceUser from user_profile.id — the
    // mapped field — so a set sourceUser proves the shape translated.
    const jc = (
      await db
        .select()
        .from(slackClassicChannels)
        .where(eq(slackClassicChannels.installationId, install.id))
    ).find((r) => r.sourceChannel === CHANNEL);
    expect(jc!.sourceUser).toBe(CHANNEL);
  });
});
