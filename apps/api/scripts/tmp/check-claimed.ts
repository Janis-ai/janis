import { createDb } from '../../src/db/client.js';
import { shopifyShops, workspaces, memberships, users } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const shops = await db.select().from(shopifyShops).orderBy(desc(shopifyShops.createdAt)).limit(10);
for (const s of shops) {
  const [ws] = s.workspaceId
    ? await db.select({ id: workspaces.id, owner: workspaces.ownerUserId, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, s.workspaceId)).limit(1)
    : [null];
  const members = s.workspaceId
    ? await db.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(eq(memberships.workspaceId, s.workspaceId))
    : [];
  const memberEmails = [];
  for (const m of members) {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, m.userId)).limit(1);
    memberEmails.push(`${u?.email ?? m.userId}:${m.role}`);
  }
  console.log(s.shop, '| ws:', ws?.id?.slice(0,8), '| owner:', ws?.owner ? ws.owner.slice(0,8) : 'NULL', '| members:', memberEmails.join(', '));
}
process.exit(0);
