/**
 * One-off: create the Google OAuth reviewer's Janis account on prod —
 * pre-verified email/password login plus a ready "Google integration demo"
 * agent, so the verification video only has to record the flows. Prints
 * the credentials to hand Google.
 *
 *   npx tsx scripts/make-review-account.ts
 *   npx tsx scripts/make-review-account.ts someone@janis.ai 'SomePass123'
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const line of readFileSync(join(here, '..', '.env.production'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  if (m) env[m[1]] = process.env[m[1]]!;
}

const email = (process.argv[2] ?? 'google-review@janis.ai').toLowerCase();
const password = process.argv[3] ?? `Janis-Review-${Math.floor(Math.random() * 9000 + 1000)}`;

const { createDb } = await import('../src/db/client.js');
const { users, workspaces, memberships, agents } = await import('../src/db/schema.js');
const { hashPassword, generateWebhookSecret } = await import('../src/lib/crypto.js');

const db = await createDb();
const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (existing) {
  console.error(`user ${email} already exists`);
  process.exit(1);
}

const [user] = await db
  .insert(users)
  .values({ email, name: 'OAuth Review', passwordHash: await hashPassword(password), emailVerifiedAt: new Date() })
  .returning();
const [ws] = await db
  .insert(workspaces)
  .values({ name: 'OAuth review workspace', plan: 'pro', ownerUserId: user.id, config: { data_retention_days: 365 } })
  .returning();
await db.insert(memberships).values({ userId: user.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
await db.update(users).set({ lastWorkspaceId: ws.id }).where(eq(users.id, user.id));
const [agent] = await db
  .insert(agents)
  .values({
    workspaceId: ws.id,
    ownerUserId: user.id,
    name: 'Google integration demo',
    webhookSecret: generateWebhookSecret(),
    hosted: true,
    autoResumeMinutes: 10,
    config: { greeting: 'Hi! Ask me anything about Meridian Realty — pricing, listings, or scheduling.' },
  })
  .returning();

console.log(JSON.stringify({ email, password, workspace: ws.name, agent: agent.name, agent_id: agent.id }, null, 2));
process.exit(0);
