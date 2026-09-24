import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { BUILTIN_TOOLS, enabledBuiltins } from '../lib/builtinTools.js';
import { agents, conversations, memberships, users, workspaces } from '../db/schema.js';
import * as schema from '../db/schema.js';
import { env } from '../env.js';
import type { Db } from '../db/client.js';

let db: Db;
const WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONV = 'cccccccc-0000-4000-8000-000000000003';

const accountStatus = () => BUILTIN_TOOLS.find((b) => b.name === 'account_status')!;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  await db.insert(users).values({ id: USER, email: 'm@x.com', name: 'Mike' });
  await db.insert(workspaces).values({ id: WS, name: 'W1', plan: 'pro' });
  await db.insert(memberships).values({ userId: USER, workspaceId: WS, role: 'owner', acceptedAt: new Date() });
  const [agent] = await db.insert(agents).values({ workspaceId: WS, name: 'Bot' }).returning();
  await db.insert(conversations).values({ id: CONV, agentId: agent.id, externalId: 'v:test' });
});

describe('account_status builtin', () => {
  it('gated to the operator workspace', () => {
    const prev = env.operatorWorkspaceId;
    env.operatorWorkspaceId = WS;
    expect(accountStatus().available(WS)).toBe(true);
    expect(accountStatus().available('other-ws')).toBe(false);
    expect(enabledBuiltins(['account_status'], WS).map((b) => b.name)).toEqual(['account_status']);
    expect(enabledBuiltins(['account_status'], 'other-ws')).toEqual([]);
    env.operatorWorkspaceId = prev;
  });

  it('returns signed_in: false when the visitor is not verified', async () => {
    const out = JSON.parse(await accountStatus().run({}, { db, convId: CONV, workspaceId: WS }));
    expect(out.signed_in).toBe(false);
  });

  it('resolves a verified user to their workspace and plan', async () => {
    await db
      .update(conversations)
      .set({
        userProfile: { external_id: USER, name: 'Mike', email: 'm@x.com', identity_verified: true },
      })
      .where(eq(conversations.id, CONV));
    const out = JSON.parse(await accountStatus().run({}, { db, convId: CONV, workspaceId: WS }));
    expect(out.signed_in).toBe(true);
    expect(out.email).toBe('m@x.com');
    expect(out.workspaces).toEqual([{ name: 'W1', plan: 'Pro', agents: 1 }]);
  });
});
