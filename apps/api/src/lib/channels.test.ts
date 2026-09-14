import { describe, expect, it } from 'vitest';
import { parseMetaWebhook, verifyMetaSignature } from './channels.js';
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
