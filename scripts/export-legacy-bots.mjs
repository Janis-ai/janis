/**
 * Export legacy bots from the wordhopapi MongoDB for import into Janis.
 *
 *   npm i mongodb --no-save   (in repo root — driver isn't a project dep)
 *   MONGODB_URI='mongodb+srv://…' node scripts/export-legacy-bots.mjs > legacy-bots.json
 *     or: node scripts/export-legacy-bots.mjs --out legacy-bots.json
 *
 * The output contains live credentials (FB page tokens, DF service-account
 * keys) — keep it local; legacy-bots*.json is gitignored.
 *
 * Selection: every bot referenced by a slack_integrations doc whose
 * stripe_customer has an active paid subscription (the 12 real payers),
 * plus any extra client keys passed via --key <client_key>.
 */
import { MongoClient } from 'mongodb';
import { writeFileSync } from 'node:fs';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('set MONGODB_URI');
  process.exit(1);
}
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const extraKeys = args.flatMap((a, i) => (a === '--key' ? [args[i + 1]] : []));

const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGO_DB ?? 'wordhopapi');
const si = db.collection('slack_integrations');

// real payers = stripe customers with a successful charge recently.
// Stripe charges are the source of truth; Mongo subs snapshots lie (metered
// subs stay "active" forever at $0). Optional override: --cus cus_xxx …
const cusIds = args.flatMap((a, i) => (a === '--cus' ? [args[i + 1]] : []));

const payerDocs = cusIds.length
  ? await si.find({ 'stripe_customer.id': { $in: cusIds } }).toArray()
  : await si
      .find({
        'stripe_customer.livemode': true,
        'stripe_customer.subscriptions.data': {
          $elemMatch: { status: 'active', 'plan.amount': { $gt: 0 } },
        },
      })
      .toArray();

const keys = [
  ...new Set([
    ...payerDocs.flatMap((d) => (d.bot_subscriptions ?? []).map((b) => b.client_key)),
    ...extraKeys,
  ]),
].filter(Boolean);
console.error(`slack_integrations matched: ${payerDocs.length}, client_keys: ${keys.length}`);

// client_key → legacy Stripe linkage, so migrated bots keep reporting metered
// usage to the subscription they were sold on.
const billingByKey = {};
for (const d of payerDocs) {
  const sc = d.stripe_customer ?? {};
  const sub = (sc.subscriptions?.data ?? []).find((s) => s.status === 'active' || s.status === 'trialing');
  const metered = (sub?.items?.data ?? []).find((i) => i.plan?.usage_type === 'metered');
  for (const b of d.bot_subscriptions ?? []) {
    if (b.client_key && !billingByKey[b.client_key]) {
      billingByKey[b.client_key] = {
        customer_id: sc.id,
        subscription_id: sub?.id ?? null,
        plan: sub?.plan?.nickname ?? null,
        meter_item_id: metered?.id ?? null,
      };
    }
  }
}

const bots = await db
  .collection('bots')
  .find({ client_key: { $in: keys } })
  .toArray();
console.error(`bots resolved: ${bots.length}/${keys.length}`);

// service_account.key is an IAM key resource whose privateKeyData is the
// base64-encoded service-account JSON — decode it to the credential itself.
const decodeSa = (key) => {
  if (!key) return undefined;
  try {
    const parsed = JSON.parse(key);
    if (parsed.privateKeyData) {
      return JSON.parse(Buffer.from(parsed.privateKeyData, 'base64').toString('utf8'));
    }
    if (parsed.private_key) return parsed; // already a SA json
  } catch {}
  return undefined;
};

const records = bots.map((b) => ({
  name: b.name,
  client_key: b.client_key,
  platform: b.platform,
  code_lang: b.code_lang, // 'chatfuel' | 'manychat' | 'nodejs' | ...
  df_project: b.dialogflow?.agent,
  df_lang: b.dialogflow?.agent_object?.defaultLanguageCode,
  sa_email: b.dialogflow?.service_account?.email,
  sa_json: decodeSa(b.dialogflow?.service_account?.key),
  page_token: b.access_token,
  page_id: b.fb_app_id || undefined, // misnamed in legacy schema — it's the page id
  takeover_from_page_inbox: !!b.takeover_from_page_inbox,
  takeover_timeout: b.takeover_timeout,
  secondary_receiver_id: b.secondary_receiver_id,
  manychat_token: b.manychat_token,
  stripe: billingByKey[b.client_key],
}));

const json = JSON.stringify(records, null, 1);
if (out) {
  writeFileSync(out, json);
  console.error(`wrote ${records.length} records → ${out}`);
} else {
  process.stdout.write(json + '\n');
}
await client.close();
