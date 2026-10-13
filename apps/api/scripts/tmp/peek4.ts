import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows: any = await db.execute(sql`
  select id, direction, created_at, left(text,150) as text, payload
  from messages
  where conversation_id = '26beb247-55b4-47f6-9be7-0aa4f58afb63'
  order by created_at asc`);
for (const r of (rows.rows ?? rows)) {
  const p = r.payload as any;
  console.log(`--- ${r.direction} ${r.created_at} "${r.text ?? ''}"`);
  if (p?.widgets) (p.widgets as any[]).forEach((w,i) =>
    console.log(`  widget[${i}] ${w.type} items=${w.items?.length}`, (w.items??[]).map((it:any)=>it.title).join(' | ')));
  if (p?.inspector?.toolCalls) console.log('  tools:', JSON.stringify(p.inspector.toolCalls).slice(0,400));
  for (const k of Object.keys(p ?? {})) if (!['via','widgets','delivered','inspector','client_id'].includes(k)) console.log('  payload key:', k, '=', JSON.stringify(p[k]).slice(0,200));
}
process.exit(0);
