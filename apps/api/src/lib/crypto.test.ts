import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  generateSessionToken,
  hashPassword,
  sha256,
  signWebhookPayload,
  verifyPassword,
} from './crypto.js';
import { createHmac } from 'node:crypto';

describe('crypto', () => {
  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('hunter2');
    expect(await verifyPassword('hunter2', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('generates api keys with hash + preview', () => {
    const { key, hash, preview } = generateApiKey();
    expect(key).toMatch(/^jk_live_/);
    expect(hash).toBe(sha256(key));
    expect(preview).not.toContain(key.slice(8, -4));
  });

  it('session token id is the stored hash', () => {
    const { token, id } = generateSessionToken();
    expect(id).toBe(sha256(token));
  });

  it('webhook signature is a verifiable HMAC of timestamp.body', () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({ type: 'message.human', text: 'hi' });
    const header = signWebhookPayload(secret, '1700000000', body);

    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header);
    expect(match).not.toBeNull();
    const expected = createHmac('sha256', secret)
      .update(`1700000000.${body}`)
      .digest('hex');
    expect(match![2]).toBe(expected);
  });
});
