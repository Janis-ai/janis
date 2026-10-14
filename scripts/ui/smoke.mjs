// UI smoke — the click-around suite. Each step gets a screenshot into
// scripts/ui/out/ (on failure too). Run a single step:
//   node scripts/ui/smoke.mjs ask-janis
import { BASE, launch, login, shot } from './lib.mjs';

const only = process.argv[2];

async function loginStep(ctx) {
  await login(ctx.context);
  // `/` is the public landing even when authed — probe an authed route.
  await ctx.page.goto(`${BASE}/conversations`, { waitUntil: 'networkidle' });
  await shot(ctx.page, 'login');
  if (new URL(ctx.page.url()).pathname.startsWith('/login')) {
    throw new Error(`bounced to /login — session cookie didn't take (base ${BASE})`);
  }
  await ctx.page.locator('main, [role="main"], #main-content').first().waitFor({ timeout: 10_000 });
}

const STEPS = [
  ['inbox', async (ctx) => {
    await ctx.page.goto(`${BASE}/conversations`, { waitUntil: 'networkidle' });
    await ctx.page.locator('main, [role="main"], #main-content').first().waitFor({ timeout: 10_000 });
    await shot(ctx.page, 'inbox');
  }],

  ['agents', async (ctx) => {
    await ctx.page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' });
    const first = ctx.page.locator('a[href^="/agents/"]').first();
    if (!(await first.count())) {
      return 'skipped — no agents in this workspace';
    }
    await first.click();
    await ctx.page.waitForLoadState('networkidle');
    await shot(ctx.page, 'agent');
  }],

  ['ask-janis', async (ctx) => {
    await ctx.page.goto(`${BASE}/ask`, { waitUntil: 'networkidle' });
    const input = ctx.page.locator('.ask-input textarea');
    await input.waitFor({ timeout: 10_000 });
    const probe = `ui-smoke probe ${Date.now()}`;
    await input.fill(probe);
    await input.press('Enter');
    // My own message renders immediately — this asserts the rail is wired,
    // not that an LLM answered.
    await ctx.page
      .locator('.ask-msg.me', { hasText: probe })
      .first()
      .waitFor({ timeout: 10_000 });
    try {
      await ctx.page.locator('.ask-msg.them').first().waitFor({ timeout: 45_000 });
    } catch {
      if (process.env.UI_EXPECT_REPLY === '1') throw new Error('no agent reply in 45s');
      return 'message posted; no reply within 45s (LLM not configured? set UI_EXPECT_REPLY=1 to fail)';
    }
    await shot(ctx.page, 'ask-janis');
  }],
];

const steps = only ? STEPS.filter(([name]) => name === only) : STEPS;
if (only && !steps.length) {
  console.error(`unknown step '${only}' — options: ${STEPS.map(([n]) => n).join(', ')}`);
  process.exit(2);
}

const ctx = await launch();
let failed = 0;
try {
  console.log(`→ login (${BASE})`);
  await loginStep(ctx);
  console.log('  ok');
  for (const [name, fn] of steps) {
    process.stdout.write(`→ ${name} `);
    try {
      const note = await fn(ctx);
      console.log(`ok${note ? ` (${note})` : ''}`);
    } catch (err) {
      failed++;
      const file = await shot(ctx.page, `fail-${name}`);
      console.log(`FAIL — ${err.message}\n    screenshot: ${file}`);
    }
  }
} catch (err) {
  failed++;
  const file = await shot(ctx.page, 'fail-login');
  console.log(`FAIL — ${err.message}\n    screenshot: ${file}`);
} finally {
  await ctx.browser.close();
}
process.exit(failed ? 1 : 0);
