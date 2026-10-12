/** Look up a user + their workspaces by name/email fragment.
 *   DATABASE_URL=<prod> npx tsx scripts/tmp/find-user.ts <fragment>
 */
import { eq, ilike, or } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { memberships, users, workspaces } from '../../src/db/schema.js';

const frag = process.argv[2] ?? '';
const db = await createDb();
const rows = await db
  .select({
    userId: users.id,
    email: users.email,
    name: users.name,
    wsId: workspaces.id,
    wsName: workspaces.name,
    plan: workspaces.plan,
    role: memberships.role,
  })
  .from(users)
  .innerJoin(memberships, eq(memberships.userId, users.id))
  .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
  .where(or(ilike(users.name, `%${frag}%`), ilike(users.email, `%${frag}%`)));
console.log(JSON.stringify(rows, null, 2));
process.exit(0);
