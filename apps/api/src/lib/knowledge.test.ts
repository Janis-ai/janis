import { describe, expect, it } from 'vitest';
import { extractKnowledgeText, UnsupportedFileError } from './knowledge.js';
import { conversationContext, systemPrompt } from './hostedAgent.js';
import type { agents, conversations } from '../db/schema.js';

const noLlm = { apiKey: '', baseUrl: '', model: '' };
const agent = { config: {} } as typeof agents.$inferSelect;

describe('extractKnowledgeText', () => {
  it('extracts plain text files', async () => {
    const text = await extractKnowledgeText(
      Buffer.from('Refunds allowed within 30 days.\nSupport hours 9-5 ET.'),
      'text/plain',
      'policy.txt',
      noLlm,
    );
    expect(text).toContain('Refunds allowed within 30 days');
  });

  it('reads text by extension when mime is generic', async () => {
    const text = await extractKnowledgeText(
      Buffer.from('order lookup needs the order number'),
      'application/octet-stream',
      'notes.md',
      noLlm,
    );
    expect(text).toContain('order lookup');
  });

  it('rejects unsupported types', async () => {
    await expect(
      extractKnowledgeText(Buffer.from([0x89, 0x50]), 'application/zip', 'a.zip', noLlm),
    ).rejects.toThrow(UnsupportedFileError);
  });

  it('rejects images without an LLM key', async () => {
    await expect(
      extractKnowledgeText(Buffer.from([1, 2, 3]), 'image/png', 'a.png', noLlm),
    ).rejects.toThrow('LLM');
  });

  it('rejects empty files', async () => {
    await expect(
      extractKnowledgeText(Buffer.from('   \n  '), 'text/plain', 'a.txt', noLlm),
    ).rejects.toThrow('empty');
  });
});

describe('systemPrompt knowledge docs', () => {
  it('injects uploaded doc text under a documents section', () => {
    const prompt = systemPrompt(agent, [
      { name: 'policy.pdf', text: 'Refunds allowed within 30 days.' },
    ]);
    expect(prompt).toContain('policy.pdf');
    expect(prompt).toContain('Refunds allowed within 30 days');
    expect(prompt).toContain('Knowledge base documents');
  });

  it('works without docs', () => {
    const prompt = systemPrompt(agent, []);
    expect(prompt).not.toContain('Knowledge base documents');
  });
});

describe('conversation context', () => {
  const conv = (userProfile: Record<string, unknown>, externalId = 'instagram:123') =>
    ({ externalId, userProfile }) as typeof conversations.$inferSelect;

  it('renders channel and customer fields that exist', () => {
    const prompt = systemPrompt(agent, [], conv({
      channel: 'instagram',
      channel_name: 'George Harrison Band',
      name: 'Michael Nathan',
      username: 'mnatha',
      id: '7383693028315153',
    }));
    expect(prompt).toContain('Channel: instagram — account "George Harrison Band"');
    expect(prompt).toContain('Customer: Michael Nathan (@mnatha)');
    expect(prompt).toContain('7383693028315153');
    expect(prompt).toContain('email: unknown');
    expect(prompt).toContain('save_user_profile');
  });

  it('shows email when present and omits missing fields', () => {
    const ctx = conversationContext(
      conv({ channel: 'messenger', name: 'Jane', email: 'j@x.com' }, 'messenger:P1'),
    );
    expect(ctx).toContain('Channel: messenger');
    expect(ctx).toContain('email: j@x.com');
    expect(ctx).not.toContain('phone');
    expect(ctx).not.toContain('platform id');
  });

  it('falls back to the external id prefix for non-channel convs', () => {
    const ctx = conversationContext(conv({}, 'webtest:u1'));
    expect(ctx).toContain('Channel: webtest');
  });
});
