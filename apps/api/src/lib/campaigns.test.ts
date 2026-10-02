import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  campaignSends,
  campaigns,
  channels,
  contactIdentities,
  contacts,
  conversations,
  jobs,
  messages,
  workspaces,
} from '../db/schema.js';
import { dispatchCampaign, dispatchCampaignStep, resolveSegment } from './campaigns.js';

let db: Db;
let workspaceId: string;
let channelId: string;
let agentId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'W' }).returning();
  workspaceId = ws.id;
  const [agent] = await db.insert(agents).values({ workspaceId, name: 'bot' }).returning();
  agentId = agent.id;
  const [ch] = await db
    .insert(channels)
    .values({ workspaceId, agentId, kind: 'sms', name: 'SMS', credentials: {} })
    .returning();
  channelId = ch.id;
});

async function mkContact(row: Partial<typeof contacts.$inferInsert> & { email?: string | null }) {
  const [c] = await db.insert(contacts).values({ workspaceId, ...row }).returning();
  await db.insert(contactIdentities).values({
    contactId: c.id,
    channelId,
    platformUserId: row.email ?? c.id,
  });
  return c;
}

describe('campaign segments', () => {
  it('filters by has_email / has_phone / active window / never_replied', async () => {
    const reachable = await mkContact({ name: 'Reach', email: 'r@x.com', phone: '+1' });
    const noEmail = await mkContact({ name: 'NoEmail', phone: '+2' });
    const altOnly = await mkContact({ name: 'AltOnly', altEmails: ['alt@x.com'], phone: '+3' });
    const quiet = await mkContact({ name: 'Quiet', email: 'q@x.com' });

    // Reachable is recently active; quiet has an old conversation only.
    const [cv] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'sms:r', contactId: reachable.id, lastMessageAt: new Date() })
      .returning();
    await db.insert(messages).values({ conversationId: cv.id, direction: 'in', text: 'hi' });
    const [old] = await db
      .insert(conversations)
      .values({
        agentId,
        externalId: 'sms:q',
        contactId: quiet.id,
        lastMessageAt: new Date(Date.now() - 90 * 86_400_000),
      })
      .returning();
    await db.insert(messages).values({ conversationId: old.id, direction: 'out', text: 'blast' });

    const base = { workspaceId, channelId };
    // SMS channel → recipients need a phone. quiet has email only → unreachable.
    expect(
      (await resolveSegment(db, { ...base, segment: { has_email: true } })).recipients
        .map((r) => r.contactId).sort(),
    ).toEqual([reachable.id, altOnly.id].sort());
    expect(
      (await resolveSegment(db, { ...base, segment: { active_within_days: 30 } })).recipients
        .map((r) => r.contactId),
    ).toEqual([reachable.id]);
    const nr = await resolveSegment(db, { ...base, segment: { never_replied: true } });
    expect(nr.recipients.map((r) => r.contactId).sort()).toEqual([noEmail.id, altOnly.id].sort());
    // quiet matches the filter but has no phone → counted unreachable.
    expect(nr.unreachable).toBe(1);
  });

  it('targets the contact\'s email on email channels and honors list_id/tags', async () => {
    const [emailCh] = await db
      .insert(channels)
      .values({ workspaceId, agentId, kind: 'email', name: 'E', credentials: {} })
      .returning();
    const tagged = await mkContact({ name: 'Vip', email: 'vip@x.com', tags: ['vip'] });
    const listed = await mkContact({ name: 'Listy', email: 'listy@x.com' });
    const { contactLists, contactListMembers } = await import('../db/schema.js');
    const [list] = await db
      .insert(contactLists)
      .values({ workspaceId, name: 'import-1' })
      .returning();
    await db.insert(contactListMembers).values({ listId: list.id, contactId: listed.id });

    const byTag = await resolveSegment(db, {
      workspaceId, channelId: emailCh.id, segment: { tags: ['vip'] },
    });
    expect(byTag.recipients.map((r) => r.contactId)).toEqual([tagged.id]);
    expect(byTag.recipients[0].platformUserId).toBe('vip@x.com');

    const byList = await resolveSegment(db, {
      workspaceId, channelId: emailCh.id, segment: { list_id: list.id },
    });
    expect(byList.recipients.map((r) => r.contactId)).toEqual([listed.id]);
    expect(byList.recipients[0].platformUserId).toBe('listy@x.com');
  });

  it('a smart list in list_id expands its rules — no member rows needed', async () => {
    const [emailCh] = await db
      .insert(channels)
      .values({ workspaceId, agentId, kind: 'email', name: 'E2', credentials: {} })
      .returning();
    const { contactLists } = await import('../db/schema.js');
    const [smart] = await db
      .insert(contactLists)
      .values({ workspaceId, name: 'smart-vip', filter: { tags: ['smartvip'] } })
      .returning();
    const hit = await mkContact({ name: 'SmartHit', email: 'sh@x.com', tags: ['smartvip'] });
    await mkContact({ name: 'Miss', email: 'miss@x.com' });

    const r = await resolveSegment(db, {
      workspaceId, channelId: emailCh.id, segment: { list_id: smart.id },
    });
    expect(r.recipients.map((x) => x.contactId)).toEqual([hit.id]);

    // Self-updating: a contact created after the list still resolves.
    const later = await mkContact({ name: 'Late', email: 'late@x.com', tags: ['smartvip'] });
    const again = await resolveSegment(db, {
      workspaceId, channelId: emailCh.id, segment: { list_id: smart.id },
    });
    expect(again.recipients.map((x) => x.contactId).sort())
      .toEqual([hit.id, later.id].sort());
  });

  it('channel_id filters contacts by identity', async () => {
    const [otherCh] = await db
      .insert(channels)
      .values({ workspaceId, agentId, kind: 'webchat', name: 'W', credentials: {} })
      .returning();
    const onOther = await mkContact({ name: 'OtherCh', phone: '+1777' });
    await db.insert(contactIdentities).values({
      contactId: onOther.id, channelId: otherCh.id, platformUserId: 'wc:1',
    });
    const r = await resolveSegment(db, {
      workspaceId, channelId, segment: { channel_id: otherCh.id },
    });
    expect(r.recipients.map((x) => x.contactId)).toEqual([onOther.id]);
  });

  it('flags opted-out identities on the target channel', async () => {
    const c = await mkContact({ name: 'Stopper', phone: '+1999' });
    // Rebind the helper's identity to the phone — that address is what
    // resolveSegment will try to send to.
    await db.delete(contactIdentities).where(eq(contactIdentities.contactId, c.id));
    await db.insert(contactIdentities).values({
      contactId: c.id,
      channelId,
      platformUserId: '+1999',
    });
    await db
      .update(contactIdentities)
      .set({ optedOutAt: new Date() })
      .where(
        and(
          eq(contactIdentities.channelId, channelId),
          eq(contactIdentities.platformUserId, '+1999'),
        ),
      );
    const r = await resolveSegment(db, { workspaceId, channelId, segment: { q: 'stopper' } });
    expect(r.recipients).toEqual([
      { contactId: c.id, platformUserId: '+1999', opted: true },
    ]);
  });
});

