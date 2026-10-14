// Live probes for collections + popularity tools through the public chat API.
const API = 'https://app.janis.ai';
const CHANNEL = 'dd416836-710e-4be7-806e-b2196669e1c5';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(vid: string, text: string) {
  const res = await fetch(`${API}/chat/${CHANNEL}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: vid, text, client_id: `${vid}-${Date.now()}` }),
  });
  if (!res.ok) throw new Error(`send ${res.status}`);
}

async function waitReply(vid: string, since: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const res = await fetch(`${API}/chat/${CHANNEL}/messages?visitor_id=${vid}`);
    const { messages } = (await res.json()) as { messages: any[] };
    const out = messages
      .filter((m) => m.direction === 'out' && m.text && (m.created_at ?? '') > since && !m.greeting
        && !/negative sentiment|still working|hang tight|one moment/i.test(m.text ?? ''))
      .sort((a, b) => (a.created_at! < b.created_at! ? -1 : 1));
    const last = out[out.length - 1];
    if (last?.text && !/typing/i.test(last.text)) {
      const cards = (last.widgets ?? []).filter((w: any) => w.type === 'cards').flatMap((w: any) => w.items ?? []);
      return { text: last.text, cards, widgets: last.widgets ?? [] };
    }
    await delay(2500);
  }
  throw new Error('timeout');
}

const vid = `coll${Date.now().toString(36)}x`;

// 1. collections ask
let t = new Date().toISOString();
await send(vid, 'what collections do you have?');
let r = await waitReply(vid, t);
console.log('=== collections ask ===');
console.log('TEXT:', r.text.slice(0, 400));
for (const c of r.cards) console.log('  CARD:', JSON.stringify(c));

// 2. tap-equivalent — model must call search with collection param
await delay(1500);
t = new Date().toISOString();
await send(vid, 'Show me the Hydrogen collection');
r = await waitReply(vid, t);
console.log('=== hydrogen ask ===');
console.log('TEXT:', r.text.slice(0, 400));
for (const c of r.cards) console.log('  CARD:', (c as any).title, '|', (c as any).price, '|', (c as any).stock ?? '');

// 3. popularity ask — best_selling sort or sales_stats
await delay(1500);
t = new Date().toISOString();
await send(vid, 'what are your best-selling items?');
r = await waitReply(vid, t);
console.log('=== bestseller ask ===');
console.log('TEXT:', r.text.slice(0, 600));
for (const c of r.cards) console.log('  CARD:', (c as any).title);
process.exit(0);
