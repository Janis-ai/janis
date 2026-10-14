import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { agents, channelBindings, channels, contactIdentities, contacts, conversations, memberships, messages, uploads, users, workspaces } from '../db/schema.js';
import { blessedUrlsFor, buttonLabelOverflow, cardsCoverQuickReplies, channelKeyFor, claimsAction, claimsAnyCatalogueCount, claimsFullCatalogue, claimsPhantomProduct, claimsWidgetShown, claimsWrongCount, complete, controlTag, deniesConfirmedAdd, deniesWidgetShown, extractButtons, extractLearns, fileAnalysisAllowed, filterChipsAgainstCards, fixFullCatalogueClaims, fixWrongCounts, guardReplyLinks, knowledgeQueryFor, listsPricedItems, mergeCardWidgets, promisesLookup, rankDocs, repairCardImages, repairCardStock, saveUserProfile, stripActionClaims, stripEscalationClaims, stripLookupPromises, stripPhantomClaims, stripPricedLists, stripRedundantCardLists, stripTranscriptNotes, stripUnbackedCounts, stripWidgetClaims, systemPrompt, unwrapInlineLists, transcriptFor, verifiedIdentityFor, verifyCardItems } from './hostedAgent.js';
import { extractWidgets } from './widgets.js';
import { newestInboundIsPending } from './convLock.js';

let db: Db;
let convId: string;
let wsId: string;

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  const [ws] = await db.insert(workspaces).values({ name: 'Test', plan: 'pro' }).returning();
  wsId = ws.id;
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: 'h', apiKeyPreview: 'p', hosted: true })
    .returning();
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId: 'webchat:vis1', state: 'active' })
    .returning();
  convId = conv.id;

  await db.insert(uploads).values([
    { filename: 'k-note', name: 'note.txt', type: 'text/plain', size: 17, data: Buffer.from('refund policy: 30d') },
    { filename: 'k-img', name: 'shot.png', type: 'image/png', size: PNG.length, data: PNG },
  ]);

  const atts = (list: { name: string; url: string; type: string; size: number }[]) => ({ attachments: list });
  // Anchor in the past so `new Date()` inserts in later tests sort newest.
  const t0 = Date.now() - 60_000;
  await db.insert(messages).values([
    {
      conversationId: conv.id,
      direction: 'in',
      text: 'here is the file',
      payload: atts([{ name: 'note.txt', url: '/uploads/k-note', type: 'text/plain', size: 17 }]),
      createdAt: new Date(t0),
    },
    {
      conversationId: conv.id,
      direction: 'in',
      text: 'and a screenshot',
      payload: atts([{ name: 'shot.png', url: '/uploads/k-img', type: 'image/png', size: PNG.length }]),
      createdAt: new Date(t0 + 1000),
    },
  ]);
});

describe('transcriptFor file analysis', () => {
  it('inlines text files and image parts when enabled', async () => {
    const history = await transcriptFor(db, convId, true);
    expect(history).toHaveLength(2);

    // text file → content inlined into the text part
    const first = history[0];
    expect(typeof first.content).toBe('string');
    expect(first.content as string).toContain('refund policy: 30d');
    expect(first.content as string).toContain('<file name="note.txt">');

    // image → multipart content with an image_url part
    const second = history[1];
    expect(Array.isArray(second.content)).toBe(true);
    const parts = second.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('and a screenshot');
    const img = parts.find((p) => p.type === 'image_url');
    expect(img).toBeTruthy();
    expect(img!.image_url!.url).toMatch(/^data:image\/png;base64,/); // dev apiOrigin is http → data URI
  });

  it('keeps name annotations when file analysis is off', async () => {
    const history = await transcriptFor(db, convId, false);
    for (const m of history) {
      expect(typeof m.content).toBe('string');
    }
    expect(history[0].content as string).toContain('[attachments: note.txt]');
    expect(history[1].content as string).toContain('[attachments: shot.png]');
  });

  it('annotates missing upload rows instead of dropping the message', async () => {
    await db.insert(messages).values({
      conversationId: convId,
      direction: 'in',
      text: 'gone file',
      payload: { attachments: [{ name: 'gone.pdf', url: '/uploads/k-gone', type: 'application/pdf', size: 10 }] },
      createdAt: new Date(),
    });
    const history = await transcriptFor(db, convId, true);
    const last = history.at(-1)!;
    expect(last.content as string).toContain('[attachments: gone.pdf]');
  });

  it('annotates widget taps with the card they came from', async () => {
    // prod incident: "Choose Free" tapped on a plan card arrived as bare text
    // and the model treated it as an instruction to change the plan.
    await db.insert(messages).values({
      conversationId: convId,
      direction: 'in',
      text: 'Choose Free',
      payload: { tap: true, tap_of: 'Free' },
      createdAt: new Date(),
    });
    const history = await transcriptFor(db, convId, true);
    const last = history.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content as string).toBe('Choose Free [tapped "Free"]');
  });

  it('marks an add-to-cart tap as a confirmed storefront success', async () => {
    // prod incident: "I just added X" arrived annotated only as a pick and
    // the model replied "it's out of stock, it couldn't be added" — a
    // fabricated failure over an event /cart/add.js had already accepted.
    await db.insert(messages).values({
      conversationId: convId,
      direction: 'in',
      text: 'I just added The Inventory Not Tracked Snowboard to my cart.',
      payload: { tap: true, tap_of: 'The Inventory Not Tracked Snowboard — add to cart' },
      createdAt: new Date(),
    });
    const history = await transcriptFor(db, convId, true);
    const last = history.at(-1)!;
    expect(last.content as string).toContain('[added to cart "The Inventory Not Tracked Snowboard"');
    expect(last.content as string).toContain('confirmed');
  });

  it('drops out-direction audit lines but keeps flagged markers and human whispers', async () => {
    // prod incident: a rule_trigger systemNote ('out' + internal) landed after
    // the inbound; transcriptFor fed it as an assistant turn and the reply
    // run's tail check saw the conversation as answered — no reply.
    const t = Date.now();
    await db.insert(messages).values([
      {
        conversationId: convId,
        direction: 'in',
        text: 'still angry',
        createdAt: new Date(t),
      },
      {
        conversationId: convId,
        direction: 'out',
        text: 'Negative sentiment — customer sentiment classified negative',
        payload: { internal: true, event: 'rule_trigger' },
        createdAt: new Date(t + 1),
      },
      {
        conversationId: convId,
        direction: 'out',
        text: 'this is going to a teammate',
        flags: { help_requested: true },
        createdAt: new Date(t + 2),
      },
      {
        conversationId: convId,
        direction: 'human',
        text: 'whisper to the bot',
        payload: { internal: true, via: 'web' },
        createdAt: new Date(t + 3),
      },
    ]);
    const history = await transcriptFor(db, convId, false);
    expect(history.some((m) => String(m.content).includes('Negative sentiment'))).toBe(false);
    expect(history.some((m) => String(m.content).includes('passed to a human teammate'))).toBe(true);
    expect(history.at(-1)!.content as string).toBe('(human operator) whisper to the bot');
  });
});

describe('newestInboundIsPending', () => {
  it('internal notes never mark an inbound answered; real replies do', async () => {
    const [base] = await db.select().from(conversations).where(eq(conversations.id, convId));
    const [c] = await db
      .insert(conversations)
      .values({ agentId: base.agentId, externalId: 'pending-test', state: 'active' })
      .returning();
    const t = Date.now();
    const msg = (direction: string, text: string, offset: number, payload?: object) =>
      db.insert(messages).values({
        conversationId: c.id,
        direction: direction as 'in' | 'out' | 'human',
        text,
        payload,
        createdAt: new Date(t + offset),
      });

    await msg('in', 'are you there?', 0);
    await msg('out', 'Negative sentiment — classified negative', 1, { internal: true, event: 'rule_trigger' });
    await msg('human', 'internal whisper', 2, { internal: true, via: 'web' });
    expect(await newestInboundIsPending(db, c.id)).toBe(true);

    await msg('out', 'sorry about that — how can I help?', 3);
    expect(await newestInboundIsPending(db, c.id)).toBe(false);
  });

  it('a reply shipped after a mid-run inbound does not cover it', async () => {
    const [base] = await db.select().from(conversations).where(eq(conversations.id, convId));
    const [c] = await db
      .insert(conversations)
      .values({ agentId: base.agentId, externalId: 'covers-test', state: 'active' })
      .returning();
    const t = Date.now();
    const msg = (direction: string, text: string, offset: number, payload?: object) =>
      db.insert(messages).values({
        conversationId: c.id,
        direction: direction as 'in' | 'out' | 'human',
        text,
        payload,
        createdAt: new Date(t + offset),
      });

    // The reply was generated when the only inbound was t=0, but shipped at
    // t=3 — after a t=2 inbound landed mid-run. Raw timestamps call t=2
    // answered; covers_through (what the transcript actually contained) is
    // the honest watermark and keeps it pending.
    await msg('in', 'first question', 0);
    await msg('out', 'answer to the first', 3, {
      covers_through: new Date(t).toISOString(),
    });
    await msg('in', 'i want to buy the snowboard', 2);
    expect(await newestInboundIsPending(db, c.id)).toBe(true);

    // A follow-up reply that DID see t=2 clears it.
    await msg('out', 'here is your checkout', 4, {
      covers_through: new Date(t + 2).toISOString(),
    });
    expect(await newestInboundIsPending(db, c.id)).toBe(false);
  });
});

describe('fileAnalysisAllowed', () => {
  it('is paid-plan only', async () => {
    expect(await fileAnalysisAllowed(db, wsId)).toBe(true);
    const [free] = await db.insert(workspaces).values({ name: 'Free', plan: 'free' }).returning();
    expect(await fileAnalysisAllowed(db, free.id)).toBe(false);
    const [unset] = await db.insert(workspaces).values({ name: 'Unset' }).returning();
    expect(await fileAnalysisAllowed(db, unset.id)).toBe(false); // unknown plan → free
  });
});

