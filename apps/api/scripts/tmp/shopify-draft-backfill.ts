// Backfill the dev-store agent whose purpose was silently dropped by the
// link flow's plain POST /api/agents (pre-bootstrap fix). Replays exactly
// what /api/agents/bootstrap does: generateDraft(purpose) → merge into
// config → materialize scenario tests.
import { createDb } from '../../src/db/client.js';
import { agents, agentTests, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { generateDraft } from '../../src/lib/agentBuilder.js';

const SHOP = 'janis-store-sx5bpcd3.myshopify.com';
const PURPOSE = `Storefront assistant for ${SHOP} — answer product questions, look up order status and tracking for customers, help with returns and exchanges, and hand off to the team when a human should take over.`;

const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
if (!shop?.agentId) throw new Error('no bound agent');
const [agent] = await db.select().from(agents).where(eq(agents.id, shop.agentId));
console.log('agent:', agent.name, '| config keys:', Object.keys(agent.config ?? {}));

const draft = await generateDraft(PURPOSE).catch(() => null);
console.log('draft:', draft ? `generated (${draft.name ?? 'no name'})` : 'null — no LLM key?');

const config = {
  purpose: PURPOSE,
  ...(draft?.system_prompt ? { system_prompt: draft.system_prompt } : {}),
  ...(draft?.tone ? { tone: draft.tone } : {}),
  ...(draft?.greeting ? { greeting: draft.greeting, greeting_enabled: true } : {}),
  // keep the tools bindShop installed
  tools: (agent.config as { tools?: unknown[] })?.tools ?? [],
  builder: {
    description: PURPOSE,
    ...(draft?.summary ? { summary: draft.summary } : {}),
    ...(draft?.suggested_knowledge?.length ? { suggested_knowledge: draft.suggested_knowledge } : {}),
    ...(draft?.suggested_templates?.length ? { suggested_templates: draft.suggested_templates } : {}),
    ...(draft?.suggested_approvals?.length ? { suggested_approvals: draft.suggested_approvals } : {}),
    ...(draft?.suggested_rules?.length ? { suggested_rules: draft.suggested_rules } : {}),
    ...(draft?.suggested_questions?.length ? { suggested_questions: draft.suggested_questions } : {}),
    ...(draft?.suggested_scenarios?.length ? { suggested_scenarios: draft.suggested_scenarios } : {}),
    ...(draft?.knowledge_need ? { knowledge_need: draft.knowledge_need } : {}),
    ...(draft?.knowledge_need_reason ? { knowledge_need_reason: draft.knowledge_need_reason } : {}),
    ...(draft?.region_sensitive ? { region_sensitive: true } : {}),
    ...(draft?.domain_risk ? { domain_risk: draft.domain_risk } : {}),
    ...(draft?.suggested_channels?.length ? { suggested_channels: draft.suggested_channels } : {}),
    generated_at: new Date().toISOString(),
  },
};
await db.update(agents).set({ config }).where(eq(agents.id, agent.id));

if (draft?.suggested_scenarios?.length) {
  await db.insert(agentTests).values(
    draft.suggested_scenarios.map((s) => ({
      workspaceId: shop.workspaceId!,
      agentId: agent.id,
      name: s.prompt.slice(0, 120),
      expectation: s.expected,
      turns: [{ role: 'customer' as const, text: s.prompt }] as never,
      category: s.category,
      source: 'generated',
    })),
  );
}
console.log('config backfilled +', draft?.suggested_scenarios?.length ?? 0, 'scenarios materialized');
process.exit(0);
