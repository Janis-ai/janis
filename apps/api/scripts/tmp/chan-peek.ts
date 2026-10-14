import { createDb } from '../../src/db/client.js';
import { channels, shopifyShops } from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const chans = await db.select().from(channels).where(and(eq(channels.agentId, shop!.agentId!), eq(channels.kind, 'webchat')));
for (const ch of chans) {
  const c = ch.credentials as Record<string, unknown>;
  console.log(ch.id, 'internal:', (c as any).internal ?? false);
  console.log('  branding:', JSON.stringify(c.branding ?? null));
  console.log('  identity_secret:', c.identity_secret ? 'set' : 'unset');
}
process.exit(0);