describe('guardReplyLinks', () => {
  const blessed = ['https://app.janis.ai/agents', 'https://janis.ai/pricing'];
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 404 })); // default: dead link
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps URLs verbatim from the blessed set', async () => {
    const r = await guardReplyLinks('Add one at https://app.janis.ai/agents.', blessed);
    expect(r.text).toBe('Add one at https://app.janis.ai/agents.');
    expect(r.fixed).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps deep links on a blessed domain', async () => {
    const r = await guardReplyLinks('see https://app.janis.ai/settings?x=1', blessed);
    expect(r.text).toContain('https://app.janis.ai/settings?x=1');
  });

  it('swaps a corrupted domain when the path matches a blessed URL', async () => {
    const r = await guardReplyLinks('Go to https://app.native.ai/agents to add one.', blessed);
    expect(r.text).toBe('Go to https://app.janis.ai/agents to add one.');
    expect(r.fixed).toEqual(['https://app.native.ai/agents']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a bare corrupted domain to the first blessed origin', async () => {
    const r = await guardReplyLinks('visit https://native.ai', blessed);
    expect(r.text).toBe('visit https://app.janis.ai/');
    expect(r.fixed).toHaveLength(1);
  });

  it('strips invented URLs that do not resolve', async () => {
    const r = await guardReplyLinks('Check https://evil.example.com/steal for details.', blessed);
    expect(r.text).toBe('Check for details.');
    expect(r.stripped).toEqual(['https://evil.example.com/steal']);
  });

  it('passes an unblessed link that actually resolves', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const r = await guardReplyLinks(
      'listen https://music.apple.com/us/search?term=bobby',
      blessed,
    );
    expect(r.text).toContain('https://music.apple.com/us/search?term=bobby');
    expect(r.verified).toEqual(['https://music.apple.com/us/search?term=bobby']);
  });

  it('keeps but flags a link that cannot be verified', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const r = await guardReplyLinks('see https://blocked.example/x', blessed);
    expect(r.text).toContain('https://blocked.example/x');
    expect(r.unverified).toHaveLength(1);
  });

  it('strips private-network targets without fetching', async () => {
    const r = await guardReplyLinks('hit http://169.254.169.254/latest/meta', blessed);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.stripped).toEqual(['http://169.254.169.254/latest/meta']);
  });

  it('strips console links to invented pages — no fetch needed', async () => {
    const r = await guardReplyLinks(
      'Review your [Approval Center](https://app.janis.ai/settings/approvals) here.',
      blessed,
    );
    expect(r.text).toBe('Review your Approval Center here.');
    expect(r.stripped).toEqual(['https://app.janis.ai/settings/approvals']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips console links carrying an id the model never saw', async () => {
    const ids = new Set(['1fb291f8c3f9422dbf3d09766829efb6']);
    const r = await guardReplyLinks(
      'open https://app.janis.ai/conversations/a630324e25c74ec88677356739906aa3 now',
      blessed,
      { ids },
    );
    expect(r.text).toBe('open now');
    expect(r.stripped).toEqual(['https://app.janis.ai/conversations/a630324e25c74ec88677356739906aa3']);
  });

  it('keeps console links built from context-known ids', async () => {
    const ids = new Set(['1fb291f8c3f9422dbf3d09766829efb6', '586895f382854a95ae2db18f389d838d']);
    const r = await guardReplyLinks(
      'see [the channel](https://app.janis.ai/agents/586895f3-8285-4a95-ae2d-b18f389d838d/channels/1fb291f8-c3f9-422d-bf3d-09766829efb6) ok',
      blessed,
      { ids },
    );
    expect(r.text).toContain('/channels/1fb291f8-c3f9-422d-bf3d-09766829efb6');
    expect(r.stripped).toHaveLength(0);
  });

  it('strips a real-seeming id the resolver says is not a conversation', async () => {
    // Prod incident: the concierge dropped the rail's visitor_id into a
    // /conversations/ slot — a real uuid in context, but the wrong resource.
    const exists = vi.fn(async (kind: string, id: string) =>
      kind === 'conversation' ? false : true,
    );
    const r = await guardReplyLinks(
      'see [the chat](https://app.janis.ai/conversations/a630324e-25c7-4ec8-8677-356739906aa3) ok',
      blessed,
      { exists },
    );
    expect(r.stripped).toEqual(['https://app.janis.ai/conversations/a630324e-25c7-4ec8-8677-356739906aa3']);
    expect(exists).toHaveBeenCalledWith('conversation', 'a630324e-25c7-4ec8-8677-356739906aa3', undefined);
  });

  it('resolver keeps verified console links and checks the parent agent', async () => {
    const exists = vi.fn(async () => true);
    const r = await guardReplyLinks(
      'open https://app.janis.ai/agents/586895f3-8285-4a95-ae2d-b18f389d838d/channels/1fb291f8-c3f9-422d-bf3d-09766829efb6',
      blessed,
      { exists },
    );
    expect(r.stripped).toHaveLength(0);
    expect(exists).toHaveBeenCalledWith('channel', '1fb291f8-c3f9-422d-bf3d-09766829efb6', '586895f3-8285-4a95-ae2d-b18f389d838d');
  });

  it('keeps builder links — /agents/new and /agents/new/<id>?step=teach', async () => {
    const exists = vi.fn(async () => true);
    const r = await guardReplyLinks(
      'start at https://app.janis.ai/agents/new then [Teach it](https://app.janis.ai/agents/new/586895f3-8285-4a95-ae2d-b18f389d838d?step=teach)',
      blessed,
      { exists },
    );
    expect(r.stripped).toHaveLength(0);
    expect(r.text).toContain('/agents/new/586895f3-8285-4a95-ae2d-b18f389d838d?step=teach');
    expect(exists).toHaveBeenCalledWith('agent', '586895f3-8285-4a95-ae2d-b18f389d838d', undefined);
  });

  it('strips /agents/new/<id> when the id is not a real agent', async () => {
    const exists = vi.fn(async () => false);
    const r = await guardReplyLinks(
      'see https://app.janis.ai/agents/new/a630324e-25c7-4ec8-8677-356739906aa3?step=teach',
      blessed,
      { exists },
    );
    expect(r.stripped).toHaveLength(1);
  });

  it('strips route-template placeholders shipped verbatim — <id>, %3Cid%3E, {agent-id}', async () => {
    // Regression: the concierge copied the pattern /agents/<id>/… into a
    // reply; LINK_RE stops at '<' so only the /agents/ prefix was judged.
    const r = await guardReplyLinks(
      'open [Overview](https://app.janis.ai/agents/<id>) and [Exp](https://app.janis.ai/agents/%3Cid%3E/behavior?sub=instructions) and https://app.janis.ai/agents/{agent-id}/tests now',
      blessed,
    );
    expect(r.text).toBe('open Overview and Exp and now');
    expect(r.stripped).toHaveLength(3);
  });

  it('normalizes relative console paths into absolute links', async () => {
    // Regression: the concierge hedged agent links as backticked relative
    // paths (`/agents/id/behavior`) — invisible to LINK_RE, unclickable.
    const exists = vi.fn(async () => true);
    const r = await guardReplyLinks(
      'see [Exp](/agents/586895f3-8285-4a95-ae2d-b18f389d838d/behavior) and `/agents/586895f3-8285-4a95-ae2d-b18f389d838d/knowledge` and /reports',
      blessed,
      { exists },
    );
    expect(r.text).toContain('[Exp](http://localhost:5173/agents/586895f3-8285-4a95-ae2d-b18f389d838d/behavior)');
    expect(r.text).toContain(
      '[`/agents/586895f3-8285-4a95-ae2d-b18f389d838d/knowledge`](http://localhost:5173/agents/586895f3-8285-4a95-ae2d-b18f389d838d/knowledge)',
    );
    expect(r.text).toContain('[`/reports`](http://localhost:5173/reports)');
    expect(r.stripped).toHaveLength(0);
    expect(exists).toHaveBeenCalledWith('agent', '586895f3-8285-4a95-ae2d-b18f389d838d', undefined);
  });

  it('strips an invalid relative console path after normalization', async () => {
    const exists = vi.fn(async () => false);
    const r = await guardReplyLinks(
      'see `/agents/586895f3-8285-4a95-ae2d-b18f389d838d/behavior` here',
      blessed,
      { exists },
    );
    expect(r.stripped).toHaveLength(1);
    expect(r.text).toBe('see `/agents/586895f3-8285-4a95-ae2d-b18f389d838d/behavior` here');
  });

  it('does not rewrite paths inside absolute URLs or non-console roots', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const r = await guardReplyLinks(
      'docs https://example.com/agents/guide and api /v1/events',
      blessed,
    );
    expect(r.text).toContain('https://example.com/agents/guide');
    expect(r.text).toContain('/v1/events');
    expect(r.text).not.toContain('localhost:5173/v1');
  });

  it('unwraps markdown links emptied by a strip', async () => {
    const r = await guardReplyLinks('see [this page](https://bogus.io/deep/path) now', blessed);
    expect(r.text).toBe('see this page now');
  });

  it('blesses customer-shared links, tool endpoints, and config domains', async () => {
    const agent = {
      config: {
        allowed_link_domains: ['ups.com'],
        tools: [{ name: 'lookup', url: 'https://api.shop.example/lookup', method: 'GET' }],
      },
    } as never;
    const urls = blessedUrlsFor(agent, 'prompt https://app.janis.ai/agents', [
      { role: 'user', content: 'my tracking link https://tracking.ups.com/1Z999' },
    ]);
    // customer-shared link echoes back fine
    expect(
      (await guardReplyLinks('your tracking: https://tracking.ups.com/1Z999', urls)).stripped,
    ).toHaveLength(0);
    // config-blessed domain (tool return values) and the tool's own origin pass
    expect((await guardReplyLinks('see https://ups.com/hub/1Z999', urls)).stripped).toHaveLength(0);
    expect(
      (await guardReplyLinks('via https://api.shop.example/item/5', urls)).stripped,
    ).toHaveLength(0);
    // subdomains of a blessed domain count; lookalikes get checked (dead → strip)
    expect(
      (await guardReplyLinks('via https://static.api.shop.example/img.png', urls)).stripped,
    ).toHaveLength(0);
    expect(
      (await guardReplyLinks('no https://notshop.example/x', urls)).stripped,
    ).toHaveLength(1);
    // but an invented link is still caught
    expect((await guardReplyLinks('bad https://evil.io/x', urls)).stripped).toHaveLength(1);
  });

  it('does not bless links from the model\'s own earlier replies', async () => {
    // A mangled id in a previous assistant message must not re-enter as
    // "context" — only inbound turns and tool results count as sources.
    const urls = blessedUrlsFor(
      { config: {} } as never,
      'prompt https://app.janis.ai/agents',
      [
        { role: 'assistant', content: 'see https://bogus.example.com/dead' },
        { role: 'user', content: 'mine: https://real.example.com/page' },
      ],
    );
    expect(urls.some((u) => u.includes('bogus.example.com'))).toBe(false);
    expect(urls).toContain('https://real.example.com/page');
  });
});

