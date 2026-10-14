import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
await db.update(schema.shopifyShops)
  .set({ agentId: null, workspaceId: null })
  .where(and(eq(schema.shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'), eq(schema.shopifyShops.state, 'unlinked')));
console.log('tidied');
await sql.end();
