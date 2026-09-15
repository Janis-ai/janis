import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, users, workspaces } from '../db/schema.js';
import { env } from '../env.js';
import { generateApiKey, generateWebhookSecret, hashPassword } from '../lib/crypto.js';

/**
 * Idempotent first-run seed: creates a workspace + admin user + demo agent.
 * Prints credentials to stdout — the demo API key is shown only here.
 */
export async function ensureSeed(db: Db): Promise<void> {
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (anyUser) return;

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: 'Default', plan: env.defaultPlan })
    .returning();
  await db.insert(users).values({
    workspaceId: workspace.id,
    email: env.seedAdminEmail,
    name: 'Admin',
    role: 'admin',
    passwordHash: await hashPassword(env.seedAdminPassword),
  });

  const { key, hash, preview } = generateApiKey();
  await db.insert(agents).values({
    workspaceId: workspace.id,
    name: 'Demo Agent',
    apiKeyHash: hash,
    apiKeyPreview: preview,
    webhookSecret: generateWebhookSecret(),
  });

  console.log('');
  console.log('─'.repeat(60));
  console.log('  Janis seeded');
  console.log(`  Console login:  ${env.seedAdminEmail} / ${env.seedAdminPassword}`);
  console.log(`  Demo agent key: ${key}`);
  console.log('  (shown once — set as JANIS_API_KEY for the demo agent)');
  console.log('─'.repeat(60));
  console.log('');
}
