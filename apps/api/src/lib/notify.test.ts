import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agentMembers,
  agents,
  memberships,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { alertNotification, eventForAlertType, notifyWorkspace, resolveNotifyRecipients } from './notify.js';
import { env } from '../env.js';

let db: Db;
let ws: typeof workspaces.$inferSelect;
let agent: typeof agents.$inferSelect;
let muted: typeof users.$inferSelect; // muted 'sentiment' globally
let plain: typeof users.$inferSelect; // defaults — everything on
let overridden: typeof users.$inferSelect; // agent override flips prefs

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  [agent] = await db.insert(agents).values({ workspaceId: ws.id, name: 'Bot' }).returning();

  [muted] = await db
    .insert(users)
    .values({
      email: 'muted@x.c',
      name: 'M',
      notifyPrefs: { push: true, email: true, events: { sentiment: false, digest: false } },
    })
    .returning();
  [plain] = await db
    .insert(users)
    .values({ email: 'plain@x.c', name: 'P', notifyPrefs: { push: true, email: true } })
    .returning();
  [overridden] = await db
    .insert(users)
    .values({
      email: 'over@x.c',
      name: 'O',
      notifyPrefs: { push: true, email: true, events: { keyword: false } },
    })
    .returning();
  for (const u of [muted, plain, overridden]) {
    await db.insert(memberships).values({
      userId: u.id,
      workspaceId: ws.id,
      role: 'member',
      acceptedAt: new Date(),
    });
  }
  // overridden: keyword muted globally, force-ON for this agent; sentiment
  // (globally on) muted for this agent only.
  await db.insert(agentMembers).values({
    agentId: agent.id,
    userId: overridden.id,
    acceptedAt: new Date(),
    notifyPrefs: { events: { keyword: true, sentiment: false } },
  });
});

describe('eventForAlertType', () => {
  it('maps every alert type to its own pref bucket', () => {
    expect(eventForAlertType('help_request')).toBe('handoff');
    expect(eventForAlertType('handoff_offer')).toBe('offer');
    expect(eventForAlertType('sentiment')).toBe('sentiment');
    expect(eventForAlertType('intent')).toBe('intent');
    expect(eventForAlertType('inactivity')).toBe('inactivity');
    expect(eventForAlertType('sla')).toBe('sla');
    expect(eventForAlertType('csat')).toBe('csat');
    expect(eventForAlertType('custom')).toBe('custom');
    expect(eventForAlertType('failure')).toBe('failure');
    expect(eventForAlertType('approval_request')).toBe('approval');
    expect(eventForAlertType('error')).toBe('ops');
    expect(eventForAlertType('keyword')).toBe('keyword');
  });
});

describe('resolveNotifyRecipients', () => {
  const ids = (rs: { recipients: { id: string }[] }) => rs.recipients.map((r) => r.id).sort();

  it('broadcast respects a per-event global mute', async () => {
    const r = await resolveNotifyRecipients(db, ws.id, { agentId: agent.id, event: 'sentiment' });
    expect(r.event).toBe('sentiment');
    expect(ids(r)).toEqual([plain.id]); // global mute + agent-override mute both out
    const k = await resolveNotifyRecipients(db, ws.id, { agentId: agent.id, event: 'keyword' });
    expect(ids(k)).toEqual([muted.id, overridden.id, plain.id].sort()); // override re-enables
  });

  it('a targeted page checks the assigned bucket, not the alert kind', async () => {
    const r = await resolveNotifyRecipients(db, ws.id, {
      agentId: agent.id,
      userIds: [muted.id],
      event: 'sentiment',
    });
    expect(r.event).toBe('assigned');
    expect(ids(r)).toEqual([muted.id]); // sentiment mute doesn't silence a routed page
  });

  it('targeted page still honors an assigned mute', async () => {
    await db
      .update(users)
      .set({ notifyPrefs: { push: true, email: true, events: { assigned: false } } })
      .where(eq(users.id, muted.id));
    const r = await resolveNotifyRecipients(db, ws.id, {
      agentId: agent.id,
      userIds: [muted.id],
      event: 'sentiment',
    });
    expect(r.recipients).toHaveLength(0);
    await db
      .update(users)
      .set({ notifyPrefs: { push: true, email: true, events: { sentiment: false, digest: false } } })
      .where(eq(users.id, muted.id));
  });

  it('merged prefs keep unrelated global mutes under an agent override', async () => {
    const r = await resolveNotifyRecipients(db, ws.id, { agentId: agent.id, event: 'digest' });
    expect(r.prefs(muted.id).events?.digest).toBe(false);
    expect(r.prefs(overridden.id).events?.keyword).toBe(true);
    expect(r.prefs(overridden.id).events?.sentiment).toBe(false);
  });
});

describe('notifyWorkspace email gate', () => {
  it('emails only members who have logged in (a session row exists)', async () => {
    const calls: { to: string[] }[] = [];
    const origFetch = globalThis.fetch;
    const resend = { key: env.resendApiKey, from: env.emailFrom, origin: env.webOrigin };
    env.resendApiKey = 're_test';
    env.emailFrom = 'alerts@test.dev';
    env.webOrigin = 'https://app.test';
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('api.resend.com/emails')) {
        calls.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
      }
      return origFetch(url as never, init);
    }) as typeof fetch;
    try {
      const [ws2] = await db.insert(workspaces).values({ name: 'Gate' }).returning();
      const [ghost] = await db
        .insert(users)
        .values({ email: 'ghost@x.c', name: 'G', notifyPrefs: { email: true } })
        .returning();
      const [real] = await db
        .insert(users)
        .values({ email: 'real@x.c', name: 'R', notifyPrefs: { email: true } })
        .returning();
      for (const u of [ghost, real]) {
        await db.insert(memberships).values({
          userId: u.id,
          workspaceId: ws2.id,
          role: 'member',
          acceptedAt: new Date(),
        });
      }
      await db
        .insert(sessions)
        .values({ id: 'sess-real', userId: real.id, expiresAt: new Date(Date.now() - 1000) });
      await notifyWorkspace(db, ws2.id, { title: 'T', body: 'B' }, { event: 'digest' });
      expect(calls).toHaveLength(1);
      expect(calls[0].to).toEqual(['real@x.c']);
    } finally {
      globalThis.fetch = origFetch;
      env.resendApiKey = resend.key;
      env.emailFrom = resend.from;
      env.webOrigin = resend.origin;
    }
  });
});

describe('alertNotification', () => {
  it('detexes math noise — push/email/Slack bodies cannot typeset', async () => {
    const n = await alertNotification(
      db,
      { type: 'help_request', detail: null },
      {
        id: '00000000-0000-0000-0000-000000000000',
        externalId: 'c-x',
        userProfile: { name: 'Kai', channel: 'webchat' },
      },
      agent,
      'aid reaches over $50% of families; tuition $\\$28,100$ and $x^2$',
    );
    expect(n.body).toBe('Kai on Bubble: aid reaches over 50% of families; tuition $28,100 and x²');
  });
});
