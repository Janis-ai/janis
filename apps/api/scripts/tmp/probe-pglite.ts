/** Forensic: count rows in each quarantined PGlite dir to find the one
 *  holding real data. Opens dirs directly (no createDb — no probes, no
 *  owner files) since they are quarantined and unheld. */
import { PGlite } from '@electric-sql/pglite';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base = join(homedir(), '.janis');
const dirs = (await readdir(base))
  .filter((d) => d.startsWith('pglite'))
  .map((d) => join(base, d));

for (const dir of dirs.sort()) {
  try {
    const db = new PGlite(dir);
    const agents = await db.query<{ n: string }>(`select count(*) as n from agents`);
    const convs = await db.query<{ n: string }>(`select count(*) as n from conversations`);
    const names = await db.query<{ name: string }>(`select name from agents order by created_at desc limit 4`).catch(() => ({ rows: [] as { name: string }[] }));
    console.log(
      `${dir.split('/').pop()}  agents=${agents.rows[0]?.n}  convs=${convs.rows[0]?.n}  [${names.rows.map((r) => r.name).join(', ')}]`,
    );
    await db.close();
  } catch (e) {
    console.log(`${dir.split('/').pop()}  OPEN-FAIL ${(e as Error).message?.slice(0, 80)}`);
  }
}
process.exit(0);
