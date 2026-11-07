// One-off: draft-first guide + "Continue in Copilot" CTA on the draft card.
import { BASE, launch, login, shot } from './lib.mjs';

const ctx = await launch();
try {
  await login(ctx.context);
  await ctx.context.addInitScript(() => {
    try { localStorage.setItem('janis.dock-open', 'closed'); } catch {}
  });
  const me = await (await ctx.context.request.get(`${BASE}/auth/me`)).json();
  console.log('support_channel_id:', me.support_channel_id);
  const list = await ctx.context.request.get(`${BASE}/api/conversations?limit=50`);
  const { conversations } = await list.json();
  const conv = conversations.find(
    (c) => c.state !== 'archived' && !c.external_id.startsWith(`webchat:u:${me.user.id}`),
  );
  if (!conv) throw new Error('no non-concierge conversation found');
  console.log('conv:', conv.id, conv.external_id);

  await ctx.page.goto(`${BASE}/conversations/${conv.id}`, { waitUntil: 'networkidle' });
  await ctx.page.addStyleTag({ content: '.push-banner{display:none!important}' });
  await ctx.page.getByRole('button', { name: 'Suggest a reply' }).first().click();
  const guide = ctx.page.locator('textarea[placeholder*="Guide the draft"]');
  await guide.waitFor({ timeout: 10_000 });
  const cta = ctx.page.getByRole('button', { name: 'Continue in Copilot' });
  await cta.waitFor({ timeout: 10_000 });
  console.log('cta visible');
  await shot(ctx.page, 'cta-visible');

  await guide.fill('offer 10% off and apologize');
  await ctx.page.getByRole('button', { name: 'Draft', exact: true }).click();
  await ctx.page.waitForTimeout(2500);
  if (await ctx.page.locator('.layout.dock-open').count()) {
    throw new Error('dock opened on Draft — the guide was routed to the concierge');
  }
  if (await guide.inputValue()) throw new Error('guide did not clear');
  console.log('draft stayed local (dock closed, guide cleared)');
  // Give the suggestion a moment to land (LLM optional — card already open).
  await ctx.page.waitForTimeout(8000);
  await shot(ctx.page, 'after-draft');

  await cta.click();
  await ctx.page.locator('.layout.dock-open').waitFor({ timeout: 10_000 });
  await ctx.page
    .locator('.ask-msg.me', { hasText: 'Help me with my reply' })
    .first()
    .waitFor({ timeout: 15_000 });
  console.log('copilot dock opened with the seed');
  await shot(ctx.page, 'copilot-seeded');
  console.log('PASS');
} finally {
  await ctx.browser.close();
}
