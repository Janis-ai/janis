/**
 * One-off: provision a Meta app-review sign-in. Creates a dedicated user +
 * its own demo workspace + a hosted demo agent so reviewers land on a
 * working product without touching any real customer data.
 *
 *   DATABASE_URL=<prod> npx tsx scripts/tmp/meta-review-account.ts
 *
 * Prints the credentials to hand to Meta. Idempotent — re-running prints
 * the existing account without resetting the password.
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { agents, memberships, users, workspaces } from '../../src/db/schema.js';
import { hashPassword, generateApiKey, generateWebhookSecret } from '../../src/lib/crypto.js';

const EMAIL = 'meta-review@janis.ai';
const PASSWORD = `Janis-Review-${Math.random().toString(36).slice(2, 8)}`;

const db = await createDb();

const [existing] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);
if (existing) {
  console.log(`account already exists: ${EMAIL} (password not rotated)`);
  process.exit(0);
}

const [user] = await db
  .insert(users)
  .values({ email: EMAIL, name: 'Meta Reviewer', passwordHash: await hashPassword(PASSWORD) })
  .returning();

const [ws] = await db
  .insert(workspaces)
  .values({ name: 'Janis (review workspace)', plan: 'pro', ownerUserId: user.id })
  .returning();

await db.insert(memberships).values({
  userId: user.id,
  workspaceId: ws.id,
  role: 'admin',
  acceptedAt: new Date(),
});
await db.update(users).set({ lastWorkspaceId: ws.id }).where(eq(users.id, user.id));

const { hash, preview } = generateApiKey();
await db.insert(agents).values({
  workspaceId: ws.id,
  name: 'Demo Concierge',
  apiKeyHash: hash,
  apiKeyPreview: preview,
  webhookSecret: generateWebhookSecret(),
  hosted: true,
  config: {
    system_prompt:
      'You are a friendly customer-service agent for a demo storefront. ' +
      'Answer questions about shipping, returns, and orders. Escalate to a human when asked.',
    greeting: "Hi! I'm the demo concierge — ask me about shipping, returns, or your order.",
    quick_replies: ['Where is my order?', 'What is the return policy?', 'Talk to a human'],
    knowledge: [
      'Orders ship within 2 business days; standard shipping is free over $50.',
      'Returns are accepted within 30 days of delivery for a full refund.',
    ],
    tone: 'friendly',
  },
});

console.log('');
console.log('  Meta reviewer account created');
console.log(`  URL:      https://app.janis.ai`);
console.log(`  Email:    ${EMAIL}`);
console.log(`  Password: ${PASSWORD}`);
console.log('');
process.exit(0);
