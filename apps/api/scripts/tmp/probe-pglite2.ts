import { PGlite } from '@electric-sql/pglite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new PGlite(join(homedir(), '.janis', 'pglite'));
console.log('--- workspaces');
for (const r of (await db.query<any>(`select id, name from workspaces`)).rows) console.log(' ', r.id.slice(0,8), r.name);
console.log('--- users (any cols)');
const u = await db.query<any>(`select * from users limit 5`).catch((e) => ({ rows: [] as any[] , _e: e.message }));
for (const r of u.rows) console.log(' ', JSON.stringify(r).slice(0, 200));
console.log('--- agents');
for (const r of (await db.query<any>(`select id, name, workspace_id, created_at from agents`)).rows) console.log(' ', r.id.slice(0,8), r.name, 'ws', r.workspace_id.slice(0,8), r.created_at);
await db.close();
process.exit(0);
