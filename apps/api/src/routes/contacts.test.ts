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
});
