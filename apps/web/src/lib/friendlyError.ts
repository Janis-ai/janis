/**
 * friendlyError — translates provider/API error strings into operator-facing
 * sentences. Machine errors still surface when nothing matches (with obvious
 * provider noise stripped), and callers should keep the raw string on `title`
 * or a details fold so support doesn't lose it.
 *
 * A rule value of null means "the message is already readable — pass through".
 */
const RULES: [RegExp, string | null][] = [
  // OAuth / auth handshake
  [/invalid oauth state/i, 'That sign-in link expired — start the connection again.'],
  [/access_denied/i, 'Authorization was declined.'],
  [/invalid_grant|token.*(expired|revoked)/i, 'The connected account needs to be re-authorized — reconnect it.'],
  // Cloudflare
  [/9109|invalid (api |access )?token|authentication error/i, "Cloudflare rejected the API token — reconnect Cloudflare or check the token's permissions."],
  [/no cloudflare zone/i, null],
  // Twilio / messaging
  [/10dlc|a2p|unregistered|registration required/i, "This number isn't registered for business texting (A2P 10DLC) — complete carrier registration in Twilio first."],
  [/twilio.*(21211|21610|21614)/i, 'Twilio rejected that phone number — check the number and country code.'],
  // Resend / domains
  [/domain.*(unverified|not verified|pending verification)/i, "The sending domain isn't verified yet — DNS records can take a few minutes to propagate."],
  // Generic HTTP / transport
  [/\b429\b|rate.?limit|too many requests/i, 'Rate limited — wait a minute and try again.'],
  [/\b401\b|unauthorized/i, 'Authorization failed — reconnect the account.'],
  [/\b403\b|forbidden/i, 'Permission denied — the connected account may lack the needed access.'],
  [/fetch failed|network|econn|etimedout|timed?\s?out/i, "Couldn't reach the service — check the connection and retry."],
];

export function friendlyError(raw: string): { text: string; detail?: string } {
  const msg = (raw || 'something went wrong').trim();
  for (const [re, text] of RULES) {
    if (!re.test(msg)) continue;
    if (text === null) return { text: msg };
    return { text, detail: msg };
  }
  // No mapping — strip the worst machine noise but keep the message.
  const cleaned = msg
    .replace(/^\s*(cloudflare|twilio|resend|graph|meta|stripe)\s*[:#]?\s*\d*\s*/i, '')
    .replace(/^error[:\s]+/i, '');
  return { text: cleaned.charAt(0).toUpperCase() + cleaned.slice(1), detail: cleaned !== msg ? msg : undefined };
}
