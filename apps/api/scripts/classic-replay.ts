/**
 * Shadow-replay harness for the classic Slack port.
 *
 *   npx tsx scripts/classic-replay.ts --file fixtures.jsonl [--client-key ck]
 *     [--workspace-id id] [--live] [--out decisions.jsonl]
 *
 * Input: JSONL — one event per line, either
 *   {"message-type":"chat message","body":{...}}   (header + body capture)
 *   {"type":"chat message","msg":{...}}            (normalized)
 *   or a raw legacy event body — its `type`/`message_type` field is used.
 *
 * For each event the harness runs the real dispatch path (handleLegacyEvent)
 * and emits one normalized decision record per line:
 *   {i, type, client_key, posted:[{kind,channel,ts,text}], suppressed:[…], errors:[…]}
 *
 * --dry (default) simulates every Slack API call deterministically — the
 * output is the comparator artifact: feed the same captures at wordhop-slack
 * (its ALERTTRACE logs show the real fan-out) and diff posted/suppressed.
 *
 * --live posts for real — use ONLY against a scratch install/workspace.
 * Without --client-key/--workspace-id, events resolve by their own
 * client_key (the production path).
 */
import '../src/loadEnv.js';
import { createReadStream, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { slackInstallations } from '../src/db/schema.js';
import { dispatchClassicEvent, resolveInstallationByClientKey } from '../src/lib/slackClassic/index.js';
import type { EventType, LegacyEvent } from '../src/lib/slackClassic/types.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const file = opt('--file');
if (!file || !existsSync(file)) {
  console.error('usage: classic-replay --file events.jsonl [--client-key k] [--workspace-id id] [--live] [--out out.jsonl]');
  process.exit(1);
}
const dry = !flag('--live');
const outPath = flag('--out') ? opt('--out') : null;
const clientKeyOverride = opt('--client-key');
const workspaceOverride = opt('--workspace-id');

const db = await createDb();

interface ParsedEvent { type: EventType; msg: LegacyEvent }

function parseLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  let j: any;
  try {
    j = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const type = (j['message-type'] ?? j.type ?? j.message_type) as EventType | undefined;
  const msg = (j.body ?? j.msg ?? j) as LegacyEvent;
  if (!type) return null;
  return { type, msg };
}

function normalizePosted(p: { kind: string; channel?: string; ts?: string; payload?: any }) {
  const text =
    (p.payload?.text as string | undefined) ??
    (p.payload?.attachments?.[0]?.text as string | undefined);
  return { kind: p.kind, channel: p.channel, ts: p.ts, ...(text ? { text: text.slice(0, 200) } : {}) };
}

let count = 0;
let suppressed = 0;
let errored = 0;

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  const ev = parseLine(line);
  if (!ev) continue;
  count++;
  if (clientKeyOverride) ev.msg.client_key = clientKeyOverride;

  let install = null as Awaited<ReturnType<typeof resolveInstallationByClientKey>> | null;
  if (workspaceOverride) {
    const [inst] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.workspaceId, workspaceOverride))
      .limit(1);
    install = inst ? { install: inst, workspacePlan: '' } : null;
  } else if (ev.msg.client_key) {
    install = await resolveInstallationByClientKey(db, String(ev.msg.client_key));
  }

  let record: Record<string, unknown>;
  if (!install) {
    record = { i: count, type: ev.type, client_key: ev.msg.client_key, posted: [], suppressed: [{ reason: 'no installation' }], errors: [] };
  } else {
    const r = await dispatchClassicEvent(db, install.install, ev.type, ev.msg, {
      workspacePlan: install.workspacePlan,
      dry,
    });
    record = {
      i: count,
      type: ev.type,
      client_key: ev.msg.client_key,
      posted: r.posted.map(normalizePosted),
      suppressed: r.suppressed,
      errors: r.errors,
    };
  }
  if ((record.errors as unknown[]).length) errored++;
  if (!(record.posted as unknown[]).length) suppressed++;
  const lineOut = JSON.stringify(record);
  if (outPath) {
    if (count === 1) writeFileSync(outPath, '');
    appendFileSync(outPath, lineOut + '\n');
  }
  console.log(lineOut);
}

console.error(
  `\n${count} events replayed (${dry ? 'dry' : 'LIVE'}): ${count - suppressed} posted, ${suppressed} fully suppressed, ${errored} with errors`,
);
process.exit(0);
