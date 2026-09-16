import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentSecrets } from '../db/schema.js';
import { env } from '../env.js';

// 32-byte key: JANIS_SECRETS_KEY (hex or base64) or sha256(session secret)
let cached: Buffer | null = null;
function key(): Buffer {
  if (cached) return cached;
  const raw = env.secretsKey;
  if (raw) {
    const buf = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? 'hex' : 'base64');
    if (buf.length !== 32) throw new Error('JANIS_SECRETS_KEY must be 32 bytes (hex or base64)');
    cached = buf;
  } else {
    cached = createHash('sha256').update(`janis-secrets:${env.sessionSecret}`).digest();
  }
  return cached;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(enc: string): string {
  const buf = Buffer.from(enc, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * Decrypted name → value map for an agent — used to interpolate
 * {{secrets.NAME}} placeholders in tool definitions at call time.
 * Values never leave the API process.
 */
export async function loadSecretsMap(db: Db, agentId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, agentId));
  const map: Record<string, string> = {};
  for (const row of rows) {
    try {
      map[row.name] = decryptSecret(row.valueEnc);
    } catch {
      // key rotated or corrupt row — treat as unset rather than crash replies
      console.error(`secret ${row.name} for agent ${agentId}: decrypt failed`);
    }
  }
  return map;
}

/** Expand {{secrets.NAME}} placeholders; unknown names become empty string. */
export function interpolateSecrets(template: string, secrets: Record<string, string>): string {
  return template.replaceAll(/\{\{secrets\.([A-Za-z0-9_]+)\}\}/g, (_, name) => secrets[name] ?? '');
}
