/**
 * Snapshot legacy MongoDB collections to "<name>_archived" copies in the
 * same wordhopapi database — originals are left untouched, so the legacy
 * app keeps running until you drop them yourself.
 *
 *   npm i mongodb --no-save   (in repo root — driver isn't a project dep)
 *   MONGODB_URI='mongodb+srv://…' node scripts/archive-legacy-collections.mjs
 *   extra collections: node scripts/archive-legacy-collections.mjs users_v2 bots
 *
 * Idempotent: re-running replaces the archived copy with a fresh snapshot.
 * $out copies documents but NOT indexes — rebuild them by hand if an
 * archive ever gets restored.
 */
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('set MONGODB_URI');
  process.exit(1);
}

const COLLECTIONS = ['user', 'slack_integrations', ...process.argv.slice(2)];

// Per-collection archive filters. `users` is ~12.6M docs of mostly
// anonymous visitors — archive only docs carrying portable contact info
// (any known email/phone path; whole docs kept, structure untouched).
const FILTERS = {
  users: {
    $or: [
      { 'profile.email': { $nin: [null, ''] } },
      { 'google.email': { $nin: [null, ''] } },
      { 'slack.user.profile.email': { $nin: [null, ''] } },
      { 'profile.phone': { $nin: [null, ''] } },
      { 'slack.user.profile.phone': { $nin: [null, ''] } },
    ],
  },
};

const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGO_DB ?? 'wordhopapi');

for (const name of COLLECTIONS) {
  const source = db.collection(name);
  const filter = FILTERS[name] ?? {};
  const total = await source.estimatedDocumentCount();
  console.error(`${name}: copying (${total} total docs)…`);
  await source.aggregate([{ $match: filter }, { $out: `${name}_archived` }]).toArray();
  const archived = await db.collection(`${name}_archived`).countDocuments();
  if (!archived) {
    console.error(`${name}: 0/${total} docs match — archive empty (typo? empty?)`);
    continue;
  }
  console.error(`${name}: ${archived}/${total} docs → ${name}_archived ✓`);
}

await client.close();
console.error('done — originals untouched; drop them separately when ready');
