// Throwaway: verify Check-for-conflicts + Suggest-rewrite render and
// land end-to-end on the dev console. Creates a probe agent in the
// session workspace with deliberately contradictory instructions, runs
// both tools, cleans up.
import { BASE, launch, login, shot } from './lib.mjs';

const { browser, context, page } = await launch();
let agentId;
try {
  await login(context);
  const created = await context.request.post(`${BASE}/api/agents`, {
    data: { name: 'Conflict Probe ZZ', hosted: true },
  });
  if (!created.ok()) throw new Error(`create agent: ${created.status()} ${await created.text()}`);
  agentId = (await created.json()).agent.id;
  await context.request.patch(`${BASE}/api/agents/${agentId}`, {
    data: {
      config: {
        system_prompt:
          'Flag for a human whenever the customer asks for one.\n\n' +
          "Always reference the user's current URL context and list your accessible data categories instead of offering a handoff.",
        knowledge: ['Manual intervention requests → send the user to sign in via the Copilot.'],
      },
    },
  });

  await page.goto(`${BASE}/agents/${agentId}/behavior?sub=instructions`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(1000);
  console.log('buttons:', (await page.locator('button').allTextContents()).join(' | '));

  await page.getByRole('button', { name: 'Check for conflicts' }).click();
  await page
    .locator('text=/No contradicting rules|collides when|redundant|Conflict check failed/')
    .first()
    .waitFor({ timeout: 90_000 });
  await shot(page, 'conflict-results');

  const applyBtn = page.getByRole('button', { name: 'Apply fix' }).first();
  if (await applyBtn.isVisible().catch(() => false)) {
    await applyBtn.click();
    await shot(page, 'fix-applied');
    console.log('applied a fix');
  } else {
    console.log('no apply button rendered');
  }

  await page.getByRole('button', { name: 'Suggest rewrite' }).click();
  await page
    .locator('text=/Suggested rewrite|Rewrite failed/')
    .first()
    .waitFor({ timeout: 120_000 });
  await shot(page, 'rewrite-result');
  const useBtn = page.getByRole('button', { name: 'Use this rewrite' });
  console.log('rewrite card:', (await useBtn.isVisible().catch(() => false)) ? 'ok' : 'missing/failed');
} finally {
  if (agentId) await context.request.delete(`${BASE}/api/agents/${agentId}`).catch(() => {});
  await browser.close();
}
