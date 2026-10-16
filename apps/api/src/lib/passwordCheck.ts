import { createHash } from 'node:crypto';

/**
 * New-password validation, current-guidance flavor (NIST SP 800-63B /
 * OWASP): length is the real signal — 8 min / 128 max, no composition
 * rules, all characters and paste allowed. Guessed-at passwords are
 * rejected two ways: a baked common-password blocklist (the offline
 * floor) and a live Have I Been Pwned k-anonymity check — only the SHA-1
 * prefix leaves the box; the suffix match happens here. HIBP fails open:
 * an unreachable API must not gate signup, the blocklist still applies.
 */
const COMMON = new Set(
  [
    'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
    'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'letmein', 'welcome1',
    'monkey123', 'dragon123', 'football', 'baseball', 'abc12345', '11111111',
    'sunshine', 'princess', 'trustno1', 'whatever', 'superman', 'batman123',
    'mustang', 'access14', 'master12', 'shadow12', 'michael1', 'charlie1',
    'jordan23', 'hunter22', 'summer2024', 'winter2024', 'janis123',
  ].map((s) => s.toLowerCase()),
);

export async function passwordIssue(password: string): Promise<string | null> {
  if (password.length < 8) return 'Use at least 8 characters';
  if (password.length > 128) return 'Use at most 128 characters';
  if (COMMON.has(password.toLowerCase())) {
    return 'That password is too common — pick something less guessable';
  }
  try {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
      signal: AbortSignal.timeout(3000),
      headers: { 'user-agent': 'janis-password-check' },
    });
    if (res.ok) {
      const suffix = sha1.slice(5);
      const hit = (await res.text())
        .split('\n')
        .some((line) => line.split(':')[0].trim() === suffix);
      if (hit) return 'That password appears in public breach dumps — pick a different one';
    }
  } catch {
    /* fail open — the blocklist above still applies */
  }
  return null;
}
