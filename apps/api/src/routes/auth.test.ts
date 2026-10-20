import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { emailVerificationTokens, passwordResetTokens, sessions, users, workspaces } from '../db/schema.js';
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

// The DB only stores token hashes — tests mint a raw token by rewriting the
// row's hash, the same way the emailed link would carry it.
const swapRawToken = async (
  table: typeof emailVerificationTokens | typeof passwordResetTokens,
  rowId: string,
) => {
  const raw = 'test-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  await db.update(table).set({ tokenHash: sha256(raw) }).where(eq(table.id, rowId));
  return raw;
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/auth', authRoutes(db));
});

// passwordIssue runs a live HIBP range query; it fails open when offline so
// these tests don't depend on the network — just avoid blocklisted passwords.
const PW = `Tst-${Math.random().toString(36).slice(2)}x9!`;

describe('signup + email verification', () => {
  it('creates the account but issues no session until verified', async () => {
    const res = await post('/auth/signup', { email: 'New@X.TEST', password: PW, name: 'New User' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ needsVerification: true });
    expect(setCookie(res)).toBe('');
    const [tok] = await db.select().from(emailVerificationTokens).limit(1);
    expect(tok).toBeTruthy();
    expect(tok.tokenHash).not.toContain('='); // hash, not raw token
  });

  it('login 403s while unverified', async () => {
    const res = await post('/auth/login', { email: 'new@x.test', password: PW });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('unverified');
  });

  it('verify burns the token, issues a session, and provisions a workspace', async () => {
    const [u] = await db.select().from(users).where(eq(users.email, 'new@x.test')).limit(1);
    const [tok] = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, u.id))
      .limit(1);
    const raw = await swapRawToken(emailVerificationTokens, tok.id);
    const res = await post('/auth/verify', { token: raw });
    expect(res.status).toBe(200);
    expect(setCookie(res)).toContain(SESSION_COOKIE);
    const me = await (await app.request('/auth/me', { headers: { cookie: setCookie(res) } })).json();
    expect(me.workspaces[0].name).toBe("New's workspace");
    // single-use
    expect((await post('/auth/verify', { token: raw })).status).toBe(400);
    const [after] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
    expect(after.emailVerifiedAt).toBeTruthy();
  });

  it('verify rejects a bogus token', async () => {
    expect((await post('/auth/verify', { token: 'a'.repeat(43) })).status).toBe(400);
  });

  it('resend-verification is indistinguishable for known/unknown emails', async () => {
    await post('/auth/signup', { email: 'unverified@x.test', password: PW });
    const known = await post('/auth/resend-verification', { email: 'unverified@x.test' });
    const unknown = await post('/auth/resend-verification', { email: 'ghost@x.test' });
    const verified = await post('/auth/resend-verification', { email: 'new@x.test' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(verified.status).toBe(200);
    // a resend burns the older unused token
    const [u] = await db.select().from(users).where(eq(users.email, 'unverified@x.test')).limit(1);
    const live = (await db.select().from(emailVerificationTokens).where(eq(emailVerificationTokens.userId, u.id))).filter((t) => !t.usedAt);
    expect(live).toHaveLength(1);
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
  it('signs in once verified', async () => {
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
  });

  it('reset rejects a bogus token', async () => {
    const res = await post('/auth/reset', { token: 'a'.repeat(43), password: PW });
    expect(res.status).toBe(400);
  });

  it('reset sets the password, burns the token, and revokes old sessions', async () => {
    const [u] = await db.select().from(users).where(eq(users.email, 'new@x.test')).limit(1);
    const { token: oldRaw, id: oldId } = generateSessionToken();
    await db.insert(sessions).values({ id: oldId, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });

    await post('/auth/forgot', { email: 'new@x.test' });
    const [tok] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, u.id))
      .limit(1);
    const raw = await swapRawToken(passwordResetTokens, tok.id);

    const res = await post('/auth/reset', { token: raw, password: PW + '-v2' });
    expect(res.status).toBe(200);
    expect(setCookie(res)).toContain(SESSION_COOKIE);

    const old = await app.request('/auth/me', { headers: { cookie: `${SESSION_COOKIE}=${oldRaw}` } });
    expect(old.status).toBe(401);
    expect((await post('/auth/login', { email: 'new@x.test', password: PW + '-v2' })).status).toBe(200);
    expect((await post('/auth/login', { email: 'new@x.test', password: PW })).status).toBe(401);
    expect((await post('/auth/reset', { token: raw, password: PW })).status).toBe(400);
  });

  it('reset marks the account verified (inbox ownership proven)', async () => {
    const [u] = await db
      .insert(users)
      .values({ email: 'oauth@x.test', name: 'Oauth' })
      .returning();
    await post('/auth/forgot', { email: 'oauth@x.test' });
    const [tok] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, u.id))
      .limit(1);
    const raw = await swapRawToken(passwordResetTokens, tok.id);
    const res = await post('/auth/reset', { token: raw, password: PW });
    expect(res.status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
    expect(after.passwordHash).toBeTruthy();
    expect(after.emailVerifiedAt).toBeTruthy();
  });
});

