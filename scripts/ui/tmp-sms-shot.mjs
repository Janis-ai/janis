import { BASE, launch, login, shot } from './lib.mjs';
const ctx = await launch();
try {
  await login(ctx.context);
  await ctx.page.goto(`${BASE}/agents/583260b5-a56f-4039-87e6-ca751a6f2ce1/channels`, { waitUntil: 'networkidle' });
  // "More channels" group may be collapsed — open every details ancestor
  await ctx.page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  await ctx.page.waitForTimeout(400);
  const summary = ctx.page.locator('summary', { hasText: 'SMS — text messaging' }).first();
  const sms = summary.locator('xpath=..');
  await sms.screenshot({ path: 'scripts/ui/out/sms-hosted.png' });
  await sms.locator('button', { hasText: 'Use my Twilio account' }).click();
  await ctx.page.waitForTimeout(300);
  await sms.screenshot({ path: 'scripts/ui/out/sms-byo.png' });
  console.log('done');
} finally {
  await ctx.browser.close();
}
