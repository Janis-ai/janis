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
      { objectId: 'PAGE123', senderId: 'PSID1', text: 'Get Started', messageId: 'mid.pb' },
      { objectId: 'PAGE123', senderId: 'PSID2', text: 'MENU_ITEM', messageId: undefined },
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
