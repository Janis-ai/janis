import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const TOKEN = 'b88daf76-f197-4c48-9ed6-140992b478a6';
const BASE = 'https://app.janis.ai';
const visitor = 'verify-' + Date.now();
const r = await fetch(`${BASE}/chat/${TOKEN}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ visitor_id: visitor, text: 'show me 3 bedroom listings with photos' }),
});
console.log('POST', r.status);
const ext = `webchat:test:${TOKEN}:${visitor}`;
for (let i = 0; i < 20; i++) {
  await new Promise((s) => setTimeout(s, 3000));
  const rows = await db.execute(sql`
    select m.text, m.payload, m.created_at::text from messages m
    join conversations c on c.id = m.conversation_id
    where c.external_id = ${ext} and m.direction = 'out'
    order by m.created_at`);
  const last = (rows as any[]).at(-1);
  if (last && !last.payload?.via) {
    console.log('--- reply @' + last.created_at + '\n' + (last.text || '').slice(0, 600));
    console.log('QRs:', JSON.stringify(last.payload?.quick_replies ?? null));
    for (const w of last.payload?.widgets ?? []) {
      console.log('widget:', w.type);
      if (w.type === 'cards') for (const it of w.items) console.log('  card:', it.title, '| link:', it.link, '\n    img:', it.image);
    }
    process.exit(0);
  }
}
console.log('no reply after 60s');
process.exit(1);
