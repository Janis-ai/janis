import { PGlite } from '@electric-sql/pglite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new PGlite(join(homedir(), '.janis', 'pglite'));
const rows = (
  await db.query<any>(
    `select id, name, workspace_id, created_at, config from agents order by created_at desc`,
  )
).rows;
for (const r of rows) {
  const b = r.config?.builder ?? {};
  console.log('---', r.name, '| ws', r.workspace_id.slice(0, 8), '|', r.created_at);
  console.log('  brief:', JSON.stringify((b.description ?? r.config?.purpose ?? '').slice(0, 160)));
  console.log('  generated_at:', b.generated_at ?? null);
  console.log('  suggested_templates:', JSON.stringify(b.suggested_templates ?? null));
  console.log('  suggested_knowledge:', JSON.stringify((b.suggested_knowledge ?? []).slice(0, 6)));
  console.log('  draft:', JSON.stringify(b.draft ?? null)?.slice(0, 300));
}
await db.close();
process.exit(0);
