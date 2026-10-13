import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql, eq, desc } from 'drizzle-orm';
import { agents, channels, conversations, messages, agentTestRuns } from '../../src/db/schema.js';

const db = await createDb();
const AGENT = 'fae34af5-2629-4367-b6eb-0e1cb331ef62';

const [ch] = await db.select().from(channels).where(eq(channels.id, '99c3ade8-65c5-4807-8de5-0db0a80e1bf1'));
console.log('CHANNEL', JSON.stringify({ id: ch?.id, kind: ch?.kind, name: ch?.name, creds: ch?.credentials }));

// per-conversation: msg count, last direction, last text, last ts
const rows = await db.execute(sql`
  select c.id, c.external_id, c.created_at,
    (select count(*)::int from messages m where m.conversation_id = c.id) as msgs,
    (select direction from messages m where m.conversation_id = c.id order by created_at desc limit 1) as last_dir,
    (select left(text,120) from messages m where m.conversation_id = c.id order by created_at desc limit 1) as last_text,
    (select created_at from messages m where m.conversation_id = c.id order by created_at desc limit 1) as last_ts
  from conversations c where c.agent_id = ${AGENT}
  order by c.created_at desc limit 20`);
console.log('CONVS', JSON.stringify(rows, null, 1));

// error/issue payloads across the agent's messages
const errs = await db.execute(sql`
  select m.created_at, m.direction, left(m.text,140) as text,
    m.payload->>'run_issues' as issues, m.payload->>'lookup_guard' as lg,
    m.payload->'internal'->>'error' as ierr, m.payload->>'error' as err
  from messages m join conversations c on c.id = m.conversation_id
  where c.agent_id = ${AGENT} and (
    m.payload->>'run_issues' is not null or m.payload->'internal'->>'error' is not null
    or m.payload->>'error' is not null)
  order by m.created_at desc limit 20`);
console.log('ERRS', JSON.stringify(errs, null, 1));

// scenario test runs — was Claude Code driving the eval suite?
const runs = await db
  .select({ id: agentTestRuns.id, status: agentTestRuns.status, startedAt: agentTestRuns.startedAt, finishedAt: agentTestRuns.finishedAt })
  .from(agentTestRuns)
  .where(eq(agentTestRuns.agentId, AGENT))
  .orderBy(desc(agentTestRuns.startedAt))
  .limit(10);
console.log('TESTRUNS', JSON.stringify(runs, null, 1));

process.exit(0);
