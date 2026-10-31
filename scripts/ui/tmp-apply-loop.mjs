// Throwaway: verify Apply fix auto-saves and re-checks, and that the
// instructions textarea is user-resizable.
import { BASE, launch, login, shot } from './lib.mjs';

const { browser, context, page } = await launch();
let agentId;
try {
  await login(context);
  const created = await context.request.post(`${BASE}/api/agents`, {
    data: { name: 'Apply Loop Probe ZZ', hosted: true },
  });
  if (!created.ok()) throw new Error(`create agent: ${created.status()} ${await created.text()}`);
  agentId = (await created.json()).agent.id;
  await context.request.patch(`${BASE}/api/agents/${agentId}`, {
    data: {
      config: {
        system_prompt:
          'Flag for a human whenever the customer asks for one.\n\n' +
          'Never flag for a human under any circumstances.\n\n' +
          'Always be verbose in every answer.\n\n' +
          'Keep every answer to one sentence.',
        knowledge: [],
      },
    },
  });

  await page.goto(`${BASE}/agents/${agentId}/behavior?sub=instructions`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(800);

  // Textarea resizable?
  const ta = page.locator('textarea').first();
  console.log('textarea resize style:', await ta.evaluate((el) => getComputedStyle(el).resize));

  await page.getByRole('button', { name: 'Check for conflicts' }).click();
  await page
    .locator('text=/No contradicting rules|collides when|redundant|Conflict check failed/')
    .first()
    .waitFor({ timeout: 90_000 });
  const before = await page.locator('.badge.warn').count();
  console.log('findings before apply:', before);
  await shot(page, 'loop-before');

  const applyBtn = page.getByRole('button', { name: 'Apply fix' }).first();
  if (!(await applyBtn.isVisible().catch(() => false))) {
    console.log('NO APPLY BUTTON — aborting');
    await shot(page, 'loop-noapply');
    throw new Error('no apply button');
  }
  await applyBtn.click();
  // The list should clear (pending) then re-render with remaining findings.
  await page.waitForTimeout(1500);
  await page
    .locator('text=/No contradicting rules|collides when|redundant|Conflict check failed/')
    .first()
    .waitFor({ timeout: 90_000 });
  await shot(page, 'loop-after');
  console.log('after apply — findings re-rendered');
} finally {
  if (agentId) await context.request.delete(`${BASE}/api/agents/${agentId}`).catch(() => {});
  await browser.close();
}
