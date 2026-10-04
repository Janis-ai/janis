import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { agents, channelBindings, channels, contactIdentities, contacts, conversations, memberships, messages, uploads, users, workspaces } from '../db/schema.js';
import { blessedUrlsFor, buttonLabelOverflow, channelKeyFor, claimsAction, claimsWidgetShown, complete, controlTag, deniesWidgetShown, extractButtons, extractLearns, fileAnalysisAllowed, guardReplyLinks, knowledgeQueryFor, rankDocs, stripActionClaims, stripEscalationClaims, stripTranscriptNotes, stripWidgetClaims, systemPrompt, unwrapInlineLists, transcriptFor, verifiedIdentityFor } from './hostedAgent.js';
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
    expect(r.toolCalls).toEqual([{ name: 'create_refund', gated: true, outcome: 'proposed' }]);
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
    expect(r.toolCalls).toEqual([{ name: 'stripe_find_customer', gated: false, outcome: 'failed' }]);
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