describe('OAuth begin redirects', () => {
  it('replies no-store with a fresh state per attempt — a cached 302 replays a dead state', async () => {
    const { vi } = await import('vitest');
    vi.stubEnv('WORKOS_CLIENT_ID', 'client_t');
    vi.stubEnv('WORKOS_API_KEY', 'sk_t');
    vi.resetModules();
    const { authRoutes: freshRoutes } = await import('./auth.js');
    const a = new Hono();
    a.route('/auth', freshRoutes(db));
    const r1 = await a.request('/auth/sso?connection=conn_1');
    const r2 = await a.request('/auth/sso?connection=conn_1');
    expect(r1.status).toBe(302);
    expect(r1.headers.get('cache-control')).toContain('no-store');
    const s1 = new URL(r1.headers.get('location')!).searchParams.get('state');
    const s2 = new URL(r2.headers.get('location')!).searchParams.get('state');
    expect(s1).toBeTruthy();
    expect(s1).not.toBe(s2);
    vi.unstubAllEnvs();
  });

  const freshSso = async () => {
    const { vi } = await import('vitest');
    vi.stubEnv('WORKOS_CLIENT_ID', 'client_t');
    vi.stubEnv('WORKOS_API_KEY', 'sk_t');
    vi.resetModules();
    const { authRoutes: freshRoutes } = await import('./auth.js');
    const a = new Hono();
    a.route('/auth', freshRoutes(db));
    return { a, vi };
  };

  it('routes SAML selectors to sso/authorize with an sso_-prefixed state', async () => {
    const { a, vi } = await freshSso();
    const res = await a.request('/auth/sso?connection=conn_9');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe('https://api.workos.com/sso/authorize');
    expect(url.searchParams.get('connection')).toBe('conn_9');
    expect(url.searchParams.get('state')).toMatch(/^sso_/);
    vi.unstubAllEnvs();
  });

  it('routes provider selectors to user_management with an um_-prefixed state', async () => {
    const { a, vi } = await freshSso();
    const res = await a.request('/auth/sso?provider=GoogleOAuth');
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(
      'https://api.workos.com/user_management/authorize',
    );
    expect(url.searchParams.get('provider')).toBe('GoogleOAuth');
    expect(url.searchParams.get('state')).toMatch(/^um_/);
    vi.unstubAllEnvs();
  });

  it('translates ?domain to the organization selector via the claiming workspace', async () => {
    const { a, vi } = await freshSso();
    await db.insert(workspaces).values({
      name: 'Acme',
      config: { workos: { domain: 'acme.test', organization_id: 'org_acme' } },
    });
    const res = await a.request('/auth/sso?domain=acme.test');
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe('https://api.workos.com/sso/authorize');
    expect(url.searchParams.get('organization')).toBe('org_acme');
    expect(url.searchParams.get('domain')).toBeNull();
    vi.unstubAllEnvs();
  });

  it('falls back to the WorkOS org registry for unclaimed domains, then errors cleanly', async () => {
    const { a, vi } = await freshSso();
    // registry hit → organization selector
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ data: [{ id: 'org_reg' }] })),
    );
    const hit = await a.request('/auth/sso?domain=claimed.test');
    const url = new URL(hit.headers.get('location')!);
    expect(url.searchParams.get('organization')).toBe('org_reg');

    // registry miss → friendly login error, not a WorkOS dead-end
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] })));
    const miss = await a.request('/auth/sso?domain=nothing.test');
    const loc = new URL(miss.headers.get('location')!);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('error')).toContain('nothing.test');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