describe('controlTag', () => {
  it('detects misspelled handoff tokens and strips them', () => {
    // prod incident: the model emitted [HANDOF] — exact-match parsing
    // delivered the raw tag to the customer and skipped the escalation
    const r = controlTag("I've alerted the team again. A human teammate will be with you shortly![HANDOF]");
    expect(r?.kind).toBe('handoff');
    expect(r?.partial).toBe("I've alerted the team again. A human teammate will be with you shortly!");
  });

  it('classifies each control token', () => {
    expect(controlTag('bringing in a human [HANDOFF]')?.kind).toBe('handoff');
    expect(controlTag('want me to ask? [OFFER_HUMAN]')?.kind).toBe('offer');
    expect(controlTag('got it [CANCEL_HANDOFF]')?.kind).toBe('cancel');
    // a cancel tag contains HANDOF — must not misclassify as handoff
    expect(controlTag('ok [CANCEL_HANDOF]')?.kind).toBe('cancel');
    expect(controlTag('ok [ofer human]')?.kind).toBe('offer');
  });

  it('returns null for plain replies and strips every occurrence', () => {
    expect(controlTag('Just a normal answer.')).toBeNull();
    expect(controlTag('[HANDOFF]').partial).toBe('');
    expect(controlTag('a [HANDOF] b [handoff] c').partial).toBe('a  b  c');
  });
});

describe('controlTag end-of-chat', () => {
  it('recognises [END_CHAT] as an end tag with the sign-off as partial', () => {
    const t = controlTag('Glad that sorted it — have a great day!\n[END_CHAT]');
    expect(t?.kind).toBe('end');
    expect(t?.partial).toBe('Glad that sorted it — have a great day!');
  });
});

describe('stripTranscriptNotes', () => {
  it('removes parroted approval annotations from replies', () => {
    // prod incident: the concierge learned "(an action was submitted for
    // teammate approval)" from transcript context and emitted it as reply
    // text when it narrated a card it never submitted.
    expect(
      stripTranscriptNotes(
        "(an action was submitted for teammate approval) I've proposed that for you.",
      ),
    ).toBe("I've proposed that for you.");
    expect(
      stripTranscriptNotes('Done. (a proposal card was shown — awaiting approval)'),
    ).toBe('Done.');
  });

  it('leaves normal parentheticals alone', () => {
    expect(stripTranscriptNotes('Sure (no problem) — done.')).toBe('Sure (no problem) — done.');
  });
});

describe('stripEscalationClaims', () => {
  it('drops an untagged human promise, keeps the rest', () => {
    // prod incident: customer tapped "No thanks" on a human offer; the
    // reply still read "let me get you connected with a human teammate".
    const r = stripEscalationClaims(
      'I hear you, Michael, and I apologize for the trouble. ' +
        "Since you'd rather not share a photo right now, let me get you " +
        'connected with a human teammate who can help you process your ' +
        'return directly.',
    );
    expect(r.stripped).toBe(1);
    expect(r.text).toBe('I hear you, Michael, and I apologize for the trouble.');
  });

  it('catches the common claim phrasings', () => {
    for (const s of [
      'A human teammate will reach out shortly.',
      "I'll transfer you to a specialist right away.",
      'Let me hand you over to our support team.',
      'Someone from our team will be in touch soon.',
      "I'm connecting you with a human agent now.",
      'We can escalate this to a representative for you.',
    ]) {
      expect(stripEscalationClaims(s).text).toBe('');
    }
  });

  it('leaves questions and non-escalation text alone', () => {
    for (const s of [
      'Would you like me to get a human?',
      'Our support team is available weekdays 9-5.',
      'Your return window is 30 days.',
      'I can help you with that directly.',
    ]) {
      expect(stripEscalationClaims(s).stripped).toBe(0);
    }
  });

  it('preserves line breaks when nothing is stripped', () => {
    // Regression: the old join(' ') flattened every plain reply's newlines,
    // undoing the model's lists AND unwrapInlineLists' output.
    const list = 'Options:\n- **Free**: $0/mo\n- **Pro**: $99/mo\n\nPick one?';
    expect(stripEscalationClaims(list)).toEqual({ text: list, stripped: 0 });
  });

  it('strips a claim on one line without flattening the rest', () => {
    const r = stripEscalationClaims(
      'Here are your plans:\n- Free\n- Pro\nI will connect you with a human teammate now.',
    );
    expect(r.stripped).toBe(1);
    expect(r.text).toBe('Here are your plans:\n- Free\n- Pro');
  });
});

describe('claimsAction / stripActionClaims', () => {
  it('catches the confabulated plan-change phrasings', () => {
    // prod incident: a "Choose Free" card tap on Messenger produced
    // "I've set your plan to Free" with zero tool calls.
    for (const s of [
      "I've set your plan to Free.",
      'I have updated the email on your account.',
      'Your subscription has been cancelled.',
      'The refund was processed — allow 5 days.',
      'Your plan is now on the Free tier.',
      'That change will take effect on your next billing cycle.',
      "I've gone ahead and switched you to the Free plan.",
    ]) {
      expect(claimsAction(s), s).toBe(true);
    }
  });

  it('leaves offers, questions and negations alone', () => {
    for (const s of [
      'I can help you change your plan from your billing page.',
      'Would you like me to walk you through cancelling?',
      "I haven't changed anything on your account.",
      'I cannot update your plan from here.',
      'To switch plans, head to Settings → Billing.',
      'The Pro plan includes unlimited seats.',
      'Your workspace might have several agents.',
    ]) {
      expect(claimsAction(s), s).toBe(false);
    }
  });

  it('strips only the claiming sentences', () => {
    const stripped = stripActionClaims(
      "I've set your plan to Free. If you'd like to move to a different " +
        'workspace, let me know which one.',
    );
    expect(stripped).toBe(
      "If you'd like to move to a different workspace, let me know which one.",
    );
  });
});

describe('claimsWidgetShown / deniesWidgetShown', () => {
  it('catches claims of components that were never emitted', () => {
    for (const s of [
      'Here are the cards for each plan.',
      'Here is the picker I built for you.',
      "I've added a form below for your details.",
      'The buttons above let you pick a plan.',
    ]) {
      expect(claimsWidgetShown(s), s).toBe(true);
      expect(deniesWidgetShown(s), s).toBe(false);
    }
  });

  it('catches apologies for components that did render', () => {
    for (const s of [
      "It looks like the buttons didn't render — sorry about that.",
      "The card doesn't seem to show up in this chat.",
      "I couldn't display the form here.",
      'The widget failed to render just now.',
    ]) {
      expect(deniesWidgetShown(s), s).toBe(true);
      expect(claimsWidgetShown(s), s).toBe(false);
    }
  });

  it('leaves ordinary text and text-choices alone', () => {
    for (const s of [
      'Here are your options: 1) refund 2) exchange.',
      'You can pick either plan — both work.',
      'The list above shows your orders.',
      'I can show you pricing if you like.',
    ]) {
      expect(claimsWidgetShown(s), s).toBe(false);
      expect(deniesWidgetShown(s), s).toBe(false);
    }
  });

  it('strips only the offending sentences', () => {
    expect(
      stripWidgetClaims(
        "Here are the cards for each plan. The Free tier covers 1 agent. Let me know if you'd like details.",
      ),
    ).toBe("The Free tier covers 1 agent. Let me know if you'd like details.");
  });
});

describe('promisesLookup / stripLookupPromises', () => {
  it('catches deferred-lookup narration that can never be fulfilled', () => {
    // prod incident (Jerry Garcia): "first, let me grab my calendar
    // connection. Give me just a second!" — tools: [], nothing ever ran.
    for (const s of [
      'Let me grab my calendar connection.',
      'Give me just a second!',
      'One moment while I look that up.',
      "I'll check and get back to you.",
      "Hang on, I'll pull that up.",
      "Let's see — I'll look into it.",
      'Bear with me for a moment.',
      'Let me verify that for you.',
    ]) {
      expect(promisesLookup(s), s).toBe(true);
    }
  });

  it('leaves direct answers, questions and negations alone', () => {
    for (const s of [
      'The next open slot is Tuesday at 2pm.',
      'Would you like me to check availability?',
      "I can't check that from here.",
      'I checked your order — it ships tomorrow.',
      'Here is what I found in the docs.',
      'Let me know if you need anything else.',
      'It takes me a second to explain.',
    ]) {
      expect(promisesLookup(s), s).toBe(false);
    }
  });

  it('strips only the narration sentences', () => {
    const stripped = stripLookupPromises(
      "I would love to chat! I'm always down to talk music.\n\n" +
        "Let's check out what times are open—first, let me grab my calendar connection. Give me just a second!",
    ).trim();
    expect(stripped).toBe("I would love to chat! I'm always down to talk music.");
  });
});

describe('rankDocs', () => {
  const docs = [
    { name: 'Shipping policy', text: 'We ship worldwide. Parcels leave the warehouse within 2 business days.' },
    { name: 'Returns', text: 'Returns are accepted within 30 days of delivery. Start a return from your account page.' },
    { name: 'Billing FAQ', text: 'Invoices are issued monthly. Update your card under Settings → Billing.' },
  ];

  it('ranks the doc matching the conversation first', () => {
    const r = rankDocs(docs, 'hi — how do I return an order? does the return window apply?');
    expect(r[0].name).toBe('Returns');
  });

  it('title hits outrank incidental body mentions', () => {
    const withIncidental = [
      { name: 'Getting started', text: 'Billing billing billing billing is mentioned a lot here.' },
      { name: 'Billing FAQ', text: 'One billing note.' },
    ];
    const r = rankDocs(withIncidental, 'billing question');
    expect(r[0].name).toBe('Billing FAQ');
  });

  it('keeps original order when the query matches nothing or is absent', () => {
    expect(rankDocs(docs, 'zqxwv unmatchable jjj').map((d) => d.name)).toEqual(
      docs.map((d) => d.name),
    );
    expect(rankDocs(docs, '').map((d) => d.name)).toEqual(docs.map((d) => d.name));
  });

  it('zero-score docs trail ranked ones as budget filler', () => {
    const r = rankDocs(docs, 'return policy please');
    // Returns first, the two unmatched docs keep their original order after.
    expect(r.map((d) => d.name)).toEqual(['Returns', 'Shipping policy', 'Billing FAQ']);
  });

  it('length-normalizes so a giant index page cannot outrank a focused doc on bulk', () => {
    const fat = {
      name: 'Terms and conditions',
      text: `one bedroom mention. ${'legal boilerplate '.repeat(3000)}`,
    };
    const focused = {
      name: '44 Moberly Ave',
      text: 'one bedroom mention. detached, 2 storey, great yard.',
    };
    const r = rankDocs([fat, focused], 'bedroom');
    expect(r[0].name).toBe('44 Moberly Ave');
  });
});

