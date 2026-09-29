import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  channels,
  contactIdentities,
  contacts,
  conversations,
  memberships,
  messages,
  sessions,
  users,
  workspaces,
  agents,
} from '../db/schema.js';
import { generateSessionToken, hashPassword, generateApiKey } from '../lib/crypto.js';
import { contactForBinding, linkConversationContact } from '../lib/contacts.js';
import { contactRoutes } from './contacts.js';

let db: Db;
let api: Hono;
let cookie: string;
let workspaceId: string;
let smsChId: string;
let emailChId: string;
let convA: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  api = new Hono().route('/api/contacts', contactRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'W', plan: 'pro' }).returning();
  workspaceId = ws.id;
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId, name: 'bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  const [smsCh] = await db
    .insert(channels)
    .values({ workspaceId, agentId: agent.id, kind: 'sms', name: 'SMS', credentials: {} })
    .returning();
  smsChId = smsCh.id;
  const [emCh] = await db
    .insert(channels)
    .values({ workspaceId, agentId: agent.id, kind: 'email', name: 'Mail', credentials: {} })
    .returning();
  emailChId = emCh.id;
  const [u] = await db
    .insert(users)
    .values({ email: 'a@a.a', name: 'Admin', passwordHash: await hashPassword('password123') })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: u.id, workspaceId, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, workspaceId, expiresAt: new Date(Date.now() + 86_400_000) });
  cookie = `janis_session=${token}`;
});

