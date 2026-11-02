// Repro for the deleted-agent sign-in landing: poison every store that can
// name an agent, delete it, sign out and back in — must not land on
// /agents/<deleted>. Run: node scripts/ui/deleted-agent-landing.mjs
import { BASE, launch, login, EMAIL, PASSWORD } from './lib.mjs';

const { browser, context, page } = await launch();
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };

try {
  await login(context);
  const me = await (await context.request.get(`${BASE}/auth/me`)).json();
  const wsId = me.workspace.id;
  const userId = me.user.id;

  // Throwaway agent — visit it so useAgentContext stores it as last-agent.
  const created = await context.request.post(`${BASE}/api/agents`, {
    data: { name: `pw-delete-probe-${Date.now()}` },
  });
  if (!created.ok()) throw new Error(`create agent: ${await created.text()}`);
  const { agent } = await created.json();
  const agentId = agent.id;
  await page.goto(`${BASE}/agents/${agentId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800); // let the last-agent write land

  const del = await context.request.delete(`${BASE}/api/agents/${agentId}`);
  if (!del.ok()) throw new Error(`delete agent: ${await del.text()}`);

  // Arm every poison vector: identity-bound stash (as RequireAuth would
  // write signing out from the dead page), a legacy plain-string stash in
  // a second check below, and confirm last-agents held the dead id.
  const storedMap = await page.evaluate(() => localStorage.getItem('janis:last-agents'));
  console.log('last-agents after visit:', storedMap);

  // 1) Direct mount of a deleted-agent URL must bounce to /conversations.
  await page.goto(`${BASE}/agents/${agentId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  console.log('direct /agents/<deleted> landed on:', page.url());
  if (page.url().includes(`/agents/${agentId}`)) fail('foreign agent URL did not bounce');
  if (await page.getByText('Agent not found').count()) fail('"Agent not found" rendered');

  // 2) Sign out while an identity-bound stash points at the deleted agent.
  await page.evaluate(
    ({ agentId: a, userId: u, wsId: w }) =>
      sessionStorage.setItem('post-login-next', JSON.stringify({ next: `/agents/${a}?rail=ask`, u, w })),
    { agentId, userId, wsId },
  );
  await context.request.post(`${BASE}/auth/logout`);
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' }); // mirrors logout()'s href='/'

  // Sign back in through the real password form — also exercises Login's
  // last-agent fallback (map still holds the deleted id for this ws).
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button.btn.primary');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000); // replay gate waits on the agents list
  console.log('post-login url:', page.url());
  if (page.url().includes(`/agents/${agentId}`)) fail('sign-in replayed the deleted-agent stash');
  if (await page.getByText('Agent not found').count()) fail('"Agent not found" after sign-in');
  const stashAfter = await page.evaluate(() => sessionStorage.getItem('post-login-next'));
  if (stashAfter) fail(`stash survived replay: ${stashAfter}`);

  // 3) Legacy plain-string stash must also drop, not replay.
  await page.evaluate(
    (a) => sessionStorage.setItem('post-login-next', `/agents/${a}`),
    agentId,
  );
  await context.request.post(`${BASE}/auth/logout`);
  await login(context); // back in via API — Layout still consumes the stash on mount
  await page.goto(`${BASE}/conversations`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  console.log('legacy-stash url:', page.url());
  if (page.url().includes(`/agents/${agentId}`)) fail('legacy stash replayed');

  if (!process.exitCode) console.log('PASS — deleted agent cannot surface on sign-in');
} finally {
  await browser.close();
}