describe('cardsCoverQuickReplies', () => {
  const cards = (withSelect: boolean) => [
    {
      type: 'cards' as const,
      items: [
        {
          title: 'T',
          ...(withSelect ? { select_label: 'Tell me more' } : {}),
        },
      ],
    },
  ];

  it('suppresses chips on webchat when card items carry select_label', () => {
    expect(cardsCoverQuickReplies('webchat', cards(true))).toBe(true);
  });

  it('keeps chips when cards have no select actions', () => {
    expect(cardsCoverQuickReplies('webchat', cards(false))).toBe(false);
  });

  it('keeps chips on cart cards — their dupes are filtered per-label instead', () => {
    const w = [
      {
        type: 'cards' as const,
        items: [{ title: 'T', cart_variant_id: '123' }],
      },
    ];
    expect(cardsCoverQuickReplies('webchat', w)).toBe(false);
  });

  it('keeps chips on channels where cards do not render', () => {
    expect(cardsCoverQuickReplies('sms', cards(true))).toBe(false);
    expect(cardsCoverQuickReplies('email', cards(true))).toBe(false);
  });

  it('keeps chips when there are no widgets at all', () => {
    expect(cardsCoverQuickReplies('webchat', [])).toBe(false);
  });
});

describe('filterChipsAgainstCards', () => {
  const productCards = [
    {
      type: 'cards' as const,
      items: [
        {
          title: 'The Videographer Snowboard',
          link: 'https://shop.example/products/videographer',
          link_label: 'View product',
          cart_variant_id: '123',
        },
      ],
    },
  ];

  it('drops chips that restate a card action, keeps offers the card can\'t answer', () => {
    const kept = filterChipsAgainstCards(
      ['View product', 'Add to cart', 'Yes, set it up'],
      productCards,
    );
    expect(kept).toEqual(['Yes, set it up']);
  });

  it('drops a chip that restates the product title', () => {
    expect(
      filterChipsAgainstCards(['Buy The Videographer Snowboard'], productCards),
    ).toEqual([]);
  });

  it('keeps short yes/no chips — substring coincidence is guarded', () => {
    expect(filterChipsAgainstCards(['Yes', 'No thanks'], productCards)).toEqual([
      'Yes',
      'No thanks',
    ]);
  });

  it('passes everything through when no cards render', () => {
    expect(filterChipsAgainstCards(['View product'], [])).toEqual(['View product']);
  });
});

describe('repairCardImages', () => {
  const DOC_URL = 'https://site.example/properties/oak-st';
  const DOC_IMG = 'https://cdn.example/oak-real.jpg';
  const docs = [
    { name: DOC_URL, text: `Image: ${DOC_IMG}\n3 beds, 2 baths.` },
    { name: 'https://site.example/properties/no-photo', text: 'Text only doc.' },
    { name: 'https://site.example/properties/other', text: 'Image: https://cdn.example/other.jpg\nOther.' },
  ];
  const card = (items: Record<string, unknown>[]) => ({
    type: 'cards' as const,
    items: items as never,
  });

  it('fills the doc\u2019s own image when the model omitted it', () => {
    const w = [card([{ title: 'Oak', link: DOC_URL }])];
    repairCardImages(w, docs, []);
    expect(w[0].items[0]).toMatchObject({ image: DOC_IMG });
  });

  it('repairs a corrupted image URL to the doc\u2019s real one', () => {
    const mangled = 'https://cdn.example/oak-real.jpg'.replace('cdn.example', 'cdn'); // lp-cdn.com/media → lp-cdn/media style slip
    const w = [card([{ title: 'Oak', link: DOC_URL, image: mangled }])];
    repairCardImages(w, docs, []);
    expect(w[0].items[0]).toMatchObject({ image: DOC_IMG });
  });

  it('drops an image borrowed from a different doc on a no-image doc card', () => {
    const w = [
      card([
        {
          title: 'NoPhoto',
          link: 'https://site.example/properties/no-photo',
          image: 'https://cdn.example/other.jpg',
        },
      ]),
    ];
    repairCardImages(w, docs, []);
    expect(w[0].items[0]).not.toHaveProperty('image');
  });

  it('drops a fabricated or borrowed image on a non-doc card', () => {
    const w = [
      card([
        { title: 'External', link: 'https://elsewhere.example/x', image: 'https://cdn.example/other.jpg' },
        { title: 'Invented', link: 'https://elsewhere.example/y', image: 'https://made.up/x.png' },
      ]),
    ];
    repairCardImages(w, docs, []);
    for (const i of w[0].items as { image?: string }[]) expect(i.image).toBeUndefined();
  });

  it('keeps context-verbatim images on non-doc cards (tool output)', () => {
    const w = [
      card([{ title: 'Product', link: 'https://shop.example/p/1', image: 'https://cdn.shopify.com/tee.png' }]),
    ];
    repairCardImages(w, docs, ['https://cdn.shopify.com/tee.png']);
    expect(w[0].items[0]).toMatchObject({ image: 'https://cdn.shopify.com/tee.png' });
  });

  it('leaves resolved saved-component specs alone', () => {
    const w = [card([{ title: 'Designed', link: DOC_URL, image: 'https://assets.example/hero.png' }])];
    repairCardImages(w, docs, [], new Set(w));
    expect(w[0].items[0]).toMatchObject({ image: 'https://assets.example/hero.png' });
  });
});

