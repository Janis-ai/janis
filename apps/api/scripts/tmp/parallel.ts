import { createHmac, randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/client.js';
import { channels, conversations, messages, users } from '../../src/db/schema.js';
import { and, desc, eq, gt } from 'drizzle-orm';
const BASE = 'https://janis-api-696050206949.us-east1.run.app';
const RAIL = '7595ffbd-6b87-47ef-8b97-9228eb28042c';
const CONV = '1fb291f8-c3f9-422d-bf3d-09766829efb6';
const db = await createDb();
const [ch] = await db.select().from(channels).where(eq(channels.id, RAIL)).limit(1);
const [u] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
const sig = createHmac('sha256', (ch.credentials as {identity_secret:string}).identity_secret).update(`${u.id}|${u.email}|${u.name ?? ''}`).digest('hex');
const claim = { id: u.id, name: u.name, email: u.email, sig };
const visitor = randomBytes(16).toString('hex');
const t0 = new Date();
const rs = await Promise.all([
  fetch(`${BASE}/chat/${RAIL}/messages`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ visitor_id: visitor, user: claim, text: 'Parallel probe A — just say ok.' }) }),
  fetch(`${BASE}/chat/${RAIL}/messages`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ visitor_id: visitor, user: claim, text: 'Parallel probe B — just say ok.' }) }),
  fetch(`${BASE}/chat/${RAIL}/messages`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ visitor_id: visitor, user: claim, text: 'Parallel probe C — just say ok.' }) }),
]);
console.log('posts:', rs.map(r => r.status).join(','));
// wait then count replies
await new Promise(r => setTimeout(r, 60_000));
const ins = await db.select().from(messages).where(and(eq(messages.conversationId, CONV), eq(messages.direction, 'in'), gt(messages.createdAt, t0)));
const outs = await db.select().from(messages).where(and(eq(messages.conversationId, CONV), eq(messages.direction, 'out'), gt(messages.createdAt, t0)));
console.log(`in=${ins.length} out=${outs.length}`);
outs.forEach(m => console.log('  out:', (m.text ?? '').slice(0, 90).replace(/\n/g,' ')));
process.exit(0);
