import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  campaignSends,
  campaigns,
  channels,
  jobs,
  suppressions,
  workspaces,
} from '../db/schema.js';
import {
  checkSendPolicy,
  normalizeAddress,
  quietHoursDeferUntil,
} from './sendPolicy.js';
import { runJobs } from './jobs.js';

let db: Db;
let workspaceId: string;
let channelId: string;
let campaignId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'W' }).returning();
  workspaceId = ws.id;
  const [agent] = await db.insert(agents).values({ workspaceId, name: 'bot' }).returning();
  const [ch] = await db
    .insert(channels)
    .values({ workspaceId, agentId: agent.id, kind: 'sms', name: 'SMS', credentials: {} })
    .returning();
  channelId = ch.id;
  const [camp] = await db
    .insert(campaigns)
    .values({ workspaceId, channelId, name: 'C', text: 'hi', status: 'sending' })
    .returning();
  campaignId = camp.id;
});

describe('quiet hours', () => {
  const p = { quiet_enabled: true, quiet_from: '21:00', quiet_to: '08:00', quiet_tz: 'UTC' };
  it('defers inside the window to its end', () => {
    const defer = quietHoursDeferUntil(p, new Date('2026-01-01T23:30:00Z'));
    expect(defer?.toISOString()).toBe('2026-01-02T08:00:00.000Z');
  });
  it('handles early-morning side of a wrap window', () => {
    const defer = quietHoursDeferUntil(p, new Date('2026-01-01T03:00:00Z'));
    expect(defer?.toISOString()).toBe('2026-01-01T08:00:00.000Z');
  });
  it('is null outside the window and when disabled', () => {
    expect(quietHoursDeferUntil(p, new Date('2026-01-01T12:00:00Z'))).toBeNull();
    expect(
      quietHoursDeferUntil({ ...p, quiet_enabled: false }, new Date('2026-01-01T23:30:00Z')),
    ).toBeNull();
  });
  it('bad tz fails open', () => {
    expect(
      quietHoursDeferUntil({ ...p, quiet_tz: 'Mars/Olympus' }, new Date('2026-01-01T23:30:00Z')),
    ).toBeNull();
  });
});

describe('address normalization', () => {
  it('lowercases email, strips phone punctuation', () => {
    expect(normalizeAddress('  Alice@X.COM ')).toBe('alice@x.com');
    expect(normalizeAddress('(415) 555-0100')).toBe('4155550100');
    expect(normalizeAddress('+1 415 555 0100')).toBe('+14155550100');
  });
});

describe('checkSendPolicy', () => {
  const pol = {};
  it('suppressed addresses are skipped, matching kind or all', async () => {
    await db.insert(suppressions).values({ workspaceId, address: 'dead@x.com', kind: 'all' });
    expect(
      await checkSendPolicy(db, {
        workspaceId, channelKind: 'email', recipient: 'Dead@X.com', policy: pol,
      }),
    ).toEqual({ ok: false, skip: 'suppressed' });
    // wrong-kind suppression doesn't block a phone send
    await db.insert(suppressions).values({ workspaceId, address: 'bounced@y.com', kind: 'phone' });
    expect(
      await checkSendPolicy(db, {
        workspaceId, channelKind: 'email', recipient: 'bounced@y.com', policy: pol,
      }),
    ).toEqual({ ok: true });
  });
  it('frequency cap skips at the rolling-24h limit', async () => {
    for (let i = 0; i < 2; i++) {
      await db.insert(campaignSends).values({
        campaignId, workspaceId, channelId,
        recipient: '+15550000001', status: 'sent', sentAt: new Date(), stepIndex: i,
      });
    }
    const capped = { max_per_recipient_per_day: 2 };
    expect(
      await checkSendPolicy(db, {
        workspaceId, channelKind: 'sms', recipient: '+15550000001', policy: capped,
      }),
    ).toEqual({ ok: false, skip: 'frequency_cap' });
    expect(
      await checkSendPolicy(db, {
        workspaceId, channelKind: 'sms', recipient: '+15550000002', policy: capped,
      }),
    ).toEqual({ ok: true });
  });
});

describe('send-time campaign state', () => {
  const mkSendJob = async (status: 'cancelled' | 'paused' | 'sending') => {
    const [camp] = await db
      .insert(campaigns)
      .values({ workspaceId, channelId, name: `C-${status}`, text: 'hi', status })
      .returning();
    const [send] = await db
      .insert(campaignSends)
      .values({
        campaignId: camp.id, workspaceId, channelId, recipient: '+15559999999',
      })
      .returning();
    await db.insert(jobs).values({
      workspaceId,
      type: 'outbound.send',
      payload: {
        channelId, to: '+15559999999', text: 'hi', campaignSendId: send.id,
      },
    });
    return { camp, send };
  };

  it('cancelled campaigns mark queued sends skipped_cancelled', async () => {
    const { send } = await mkSendJob('cancelled');
    await runJobs(db);
    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe('skipped_cancelled');
  });

  it('paused campaigns defer — send stays pending, job re-queues', async () => {
    const { send } = await mkSendJob('paused');
    await runJobs(db);
    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe('pending');
    const deferred = await db.select().from(jobs).where(eq(jobs.type, 'outbound.send'));
    expect(deferred.some((j) => j.status === 'pending' && j.runAt > new Date())).toBe(true);
  });
});