describe('verifyCardItems', () => {
  // The tool-result corpus a Shopify product search produces — items check
  // their catalog fields against it.
  const TOOL_TEXT = JSON.stringify({
    data: {
      products: {
        nodes: [
          { title: 'Gift Card', handle: 'gift-card', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/111', availableForSale: false }] } },
          { title: 'The Snowboard', handle: 'the-snowboard', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/222', availableForSale: true }] } },
        ],
      },
    },
  });
  const card = (items: Record<string, unknown>[]) => ({ type: 'cards' as const, items: items as never });

  it('keeps catalog items that trace to the run\u2019s tool results', () => {
    const w = [card([{ title: 'Gift Card', cart_variant_id: '111', stock: 'Out of stock' }])];
    expect(verifyCardItems(w, TOOL_TEXT)).toBe(0);
    expect(w[0].items).toHaveLength(1);
  });

  it('drops items whose variant id was never in a tool result', () => {
    const w = [
      card([
        { title: 'Gift Card', cart_variant_id: '111' },
        { title: 'Invented Board', cart_variant_id: '999' },
      ]),
    ];
    expect(verifyCardItems(w, TOOL_TEXT)).toBe(1);
    expect(w[0].items).toHaveLength(1);
    expect((w[0].items[0] as { title: string }).title).toBe('Gift Card');
  });

  it('drops the whole widget when every catalog item is unverifiable', () => {
    const w = [card([{ title: 'Fake', cart_variant_id: '999', stock: 'Out of stock' }])];
    verifyCardItems(w, TOOL_TEXT);
    expect(w).toHaveLength(0);
  });

  it('leaves non-catalog items alone (editorial cards, plans)', () => {
    const w = [card([{ title: 'Pro Plan', price: '$29', link: 'https://site.example/pro' }])];
    expect(verifyCardItems(w, '')).toBe(0);
    expect(w[0].items).toHaveLength(1);
  });

  it('leaves resolved saved-component specs alone', () => {
    const w = [card([{ title: 'Fake', cart_variant_id: '999' }])];
    expect(verifyCardItems(w, TOOL_TEXT, new Set(w))).toBe(0);
    expect(w[0].items).toHaveLength(1);
  });
});

describe('repairCardStock', () => {
  const TOOL_TEXT = JSON.stringify({
    data: {
      products: {
        nodes: [
          { title: 'Gift Card', variants: { nodes: [{ availableForSale: false }] } },
          {
            title: 'The Snowboard',
            priceRangeV2: { minVariantPrice: { amount: '885.95', currencyCode: 'USD' } },
            variants: { nodes: [{ id: 'gid://shopify/ProductVariant/222', availableForSale: true, price: '885.95' }] },
          },
        ],
      },
    },
  });
  const card = (items: Record<string, unknown>[]) => ({ type: 'cards' as const, items: items as never });

  it('forces the Out of stock badge onto a buyable-looking card for an OOS product', () => {
    const w = [card([{ title: 'Gift Card', price: '$10.00', link: 'https://s.test/p/gc' }])];
    expect(repairCardStock(w, TOOL_TEXT)).toBe(1);
    expect((w[0].items[0] as { stock?: string }).stock).toBe('Out of stock');
  });

  it('strips a fabricated Out of stock badge from an in-stock product', () => {
    const w = [card([{ title: 'The Snowboard', stock: 'Out of stock' }])];
    // badge stripped + variant id + formatted price hydrated
    expect(repairCardStock(w, TOOL_TEXT)).toBe(3);
    expect((w[0].items[0] as { stock?: string }).stock).toBeUndefined();
    expect((w[0].items[0] as { cart_variant_id?: string }).cart_variant_id).toBe('222');
    expect((w[0].items[0] as { price?: string }).price).toBe('$885.95');
  });

  it('leaves cards for products the corpus does not know alone', () => {
    const w = [card([{ title: 'Pro Plan', price: '$29' }])];
    expect(repairCardStock(w, TOOL_TEXT)).toBe(0);
    expect(w[0].items).toHaveLength(1);
  });

  it('drops a subtitle that duplicates the price', () => {
    const w = [card([{ title: 'Gift Card', subtitle: 'USD 10.0', price: 'USD 10.0', stock: 'Out of stock' }])];
    repairCardStock(w, TOOL_TEXT);
    expect((w[0].items[0] as { subtitle?: string }).subtitle).toBeUndefined();
  });

  it('hydrates the variant id onto a buyable hand-authored card', () => {
    const w = [card([{ title: 'The Snowboard', price: 'USD 885.95' }])];
    repairCardStock(w, TOOL_TEXT);
    expect((w[0].items[0] as { cart_variant_id?: string }).cart_variant_id).toBe('222');
    expect((w[0].items[0] as { price?: string }).price).toBe('$885.95');
  });

  it('never hydrates a variant id onto an out-of-stock card', () => {
    const w = [card([{ title: 'Gift Card', cart_variant_id: '999' }])];
    repairCardStock(w, TOOL_TEXT);
    expect((w[0].items[0] as { cart_variant_id?: string }).cart_variant_id).toBeUndefined();
    expect((w[0].items[0] as { stock?: string }).stock).toBe('Out of stock');
  });
});

describe('listsPricedItems / stripPricedLists', () => {
  const dump =
    'Here are our products:\n' +
    '- The 3p Fulfilled Snowboard ($2629.95)\n' +
    '- The Collection Snowboard: Hydrogen ($600.00)\n' +
    '- The Hidden Snowboard ($749.95)\n' +
    'Anything else I can help with?';

  it('flags a priced catalogue dump, not prose or a one-item line', () => {
    expect(listsPricedItems(dump)).toBe(true);
    expect(listsPricedItems('We carry a great snowboard — want a look?')).toBe(false);
    expect(listsPricedItems('- The Snowboard ($885.95)')).toBe(false);
  });

  it('drops the whole run and its dangling lead-in', () => {
    const out = stripPricedLists(dump);
    expect(out).not.toContain('Snowboard ($');
    expect(out).not.toContain('Here are our products:');
    expect(out).toContain('Anything else I can help with?');
  });

  it('keeps an unpriced list and priced prose', () => {
    expect(stripPricedLists('Options:\n- red\n- blue')).toBe('Options:\n- red\n- blue');
    expect(stripPricedLists('It costs $10.00 total.')).toBe('It costs $10.00 total.');
  });
});

describe('stripRedundantCardLists', () => {
  const titles = new Set(['the videographer snowboard', 'the complete snowboard']);
  const dupe =
    'Here are some of our available products:\n' +
    '- The Videographer Snowboard ($885.95)\n' +
    '- The Complete Snowboard ($699.95)\n' +
    'Want a closer look at either?';

  it('drops a list that restates the rendered cards, lead-in included', () => {
    const out = stripRedundantCardLists(dupe, titles);
    expect(out).not.toContain('Videographer Snowboard ($');
    expect(out).not.toContain('available products:');
    expect(out).toContain('Want a closer look at either?');
  });

  it('keeps lists that are not the carousel', () => {
    const other = 'Steps:\n- pick a size\n- add to cart';
    expect(stripRedundantCardLists(other, titles)).toBe(other);
    // a single matching line inside a mostly-other list survives
    const mixed = '- The Videographer Snowboard\n- some accessory\n- another thing';
    expect(stripRedundantCardLists(mixed, titles)).toBe(mixed);
  });

  it('returns text unchanged with no cards', () => {
    expect(stripRedundantCardLists(dupe, new Set())).toBe(dupe);
  });
});

describe('mergeCardWidgets', () => {
  const card = (items: Record<string, unknown>[]) => ({ type: 'cards' as const, items: items as never });

  it('merges adjacent cards widgets into one carousel', () => {
    const out = mergeCardWidgets([
      card([{ title: 'A' }]),
      card([{ title: 'B' }]),
      { type: 'options' as const, items: [{ label: 'x' }] },
      card([{ title: 'C' }]),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].type === 'cards' && out[0].items.map((i) => i.title)).toEqual(['A', 'B']);
    // Non-adjacent cards stay separate (an options widget sits between).
    expect(out[2].type === 'cards' && out[2].items[0].title).toBe('C');
  });
});

describe('knowledgeQueryFor', () => {
  it('uses recent customer messages plus the conversation summary', () => {
    const conv = { agentSummary: 'customer is asking about a refund' } as Parameters<
      typeof knowledgeQueryFor
    >[1];
    const q = knowledgeQueryFor(
      [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'where is my refund' },
      ],
      conv,
    );
    expect(q).toContain('refund');
    expect(q).toContain('first question');
    expect(q).not.toContain('answer');
  });
});

describe('extractLearns', () => {
  it('strips LEARN lines from the reply and returns them', () => {
    const r = extractLearns('Here is your answer.\nLEARN: returns are 30 days\nlearn: see /returns');
    expect(r.text).toBe('Here is your answer.');
    expect(r.learns).toEqual(['returns are 30 days', 'see /returns']);
  });

  it('leaves plain replies untouched', () => {
    const r = extractLearns('Nothing to learn here.');
    expect(r.text).toBe('Nothing to learn here.');
    expect(r.learns).toHaveLength(0);
  });
});

describe('extractButtons', () => {
  it('strips BUTTON lines into tappable labels', () => {
    const r = extractButtons(
      'Want your email on file?\nBUTTON: Sure, take it\nbutton: Not now',
    );
    expect(r.text).toBe('Want your email on file?');
    expect(r.buttons).toEqual(['Sure, take it', 'Not now']);
  });

  it('caps at 4 buttons and keeps labels intact past 20 chars', () => {
    const r = extractButtons(
      'pick one\nBUTTON: a\nBUTTON: No, try something else\nBUTTON: c\nBUTTON: d\nBUTTON: e',
    );
    expect(r.buttons).toEqual(['a', 'No, try something else', 'c', 'd']);
    expect(r.text).toBe('pick one');
  });

  it('word-boundary-trims pathological labels past 60 chars', () => {
    const long = 'this button label is far too long to ever fit on a chat chip anywhere';
    const r = extractButtons(`x\nBUTTON: ${long}`);
    expect(r.buttons).toEqual(['this button label is far too long to ever fit on a chat']);
  });

  it('derives the channel key from profile or externalId', () => {
    expect(channelKeyFor({ externalId: 'whatsapp:+1555', userProfile: null } as never)).toBe('whatsapp');
    expect(channelKeyFor({ externalId: 'web:abc', userProfile: { channel: 'webchat' } } as never)).toBe('webchat');
    expect(channelKeyFor(undefined)).toBe('external');
  });

  it('flags labels over the Meta 20-char display cap', () => {
    expect(buttonLabelOverflow(['No, try something else'])).toBe(true);
    expect(buttonLabelOverflow(['No, try something', 'ok'])).toBe(false);
    expect(buttonLabelOverflow([{ type: 'email' }, 'a'.repeat(25)])).toBe(true);
    expect(buttonLabelOverflow([])).toBe(false);
  });

  it('turns ASK lines into contact-field quick replies', () => {
    const r = extractButtons(
      'Could I get your email?\nASK: email\nBUTTON: skip for now\nask: phone',
    );
    expect(r.text).toBe('Could I get your email?');
    expect(r.buttons).toEqual([{ type: 'email' }, 'skip for now', { type: 'phone' }]);
  });
});

describe('extractWidgets', () => {
  it('strips WIDGET lines into validated components', () => {
    const r = extractWidgets(
      'Here are the plans:\nWIDGET: {"type":"options","title":"Pick a slot","items":[{"label":"Tue 3pm"},{"label":"Wed 10am","description":"with Dr. Lee"}]}',
    );
    expect(r.text).toBe('Here are the plans:');
    expect(r.widgets).toEqual([
      {
        type: 'options',
        title: 'Pick a slot',
        items: [{ label: 'Tue 3pm' }, { label: 'Wed 10am', description: 'with Dr. Lee' }],
      },
    ]);
  });

  it('drops malformed JSON and schema violations without leaking them', () => {
    const r = extractWidgets(
      'reply text\nWIDGET: {not json\nWIDGET: {"type":"options","items":[]}\nWIDGET: {"type":"nonsense"}',
    );
    expect(r.text).toBe('reply text');
    expect(r.widgets).toEqual([]);
  });

  it('caps at 3 widgets and accepts every component type', () => {
    const card = 'WIDGET: {"type":"cards","items":[{"title":"Shoe","price":"$40","link":"https://x.com/p","select_label":"Buy"}]}';
    const form = 'WIDGET: {"type":"form","title":"Support","fields":[{"name":"email","label":"Email","type":"email","required":true}]}';
    const status = 'WIDGET: {"type":"status","steps":[{"label":"Filed","state":"done"},{"label":"Review","state":"current"}]}';
    const receipt = 'WIDGET: {"type":"receipt","rows":[{"label":"Shoes","value":"$40"}],"total":{"label":"Total","value":"$40"}}';
    const r = extractWidgets(`x\n${card}\n${form}\n${status}\n${receipt}`);
    // four emitted, capped at three — the receipt line is dropped
    expect(r.widgets.map((w) => w.type)).toEqual(['cards', 'form', 'status']);
    expect(r.text).toBe('x');
  });
});

describe('testRun tool stubbing', () => {
  const fetchMock = vi.fn();
  const llm = { apiKey: 'k', baseUrl: 'https://llm.example', model: 'm', byok: false };
  const gatedTool = {
    name: 'create_refund',
    description: 'issue a refund',
    method: 'POST' as const,
    url: 'https://api.example/refund',
    approval: true,
  };
  const toolCall = (id: string) => ({
    id,
    function: { name: 'create_refund', arguments: '{"order":"5"}' },
  });
  const reply = (body: object) =>
    new Response(JSON.stringify({ choices: [{ message: body }], usage: {} }), { status: 200 });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('tells the model a gated call is queued so it wraps up instead of re-calling', async () => {
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: wsId, name: 'T', apiKeyHash: 'h-t', apiKeyPreview: 'p', hosted: true })
      .returning();
    fetchMock
      .mockResolvedValueOnce(reply({ tool_calls: [toolCall('c1')] }))
      .mockResolvedValueOnce(reply({ content: 'Your refund request is pending approval.' }));
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'refund me' }], [gatedTool], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
      agent,
      testRun: true,
    });
    expect(r.text).toBe('Your refund request is pending approval.');
    expect(r.toolCalls).toEqual([
      { name: 'create_refund', gated: true, outcome: 'proposed', args: { order: '5' } },
    ]);
    // the tool result fed back says "queued for review", not "treat as proposed, not done"
    const round2 = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const toolMsg = round2.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.content).toContain('queued for review');
    // and the real endpoint was never hit
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes('llm.example'))).toBe(true);
  });

  it('trims trailing assistant turns — providers reject a request ending on a model turn', async () => {
    // prod incident: a pending-flag pass fired on a transcript whose newest
    // row was our own reply — Gemini 400s "ending with a model turn".
    fetchMock.mockResolvedValueOnce(reply({ content: 'ok' }));
    const r = await complete(
      llm,
      'sys',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello there' },
      ],
      [],
      {},
      { db, convId: 'c', workspaceId: wsId },
    );
    expect(r.text).toBe('ok');
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.messages[sent.messages.length - 1].role).toBe('user');
    expect(sent.messages).toHaveLength(2); // system + user — the stale reply is gone
  });

  it('resumes a reply cut at the token cap instead of shipping it truncated', async () => {
    // Prod incident: the concierge's sitemap reply hit max_tokens=400 and
    // shipped a message ending inside a markdown link.
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: 'part one ends [Campaigns](https' }, finish_reason: 'length' },
            ],
            usage: {},
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(reply({ content: '://app.janis.ai/agents) done' }));
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'list pages' }], [], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
    });
    expect(r.text).toBe('part one ends [Campaigns](https://app.janis.ai/agents) done');
    const round2 = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const tail = round2.messages.slice(-2);
    expect(tail[0]).toMatchObject({ role: 'assistant', content: 'part one ends [Campaigns](https' });
    expect(tail[1].content).toContain('continue from exactly where it stopped');
  });

  it('returns empty rather than calling the provider with no user turn at all', async () => {
    const r = await complete(
      llm,
      'sys',
      [{ role: 'assistant', content: 'unanswered? no — nothing to answer' }],
      [],
      {},
      { db, convId: 'c', workspaceId: wsId },
    );
    expect(r.text).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no text when the model loops on tool calls for all 4 rounds', async () => {
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: wsId, name: 'T2', apiKeyHash: 'h-t2', apiKeyPreview: 'p', hosted: true })
      .returning();
    fetchMock.mockImplementation(() =>
      Promise.resolve(reply({ tool_calls: [toolCall('c')] })),
    );
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'refund me' }], [gatedTool], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
      agent,
      testRun: true,
    });
    expect(r.text).toBeNull();
    expect(r.toolCalls).toHaveLength(4);
    expect(r.toolCalls.every((t) => t.outcome === 'proposed')).toBe(true);
  });

  it('forces a plain-text reply when the model burns all rounds on tool calls', async () => {
    // Prod incident (conv ac153999): update_agent kept rejecting an
    // overstuffed call, the model re-issued it all 4 rounds, text came back
    // null → "empty reply" handoff. The salvage pass must answer anyway.
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: wsId, name: 'T-storm', apiKeyHash: 'h-storm', apiKeyPreview: 'p', hosted: true })
      .returning();
    let n = 0;
    fetchMock.mockImplementation(() => {
      n++;
      return Promise.resolve(
        n <= 4
          ? reply({ tool_calls: [toolCall(`c${n}`)] })
          : reply({ content: 'I could not apply that change — a teammate is taking a look.' }),
      );
    });
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'refund me' }], [gatedTool], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
      agent,
      testRun: true,
    });
    expect(r.text).toBe('I could not apply that change — a teammate is taking a look.');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // the salvage request offers no tools — the model cannot loop again
    const salvage = JSON.parse(fetchMock.mock.calls[4][1].body as string);
    expect(salvage.tools).toBeUndefined();
    expect(salvage.messages[salvage.messages.length - 1].role).toBe('user');
  });

  it('short-circuits an identical call that already failed this turn', async () => {
    // Same incident: the model re-issued the exact same rejected update_agent
    // every round. An identical retry can only fail again — stop it early.
    let runs = 0;
    const failBuiltin = {
      name: 'update_agent',
      description: 'propose config changes',
      params: { agent: 'name' },
      available: () => true,
      run: async () => {
        runs++;
        return '{"error":"10 settings in one card — send only the requested fields"}';
      },
    };
    const dupe = (id: string) => ({
      id,
      function: { name: 'update_agent', arguments: '{"agent":"Mr. Tony","greeting":"hi"}' },
    });
    fetchMock
      .mockResolvedValueOnce(reply({ tool_calls: [dupe('c1'), dupe('c2')] }))
      .mockResolvedValueOnce(reply({ tool_calls: [dupe('c3')] }))
      .mockResolvedValueOnce(reply({ content: "That change didn't go through." }));
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'change the greeting' }], [], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
    }, [failBuiltin]);
    expect(r.text).toBe("That change didn't go through.");
    expect(runs).toBe(1); // the tool executed once — repeats were short-circuited
    expect(r.toolCalls).toHaveLength(3);
    expect(r.toolCalls[1].outcome).toBe('failed');
    expect(r.toolCalls[1].error).toContain('already failed this turn');
    expect(r.toolCalls[2].error).toContain('already failed this turn');
  });

  it('marks a GraphQL {"errors"} body as failed — the model sees the error, not fake data', async () => {
    // Prod incident (janis-store): the stored shopify tool's bodyTemplate was
    // stripped, Shopify returned {"errors":[…syntax…]} with HTTP 200, the call
    // was recorded 'ran', and the model retried the same broken call until
    // tool-storm salvage — then hallucinated links in its forced reply.
    const searchTool = {
      name: 'shopify_search_products',
      description: 'search products',
      method: 'POST' as const,
      url: 'https://shop.example/admin/api/2026-10/graphql.json',
      params: { query: 'search clause' },
    };
    const searchCall = (id: string) => ({
      id,
      function: { name: 'shopify_search_products', arguments: '{"query":"status:active"}' },
    });
    fetchMock
      .mockResolvedValueOnce(reply({ tool_calls: [searchCall('c1')] }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ errors: [{ message: 'Parse error on "status" (IDENTIFIER)' }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(reply({ tool_calls: [searchCall('c2')] }))
      .mockResolvedValueOnce(reply({ content: 'Search is having trouble — please try again.' }));
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'show products' }], [searchTool], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
    });
    expect(r.toolCalls[0].outcome).toBe('failed');
    expect(r.toolCalls[0].error).toContain('Parse error');
    // the identical retry is short-circuited — the tool endpoint is hit once
    expect(r.toolCalls[1].outcome).toBe('failed');
    expect(r.toolCalls[1].error).toContain('already failed this turn');
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('shop.example'))).toHaveLength(1);
    expect(r.text).toBe('Search is having trouble — please try again.');
  });

  it('counts action_card results so a parked-but-silent run can narrate the card', async () => {
    // Prod incident (conv ac153999): the concierge parked nothing and went
    // silent — but when it DOES park a card then produce no text, the caller
    // must know a card exists so it doesn't escalate as "empty reply".
    const cardBuiltin = {
      name: 'update_agent',
      description: 'propose config changes',
      params: { greeting: 'new greeting text' },
      available: () => true,
      run: async () =>
        'action_card: an approval card was posted to the chat — the visitor applies or dismisses it there; do not claim the change is done',
    };
    const cardCall = (id: string) => ({
      id,
      function: { name: 'update_agent', arguments: '{"greeting":"hi"}' },
    });
    fetchMock
      .mockResolvedValueOnce(reply({ tool_calls: [cardCall('c1')] }))
      .mockResolvedValueOnce(reply({ content: null }));
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'change my greeting to hi' }], [], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
    }, [cardBuiltin]);
    expect(r.text).toBeNull();
    expect(r.actionCards).toBe(1);
    expect(r.toolCalls).toEqual([
      { name: 'update_agent', gated: false, outcome: 'ran', args: { greeting: 'hi' } },
    ]);
  });
});