describe('campaign dispatch', () => {
  it('is idempotent — re-dispatch resumes instead of doubling sends', async () => {
    const [campaign] = await db
      .insert(campaigns)
      .values({ workspaceId, channelId, name: 'C', text: 'hey', status: 'sending' })
      .returning();
    await dispatchCampaign(db, campaign.id);
    const first = await db
      .select()
      .from(campaignSends)
      .where(eq(campaignSends.campaignId, campaign.id));
    const n1 = first.length;
    expect(n1).toBeGreaterThan(0);
    // Simulate the mid-dispatch crash: wipe half the sends + their jobs.
    for (const s of first.slice(0, Math.floor(n1 / 2))) {
      await db.delete(campaignSends).where(eq(campaignSends.id, s.id));
    }
    await db.delete(jobs).where(eq(jobs.type, 'outbound.send'));
    await dispatchCampaign(db, campaign.id);
    const second = await db
      .select()
      .from(campaignSends)
      .where(eq(campaignSends.campaignId, campaign.id));
    expect(second.length).toBe(n1); // back to full coverage, no dupes
    const uniq = new Set(second.map((s) => s.recipient));
    expect(uniq.size).toBe(second.length);
  });

  it('drip step reaches only prior-step sent + unreplied', async () => {
    const [campaign] = await db
      .insert(campaigns)
      .values({
        workspaceId,
        channelId,
        name: 'Drip',
        text: 'first',
        status: 'sending',
        steps: [{ delay_minutes: 60, text: 'follow-up' }],
      })
      .returning();
    await dispatchCampaign(db, campaign.id);
    const stepJob = await db
      .select()
      .from(jobs)
      .where(eq(jobs.type, 'campaign.step'));
    expect(stepJob.length).toBe(1); // step 1 scheduled after base dispatch

    const sends = await db
      .select()
      .from(campaignSends)
      .where(and(eq(campaignSends.campaignId, campaign.id), eq(campaignSends.stepIndex, 0)));
    // Mark: one replied, one failed, the rest sent 2h ago (past the 60m
    // step delay — eligibility is per-recipient sentAt, not dispatch time).
    const past = new Date(Date.now() - 2 * 3_600_000);
    await db
      .update(campaignSends)
      .set({ status: 'sent', sentAt: past, repliedAt: new Date() })
      .where(eq(campaignSends.id, sends[0].id));
    await db
      .update(campaignSends)
      .set({ status: 'failed' })
      .where(eq(campaignSends.id, sends[1].id));
    await db
      .update(campaignSends)
      .set({ status: 'sent', sentAt: past })
      .where(inArray(campaignSends.id, sends.slice(2).map((s) => s.id)));
    const eligible = sends.length - 2; // minus replied + failed

    await dispatchCampaignStep(db, campaign.id, 1);
    const stepSends = await db
      .select()
      .from(campaignSends)
      .where(and(eq(campaignSends.campaignId, campaign.id), eq(campaignSends.stepIndex, 1)));
    expect(stepSends.length).toBe(eligible);
    // Step 1 is the last defined step — nothing further queued.
    const after = await db.select().from(jobs).where(eq(jobs.type, 'campaign.step'));
    expect(after.filter((j) => (j.payload as { stepIndex?: number }).stepIndex === 2).length).toBe(0);
    // Re-running the step is a no-op (unique key).
    await dispatchCampaignStep(db, campaign.id, 1);
    const again = await db
      .select()
      .from(campaignSends)
      .where(and(eq(campaignSends.campaignId, campaign.id), eq(campaignSends.stepIndex, 1)));
    expect(again.length).toBe(eligible);
  });

  it('branch conditions select prior-step recipients by outcome', async () => {
    const past = new Date(Date.now() - 2 * 3_600_000);
    const mk = async (condition: string) => {
      const [campaign] = await db
        .insert(campaigns)
        .values({
          workspaceId,
          channelId,
          name: `B-${condition}`,
          text: 'first',
          status: 'sending',
          steps: [{ delay_minutes: 60, text: 'follow', condition }],
        })
        .returning();
      await dispatchCampaign(db, campaign.id);
      const sends = await db
        .select()
        .from(campaignSends)
        .where(and(eq(campaignSends.campaignId, campaign.id), eq(campaignSends.stepIndex, 0)));
      // Outcomes: [replied], [converted], [plain sent]
      await db
        .update(campaignSends)
        .set({ status: 'sent', sentAt: past, repliedAt: new Date() })
        .where(eq(campaignSends.id, sends[0].id));
      await db
        .update(campaignSends)
        .set({ status: 'sent', sentAt: past, convertedAt: new Date() })
        .where(eq(campaignSends.id, sends[1].id));
      await db
        .update(campaignSends)
        .set({ status: 'sent', sentAt: past })
        .where(eq(campaignSends.id, sends[2].id));
      return campaign.id;
    };
    const stepCount = async (campaignId: string) => {
      await dispatchCampaignStep(db, campaignId, 1);
      return (
        await db
          .select()
          .from(campaignSends)
          .where(and(eq(campaignSends.campaignId, campaignId), eq(campaignSends.stepIndex, 1)))
      ).length;
    };
    expect(await stepCount(await mk('if_replied'))).toBe(1); // only the replayer
    expect(await stepCount(await mk('if_converted'))).toBe(1); // only the converter
    expect(await stepCount(await mk('if_not_converted'))).toBe(2); // replied + plain
    expect(await stepCount(await mk('if_not_replied'))).toBe(2); // converted + plain
    expect(await stepCount(await mk('always'))).toBe(3); // all sent rows
  });
});

