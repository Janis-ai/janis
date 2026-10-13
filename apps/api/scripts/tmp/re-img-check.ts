import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows = await db.execute(sql`
  select status, image_url is not null as has_img, name
  from knowledge_files
  where agent_id = 'f454f596-338a-431f-b604-68535303317b'`);
const list = rows as unknown as { status: string; has_img: boolean; name: string }[];
const ready = list.filter(r => r.status === 'ready');
const imgs = list.filter(r => r.has_img);
console.log('total', list.length, '| ready', ready.length, '| with image_url', imgs.length);
console.log('non-ready:', list.filter(r => r.status !== 'ready').map(r => `${r.name}(${r.status})`).join(', ') || 'none');
console.log('ready w/o img:', ready.filter(r => !r.has_img).length);
process.exit(0);
