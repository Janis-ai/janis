import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows: any = await db.execute(sql`
  select id, name, kind, credentials from channels
  where agent_id = 'd408d7b5-fdad-49a4-a34d-11fa16e88135'`);
for (const r of (rows.rows ?? rows)) {
  console.log('===', r.name, r.kind, r.id);
  const c = r.credentials as any;
  for (const k of Object.keys(c ?? {})) {
    const v = c[k];
    console.log(' ', k, ':', JSON.stringify(v).slice(0, 900));
  }
}
process.exit(0);
