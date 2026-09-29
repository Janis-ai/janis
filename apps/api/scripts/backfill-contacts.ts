/**
 * Backfill the contact spine for conversations that predate it: resolve
 * every channel_binding on a contact-less conversation through
 * contactForBinding, then link the conversation. Idempotent — re-runnable;
 * resolved conversations skip on the next pass.
 *
 *   DATABASE_URL=… npx tsx scripts/backfill-contacts.ts [--workspace <id>]
 */
import { and, eq, isNull } from 'drizzle-orm';
import { agents, channelBindings, conversations } from '../src/db/schema.js';
import { createDb } from '../src/db/client.js';
import { contactForBinding, linkConversationContact } from '../src/lib/contacts.js';
import type { UserProfile } from '@janis/shared';

const wsArg = process.argv.indexOf('--workspace');
const workspaceFilter = wsArg > 0 ? process.argv[wsArg + 1] : undefined;

const db = await createDb();
const rows = await db
  .select({
    conversationId: channelBindings.conversationId,
    channelId: channelBindings.channelId,
    platformUserId: channelBindings.platformUserId,
    workspaceId: agents.workspaceId,
    userProfile: conversations.userProfile,
  })
  .from(channelBindings)
  .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
  .innerJoin(agents, eq(conversations.agentId, agents.id))
  .where(
    and(
      isNull(conversations.contactId),
      ...(workspaceFilter ? [eq(agents.workspaceId, workspaceFilter)] : []),
    ),
  );

console.log(`${rows.length} channel bindings on unlinked conversations`);
let linked = 0;
let skipped = 0;
for (const r of rows) {
  try {
    const contactId = await contactForBinding(db, {
      workspaceId: r.workspaceId,
      channelId: r.channelId,
      platformUserId: r.platformUserId,
      profile: (r.userProfile ?? {}) as UserProfile,
    });
    if (contactId) {
      await linkConversationContact(db, r.conversationId, contactId);
      linked++;
    } else {
      skipped++;
    }
  } catch (err) {
    skipped++;
    console.error(`  ${r.conversationId}: ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`linked ${linked}, skipped ${skipped} (no resolvable identity)`);
process.exit(0);
