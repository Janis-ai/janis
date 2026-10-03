/** Sync the concierge agent's knowledge entries from the canonical file at
 *  scripts/concierge-kb.txt — entries separated by a line containing only '---'.
 *
 *    npx tsx scripts/sync-concierge-kb.ts            # writes prod (.env.production)
 *    npx tsx scripts/sync-concierge-kb.ts --check    # diff only, no write
 *
 *  The file is the source of truth: update it with feature/nav changes and
 *  re-run. Entries inject line-by-line into the agent's context, so keep each
 *  a standalone fact. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd';
const KB_FILE = fileURLToPath(new URL('./concierge-kb.txt', import.meta.url));

const envv = (k: string) =>
  fs.readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${k}=`))
    ?.slice(k.length + 1)
    .trim()
    .replace(/^["']|["']$/g, '');

const entries = fs
  .readFileSync(KB_FILE, 'utf8')
  .split(/\n---\n/)
  .map((s) => s.trim())
  .filter(Boolean);
if (entries.length < 50) throw new Error(`only ${entries.length} entries — refusing to wipe`);

const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const [a] = await sql`select config->'knowledge' as kb from agents where id=${AGENT_ID}`;
const cur = (Array.isArray(a?.kb) ? a.kb : []) as string[];
if (a?.kb && !Array.isArray(a.kb)) console.log('warning: stored knowledge is not an array — will overwrite');

const added = entries.filter((e) => !cur.includes(e));
const removed = cur.filter((e) => !entries.includes(e));
console.log(`current: ${cur.length}, file: ${entries.length}, +${added.length} -${removed.length}`);
removed.forEach((e) => console.log('  -', e.slice(0, 90)));
added.forEach((e) => console.log('  +', e.slice(0, 90)));

if (!process.argv.includes('--check')) {
  // text[] → to_jsonb: a JS array param binds as a PG array and converts to a
  // real jsonb array — passing JSON text or sql.json() stores a string scalar.
  await sql`update agents set config = jsonb_set(config, '{knowledge}', to_jsonb(${entries}::text[])) where id=${AGENT_ID}`;
  console.log('synced.');
}
await sql.end();
