/** Live probe: narration↔card agreement on the public webchat channel. */
const API = 'https://app.janis.ai';
const CHANNEL = 'dd416836-710e-4be7-806e-b2196669e1c5';
const vid = `named${Date.now().toString(36)}x`;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(text: string) {
  const res = await fetch(`${API}/chat/${CHANNEL}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: vid, text, client_id: `${vid}-${Date.now()}` }),
  });
  if (!res.ok) throw new Error(`send ${res.status}: ${(await res.text()).slice(0, 120)}`);
}

const seen = new Set<string>();
async function reply(since: string, timeoutMs = 120_000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const res = await fetch(`${API}/chat/${CHANNEL}/messages?visitor_id=${vid}`);
    const { messages } = (await res.json()) as { messages: any[] };
    const out = messages
      .filter((m) => m.direction === 'out' && m.text && (m.created_at ?? '') > since && !m.greeting
        && !seen.has(m.created_at)
        && !/negative sentiment|still working|hang tight|one moment/i.test(m.text ?? ''))
      .sort((a, b) => (a.created_at! < b.created_at! ? -1 : 1));
    const last = out[out.length - 1];
    if (last && !/typing/i.test(last.text)) { seen.add(last.created_at); return last; }
    await delay(2500);
  }
  throw new Error('no reply');
}

async function turn(text: string) {
  const since = new Date(Date.now() - 1000).toISOString();
  await send(text);
  const r = await reply(since);
  const cards = (r.widgets ?? []).filter((w: any) => w.type === 'cards').flatMap((w: any) => w.items ?? []);
  console.log('\n>>> ' + text);
  console.log('    text: ' + r.text.replace(/\n/g, ' ').slice(0, 220));
  console.log('    cards: ' + (cards.map((c: any) => c.title).join(' | ') || '(none)'));
  return { text: r.text, cards };
}

// Turn 1: snowboard-scoped ask — gift card must not render
const t1 = await turn('show me your snowboards');
const gift = t1.cards.filter((c: any) => /gift/i.test(c.title ?? ''));
console.log(gift.length ? `    ✗ gift card in snowboard ask: ${gift.map((c:any)=>c.title)}` : '    ✓ no gift card on snowboard ask');

// Turn 2: named product — named card must lead
const t2 = await turn('i want the collection snowboard liquid');
const first = t2.cards[0]?.title ?? '';
console.log(/liquid/i.test(first) ? `    ✓ named match leads: ${first}` : `    ✗ named product not leading: ${first}`);
const liqCard = t2.cards.find((c: any) => /liquid/i.test(c.title ?? ''));
console.log(liqCard ? '    ✓ liquid card rendered' : '    ✗ liquid card MISSING');

// Turn 3: alternates — every product named in text must have a card
const t3 = await turn('any others in that collection it might be?');
const mentioned = ['liquid', 'hydrogen', 'oxygen'].filter((n) => t3.text.toLowerCase().includes(n));
const missing = mentioned.filter((n) => !t3.cards.some((c: any) => (c.title ?? '').toLowerCase().includes(n)));
console.log(`    named in text: ${mentioned.join(', ') || '(none)'}`);
console.log(missing.length ? `    ✗ named but no card: ${missing.join(', ')}` : '    ✓ every named product has a card');
const alien = t3.cards.filter((c: any) => /gift card|ski wax/i.test(c.title ?? ''));
console.log(alien.length ? `    ✗ unrelated cards: ${alien.map((c:any)=>c.title)}` : '    ✓ no unrelated filler');
