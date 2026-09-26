import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPlatformProfile,
  parseMetaWebhook,
  sendChannelMessage,
  verifyMetaSignature,
} from './channels.js';
import type { channels } from '../db/schema.js';
import { createHmac } from 'node:crypto';

describe('parseMetaWebhook', () => {
  it('parses messenger text messages', () => {
    const body = {
      entry: [
        {
          id: 'PAGE123',
          messaging: [
            { sender: { id: 'PSID1' }, recipient: { id: 'PAGE123' }, message: { mid: 'mid.1', text: 'hello' } },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([
      { objectId: 'PAGE123', senderId: 'PSID1', text: 'hello', messageId: 'mid.1', name: undefined },
    ]);
  });

  it('parses Get Started / button postbacks as inbound text', () => {
    const body = {
      entry: [
        {
          id: 'PAGE123',
          messaging: [
            {
              sender: { id: 'PSID1' },
              recipient: { id: 'PAGE123' },
              postback: { title: 'Get Started', payload: 'JANIS_GET_STARTED', mid: 'mid.pb' },
            },
            {
              sender: { id: 'PSID2' },
              recipient: { id: 'PAGE123' },
              postback: { payload: 'MENU_ITEM' }, // no title — payload text
            },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([
      { objectId: 'PAGE123', senderId: 'PSID1', text: 'Get Started', messageId: 'mid.pb', postback: true },
      { objectId: 'PAGE123', senderId: 'PSID2', text: 'MENU_ITEM', messageId: undefined, postback: true },
    ]);
  });

  it('parses standby feed (handover) messages flagged standby', () => {
    const body = {
      entry: [
        {
          id: 'PAGE123',
          standby: [
            { sender: { id: 'PSID9' }, recipient: { id: 'PAGE123' }, message: { mid: 'mid.s1', text: 'hi' } },
            { sender: { id: 'PSID9' }, recipient: { id: 'PAGE123' }, message: { text: 'echo', is_echo: true } },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([
      { objectId: 'PAGE123', senderId: 'PSID9', text: 'hi', messageId: 'mid.s1', standby: true },
    ]);
  });

  it('skips echoes, receipts, and non-text', () => {
    const body = {
      entry: [
        {
          messaging: [
            { sender: { id: 'P' }, recipient: { id: 'PG' }, message: { text: 'x', is_echo: true } },
            { sender: { id: 'P' }, recipient: { id: 'PG' }, delivery: {} },
            { sender: { id: 'P' }, recipient: { id: 'PG' }, message: { attachments: [] } },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([]);
  });

  it('parses messenger attachment-only messages', () => {
    const body = {
      entry: [
        {
          id: 'PAGE123',
          messaging: [
            {
              sender: { id: 'PSID1' },
              recipient: { id: 'PAGE123' },
              message: {
                mid: 'mid.2',
                attachments: [
                  { type: 'image', payload: { url: 'https://cdn.fb.com/abc/photo.jpg?x=1' } },
                  { type: 'file', payload: { url: 'https://cdn.fb.com/doc.pdf' } },
                  { type: 'location', payload: { coordinates: { lat: 1, long: 2 } } }, // no url — dropped
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([
      {
        objectId: 'PAGE123',
        senderId: 'PSID1',
        text: '',
        messageId: 'mid.2',
        attachments: [
          { name: 'photo.jpg', url: 'https://cdn.fb.com/abc/photo.jpg?x=1', type: 'image/jpeg', size: 0 },
          { name: 'doc.pdf', url: 'https://cdn.fb.com/doc.pdf', type: 'application/octet-stream', size: 0 },
        ],
      },
    ]);
  });

  it('parses messenger text + attachment together', () => {
    const body = {
      entry: [
        {
          messaging: [
            {
              sender: { id: 'P' },
              recipient: { id: 'PG' },
              message: {
                mid: 'mid.3',
                text: 'here it is',
                attachments: [{ type: 'image', payload: { url: 'https://cdn.fb.com/x' } }],
              },
            },
          ],
        },
      ],
    };
    const [msg] = parseMetaWebhook(body);
    expect(msg.text).toBe('here it is');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments?.[0].name).toBe('Image'); // no filename in url → type label
  });

  it('parses whatsapp media messages into wa-media refs', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PHONE1' },
                contacts: [{ wa_id: '1555', profile: { name: 'Jane' } }],
                messages: [
                  {
                    id: 'wamid.2',
                    from: '1555',
                    type: 'image',
                    image: { id: 'media123', mime_type: 'image/png', caption: 'receipt' },
                  },
                  {
                    id: 'wamid.3',
                    from: '1555',
                    type: 'document',
                    document: { id: 'media456', mime_type: 'application/pdf', filename: 'lease.pdf' },
                  },
                  { id: 'wamid.4', from: '1555', type: 'reaction', reaction: {} }, // unsupported — skipped
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([
      {
        objectId: 'PHONE1',
        senderId: '1555',
        text: 'receipt',
        messageId: 'wamid.2',
        name: 'Jane',
        attachments: [{ name: 'receipt', url: 'wa-media:media123', type: 'image/png', size: 0 }],
      },
      {
        objectId: 'PHONE1',
        senderId: '1555',
        text: '',
        messageId: 'wamid.3',
        name: 'Jane',
        attachments: [{ name: 'lease.pdf', url: 'wa-media:media456', type: 'application/pdf', size: 0 }],
      },
    ]);
  });

  it('parses whatsapp interactive button/list taps as text', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PHONE1' },
                contacts: [{ wa_id: '1555', profile: { name: 'Jane' } }],
                messages: [
                  {
                    id: 'wamid.9',
                    from: '1555',
                    type: 'interactive',
                    interactive: { type: 'button_reply', button_reply: { id: 'qr_0', title: 'Pricing' } },
                  },
                  {
                    id: 'wamid.10',
                    from: '1555',
                    type: 'interactive',
                    interactive: { type: 'list_reply', list_reply: { id: 'opt_2', title: 'Support' } },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([
      { objectId: 'PHONE1', senderId: '1555', text: 'Pricing', messageId: 'wamid.9', name: 'Jane' },
      { objectId: 'PHONE1', senderId: '1555', text: 'Support', messageId: 'wamid.10', name: 'Jane' },
    ]);
  });

  it('parses whatsapp messages with contact names', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PHONE1' },
                contacts: [{ wa_id: '15551234567', profile: { name: 'Jane' } }],
                messages: [{ id: 'wamid.1', from: '15551234567', type: 'text', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([
      { objectId: 'PHONE1', senderId: '15551234567', text: 'hi', messageId: 'wamid.1', name: 'Jane' },
    ]);
  });
});

describe('fetchPlatformProfile', () => {
  const ch = (kind: string) =>
    ({
      kind,
      credentials: { access_token: 'tok', page_id: 'PG1', phone_number_id: 'PN1' },
    }) as typeof channels.$inferSelect;

  afterEach(() => vi.unstubAllGlobals());

  it('fetches messenger name and picture with the right fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          first_name: 'Jane',
          last_name: 'Doe',
          profile_pic: 'https://cdn.example/pic.jpg',
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = await fetchPlatformProfile(ch('messenger'), 'PSID1');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('PSID1?fields=first_name,last_name,profile_pic'),
      expect.anything(),
    );
    expect(p.name).toBe('Jane Doe');
    expect(p.picture_url).toBe('https://cdn.example/pic.jpg');
    expect(p.profile_fetched_at).toBeTruthy();
  });

  it('fetches instagram name/username/picture', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ name: 'Jane', username: 'jane.d', profile_pic: 'https://cdn/ig.jpg' }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = await fetchPlatformProfile(ch('instagram'), 'IGSID1');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('IGSID1?fields=name,username,profile_pic'),
      expect.anything(),
    );
    expect(p.username).toBe('jane.d');
  });

  it('returns {} for whatsapp (no profile endpoint) and failures', async () => {
    expect(await fetchPlatformProfile(ch('whatsapp'), '1555')).toEqual({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })));
    expect(await fetchPlatformProfile(ch('messenger'), 'PSID1')).toEqual({});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await fetchPlatformProfile(ch('messenger'), 'PSID1')).toEqual({});
  });
});

describe('sendChannelMessage quick replies', () => {
  const ch = (kind: string) =>
    ({
      kind,
      credentials: { access_token: 'tok', page_id: 'PG1', phone_number_id: 'PN1' },
    }) as typeof channels.$inferSelect;

  const lastBody = (fetchMock: ReturnType<typeof vi.fn>) =>
    JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);

  afterEach(() => vi.unstubAllGlobals());

  it('sends native quick_replies on messenger', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendChannelMessage(ch('messenger'), 'PSID1', 'Welcome!', undefined, {
      quickReplies: ['Pricing questions', 'Talk to a human'],
    });
    const { recipient, message } = lastBody(fetchMock);
    expect(recipient).toEqual({ id: 'PSID1' });
    expect(message.text).toBe('Welcome!');
    expect(message.quick_replies).toEqual([
      { content_type: 'text', title: 'Pricing questions', payload: 'Pricing questions' },
      { content_type: 'text', title: 'Talk to a human', payload: 'Talk to a human' },
    ]);
  });

  it('sends whatsapp interactive reply buttons, capped at 3 with 20-char titles', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendChannelMessage(ch('whatsapp'), '1555', 'Hi!', undefined, {
      quickReplies: ['A very long reply title that gets cut', 'B', 'C', 'D'],
    });
    const body = lastBody(fetchMock);
    expect(body.type).toBe('interactive');
    expect(body.interactive.body.text).toBe('Hi!');
    expect(body.interactive.action.buttons).toEqual([
      { type: 'reply', reply: { id: 'qr_0', title: 'A very long reply ti' } },
      { type: 'reply', reply: { id: 'qr_1', title: 'B' } },
      { type: 'reply', reply: { id: 'qr_2', title: 'C' } },
    ]);
  });

  it('sends plain text when no quick replies configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendChannelMessage(ch('messenger'), 'P', 'hi');
    expect(lastBody(fetchMock).message).toEqual({ text: 'hi' });
    await sendChannelMessage(ch('whatsapp'), '1555', 'hi', undefined, { quickReplies: [] });
    const body = lastBody(fetchMock);
    expect(body.type).toBe('text');
    expect(body.text.body).toBe('hi');
  });
});

describe('messenger personas', () => {
  const ch = (personas?: Record<string, { id: string; name: string; avatar: string }>) =>
    ({
      id: 'ch1',
      kind: 'messenger',
      credentials: { access_token: 'tok', page_id: 'PG1', personas },
    }) as typeof channels.$inferSelect;

  // drizzle's update().set().where() chain resolves to a thenable — the only
  // surface resolvePersona touches.
  const fakeDb = {
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as never;

  const sender = {
    senderId: 'u1',
    senderName: 'Bob',
    senderAvatar: 'https://janis.test/av.png',
  };

  afterEach(() => vi.unstubAllGlobals());

  it('creates a persona and sends persona_id alongside the name prefix', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/personas')) {
        return new Response(JSON.stringify({ id: 'PERSONA1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ message_id: 'm.1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await sendChannelMessage(ch(), 'PSID1', 'hi there', undefined, sender, fakeDb);
    expect(res?.mid).toBe('m.1');
    const personaCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/personas'));
    expect(JSON.parse(String(personaCall![1]?.body))).toEqual({
      name: 'Bob',
      profile_picture_url: 'https://janis.test/av.png',
    });
    const sendBody = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body));
    expect(sendBody.persona_id).toBe('PERSONA1');
    // Meta accepts persona_id but drops persona rendering on many surfaces —
    // the inline prefix is the dependable attribution.
    expect(sendBody.message.text).toBe('Bob: hi there');
  });

  it('reuses a cached persona when name and avatar are unchanged', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message_id: 'm.2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const channel = ch({ u1: { id: 'P9', name: 'Bob', avatar: 'https://janis.test/av.png' } });
    await sendChannelMessage(channel, 'PSID1', 'hi', undefined, sender, fakeDb);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/personas'))).toBe(false);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body)).persona_id).toBe('P9');
  });

  it('falls back to the inline name prefix without an avatar', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message_id: 'm.3' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendChannelMessage(ch(), 'PSID1', 'hi', undefined, { ...sender, senderAvatar: null }, fakeDb);
    const sendBody = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body));
    expect(sendBody.persona_id).toBeUndefined();
    expect(sendBody.message.text).toBe('Bob: hi');
  });
});

describe('sendChannelMessage delivery results', () => {
  const ch = (kind: string) =>
    ({
      kind,
      credentials: { access_token: 'tok', page_id: 'PG1', phone_number_id: 'PN1' },
    }) as typeof channels.$inferSelect;

  afterEach(() => vi.unstubAllGlobals());

  it('reports the Meta error body with a 24h-window hint (error 10/2018278)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'This person is not available right now.',
            type: 'OAuthException',
            code: 10,
            error_subcode: 2018278,
          },
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await sendChannelMessage(ch('messenger'), 'PSID1', 'still there?');
    expect(res?.mid).toBeNull();
    expect(res?.error).toContain('This person is not available right now');
    expect(res?.error).toContain('10/2018278');
    expect(res?.error).toContain('24-hour messaging window');
    expect(res?.retryable).toBe(false); // closed window — retry re-fails
  });

  it('returns the wamid on WhatsApp success and the error on rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.abc' }] }), { status: 200 }),
      ),
    );
    const ok = await sendChannelMessage(ch('whatsapp'), '1555', 'hi');
    expect(ok).toEqual({ mid: 'wamid.abc', error: null, retryable: true });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'Re-engagement message', code: 131047 },
          }),
          { status: 400 },
        ),
      ),
    );
    const bad = await sendChannelMessage(ch('whatsapp'), '1555', 'hi');
    expect(bad?.mid).toBeNull();
    expect(bad?.error).toContain('131047');
    expect(bad?.error).toContain('24-hour messaging window');
    expect(bad?.retryable).toBe(false);
  });

  it('flags transient HTTP failures as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 502 })));
    const res = await sendChannelMessage(ch('messenger'), 'PSID1', 'hi');
    expect(res?.mid).toBeNull();
    expect(res?.retryable).toBe(true);
  });

  it('surfaces a missing access token as an error, and null for webchat', async () => {
    const noToken = { kind: 'messenger', credentials: {} } as typeof channels.$inferSelect;
    const res = await sendChannelMessage(noToken, 'PSID1', 'hi');
    expect(res?.error).toContain('access token');
    expect(res?.retryable).toBe(false);
    expect(await sendChannelMessage(ch('webchat'), 'v1', 'hi')).toBeNull();
  });
});

describe('verifyMetaSignature', () => {
  it('accepts a valid sha256 signature and rejects bad ones', () => {
    const body = '{"a":1}';
    const sig = 'sha256=' + createHmac('sha256', 'testsecret').update(body).digest('hex');
    expect(verifyMetaSignature('testsecret', body, sig)).toBe(true);
    expect(verifyMetaSignature('testsecret', body, 'sha256=bad')).toBe(false);
    expect(verifyMetaSignature('testsecret', 'tampered', sig)).toBe(false);
  });

  it('accepts anything when no app secret is configured (dev mode)', () => {
    expect(verifyMetaSignature('', 'body', undefined)).toBe(true);
  });
});