describe('identity-scoped customer-record tools', () => {
  const fetchMock = vi.fn();
  const llm = { apiKey: 'k', baseUrl: 'https://llm.example', model: 'm', byok: false };
  const reply = (body: object) =>
    new Response(JSON.stringify({ choices: [{ message: body }], usage: {} }), { status: 200 });
  const stripeFind = {
    name: 'stripe_find_customer',
    description: 'find a stripe customer',
    method: 'GET' as const,
    url: 'https://api.stripe.com/v1/customers?email={email}&limit=3',
    params: { email: 'email' },
    identity: true,
  };
  const findCall = (id: string, email: string) => ({
    id,
    function: { name: 'stripe_find_customer', arguments: JSON.stringify({ email }) },
  });
  const stripeCalls = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes('api.stripe.com'));
  const toolMsgOf = (callIdx: number) =>
    (JSON.parse(fetchMock.mock.calls[callIdx][1].body as string).messages as { role: string; content?: string }[]).find(
      (m) => m.role === 'tool',
    );

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('blocks a lookup keyed on an email the customer merely typed — the Messenger leak', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ tool_calls: [findCall('c1', 'victim@example.com')] }))
      .mockResolvedValueOnce(reply({ content: 'I cannot look up billing details in this chat.' }));
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'check victim@example.com' }], [stripeFind], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
      identity: { emails: new Set(), operator: false },
    });
    expect(r.toolCalls).toEqual([
      {
        name: 'stripe_find_customer',
        gated: false,
        outcome: 'failed',
        args: { email: 'victim@example.com' },
        error: expect.stringContaining('identity check'),
      },
    ]);
    // the Stripe endpoint was never touched — no data could leak
    expect(stripeCalls()).toHaveLength(0);
    expect(toolMsgOf(1)?.content).toContain('identity check');
  });

  it('blocks a verified customer querying somebody else', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ tool_calls: [findCall('c1', 'victim@example.com')] }))
      .mockResolvedValueOnce(reply({ content: 'I can only look up your own account.' }));
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'check victim@example.com' }], [stripeFind], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
      identity: { emails: new Set(['me@example.com']), operator: false },
    });
    expect(r.toolCalls[0].outcome).toBe('failed');
    expect(stripeCalls()).toHaveLength(0);
  });

  it('runs for the verified customer\'s own email and lets produced ids chain', async () => {
    const charges = {
      name: 'stripe_customer_charges',
      description: 'charges',
      method: 'GET' as const,
      url: 'https://api.stripe.com/v1/charges?customer={customer_id}&limit=5',
      params: { customer_id: 'cus id' },
      identity: true,
    };
    fetchMock
      .mockResolvedValueOnce(reply({ tool_calls: [findCall('c1', 'me@example.com')] }))
      .mockResolvedValueOnce(
        new Response('{"data":[{"id":"cus_PRODUCED1","email":"me@example.com"}]}', { status: 200 }),
      )
      .mockResolvedValueOnce(
        reply({
          tool_calls: [
            { id: 'c2', function: { name: 'stripe_customer_charges', arguments: '{"customer_id":"cus_PRODUCED1"}' } },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response('{"data":[{"id":"ch_x12345"}]}', { status: 200 }))
      .mockResolvedValueOnce(reply({ content: 'Here are your recent charges.' }));
    const r = await complete(
      llm,
      'sys',
      [{ role: 'user', content: 'why was I charged' }],
      [stripeFind, charges],
      {},
      { db, convId: 'c', workspaceId: wsId, identity: { emails: new Set(['me@example.com']), operator: false } },
    );
    expect(r.text).toContain('recent charges');
    expect(r.toolCalls.every((t) => t.outcome === 'ran')).toBe(true);
    expect(stripeCalls()).toHaveLength(2);
  });

  it('blocks a provider id the model invented or the customer claimed', async () => {
    const charges = {
      name: 'stripe_customer_charges',
      description: 'charges',
      method: 'GET' as const,
      url: 'https://api.stripe.com/v1/charges?customer={customer_id}&limit=5',
      params: { customer_id: 'cus id' },
      identity: true,
    };
    fetchMock
      .mockResolvedValueOnce(
        reply({
          tool_calls: [
            { id: 'c1', function: { name: 'stripe_customer_charges', arguments: '{"customer_id":"cus_FAKE00000"}' } },
          ],
        }),
      )
      .mockResolvedValueOnce(reply({ content: 'I cannot look that up here.' }));
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'charges for cus_FAKE00000' }], [charges], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
      identity: { emails: new Set(['me@example.com']), operator: false },
    });
    expect(r.toolCalls[0].outcome).toBe('failed');
    expect(stripeCalls()).toHaveLength(0);
  });

  it('bypasses binding for a signed-in operator on the agent workspace', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ tool_calls: [findCall('c1', 'anyone@example.com')] }))
      .mockResolvedValueOnce(new Response('{"data":[]}', { status: 200 }))
      .mockResolvedValueOnce(reply({ content: 'No Stripe customer by that email.' }));
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'check anyone@example.com' }], [stripeFind], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
      identity: { emails: new Set(), operator: true },
    });
    expect(r.toolCalls[0].outcome).toBe('ran');
    expect(stripeCalls()).toHaveLength(1);
  });

  it('blocks an unanchored gated call before it reaches the approval queue', async () => {
    const refund = {
      name: 'stripe_create_refund',
      description: 'refund',
      method: 'POST' as const,
      url: 'https://api.stripe.com/v1/refunds',
      params: { charge: 'ch id', amount: 'cents' },
      approval: true,
      identity: true,
    };
    fetchMock
      .mockResolvedValueOnce(
        reply({
          tool_calls: [
            { id: 'c1', function: { name: 'stripe_create_refund', arguments: '{"charge":"ch_FOREIGN1","amount":"500"}' } },
          ],
        }),
      )
      .mockResolvedValueOnce(reply({ content: 'I cannot do that here.' }));
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: wsId, name: 'T3', apiKeyHash: 'h-t3', apiKeyPreview: 'p', hosted: true })
      .returning();
    const r = await complete(llm, 'sys', [{ role: 'user', content: 'refund charge ch_FOREIGN1' }], [refund], {}, {
      db,
      convId: 'c',
      workspaceId: wsId,
      agent,
      identity: { emails: new Set(['me@example.com']), operator: false },
    });
    // not 'proposed' — the call never reached the approval queue
    expect(r.toolCalls[0].outcome).toBe('failed');
    expect(stripeCalls()).toHaveLength(0);
  });
});

