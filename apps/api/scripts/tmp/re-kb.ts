import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const A = 'f454f596-338a-431f-b604-68535303317b';
const kn = await db.execute(sql`
  select name, source_url, length(text)::int as chars,
    position('roxborough' in lower(text)) > 0 as has_rox,
    position('inglewood' in lower(text)) > 0 as has_ing,
    position('sumach' in lower(text)) > 0 as has_sum,
    position('wp-content/uploads' in text) > 0 as has_imgurl
  from knowledge_files where agent_id = ${A} order by created_at`);
console.log(JSON.stringify(kn));
const imgs = await db.execute(sql`
  select count(*)::int as files_with_img from knowledge_files
  where agent_id = ${A} and text ~ 'https?://[^ ]+\.(jpg|jpeg|png|webp)'`);
console.log('IMGS', JSON.stringify(imgs));
process.exit(0);
