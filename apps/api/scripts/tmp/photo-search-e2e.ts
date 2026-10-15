/** Live E2E: widget upload → attachment on message → vision → product cards.
 *  Hits the real public chat API exactly like widget.js does. */
const API = 'https://app.janis.ai';
const CHANNEL = 'b8c89e5f-b95b-4dc8-a805-1b739dc8e61c'; // torontofood Shopify webchat
const visitor = `photo${Date.now().toString(36)}x`;

const fd = new FormData();
fd.append('visitor_id', visitor);
fd.append('file', new Blob([await (await import('node:fs/promises')).readFile('/tmp/probe-photo.jpg')], { type: 'image/jpeg' }), 'probe-photo.jpg');
const up = await fetch(`${API}/chat/${CHANNEL}/uploads`, { method: 'POST', body: fd });
console.log('upload:', up.status, await up.clone().text().catch(() => ''));
if (!up.ok) process.exit(1);
const ref = (await up.clone().json().catch(() => null)) ?? JSON.parse('{}');
const att = await up.json().catch(() => ref) as { name: string; url: string; type: string; size: number };

const send = await fetch(`${API}/chat/${CHANNEL}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    visitor_id: visitor,
    text: 'what is this? do you sell anything like it?',
    attachments: [{ name: att.name, url: att.url, type: att.type, size: att.size }],
    client_id: `${visitor}-1`,
  }),
});
console.log('send:', send.status);

const t0 = Date.now();
let seen = '';
while (Date.now() - t0 < 120_000) {
  const r = await fetch(`${API}/chat/${CHANNEL}/messages?visitor_id=${visitor}`);
  const { messages } = (await r.json()) as { messages: { direction: string; text?: string; created_at?: string; widgets?: {type:string;items?:{title?:string}[]}[]; greeting?: boolean }[] };
  const out = messages
    .filter((m) => m.direction === 'out' && m.text && !m.greeting && (m.created_at ?? '') > seen)
    .sort((a, b) => (a.created_at! < b.created_at! ? -1 : 1));
  const last = out[out.length - 1];
  if (last) {
    for (const m of messages) if ((m.created_at ?? '') > seen) seen = m.created_at!;
    console.log('\nREPLY:', last.text);
    const cards = (last.widgets ?? []).filter((w) => w.type === 'cards').flatMap((w) => w.items ?? []);
    console.log('WIDGETS:', (last.widgets ?? []).map((w) => w.type).join(',') || 'none');
    if (cards.length) console.log('CARDS:', cards.map((c) => c.title).join(' | '));
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
process.exit(0);
