import { createDb } from '../../src/db/client.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';
const db = await createDb();
const s = await loadSecretsMap(db as never, 'd408d7b5-fdad-49a4-a34d-11fa16e88135');
for (const k of Object.keys(s)) console.log(k, '=', String(s[k]).length < 40 ? String(s[k]).slice(0,38) : String(s[k]).slice(0,12)+'…len'+s[k].length);
process.exit(0);
