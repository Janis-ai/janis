import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { usageEvents, workspaces } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { recordLlmUsage } from './usage.js';
import { rateFor } from './billing.js';

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

describe('rateFor', () => {
  it('prefix-matches the longer key first (flash-lite ≠ flash)', () => {
    expect(rateFor('gemini-3.5-flash-lite')).toEqual({ input: 0.3, output: 2.5 });
    expect(rateFor('gemini-3.5-flash')).toEqual({ input: 1.5, output: 9 });
    expect(rateFor('gemini-3.7-flash')).toEqual({ input: 0.75, output: 3.75 });
    // opus 5.5 is cheaper than opus 5 — order matters
    expect(rateFor('claude-opus-5-5')).toEqual({ input: 4, output: 20 });
    expect(rateFor('claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(rateFor('gpt-6-sol')).toEqual({ input: 2, output: 10 });
  });

  it('dated variants hit their family prefix; unknown models get the default', () => {
    expect(rateFor('gemini-3.5-flash-lite-2026-07-21')).toEqual({ input: 0.3, output: 2.5 });
    expect(rateFor('llama-local-70b')).toEqual({ input: 0.5, output: 1.5 });
    expect(rateFor(null)).toEqual({ input: 0.5, output: 1.5 });
  });

  it('normalizes transport ids — models/ prefix and OpenRouter vendor/ compounds', () => {
    expect(rateFor('models/gemini-3.5-flash')).toEqual({ input: 1.5, output: 9 });
    expect(rateFor('anthropic/claude-fable-5-1')).toEqual({ input: 10, output: 50 });
    expect(rateFor('google/gemini-3.7-pro')).toEqual({ input: 2, output: 12 });
  });
});