describe('verifiedIdentityFor', () => {
  const mkAgent = async (name: string, ws = wsId) => {
    const [a] = await db
      .insert(agents)
      .values({ workspaceId: ws, name, apiKeyHash: `h-${name}`, apiKeyPreview: 'p', hosted: true })
      .returning();
    return a;
  };
  const mkConv = async (agentId: string, externalId: string, userProfile?: object) => {
    const [c] = await db
      .insert(conversations)
      .values({ agentId, externalId, state: 'active', userProfile })
      .returning();
    return c;
  };

  it('a messenger binding verifies nothing — typed emails are just claims', async () => {
    const a = await mkAgent('msgr');
    const [ch] = await db
      .insert(channels)
      .values({ workspaceId: wsId, agentId: a.id, kind: 'messenger', name: 'Page' })
      .returning();
    const conv = await mkConv(a.id, 'messenger:psid1', { id: 'psid1', email: 'claimed@x.com' });
    await db
      .insert(channelBindings)
      .values({ channelId: ch.id, conversationId: conv.id, platformUserId: 'psid1' });
    const id = await verifiedIdentityFor(db, conv, wsId);
    expect(id.operator).toBe(false);
    // a profile email nobody verified does not count
    expect(id.emails.has('claimed@x.com')).toBe(false);
  });

  it('an email-channel sender is verified — their address anchors lookups', async () => {
    const a = await mkAgent('mail');
    const [ch] = await db
      .insert(channels)
      .values({ workspaceId: wsId, agentId: a.id, kind: 'gmail', name: 'Inbox' })
      .returning();
    const conv = await mkConv(a.id, 'gmail:thread1', { email: 'real-sender@x.com' });
    await db
      .insert(channelBindings)
      .values({ channelId: ch.id, conversationId: conv.id, platformUserId: 'real-sender@x.com' });
    const id = await verifiedIdentityFor(db, conv, wsId);
    expect(id.emails.has('real-sender@x.com')).toBe(true);
    expect(id.operator).toBe(false);
  });

  it('a contact\'s email-channel identity counts across channels', async () => {
    // Same person on Messenger AND email: the email-channel identity
    // authenticates that address for every conversation of the contact.
    const a = await mkAgent('xchan');
    const [messenger] = await db
      .insert(channels)
      .values({ workspaceId: wsId, agentId: a.id, kind: 'messenger', name: 'Page2' })
      .returning();
    const [gmail] = await db
      .insert(channels)
      .values({ workspaceId: wsId, agentId: a.id, kind: 'gmail', name: 'Inbox2' })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: wsId, email: 'known@x.com' })
      .returning();
    await db
      .insert(contactIdentities)
      .values({ contactId: contact.id, channelId: gmail.id, platformUserId: 'known@x.com' });
    const conv = await mkConv(a.id, 'messenger:psid2', { id: 'psid2' });
    await db.update(conversations).set({ contactId: contact.id }).where(eq(conversations.id, conv.id));
    await db
      .insert(channelBindings)
      .values({ channelId: messenger.id, conversationId: conv.id, platformUserId: 'psid2' });
    const id = await verifiedIdentityFor(db, { ...conv, contactId: contact.id }, wsId);
    expect(id.emails.has('known@x.com')).toBe(true);
    expect(id.operator).toBe(false);
  });

  it('a signed-in member is operator on their own workspace only', async () => {
    const a = await mkAgent('op');
    const [u] = await db
      .insert(users)
      .values({ email: 'op@janis.ai', name: 'Op' })
      .returning();
    await db.insert(memberships).values({ userId: u.id, workspaceId: wsId, role: 'admin', acceptedAt: new Date() });
    const conv = await mkConv(a.id, 'webchat:ask1', {
      email: 'op@janis.ai',
      external_id: u.id,
      identity_verified: true,
    });
    const own = await verifiedIdentityFor(db, conv, wsId);
    expect(own.operator).toBe(true);
    expect(own.emails.has('op@janis.ai')).toBe(true);

    // same signed-in user, someone else's agent → not an operator there
    const [otherWs] = await db.insert(workspaces).values({ name: 'Other', plan: 'free' }).returning();
    const otherAgent = await mkAgent('op2', otherWs.id);
    const foreignConv = await mkConv(otherAgent.id, 'webchat:ask2', {
      email: 'op@janis.ai',
      external_id: u.id,
      identity_verified: true,
    });
    const foreign = await verifiedIdentityFor(db, foreignConv, otherWs.id);
    expect(foreign.operator).toBe(false);
    expect(foreign.emails.has('op@janis.ai')).toBe(true); // still their own verified email
  });
});

describe('procedures', () => {
  it('injects authored runbooks stepwise into the system prompt', () => {
    const fakeAgent = {
      name: 'Bot',
      config: {
        procedures: [
          {
            name: 'Returns & exchanges',
            when: 'the customer wants to send something back',
            steps: [
              'Ask for the order number and the email it was placed under',
              'Run shopify_lookup_order to verify',
              'Run shopify_request_return with the items they pick',
            ],
          },
        ],
      },
    } as never;
    const p = systemPrompt(fakeAgent, [], undefined, {});
    expect(p).toContain('Procedures — authored workflows');
    expect(p).toContain('Returns & exchanges');
    expect(p).toContain('use when: the customer wants to send something back');
    expect(p).toContain('1. Ask for the order number');
    expect(p).toContain('3. Run shopify_request_return');
  });

  it('omits the section when no procedures are configured', () => {
    const p = systemPrompt({ name: 'Bot', config: {} } as never, [], undefined, {});
    expect(p).not.toContain('Procedures');
  });
});

describe('handoff opt-out', () => {
  it('systemPrompt drops the escalation ladder when handoff_enabled is false', () => {
    const fakeAgent = { name: 'Bot', config: { handoff_enabled: false } } as never;
    const p = systemPrompt(fakeAgent, [], undefined, {});
    expect(p).toContain('no human escalation');
    expect(p).toContain('no human tier above you');
    expect(p).not.toContain('Escalation, two levels');
    expect(p).not.toContain('offer a human once');
    // and a handoff-on agent still gets the ladder
    const on = systemPrompt({ name: 'Bot', config: {} } as never, [], undefined, {});
    expect(on).toContain('Escalation, two levels');
  });

  it('withWorkspaceDefaults inherits the workspace flag unless the agent overrides', async () => {
    const { withWorkspaceDefaults } = await import('./hostedAgent.js');
    const [ws] = await db
      .insert(workspaces)
      .values({ name: 'NoHumans', plan: 'pro', config: { handoff_enabled: false } })
      .returning();
    const [a] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'A', apiKeyHash: 'ha', apiKeyPreview: 'pa', hosted: true })
      .returning();
    const [b] = await db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: 'B',
        apiKeyHash: 'hb',
        apiKeyPreview: 'pb',
        hosted: true,
        config: { handoff_enabled: true },
      })
      .returning();
    // unset on the agent → inherits the workspace's false
    expect(
      ((await withWorkspaceDefaults(db, a)).config as { handoff_enabled?: boolean })
        .handoff_enabled,
    ).toBe(false);
    // explicit agent true beats the workspace false
    expect(
      ((await withWorkspaceDefaults(db, b)).config as { handoff_enabled?: boolean })
        .handoff_enabled,
    ).toBe(true);
    // unset everywhere → default on
    expect(
      (
        (await withWorkspaceDefaults(db, { ...a, workspaceId: wsId } as never))
          .config as { handoff_enabled?: boolean }
      ).handoff_enabled,
    ).toBe(true);
  });
});

describe('operator copilot prompt', () => {
  it('drops the customer handoff ladder for a signed-in teammate', () => {
    const fakeAgent = { name: 'Janis', config: {} } as never;
    const op = systemPrompt(fakeAgent, [], undefined, { operator: true });
    expect(op).toContain("operator's copilot");
    expect(op).not.toContain('Escalation, two levels');
    expect(op).not.toContain('offer a human once');
    const cust = systemPrompt(fakeAgent, [], undefined, {});
    expect(cust).toContain('Escalation, two levels');
    expect(cust).toContain('offer a human once');
  });
});

