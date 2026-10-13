import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const emitted = {
  'https://jonathanferrier.com/properties/98glencairnave': 'https://media-production.lp-cdn.com/cdn-cgi/image/format=auto,quality=85,fit=scale-down,width=960/https://media-production.lp-cdn.com/media/0da3e532-56e7-436d-b7a7-4eac0a7e7474',
  'https://jonathanferrier.com/properties/211walmerrd': 'https://media-production.lp-cdn.com/cdn-cgi/image/format=auto,quality=85,fit=scale-down,width=960/https://media-production.lp-cdn.com/media/99baa48e-465b-4fa7-b583-6ebf12fd17a5',
};
for (const [src, img] of Object.entries(emitted)) {
  const rows = await db.execute(sql`select image_url from knowledge_files where source_url = ${src}`);
  const stored = (rows as any[])[0]?.image_url;
  console.log(src, '\n  match:', stored === img, stored === img ? '' : `\n  stored: ${stored}`);
  const r = await fetch(img, { method: 'HEAD' });
  console.log('  HTTP', r.status, r.headers.get('content-type'));
}
process.exit(0);
