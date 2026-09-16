import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPlatformProfile, parseMetaWebhook, verifyMetaSignature } from './channels.js';
import type { channels } from '../db/schema.js';
import { createHmac } from 'node:crypto';

describe('parseMetaWebhook', () => {
  it('parses messenger text messages', () => {
    const body = {
      entry: [
        {
          id: 'PAGE123',
          messaging: [
            { sender: { id: 'PSID1' }, recipient: { id: 'PAGE123' }, message: { text: 'hello' } },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([
      { objectId: 'PAGE123', senderId: 'PSID1', text: 'hello', name: undefined },
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

  it('parses whatsapp messages with contact names', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PHONE1' },
                contacts: [{ wa_id: '15551234567', profile: { name: 'Jane' } }],
                messages: [{ from: '15551234567', type: 'text', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([
      { objectId: 'PHONE1', senderId: '15551234567', text: 'hi', name: 'Jane' },
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
