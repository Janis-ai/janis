import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { usageEvents, workspaces } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { recordLlmUsage } from './usage.js';

let db: Db;
let wsId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'U' }).returning();
  wsId = ws.id;
});

describe('recordLlmUsage', () => {
  it('meters platform-key calls at cost', async () => {
    await recordLlmUsage(db, {
      workspaceId: wsId,
      model: 'gpt-4o-mini',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    const [row] = await db.select().from(usageEvents).where(eq(usageEvents.workspaceId, wsId));
    expect(row?.costMicros).toBeGreaterThan(0);
  });

  it('records BYOK calls at zero cost — the customer pays their provider', async () => {
    await recordLlmUsage(db, {
      workspaceId: wsId,
      model: 'gpt-4o-mini',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      byok: true,
    });
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.workspaceId, wsId));
    const byok = rows[rows.length - 1];
    expect(byok.costMicros).toBe(0);
    // tokens still tracked for the usage breakdown
    expect(byok.promptTokens).toBe(1_000_000);
  });
});
