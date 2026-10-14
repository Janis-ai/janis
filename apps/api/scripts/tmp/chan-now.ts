import { createDb } from '../../src/db/client.js';
import { channels, messages } from '../../src/db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
const db = await createDb();
const [ch] = await db.select().from(channels).where(eq(channels.id, 'dd416836-710e-4be7-806e-b2196669e1c5'));
const c = ch!.credentials as Record<string, unknown>;
console.log('branding now:', JSON.stringify(c.branding ?? null), '| updated:', ch!.updatedAt?.toISOString());
// latest replies in the test conv to see if OOS still renders post-deploy
const rows = await db.select().from(messages)
  .where(and(eq(messages.conversationId, '0e19e4aa-69aa-42ff-a17c-328403bbc145'), eq(messages.direction, 'out')))
  .orderBy(desc(messages.createdAt)).limit(5);
for (const m of rows) {
  const w = ((m.payload as any)?.widgets ?? []).find((x: any) => x.type === 'cards');
  console.log(m.createdAt?.toISOString(), '|', (m.text ?? '').slice(0, 55),
    w ? '| cards: ' + w.items.map((i: any) => `${i.title}${i.stock ? ' [' + i.stock + ']' : ''}`).join(', ') : '| no cards');
}
process.exit(0);
