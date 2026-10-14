import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const rows = await db.select({
  shop: schema.shopifyShops.shop,
  state: schema.shopifyShops.state,
  hasTok: schema.shopifyShops.accessTokenEnc,
  hasRt: schema.shopifyShops.refreshTokenEnc,
  exp: schema.shopifyShops.tokenExpiresAt,
  agent: schema.shopifyShops.agentId,
  updated: schema.shopifyShops.updatedAt,
}).from(schema.shopifyShops);
for (const r of rows)
  console.log(r.shop, '|', r.state, '| tok:', !!r.hasTok, '| rt:', !!r.hasRt, '| exp:', r.exp?.toISOString(), '| agent:', r.agent, '| upd:', r.updated.toISOString());
await sql.end();