describe('contacts', () => {
  it('resolves an identity to a fresh contact', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: (await db.select().from(agents))[0].id, externalId: 'sms:+1555' })
      .returning();
    convA = conv.id;
    const contactId = await contactForBinding(db, {
      workspaceId,
      channelId: smsChId,
      platformUserId: '+1555',
      profile: { name: 'Sam', phone: '+1555' },
    });
    expect(contactId).toBeTruthy();
    await linkConversationContact(db, convA, contactId);
    const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId!));
    expect(c.phone).toBe('+1555');
    expect(c.name).toBe('Sam');
  });

  it('merges a second channel identity onto the same person via phone', async () => {
    // Same phone arrives over the email channel → same contact
    const contactId = await contactForBinding(db, {
      workspaceId,
      channelId: emailChId,
      platformUserId: 'sam@x.com',
      profile: { email: 'sam@x.com', phone: '+1555' },
    });
    const [first] = await db
      .select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(eq(contactIdentities.channelId, smsChId))
      .limit(1);
    expect(contactId).toBe(first.contactId);
  });

  it('different identity with no matchable fields gets its own contact', async () => {
    const id = await contactForBinding(db, {
      workspaceId,
      channelId: smsChId,
      platformUserId: '+1999',
      profile: { phone: '+1999' },
    });
    const all = await db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId));
    expect(all.length).toBe(2);
    expect(id).not.toBeNull();
  });

  it('lists contacts via the API', async () => {
    const res = await api.request('/api/contacts', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { contacts: list } = (await res.json()) as { contacts: { name: string }[] };
    expect(list.length).toBe(2);
  });

  it('detail returns identities, conversations, and duplicates', async () => {
    const res = await api.request('/api/contacts?q=Sam', { headers: { cookie } });
    const { contacts: list } = (await res.json()) as { contacts: { id: string }[] };
    const d = await api.request(`/api/contacts/${list[0].id}`, { headers: { cookie } });
    const body = (await d.json()) as {
      identities: unknown[];
      conversations: { id: string }[];
      possible_duplicates: unknown[];
    };
    expect(body.identities.length).toBe(2);
    expect(body.conversations[0].id).toBe(convA);
  });

  it('merge folds identities + conversations into the kept contact', async () => {
    const [other] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.workspaceId, workspaceId));
    // find the +1999 contact (second created)
    const [dupe] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.phone, '+1999'))
      .limit(1);
    const keep = await db
      .select()
      .from(contacts)
      .where(eq(contacts.phone, '+1555'))
      .limit(1);
    const res = await api.request(`/api/contacts/${keep[0].id}/merge`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ other_id: dupe.id }),
    });
    expect(res.status).toBe(200);
    const ids = await db
      .select()
      .from(contactIdentities)
      .where(eq(contactIdentities.contactId, keep[0].id));
    expect(ids.length).toBe(3);
    const gone = await db.select().from(contacts).where(eq(contacts.id, dupe.id));
    expect(gone.length).toBe(0);
  });

  it('possible_duplicates is empty for contacts with no match signals', async () => {
    // A Messenger-PSID-only contact has no email/phone/name to match on —
    // the dup query must return nobody, not the whole workspace.
    const [bare] = await db
      .insert(contacts)
      .values({ workspaceId, name: null })
      .returning();
    const res = await api.request(`/api/contacts/${bare.id}`, { headers: { cookie } });
    const body = (await res.json()) as { possible_duplicates: unknown[] };
    expect(body.possible_duplicates).toEqual([]);
  });

  it('possible_duplicates surfaces same-name contacts', async () => {
    // Backfill-era contacts often share a name but no identifiers — name
    // match is the suggestion channel that lets operators merge them.
    const [twin] = await db
      .insert(contacts)
      .values({ workspaceId, name: 'sam' }) // case-insensitive match on 'Sam'
      .returning();
    const res = await api.request(`/api/contacts?q=Sam`, { headers: { cookie } });
    const { contacts: list } = (await res.json()) as { contacts: { id: string; name: string }[] };
    const sam = list.find((c) => c.name === 'Sam');
    const d = await api.request(`/api/contacts/${sam!.id}`, { headers: { cookie } });
    const body = (await d.json()) as {
      possible_duplicates: { id: string; match: string }[];
    };
    const hit = body.possible_duplicates.find((p) => p.id === twin.id);
    expect(hit?.match).toBe('same name');
  });

  it('merge folds differing email into alt_emails and stays resolvable', async () => {
    // Two contacts for the same person with different emails — merging
    // keeps both addresses on the survivor.
    const [keep] = await db
      .insert(contacts)
      .values({ workspaceId, name: 'Pat', email: 'pat@work.com' })
      .returning();
    const [drop] = await db
      .insert(contacts)
      .values({ workspaceId, name: 'Pat', email: 'pat@home.com' })
      .returning();
    const res = await api.request(`/api/contacts/${keep.id}/merge`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ other_id: drop.id }),
    });
    expect(res.status).toBe(200);
    const [merged] = await db.select().from(contacts).where(eq(contacts.id, keep.id));
    expect(merged.email).toBe('pat@work.com');
    expect(merged.altEmails).toEqual(['pat@home.com']);
    // A new identity arriving from the merged-away address resolves to the
    // survivor — not a fresh duplicate contact.
    const cid = await contactForBinding(db, {
      workspaceId,
      channelId: emailChId,
      platformUserId: 'pat@home.com',
      profile: { email: 'pat@home.com' },
    });
    expect(cid).toBe(keep.id);
  });

  it('export returns the full data bundle', async () => {
    const [c] = await db.select().from(contacts).where(eq(contacts.phone, '+1555')).limit(1);
    const res = await api.request(`/api/contacts/${c.id}/export`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contact: { id: string };
      identities: unknown[];
      conversations: { id: string; messages: unknown[] }[];
    };
    expect(body.contact.id).toBe(c.id);
    expect(body.identities.length).toBeGreaterThan(0);
    expect(body.conversations[0]?.id).toBe(convA);
  });

  it('viewer role is read-only — writes 403, reads pass', async () => {
    const [v] = await db
      .insert(users)
      .values({ email: 'view@x.com', name: 'Vic', passwordHash: await hashPassword('password123') })
      .returning();
    await db
      .insert(memberships)
      .values({ userId: v.id, workspaceId, role: 'viewer', acceptedAt: new Date() });
    const { token, id } = generateSessionToken();
    await db
      .insert(sessions)
      .values({ id, userId: v.id, workspaceId, expiresAt: new Date(Date.now() + 86_400_000) });
    const vcookie = `janis_session=${token}`;
    const [c] = await db.select().from(contacts).limit(1);
    const list = await api.request('/api/contacts', { headers: { cookie: vcookie } });
    expect(list.status).toBe(200);
    const write = await api.request(`/api/contacts/${c.id}`, {
      method: 'PATCH',
      headers: { cookie: vcookie, 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'nope' }),
    });
    expect(write.status).toBe(403);
    const mergeTry = await api.request(`/api/contacts/${c.id}/merge`, {
      method: 'POST',
      headers: { cookie: vcookie, 'content-type': 'application/json' },
      body: JSON.stringify({ other_id: c.id }),
    });
    expect(mergeTry.status).toBe(403);
  });

  it('delete unlinks conversations; purge deletes them', async () => {
    const mk = async (email: string) => {
      const [c] = await db
        .insert(contacts)
        .values({ workspaceId, name: 'Tmp', email })
        .returning();
      const [cv] = await db
        .insert(conversations)
        .values({ agentId: (await db.select().from(agents))[0].id, externalId: `x:${email}`, contactId: c.id })
        .returning();
      await db
        .insert(messages)
        .values({ conversationId: cv.id, direction: 'in', text: 'hi' });
      return { contact: c, conv: cv };
    };
    const a = await mk('del-unlink@x.com');
    const res1 = await api.request(`/api/contacts/${a.contact.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res1.status).toBe(200);
    const [orphan] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, a.conv.id));
    expect(orphan.contactId).toBeNull(); // transcript survives, person gone

    const b = await mk('del-purge@x.com');
    const res2 = await api.request(`/api/contacts/${b.contact.id}?mode=purge`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res2.status).toBe(200);
    const gone = await db.select().from(conversations).where(eq(conversations.id, b.conv.id));
    const goneMsgs = await db.select().from(messages).where(eq(messages.conversationId, b.conv.id));
    expect(gone.length).toBe(0);
    expect(goneMsgs.length).toBe(0);
  });
});