describe('unwrapInlineLists', () => {
  it('splits a "- **A:** … - **B:** …" run into real bullet lines', () => {
    expect(unwrapInlineLists('I can do: - **Build:** agents - **Analyze:** stats')).toBe(
      'I can do:\n- **Build:** agents\n- **Analyze:** stats',
    );
  });

  it('normalizes a bullet line carrying an inline marker into clean items', () => {
    expect(unwrapInlineLists('* **A** one * **B** two')).toBe('- **A** one\n- **B** two');
  });

  it('leaves prose dashes and single markers alone', () => {
    expect(unwrapInlineLists('cost - billed monthly - honestly')).toBe(
      'cost - billed monthly - honestly',
    );
    expect(unwrapInlineLists('try it - **once** and see')).toBe('try it - **once** and see');
  });

  it('leaves real multiline lists untouched', () => {
    expect(unwrapInlineLists('Items:\n- **A** one\n- **B** two')).toBe(
      'Items:\n- **A** one\n- **B** two',
    );
  });

  it('unwraps an inline numbered run and keeps the numbering', () => {
    expect(
      unwrapInlineLists('Three ways: 1. **Gaps:** review them 2. **Forms:** finalize 3. **Stats:** pull them'),
    ).toBe('Three ways:\n1. **Gaps:** review them\n2. **Forms:** finalize\n3. **Stats:** pull them');
  });

  it('detaches trailing prose glued onto the last item', () => {
    // Real concierge reply: the closing question rode inside the last li.
    expect(
      unwrapInlineLists(
        'Options: - **Web Chat:** script-tag widget. - **Email:** Gmail OAuth. - **API:** SDK or raw HTTP. All share one inbox. Want to set one up?',
      ),
    ).toBe(
      'Options:\n- **Web Chat:** script-tag widget.\n- **Email:** Gmail OAuth.\n- **API:** SDK or raw HTTP.\nAll share one inbox. Want to set one up?',
    );
  });

  it('keeps multi-sentence tails when earlier items are also multi-sentence', () => {
    expect(
      unwrapInlineLists('Try: - **A** do this. Carefully. - **B** do that. Then rest.'),
    ).toBe('Try:\n- **A** do this. Carefully.\n- **B** do that. Then rest.');
  });
});

describe('save_user_profile → contact enrichment', () => {
  const mkAgent = async (name: string) => {
    const [a] = await db
      .insert(agents)
      .values({ workspaceId: wsId, name, apiKeyHash: `h-${name}`, apiKeyPreview: 'p', hosted: true })
      .returning();
    return a;
  };
  const mkConv = async (agentId: string, externalId: string) => {
    const [c] = await db
      .insert(conversations)
      .values({ agentId, externalId, state: 'active' })
      .returning();
    return c;
  };

  it('claimed fields fill the bound contact and tag it self-reported', async () => {
    const a = await mkAgent('sp1');
    const [contact] = await db.insert(contacts).values({ workspaceId: wsId }).returning();
    const conv = await mkConv(a.id, 'webchat:sp1');
    await db.update(conversations).set({ contactId: contact.id }).where(eq(conversations.id, conv.id));

    const out = await saveUserProfile(
      { db, convId: conv.id, workspaceId: wsId },
      { name: 'Jane', email: 'Jane@Acme.com', phone: '+1 555 0100' },
    );
    expect(out).toContain('saved');

    const [c] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(c.email).toBe('jane@acme.com'); // normalized at write
    expect(c.name).toBe('Jane');
    expect(c.phone).toBe('+1 555 0100');
    expect(c.tags).toContain('self-reported');

    // conversation-local save keeps the value as typed
    const [cv] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect((cv.userProfile as { email?: string }).email).toBe('Jane@Acme.com');
  });

  it('never overwrites a verified contact email — the claim folds to alt_emails', async () => {
    const a = await mkAgent('sp2');
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: wsId, email: 'real@x.com', name: 'Real' })
      .returning();
    const conv = await mkConv(a.id, 'webchat:sp2');
    await db.update(conversations).set({ contactId: contact.id }).where(eq(conversations.id, conv.id));

    await saveUserProfile(
      { db, convId: conv.id, workspaceId: wsId },
      { email: 'claimed@y.com' },
    );

    const [c] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(c.email).toBe('real@x.com');
    expect(c.altEmails).toContain('claimed@y.com');
    expect(c.tags).toContain('self-reported');
  });

  it('still saves conversation-locally when no contact is bound', async () => {
    const a = await mkAgent('sp3');
    const conv = await mkConv(a.id, 'webchat:sp3'); // no contactId
    const out = await saveUserProfile(
      { db, convId: conv.id, workspaceId: wsId },
      { email: 'a@b.co' },
    );
    expect(out).toContain('saved');
    const [cv] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect((cv.userProfile as { email?: string }).email).toBe('a@b.co');
  });
});

describe('save_user_profile facts → metadata.claimed', () => {
  const mkAgent = async (name: string) => {
    const [a] = await db
      .insert(agents)
      .values({ workspaceId: wsId, name, apiKeyHash: `h-${name}`, apiKeyPreview: 'p', hosted: true })
      .returning();
    return a;
  };

  it('claimed facts land in metadata.claimed — never touching system keys', async () => {
    const a = await mkAgent('sp4');
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: wsId, metadata: { plan: 'enterprise' } })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: a.id, externalId: 'webchat:sp4', state: 'active' })
      .returning();
    await db.update(conversations).set({ contactId: contact.id }).where(eq(conversations.id, conv.id));

    const out = await saveUserProfile(
      { db, convId: conv.id, workspaceId: wsId },
      { facts: { interest: 'package 9', plan: 'unverified?' } },
    );
    expect(out).toContain('saved');

    const [c] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    const md = c.metadata as { claimed?: Record<string, string>; plan?: string };
    expect(md.claimed?.interest).toBe('package 9');
    // Same key name as a system trait — separate namespace, no clobber
    expect(md.claimed?.plan).toBe('unverified?');
    expect(md.plan).toBe('enterprise');

    // conversation-local metadata carries them for recall next turn
    const [cv] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    const convMd = ((cv.userProfile as Record<string, unknown>).metadata ?? {}) as Record<string, unknown>;
    expect(convMd.interest).toBe('package 9');
  });

  it('facts alone satisfy "something to save" — name/email/phone optional', async () => {
    const a = await mkAgent('sp5');
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: a.id, externalId: 'webchat:sp5', state: 'active' })
      .returning();
    const out = await saveUserProfile(
      { db, convId: conv.id, workspaceId: wsId },
      { facts: { company: 'Acme' } },
    );
    expect(out).toContain('saved');
    expect(out).toContain('fact:company');
  });
});

describe('phantom-product guard', () => {
  const terms = ['hidden snowboard', 'hidden'];

  it('flags "yes we carry it" when the search returned zero rows', () => {
    expect(
      claimsPhantomProduct(
        'Yes, we carry **The Hidden Snowboard** for $749.95. Here it is:',
        terms,
      ),
    ).toBe(true);
  });

  it('passes a correct "not sold here" answer', () => {
    expect(
      claimsPhantomProduct(
        "The Hidden Snowboard isn't available on our storefront right now — it is no longer published.",
        terms,
      ),
    ).toBe(false);
    expect(
      claimsPhantomProduct(
        "We don't carry the Hidden Snowboard in our catalogue anymore.",
        terms,
      ),
    ).toBe(false);
  });

  it('passes a reply that never names the phantom item', () => {
    expect(claimsPhantomProduct('We carry 13 snowboards starting at $499.', terms)).toBe(false);
  });

  it('strips only the claiming sentences', () => {
    const out = stripPhantomClaims(
      'Yes, we carry The Hidden Snowboard for $749.95. But let me show you real alternatives.',
      terms,
    );
    expect(out).not.toContain('$749.95');
    expect(out).toContain('real alternatives');
  });
});

describe('catalogue-count guard', () => {
  const totals = new Set([13]);

  it('flags a wrong "we have N products" claim', () => {
    expect(claimsWrongCount('We have 15 active products in total in our store.', totals)).toBe(true);
    expect(claimsWrongCount('Our collection has 15 active items:', totals)).toBe(true);
  });

  it('passes the true total and non-catalogue counts', () => {
    expect(claimsWrongCount('We have 13 active products in total.', totals)).toBe(false);
    expect(claimsWrongCount('2 of them are out of stock right now.', totals)).toBe(false);
    expect(claimsWrongCount('I found 3 snowboards under $500.', totals)).toBe(false);
  });

  it('corrects the number in place', () => {
    expect(fixWrongCounts('We have 15 active products in total.', totals)).toBe(
      'We have 13 active products in total.',
    );
  });
});

describe('unbacked catalogue count', () => {
  it('flags a count claim with no tool total to back it', () => {
    expect(claimsAnyCatalogueCount('We currently have 15 active products in our store catalog.')).toBe(true);
    expect(claimsAnyCatalogueCount('Here are some products:')).toBe(false);
    expect(claimsAnyCatalogueCount('2 of them are out of stock.')).toBe(false);
  });
  it('strips the unverifiable sentence', () => {
    expect(
      stripUnbackedCounts('We have 15 products in total! Want me to show you some?'),
    ).toBe('Want me to show you some?');
  });
});

describe('full-catalogue overclaim guard', () => {
  const totals = new Set([13]);

  it('flags "all 13" and completeness claims over a 10-card render', () => {
    expect(claimsFullCatalogue('Here are all 13 products available in our store:', 10, totals)).toBe(true);
    expect(claimsFullCatalogue('Here is our full product range:', 10, totals)).toBe(true);
    expect(claimsFullCatalogue('I can show you every product we carry.', 10, totals)).toBe(true);
  });

  it('passes honest scoping, subset counts, and complete renders', () => {
    expect(claimsFullCatalogue('Here are the first 10 of 13 products:', 10, totals)).toBe(false);
    expect(claimsFullCatalogue('Here are all 3 out-of-stock items:', 3, totals)).toBe(false);
    expect(claimsFullCatalogue('Here are all 13 products:', 13, totals)).toBe(false);
    expect(claimsFullCatalogue('Here are some products:', 10, totals)).toBe(false);
    expect(claimsFullCatalogue('Here are all 13 products:', 10, new Set())).toBe(false);
  });

  it('rewrites the claim to the honest K of N', () => {
    expect(fixFullCatalogueClaims('Here are all 13 products available in our store:', 10, 13)).toBe(
      'Here are the first 10 of 13 products available in our store:',
    );
    expect(fixFullCatalogueClaims('Take a look at our full product range:', 10, 13)).toBe(
      'Take a look at our first 10 of 13 products:',
    );
  });
});

describe('confirmed-add denial guard', () => {
  it('flags a failure/stock denial answering an add-to-cart tap', () => {
    expect(deniesConfirmedAdd("That item is out of stock right now, so it couldn't be added to your cart.")).toBe(true);
    expect(deniesConfirmedAdd('The add failed — sorry about that.')).toBe(true);
    expect(deniesConfirmedAdd('Added! Your cart has 2 items — want to check out?')).toBe(false);
  });
});
