import { createDb } from '../../src/db/client.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';
import { callTool } from '../../src/lib/toolExec.js';
import { widgetFromToolResult } from '../../src/lib/widgets.js';
import { TOOL_TEMPLATES } from '../../src/lib/toolTemplates.js';
const db = await createDb();
const secrets = await loadSecretsMap(db, 'd408d7b5-fdad-49a4-a34d-11fa16e88135');
const tool = TOOL_TEMPLATES.flatMap(t => t.tools).find(t => t.name === 'shopify_search_products')!;
const text = await callTool(tool, { query: 'status:active published_status:published' }, secrets);
if (text.startsWith('error')) { console.log(text.slice(0,400)); process.exit(1); }
const w = widgetFromToolResult(tool.widget, text, {}, {});
if (w?.type !== 'cards') { console.log('no widget', text.slice(0,300)); process.exit(1); }
for (const i of w.items) {
  console.log(`\n${i.title} | ${i.price ?? '-'} | cvid:${i.cart_variant_id ?? 'NONE'} | stock:${i.stock ?? '-'}`);
  if (i.options) console.log(`   options: ${i.options}`);
  if (i.compare_at) console.log(`   was: ${i.compare_at}`);
}
console.log('\ntotal:', w.total, 'cursor:', !!w.end_cursor);
process.exit(0);
