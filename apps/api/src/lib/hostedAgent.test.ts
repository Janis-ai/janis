import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, messages, uploads, workspaces } from '../db/schema.js';
import { blessedUrlsFor, complete, controlTag, extractButtons, extractLearns, fileAnalysisAllowed, guardReplyLinks, knowledgeQueryFor, rankDocs, stripEscalationClaims, stripTranscriptNotes, transcriptFor } from './hostedAgent.js';

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

  it('caps at 4 buttons and 20-char labels', () => {
    const r = extractButtons(
      'pick one\nBUTTON: a\nBUTTON: a very long button label here\nBUTTON: c\nBUTTON: d\nBUTTON: e',
    );
    expect(r.buttons).toEqual(['a', 'a very long button l', 'c', 'd']);
    expect(r.text).toBe('pick one');
  });

  it('turns ASK lines into contact-field quick replies', () => {
    const r = extractButtons(
      'Could I get your email?\nASK: email\nBUTTON: skip for now\nask: phone',
    );
    expect(r.text).toBe('Could I get your email?');
    expect(r.buttons).toEqual([{ type: 'email' }, 'skip for now', { type: 'phone' }]);
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
