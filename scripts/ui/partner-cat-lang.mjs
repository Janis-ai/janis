import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);

// ---- primary category ----
const catSection = page.locator('section:has-text("App category"), div:has-text("Primary category")').last();
await page.locator('button:has-text("Select")').first().scrollIntoViewIfNeeded();
await page.locator('button:has-text("Select")').first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/29-cat-modal.png` });
const catSearch = page.locator('[role="dialog"] input[type="search"], [role="dialog"] input[placeholder*="earch"], .Polaris-Modal input[type="search"], .Polaris-Modal input[placeholder*="earch"]').first();
const catSearchCount = await catSearch.count();
console.log('cat search inputs:', catSearchCount);
if (catSearchCount) {
  await catSearch.fill('Chat');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/30-cat-results.png` });
  // click the Chat option
  const opt = page.locator('[role="dialog"] :text-is("Chat"), .Polaris-Modal :text-is("Chat")').first();
  await opt.click().catch(async () => {
    const box = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[role="dialog"] li, [role="dialog"] [role="option"], .Polaris-Modal li, .Polaris-Modal label')];
      const el = els.find(e => e.textContent.trim() === 'Chat' || e.textContent.trim().startsWith('Chat'));
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    if (box) await page.mouse.click(box.x, box.y);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/31-cat-picked.png` });
  // confirm modal if needed
  const done = page.locator('[role="dialog"] button:has-text("Done"), [role="dialog"] button:has-text("Save"), .Polaris-Modal button:has-text("Done"), .Polaris-Modal button:has-text("Save")').first();
  if (await done.count()) { await done.click(); await page.waitForTimeout(1200); }
}
const catState = await page.evaluate(() => {
  const t = document.body.innerText;
  return { hasChat: t.includes('Chat'), stillRequired: t.includes('Primary category is required') };
});
console.log('cat state:', JSON.stringify(catState));

// ---- languages ----
await page.locator('.param-multi-select-languages > button').scrollIntoViewIfNeeded();
await page.locator('.param-multi-select-languages > button').click();
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const s = document.querySelector('.param-multi-select-languages input[type="search"], .param-multi-select-languages input[placeholder*="earch"]');
  setVal(s, 'English');
});
await page.waitForTimeout(1500);
const box = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.param-multi-select-languages label')].find(l => l.textContent.trim() === 'English');
  const r = el?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
});
if (box) await page.mouse.click(box.x, box.y);
await page.waitForTimeout(1000);
const langSt = await page.evaluate(() => {
  const cb = [...document.querySelectorAll('.param-multi-select-languages input[type="checkbox"]')].find(c => c.closest('label')?.textContent.trim() === 'English');
  return cb?.checked;
});
console.log('english checked:', langSt);
await page.keyboard.press('Escape');
await page.waitForTimeout(800);

// ---- save ----
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(6000);
const final = await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no-issue-label');
console.log('after save:', final);
await page.screenshot({ path: `${OUT}/32-after-save.png` });
await ctx.close();