describe('campaign agent context', () => {
  it('returns campaign name + instructions for a campaign-originated conversation', async () => {
    const { campaignContextFor } = await import('./campaigns.js');
    const [campaign] = await db
      .insert(campaigns)
      .values({
        workspaceId,
        channelId,
        name: 'Win-back',
        text: 'hey',
        status: 'sending',
        agentInstructions: 'Offer 20% off if asked.',
      })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'sms:ctx' })
      .returning();
    await db.insert(campaignSends).values({
      campaignId: campaign.id,
      workspaceId,
      channelId,
      recipient: '+1555',
      conversationId: conv.id,
    });

    const ctx = await campaignContextFor(db, conv.id);
    expect(ctx).toContain('Win-back');
    expect(ctx).toContain('Offer 20% off if asked.');
    // An unlinked conversation gets nothing.
    const [plain] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'sms:plain' })
      .returning();
    expect(await campaignContextFor(db, plain.id)).toBeNull();
    // A linked campaign with no instructions still names the campaign.
    const [noInstr] = await db
      .insert(campaigns)
      .values({ workspaceId, channelId, name: 'Plain', text: 'x', status: 'sending' })
      .returning();
    const [conv2] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'sms:ctx2' })
      .returning();
    await db.insert(campaignSends).values({
      campaignId: noInstr.id,
      workspaceId,
      channelId,
      recipient: '+1556',
      conversationId: conv2.id,
    });
    const ctx2 = await campaignContextFor(db, conv2.id);
    expect(ctx2).toContain('Plain');
    expect(ctx2).not.toContain('Campaign instructions');
  });
});

