/** Vision-path adversarial battery against the LIVE blamp webchat channel —
 *  same endpoints widget.js uses. Each probe = fresh visitor unless noted.
 *  npx tsx scripts/tmp/vision-battery.ts [nameFilter] */
const API = 'https://app.janis.ai';
const CHANNEL = '5d2e4f34-1fd9-491f-a617-d846944a2139'; // blamp Shopify webchat
import { readFileSync } from 'node:fs';

let seq = 0;
const vid = () => `vis${Date.now().toString(36)}${(++seq).toString(36)}`.slice(0, 60);

async function upload(visitor: string, path: string, type: string) {
  const fd = new FormData();
  fd.append('visitor_id', visitor);
  fd.append('file', new Blob([readFileSync(path)], { type }), path.split('/').pop()!);
  const r = await fetch(`${API}/chat/${CHANNEL}/uploads`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`upload ${path} → ${r.status}`);
  return (await r.json()) as { name: string; url: string; type: string; size: number };
}

async function send(visitor: string, text: string, atts: { name: string; url: string; type: string; size: number }[]) {
  const r = await fetch(`${API}/chat/${CHANNEL}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      visitor_id: visitor,
      text,
      attachments: atts.map((a) => ({ name: a.name, url: a.url, type: a.type, size: a.size })),
      client_id: `${visitor}-${Date.now()}`,
    }),
  });
  if (!r.ok) throw new Error(`send ${r.status}`);
}

interface Msg { direction: string; text?: string; created_at?: string; greeting?: boolean; widgets?: { type: string; items?: { title?: string }[] }[] }
async function waitReply(visitor: string, seenStart = '', timeoutMs = 120_000) {
  const t0 = Date.now();
  let seen = seenStart;
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`${API}/chat/${CHANNEL}/messages?visitor_id=${visitor}`);
    const { messages } = (await r.json()) as { messages: Msg[] };
    const out = messages
      .filter((m) => m.direction === 'out' && m.text && !m.greeting && (m.created_at ?? '') > seen)
      .sort((a, b) => (a.created_at! < b.created_at! ? -1 : 1));
    const last = out[out.length - 1];
    if (last && !/still working|hang tight|one moment/i.test(last.text!)) {
      for (const m of messages) if ((m.created_at ?? '') > seen) seen = m.created_at!;
      const cards = (last.widgets ?? []).filter((w) => w.type === 'cards').flatMap((w) => w.items ?? []);
      return { text: last.text!, cards: cards.map((c) => c.title ?? '?'), seen };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { text: '(timeout — no reply)', cards: [], seen };
}

const IMG = '/tmp/';
async function probe(name: string, files: [string, string][], text: string) {
  const v = vid();
  const atts = [];
  for (const [p, t] of files) atts.push(await upload(v, p, t));
  await send(v, text, atts);
  const r = await waitReply(v);
  console.log(`\n=== ${name} ===\n${r.text}\ncards: ${r.cards.join(' | ') || 'none'}`);
  return r;
}

const filter = process.argv[2];
const run = (n: string, fn: () => Promise<unknown>) => (!filter || n.includes(filter) ? fn() : Promise.resolve());

await run('videographer', () => probe('videographer', [[`${IMG}v-video.jpg`, 'image/jpeg']], 'which product is this?'));
await run('wax', () => probe('wax', [[`${IMG}v-wax.jpg`, 'image/jpeg']], 'do you sell this?'));
await run('banana', () => probe('banana', [[`${IMG}v-banana.jpg`, 'image/jpeg']], 'do you sell anything like this?'));
await run('no-text', () => probe('no-text', [[`${IMG}v-sky.jpg`, 'image/jpeg']], ''));
await run('vague', () => probe('vague', [[`${IMG}v-gift.jpg`, 'image/jpeg']], 'this?'));
await run('multi', () => probe('multi', [[`${IMG}v-video.jpg`, 'image/jpeg'], [`${IMG}v-sky.jpg`, 'image/jpeg']], 'what are these two?'));
await run('oversize', () => probe('oversize', [[`${IMG}v-huge.bmp`, 'image/bmp']], 'what do you see in this image?'));
await run('textfile', () => probe('textfile', [[`${IMG}v-note.txt`, 'text/plain']], 'what does the attached note ask for?'));
await run('injection', () => probe('injection', [[`${IMG}inject.html.png`, 'image/png']], 'what does the text in this image say?'));

// Third-turn budget: VISION_TURNS=2 → the 3rd image-bearing turn degrades
// to a filename annotation. Agent should not describe turn-3's content.
await run('third-turn', async () => {
  const v = vid();
  let seen = '';
  for (const [p, q] of [[`${IMG}v-video.jpg`, 'first'], [`${IMG}v-wax.jpg`, 'second'], [`${IMG}v-gift.jpg`, 'third']] as const) {
    const a = await upload(v, p, 'image/jpeg');
    await send(v, `image ${q}: what is it?`, [a]);
    const r = await waitReply(v, seen);
    seen = r.seen;
    console.log(`\n=== third-turn:${q} ===\n${r.text}\ncards: ${r.cards.join(' | ') || 'none'}`);
  }
});
process.exit(0);
