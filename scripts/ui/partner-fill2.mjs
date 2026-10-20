import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);

// helper: fill a tag input by typing then clicking the first checkbox option
async function pickTag(placeholder, search, prefer) {
  const inp = page.locator(`input[placeholder="${placeholder}"]`);
  await inp.scrollIntoViewIfNeeded();
  await inp.click();
  await inp.pressSequentially(search, { delay: 40 });
  await page.waitForTimeout(1500);
  const box = await page.evaluate(({ prefer }) => {
    const labels = [...document.querySelectorAll('label')].filter(l => l.offsetParent !== null && l.querySelector('input[type="checkbox"]'));
    const opts = labels.map(l => l.textContent.trim()).filter(t => t && t !== 'Not applicable for this app' && t.length < 60);
    const target = labels.find(l => l.textContent.trim() === prefer) ?? labels.find(l => {
      const t = l.textContent.trim();
      return t && t !== 'Not applicable for this app' && t.length < 60;
    });
    const r = target?.getBoundingClientRect();
    return { opts, picked: target?.textContent.trim(), r: r ? { x: r.x + 15, y: r.y + r.height / 2 } : null };
  }, { prefer });
  console.log(placeholder.slice(9, 40), '→ options:', JSON.stringify(box.opts), 'picked:', box.picked);
  if (box.r) await page.mouse.click(box.r.x, box.r.y);
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

// 1. category details — three tag fields
await pickTag('Example: AI chatbots, Live chat, SMS', 'Live chat', 'Live chat');
await pickTag('Example: Cart recovery, COD verification, Discounts', 'Chatbot', 'AI-generated responses');
await pickTag('Example: Color and font, Emojis and stickers, Chat window', 'Chat', 'Chat window');
await page.screenshot({ path: `${OUT}/35-catdetails.png` });

// 2. subtitle — no "Shopify" allowed
const sub = page.locator('input[name="subtitle"]');
await sub.scrollIntoViewIfNeeded();
await sub.fill('AI agent that answers shoppers and looks up orders');

// 3. search terms — tag input right after subtitle (bare input + Add button)
const termInput = page.locator('input[name="subtitle"] + div input, input[name="subtitle"]').locator('..').locator('..').locator('..').locator('xpath=following-sibling::*').locator('input[type="text"]').first();
// simpler: find the unnamed text input after subtitle in the same section
const st = await page.evaluate(() => {
  const sub = document.querySelector('input[name="subtitle"]');
  let card = sub; for (let i = 0; i < 10 && card; i++) card = card.parentElement;
  const inputs = [...card.querySelectorAll('input[type="text"]')].map(i => ({ n: i.name, ph: i.placeholder }));
  return inputs;
});
console.log('discovery inputs:', JSON.stringify(st));
await ctx.close();
