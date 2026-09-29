import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Agent, Channel } from '@janis/shared';
import { CodeBlock } from './bits';

export interface PendingAssets {
  pages: { id: string; name: string; instagram: { id: string; username?: string } | null }[];
  whatsapp: { id: string; name?: string; phone_numbers: { id: string; display_phone_number?: string }[] }[];
}

export const KIND_LABEL: Record<string, string> = {
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  webchat: 'Web chat',
  email: 'Email',
  gmail: 'Gmail',
  voice: 'Voice',
};

/** Comma- or newline-separated text → trimmed array of quick-reply labels. */
export function parseReplies(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** A single connected channel — the full editor (branding, embed, credentials,
 *  reassign, remove). Rendered on the owning agent's Channels tab. */
export function ChannelCard({
  ch,
  agents,
}: {
  ch: Channel;
  agents: Agent[];
}) {
  const qc = useQueryClient();
  const apiOrigin =
    window.location.hostname === 'localhost' ? 'http://localhost:8787' : window.location.origin;
  const chAgent = agents.find((a) => a.id === ch.agent_id);
  const dead = chAgent && !chAgent.hosted && !chAgent.webhook_url;
  const reassign = useMutation({
    mutationFn: (agent_id: string) =>
      api(`/api/channels/${ch.id}`, { method: 'PATCH', body: JSON.stringify({ agent_id }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['channel', ch.id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(ch.name);
  const rename = useMutation({
    mutationFn: (name: string) =>
      api(`/api/channels/${ch.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      setEditingName(false);
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/channels/${ch.id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['channels'] }),
  });
  return (
    <div id={`ch-${ch.id}`} className="card channel-card">
      <div className="row">
        {editingName ? (
          <input
            className="grow"
            autoFocus
            value={nameDraft}
            disabled={rename.isPending}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              const next = nameDraft.trim();
              if (next && next !== ch.name) rename.mutate(next);
              else setEditingName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setNameDraft(ch.name);
                setEditingName(false);
              }
            }}
          />
        ) : (
          <strong
            className="grow"
            style={{ cursor: 'text' }}
            title="Click to rename"
            onClick={() => {
              setNameDraft(ch.name);
              setEditingName(true);
            }}
          >
            {ch.name}
          </strong>
        )}
        <span className="badge active">{KIND_LABEL[ch.kind] ?? ch.kind}</span>
        <button className="btn danger" onClick={() => remove.mutate()}>Remove</button>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>
        Answered by{' '}
        <select
          value={ch.agent_id}
          onChange={(e) => reassign.mutate(e.target.value)}
          disabled={reassign.isPending}
        >
          {[...agents]
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
            .map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
        </select>
        {dead && <span className="badge warn" style={{ marginLeft: 6 }}>agent unreachable</span>}
        {ch.meta.page_id && <> · page {ch.meta.page_id}</>}
        {ch.meta.phone_number_id && <> · {ch.meta.phone_number_id}</>}
      </div>
      {dead && (
        <div style={{ color: '#fde047', marginTop: 6, fontSize: 13 }}>
          {ch.agent_name} has no webhook URL and isn't hosted by Janis — inbound messages on this
          channel go unanswered. Fix it on the agent's page.
        </div>
      )}
      {ch.meta.chat_url && (
        <div style={{ marginTop: 6 }}>
          <a href={ch.meta.chat_url} target="_blank" rel="noreferrer">
            Open chat as a customer ↗
          </a>
        </div>
      )}
      {ch.kind === 'webchat' && (
        <>
          <CodeBlock
            title="Embed — paste before </body> on your site"
            code={`<script src="${apiOrigin}/widget.js" data-janis-token="${ch.id}" async></script>`}
          />
          <WebchatIdentity channel={ch} />
          <details className="webhook-details appearance-details" open style={{ marginTop: 8 }}>
            <summary>
              <span className="details-title">Appearance</span>
              <span className="details-sub">branding for the embedded widget</span>
            </summary>
            <WebchatBranding channel={ch} />
          </details>
        </>
      )}
      {ch.kind === 'email' && ch.meta.inbound_address && (
        <details className="webhook-details" open style={{ marginTop: 8 }}>
          <summary>
            <span className="details-title">Inbound address</span>
            <span className="details-sub">mail to this address becomes a conversation</span>
          </summary>
          <div className="mono" style={{ marginTop: 6, fontSize: 14 }}>
            {ch.meta.inbound_address}
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
            To receive mail: point the inbound domain's MX record at your inbound provider
            (Resend → Receiving), register the webhook{' '}
            <span className="mono">{apiOrigin}/channels/email/inbound</span>, or forward an
            existing mailbox to this address. Replies send back from the same address, threaded
            onto the customer's message.
          </div>
          <EmailFromName channel={ch} />
        </details>
      )}
      {ch.kind === 'gmail' && ch.meta.email_address && (
        <details className="webhook-details" open style={{ marginTop: 8 }}>
          <summary>
            <span className="details-title">Connected mailbox</span>
            <span className="details-sub">polled about once a minute</span>
          </summary>
          <div className="mono" style={{ marginTop: 6, fontSize: 14 }}>
            {ch.meta.email_address}
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
            New inbox mail becomes conversations here and replies send from this address in
            the customer's thread. To stop syncing, disconnect the channel — or revoke access
            at myaccount.google.com/permissions.
          </div>
        </details>
      )}
      {ch.kind === 'voice' && ch.meta.hosted && (
        <details className="webhook-details" open style={{ marginTop: 8 }}>
          <summary>
            <span className="details-title">{ch.meta.phone_number}</span>
            <span className="details-sub">provisioned by Janis — no setup needed</span>
          </summary>
          <div className="muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
            This number is live — calls answer now. Callers are transcribed, the agent
            answers by voice, and the call lands in this inbox as a normal conversation.
          </div>
        </details>
      )}
      {ch.kind === 'voice' && !ch.meta.hosted && (
        <details className="webhook-details" open style={{ marginTop: 8 }}>
          <summary>
            <span className="details-title">Twilio voice webhook</span>
            <span className="details-sub">paste this on the number in the Twilio console</span>
          </summary>
          <div className="mono" style={{ marginTop: 6, fontSize: 13, wordBreak: 'break-all' }}>
            {apiOrigin}/voice/{ch.id}/incoming
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
            Twilio console → Phone Numbers → your number → Voice → "A call comes in": POST to
            the URL above. Optionally point "Call status changes" at{' '}
            <span className="mono">{apiOrigin}/voice/{ch.id}/status</span> so hangups close the
            call cleanly. Callers are transcribed, the agent answers by voice, and the call
            lands in this inbox as a normal conversation.
          </div>
        </details>
      )}
      {ch.meta.via !== 'oauth' && ch.kind !== 'webchat' && ch.kind !== 'email' && ch.kind !== 'gmail' && ch.kind !== 'voice' && (
      <details className="webhook-details">
        <summary>Webhook details</summary>
        <div className="mono" style={{ marginTop: 6 }}>
          <div>URL: {apiOrigin}/channels/meta/webhook</div>
          <div>Verify token: {ch.meta.verify_token}</div>
        </div>
      </details>
      )}
    </div>
  );
}

/** Email channel: the From display name outbound replies send as. */
function EmailFromName({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const [name, setName] = useState(channel.meta.from_name ?? '');
  const [msg, setMsg] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ from_name: name.trim() }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['channel', channel.id] });
      setMsg('Saved.');
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'Save failed'),
  });
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <input
        className="grow"
        placeholder={`From name on replies (defaults to "${channel.name}")`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>
        Save
      </button>
      {msg && <span className="muted">{msg}</span>}
    </div>
  );
}

/** Visitor identity for the webchat widget: unsigned claims vs HMAC-signed
 *  identity, and the channel's signing secret. */
function WebchatIdentity({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const [secret, setSecret] = useState(channel.meta.identity_secret ?? '');
  const [msg, setMsg] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ identity_secret: secret.trim() }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      setMsg(secret.trim() ? 'Saved — signed identity is now enabled.' : 'Cleared — signed identity disabled.');
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'Save failed'),
  });
  const generate = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    setSecret([...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));
    setMsg('Generated — Save to activate.');
  };
  return (
    <div style={{ marginTop: 14 }}>
      <strong style={{ fontSize: 13 }}>Identify logged-in visitors</strong>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
        Anonymous by default. If your site has accounts, tell the widget who the visitor is — the
        agent sees their name/email/account id instead of asking. To mark the identity{' '}
        <em>verified</em> (required before the agent trusts the account id for lookups), sign it on
        your server with the secret below — never in browser JavaScript.
      </div>
      <CodeBlock
        title="Your server — sign the identity (Node.js)"
        code={`const sig = crypto.createHmac('sha256', IDENTITY_SECRET)
  .update(\`\${user.id}|\${user.email}|\${user.name}\`)
  .digest('hex');
// send sig to the page with the rest of the user payload`}
      />
      <CodeBlock
        title="Your page — after the widget script"
        code={`Janis.identify({ id: user.id, name: user.name, email: user.email, sig });
// or unsigned (self-reported name/email only):
Janis.identify({ id: user.id, name: user.name, email: user.email });`}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <input
          className="grow mono"
          placeholder="Identity signing secret (optional)"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <button className="btn" type="button" onClick={generate}>Generate</button>
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
      </div>
      {msg && <div className="muted" style={{ fontSize: 12 }}>{msg}</div>}
      {channel.meta.identity_secret && secret !== channel.meta.identity_secret && (
        <div className="muted" style={{ fontSize: 12 }}>unsaved changes — the widget still uses the stored secret</div>
      )}
    </div>
  );
}

// widget.js paints this accent when none is configured — the picker should
// always show the color that's actually in effect, and <input type=color>
// only renders a valid 6-digit hex (empty/invalid values show a blank box)
const DEFAULT_ACCENT = '#5b21b6';
const normHex = (v: string | undefined) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v ?? '');
  if (!m) return DEFAULT_ACCENT;
  const h = m[1].toLowerCase();
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h);
};

/** Webchat widget appearance editor — PATCHes display config on the channel. */
function WebchatBranding({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const b = channel.meta.branding ?? {};
  const [f, setF] = useState({
    title: b.title ?? '',
    subtitle: b.subtitle ?? '',
    greeting: b.greeting ?? '',
    accent: normHex(b.accent),
    position: b.position ?? 'right',
    logo_url: b.logo_url ?? '',
    quick_replies: (b.quick_replies ?? []).join(', '),
    teaser_text: b.teaser_text ?? '',
    proactive: b.proactive !== false,
    proactive_delay: b.proactive_delay ?? 20,
    sound: b.sound !== false,
  });
  const [msg, setMsg] = useState('');
  const uploadLogo = async (file: File) => {
    setMsg('Uploading…');
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'include' });
    if (res.ok) {
      const att = (await res.json()) as { url: string };
      setF((cur) => ({ ...cur, logo_url: att.url }));
      setMsg('Logo uploaded — save appearance to apply.');
    } else {
      setMsg('Upload failed.');
    }
  };
  const save = useMutation({
    mutationFn: () =>
      api(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          branding: {
            title: f.title,
            subtitle: f.subtitle,
            greeting: f.greeting,
            accent: f.accent,
            position: f.position,
            logo_url: f.logo_url,
            quick_replies: parseReplies(f.quick_replies),
            teaser_text: f.teaser_text,
            proactive: f.proactive,
            proactive_delay: f.proactive_delay,
            sound: f.sound,
          },
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      setMsg('Saved — the widget picks it up on the next page load.');
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'Save failed'),
  });
  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, maxWidth: 460 }}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Accent{' '}
          <input
            type="color"
            value={f.accent}
            onChange={(e) => setF({ ...f, accent: e.target.value })}
          />
        </label>
        <label className="grow" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Position
          <select value={f.position} onChange={(e) => setF({ ...f, position: e.target.value as 'left' | 'right' })}>
            <option value="right">Bottom right</option>
            <option value="left">Bottom left</option>
          </select>
        </label>
      </div>
      <input
        placeholder="Header title (defaults to widget name)"
        value={f.title}
        onChange={(e) => setF({ ...f, title: e.target.value })}
      />
      <input
        placeholder="Subtitle (defaults to agent name)"
        value={f.subtitle}
        onChange={(e) => setF({ ...f, subtitle: e.target.value })}
      />
      <input
        placeholder="Greeting — overrides the agent's greeting (optional)"
        value={f.greeting}
        onChange={(e) => setF({ ...f, greeting: e.target.value })}
      />
      <div className="row">
        <input
          className="grow"
          placeholder="Logo image URL — header + bubble icon (optional)"
          value={f.logo_url}
          onChange={(e) => setF({ ...f, logo_url: e.target.value })}
        />
        <label className="btn" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
          Upload image
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadLogo(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {f.logo_url && (
        <div className="row">
          <img
            src={f.logo_url}
            alt="logo preview"
            style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--border, #ddd)' }}
          />
          <button type="button" className="btn" onClick={() => setF({ ...f, logo_url: '' })}>
            Remove logo
          </button>
        </div>
      )}
      <input
        placeholder="Quick replies — comma-separated (optional, e.g. Pricing, Support, Book demo)"
        value={f.quick_replies}
        onChange={(e) => setF({ ...f, quick_replies: e.target.value })}
      />
      <div className="row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={f.proactive}
            onChange={(e) => setF({ ...f, proactive: e.target.checked })}
          />
          Proactive teaser
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          after
          <input
            type="number"
            min={0}
            max={300}
            style={{ width: 64 }}
            value={f.proactive_delay}
            onChange={(e) => setF({ ...f, proactive_delay: Math.max(0, Math.min(300, Number(e.target.value) || 0)) })}
          />
          s
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={f.sound}
            onChange={(e) => setF({ ...f, sound: e.target.checked })}
          />
          Reply sound
        </label>
      </div>
      {f.proactive && (
        <input
          placeholder="Teaser text (optional — defaults to the greeting)"
          value={f.teaser_text}
          onChange={(e) => setF({ ...f, teaser_text: e.target.value })}
        />
      )}
      <div className="row">
        <button className="btn" disabled={save.isPending}>Save appearance</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </form>
  );
}
