// Probe: inline tool notes under agent replies (payload.inspector.tools).
import { BASE, launch, login, shot } from './lib.mjs';

const CONV = '4bcd70a8-1381-4386-8c5d-19a03fa55c4d';

const ctx = await launch();
await login(ctx.context);
await ctx.page.goto(`${BASE}/conversations/${CONV}`, { waitUntil: 'networkidle' });
await ctx.page.locator('.msg.out').first().waitFor({ timeout: 15_000 });

const notes = await ctx.page.locator('.tool-note').allTextContents();
console.log(`tool-note count: ${notes.length}`);
notes.forEach((n, i) => console.log(`  [${i}] ${n}`));

// the inspector toggle must still be there
const toggles = await ctx.page.locator('.inspector-toggle').count();
console.log(`inspector-toggle count: ${toggles}`);

await shot(ctx.page, 'toolnote');
if (!notes.length) throw new Error('no .tool-note rendered');
await ctx.browser.close();