describe('enrollment', () => {
  it('enrolls a contact event-driven and honors opt-out', async () => {
    const { enrollContactInCampaign } = await import('./campaigns.js');
    const [campaign] = await db
      .insert(campaigns)
      .values({ workspaceId, channelId, name: 'Abandon', text: 'finish?', status: 'sending' })
      .returning();
    const contact = await mkContact({ name: 'Enrollee', phone: '+1777' });
    const r = await enrollContactInCampaign(db, campaign, contact);
    expect(r).toBe('queued');
    // Duplicate enrollment is a no-op.
    expect(await enrollContactInCampaign(db, campaign, contact)).toBe('duplicate');
    // Opted-out → recorded as skipped, not sent.
    const opted = await mkContact({ name: 'Opted', phone: '+1888' });
    await db.delete(contactIdentities).where(eq(contactIdentities.contactId, opted.id));
    await db.insert(contactIdentities).values({
      contactId: opted.id, channelId, platformUserId: '+1888', optedOutAt: new Date(),
    });
    expect(await enrollContactInCampaign(db, campaign, opted)).toBe('skipped_opted_out');
    // No usable address for this channel.
    const noAddr = await mkContact({ name: 'EmailOnly', email: 'only@x.com' });
    expect(await enrollContactInCampaign(db, campaign, noAddr)).toBe('unreachable');
  });

  it('continuous campaigns keep enrolling new matches and stay sending', async () => {
    const { sweepCampaigns } = await import('./campaigns.js');
    const [campaign] = await db
      .insert(campaigns)
      .values({
        workspaceId, channelId, name: 'Cont', text: 'hi', status: 'sending',
        enrollment: 'continuous', segment: { tags: ['winback'] },
      })
      .returning();
    await db.update(campaignSends).set({ status: 'sent' }).where(
      eq(campaignSends.campaignId, campaign.id),
    );
    await sweepCampaigns(db);
    let [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(c.status).toBe('sending'); // continuous never done
    // New qualifying contact enrolled on the next sweep.
    const [con] = await db
      .insert(contacts)
      .values({ workspaceId, name: 'Late', phone: '+1444', tags: ['winback'] })
      .returning();
    await sweepCampaigns(db);
    const sends = await db
      .select()
      .from(campaignSends)
      .where(eq(campaignSends.campaignId, campaign.id));
    expect(sends.map((s) => s.contactId)).toContain(con.id);
  });

  it('a drip stays sending while its next-step job is queued', async () => {
    const { sweepCampaigns } = await import('./campaigns.js');
    const [campaign] = await db
      .insert(campaigns)
      .values({
        workspaceId, channelId, name: 'DripSweep', text: 'hi', status: 'sending',
        steps: [{ delay_minutes: 60, text: 'follow-up' }],
      })
      .returning();
    await dispatchCampaign(db, campaign.id);
    // Step-0 sends complete (past the 60m step delay); the step-1 job is
    // still queued for later. The campaign must NOT close — the step job
    // would fire into 'done' and die.
    await db
      .update(campaignSends)
      .set({ status: 'sent', sentAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(campaignSends.campaignId, campaign.id));
    await sweepCampaigns(db);
    let [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(c.status).toBe('sending');
    // Losing the step job mid-flight (deploy drain, crash window) must not
    // strand the drip: the sweeper re-arms it while stragglers remain —
    // the sends above have no step-1 rows yet, so they ARE stragglers.
    await db
      .update(jobs)
      .set({ status: 'done' })
      .where(eq(jobs.type, 'campaign.step'));
    await sweepCampaigns(db);
    const rearmed = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, 'campaign.step'), eq(jobs.status, 'pending')));
    expect(rearmed.length).toBe(1);
    [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(c.status).toBe('sending');
    // Dispatch the step — now every prior send has a step-1 row, so the
    // chain has no queued work left and the campaign closes.
    await dispatchCampaignStep(db, campaign.id, 1);
    await db
      .update(campaignSends)
      .set({ status: 'sent', sentAt: new Date() })
      .where(and(eq(campaignSends.campaignId, campaign.id), eq(campaignSends.stepIndex, 1)));
    await db
      .update(jobs)
      .set({ status: 'done' })
      .where(eq(jobs.type, 'campaign.step'));
    await sweepCampaigns(db);
    [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(c.status).toBe('done');
  });
});
