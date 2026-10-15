import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(shopifyShops).orderBy(desc(shopifyShops.updatedAt));
for (const r of rows)
  console.log([
    r.shop,
    `state=${r.state}`,
    `ws=${r.workspaceId?.slice(0, 8)}`,
    `agent=${r.agentId?.slice(0, 8)}`,
    `access=${r.accessTokenEnc ? 'yes' : 'NO'}`,
    `refresh=${r.refreshTokenEnc ? 'yes' : 'no'}`,
    `expires=${r.tokenExpiresAt?.toISOString() ?? 'legacy'}`,
    `scopes=${r.scopes}`,
    `contact=${r.contactEmail}`,
    `updated=${r.updatedAt.toISOString()}`,
  ].join(' | '));
process.exit(0);
