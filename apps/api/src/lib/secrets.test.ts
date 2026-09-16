import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, interpolateSecrets } from './secrets.js';

describe('secrets', () => {
  it('encrypt/decrypt round-trips', () => {
    const enc = encryptSecret('sk-live-abc123');
    expect(enc).not.toContain('sk-live-abc123');
    expect(decryptSecret(enc)).toBe('sk-live-abc123');
  });

  it('different ciphertexts for the same value (random IV)', () => {
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
  });

  it('tampered ciphertext fails to decrypt', () => {
    const enc = encryptSecret('hello');
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] ^= 1;
    expect(() => decryptSecret(buf.toString('base64'))).toThrow();
  });

  it('interpolates {{secrets.NAME}} and blanks unknowns', () => {
    const s = { POS_API_KEY: 'k123' };
    expect(interpolateSecrets('Bearer {{secrets.POS_API_KEY}}', s)).toBe('Bearer k123');
    expect(interpolateSecrets('https://x.test/?key={{secrets.MISSING}}', s)).toBe(
      'https://x.test/?key=',
    );
    expect(interpolateSecrets('no placeholders', s)).toBe('no placeholders');
  });

  it('does not expand {{secrets.*}} inside already-substituted arg text', () => {
    // callTool expands secrets before args — simulate the ordering guarantee
    const url = interpolateSecrets('https://api.test/orders/{q}', { K: 'v' });
    const arg = '{{secrets.K}}';
    const final = url.replaceAll('{q}', encodeURIComponent(arg));
    expect(final).toBe('https://api.test/orders/%7B%7Bsecrets.K%7D%7D');
  });
});
