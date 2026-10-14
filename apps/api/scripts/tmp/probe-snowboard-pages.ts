/**
 * Relevance-filtered pagination probe — the exact scenario that motivated the
 * reconciler: "snowboards" where the gift card is dropped mid-page.
 * Expect: page 1 backfilled to 10 real snowboards, total stamped as the
 * FILTERED count (11), page 2 returns exactly the remainder.
 */
const API = 'https://app.janis.ai';
const CHANNEL = 'dd416836-710e-4be7-806e-b2196669e1c5';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vid = `sbpg${Date.now().toString(36)}`;
let lastSeen = '';

async function turn(text: string) {
  const res0 = await fetch(`${API}/chat/${CHANNEL}/messages?visitor_id=${vid}`);
  for (const m of ((await res0.json()) as any).messages ?? [])
    if ((m.created_at ?? '') > lastSeen) lastSeen = m.created_at;
  await fetch(`${API}/chat/${CHANNEL}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: vid, text, client_id: `${vid}-${Date.now()}` }),
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    const res = await fetch(`${API}/chat/${CHANNEL}/messages?visitor_id=${vid}`);
    const { messages } = (await res.json()) as any;
    const out = messages.filter(
      (m: any) =>
        m.direction === 'out' && m.text && !m.greeting && (m.created_at ?? '') > lastSeen,
    );
    const last = out[out.length - 1];
    if (last && !/typing|still working|hang tight/i.test(last.text)) {
      const cards = (last.widgets ?? []).filter((w: any) => w.type === 'cards').flatMap((w: any) => w.items ?? []);
      console.log(`→ "${text}"`);
      console.log(`   ${last.text.slice(0, 200).replace(/\n/g, ' ⏎ ')}`);
      console.log(`   cards(${cards.length}): ${cards.map((c: any) => `${c.title}${c.stock ? ' [OOS]' : ''}`).join(' | ')}`);
      return cards;
    }
    await delay(2500);
  }
  throw new Error('timeout');
}

await turn('show me just the snowboards');
await delay(1500);
await turn('any more?');
process.exit(0);
