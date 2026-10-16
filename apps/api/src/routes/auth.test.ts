import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { passwordResetTokens, sessions, users } from '../db/schema.js';
import { generateSessionToken, sha256 } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { authRoutes } from './auth.js';

let app: Hono;
let db: Db;

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const setCookie = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/auth', authRoutes(db));
});

// passwordIssue runs a live HIBP range query; it fails open when offline so
// these tests don't depend on the network — just avoid blocklisted passwords.
const PW = `Tst-${Math.random().toString(36).slice(2)}x9!`;

describe('signup', () => {
  it('creates an account, issues a session, and provisions a workspace', async () => {
    const res = await post('/auth/signup', { email: 'New@X.TEST', password: PW, name: 'New User' });
    expect(res.status).toBe(201);
    const { user } = await res.json();
    expect(user.email).toBe('new@x.test'); // normalized
    expect(setCookie(res)).toContain(SESSION_COOKIE);
    const me = await (await app.request('/auth/me', { headers: { cookie: setCookie(res) } })).json();
    expect(me.workspaces.length).toBe(1);
    expect(me.workspaces[0].name).toBe("New's workspace");
  });

  it('rejects a duplicate email', async () => {
    const res = await post('/auth/signup', { email: 'new@x.test', password: PW });
    expect(res.status).toBe(409);
  });

  it('rejects weak passwords before hashing', async () => {
    expect((await post('/auth/signup', { email: 'a@x.test', password: 'short' })).status).toBe(400);
    const res = await post('/auth/signup', { email: 'a@x.test', password: 'password123' });
    expect(res.status).toBe(400);
    const [u] = await db.select().from(users).where(eq(users.email, 'a@x.test')).limit(1);
    expect(u).toBeUndefined();
  });

  it('rejects malformed email', async () => {
    expect((await post('/auth/signup', { email: 'nope', password: PW })).status).toBe(400);
  });
});

describe('login', () => {
  it('signs in with the new credentials', async () => {
    const res = await post('/auth/login', { email: 'NEW@x.test', password: PW });
    expect(res.status).toBe(200);
    expect(setCookie(res)).toContain(SESSION_COOKIE);
  });

  it('401s on wrong password and unknown email alike', async () => {
    expect((await post('/auth/login', { email: 'new@x.test', password: 'wrong' })).status).toBe(401);
    expect((await post('/auth/login', { email: 'ghost@x.test', password: PW })).status).toBe(401);
  });
});

describe('forgot/reset', () => {
  it('forgot is indistinguishable for known and unknown emails', async () => {
    const known = await post('/auth/forgot', { email: 'new@x.test' });
    const unknown = await post('/auth/forgot', { email: 'ghost@x.test' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    const [tok] = await db.select().from(passwordResetTokens).limit(1);
    expect(tok.tokenHash).not.toContain('='); // stored hash, not the raw token
  });

  it('a fresh forgot burns the previous unused token', async () => {
    const [before] = await db.select().from(passwordResetTokens).limit(5).then((r) => r.slice(-1));
    await post('/auth/forgot', { email: 'new@x.test' });
    const rows = await db.select().from(passwordResetTokens);
    const live = rows.filter((t) => !t.usedAt);
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe(before.id);
  });

  it('reset rejects a bogus token', async () => {
    const res = await post('/auth/reset', { token: 'a'.repeat(43), password: PW });
    expect(res.status).toBe(400);
  });

  it('reset sets the password, burns the token, and revokes old sessions', async () => {
    // Live session for the account that should die on reset
    const [u] = await db.select().from(users).where(eq(users.email, 'new@x.test')).limit(1);
    const { token: oldRaw, id: oldId } = generateSessionToken();
    await db.insert(sessions).values({ id: oldId, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });

    const [tok] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, u.id))
      .limit(1);
    // The DB only holds the hash — mint the raw token by rewriting the row
    const raw = 'test-token-' + Math.random().toString(36).slice(2);
    await db
      .update(passwordResetTokens)
      .set({ tokenHash: sha256(raw) })
      .where(eq(passwordResetTokens.id, tok.id));

    const res = await post('/auth/reset', { token: raw, password: PW + '-v2' });
    expect(res.status).toBe(200);
    expect(setCookie(res)).toContain(SESSION_COOKIE);

    // Old session revoked — the cookie no longer authenticates
    const old = await app.request('/auth/me', { headers: { cookie: `${SESSION_COOKIE}=${oldRaw}` } });
    expect(old.status).toBe(401);
    // New password works, old doesn't
    expect((await post('/auth/login', { email: 'new@x.test', password: PW + '-v2' })).status).toBe(200);
    expect((await post('/auth/login', { email: 'new@x.test', password: PW })).status).toBe(401);
    // Token is single-use
    expect((await post('/auth/reset', { token: raw, password: PW })).status).toBe(400);
  });

  it('reset on an OAuth-only account sets a password without touching identity', async () => {
    const [u] = await db.insert(users).values({ email: 'oauth@x.test', name: 'Oauth' }).returning();
    await post('/auth/forgot', { email: 'oauth@x.test' });
    const [tok] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, u.id))
      .limit(1);
    const raw = 'oauth-reset-' + Math.random().toString(36).slice(2);
    await db.update(passwordResetTokens).set({ tokenHash: sha256(raw) }).where(eq(passwordResetTokens.id, tok.id));
    const res = await post('/auth/reset', { token: raw, password: PW });
    expect(res.status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
    expect(after.passwordHash).toBeTruthy();
  });
});
