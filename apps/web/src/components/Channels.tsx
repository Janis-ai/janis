import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Agent, Channel } from '@janis/shared';
import { useAgents } from '../api/hooks';
import { CodeBlock } from './bits';
import { useConfirm } from './Prompt';
import { friendlyError } from '../lib/friendlyError';

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
  sms: 'SMS',
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
  onRemoved,
}: {
  ch: Channel;
  agents: Agent[];
  /** Detail-page hook: the card is the whole page, so deleting navigates
   *  away instead of leaving a dead panel on screen. */
  onRemoved?: () => void;
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
      api<{ channel: Channel }>(`/api/channels/${ch.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    onSuccess: (data) => {
      setEditingName(false);
      // Write the saved channel into the detail cache — invalidating
      // ['channels'] alone left the detail page showing the old name until
      // a manual refresh (the very bug reported five times).
      qc.setQueryData(['channel', ch.id], data);
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['channel', ch.id] });
    },
  });
  const [confirmEl, confirmRemove] = useConfirm();
  const remove = useMutation({
    mutationFn: () => api(`/api/channels/${ch.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['channel', ch.id] });
      onRemoved?.();
    },
  });
  return (
    <div id={`ch-${ch.id}`} className="card channel-card">
      {confirmEl}
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
        <button
          className="btn danger"
          disabled={remove.isPending}
          onClick={async () => {
            if (
              await confirmRemove(
                `Remove ${ch.name}? Its conversations stay in the inbox, but inbound messages stop arriving and the widget/integration stops working.`,
                [{ key: 'ok', label: 'Remove channel', danger: true }],
              )
            )
              remove.mutate();
          }}
        >
          {remove.isPending ? 'Removing…' : 'Remove'}
        </button>
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
          <details className="webhook-details" style={{ marginTop: 8 }}>
            <summary>
              <span className="details-title">Developer</span>
              <span className="details-sub">signed visitor identity — only needed if your site verifies logged-in users</span>
            </summary>
            <WebchatIdentity channel={ch} />
          </details>
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
          {ch.meta.reply_address && (
            <div className="mono" style={{ marginTop: 4, fontSize: 14 }}>
              {ch.meta.reply_address}
              <span className="muted" style={{ fontFamily: 'inherit', fontSize: 12 }}>
                {' '}
                — replies send from this address
              </span>
            </div>
          )}
          <div className="muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
            To receive mail: point the inbound domain's MX record at your inbound provider
            (Resend → Receiving), register the webhook{' '}
            <span className="mono">{apiOrigin}/channels/email/inbound</span>, or forward an
            existing mailbox to this address. Replies send back from the channel's reply
            address — unique to this channel — threaded onto the customer's message.
          </div>
          <EmailFromName channel={ch} />
        </details>
      )}
      {['gmail','outlook'].includes(ch.kind) && ch.meta.email_address && (
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
          <EmailFromName channel={ch} />
        </details>
      )}
      {['email', 'gmail', 'outlook'].includes(ch.kind) && (
        <details className="webhook-details" open style={{ marginTop: 8 }}>
          <summary>
            <span className="details-title">Answer rules</span>
            <span className="details-sub">
              which mail the agent replies to — groups, senders, subjects
            </span>
          </summary>
          <EmailAnswerRules channel={ch} />
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
      {ch.kind === 'sms' && (
        <details className="webhook-details" open style={{ marginTop: 8 }}>
          <summary>
            <span className="details-title">{ch.meta.phone_number ?? 'SMS number'}</span>
            <span className="details-sub">texts to this number land in this inbox</span>
          </summary>
          <div className="mono" style={{ marginTop: 6, fontSize: 13, wordBreak: 'break-all' }}>
            {apiOrigin}/sms/{ch.id}
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
            Inbound webhook — Janis sets this on the number automatically when the channel is
            created. If texts aren't arriving, paste it in the Twilio console: Phone Numbers →
            your number → Messaging → "A message comes in": POST to the URL above.
          </div>
        </details>
      )}
      {ch.meta.via !== 'oauth' && ch.kind !== 'webchat' && ch.kind !== 'email' && ch.kind !== 'gmail' && ch.kind !== 'outlook' && ch.kind !== 'voice' && ch.kind !== 'sms' && (
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

/** Email answer rules — which inbound mail reaches the agent. The headline
 *  feature is `answer_addresses`: mail To/Cc/Delivered-To'd to a listed
 *  address is ingested even when it's list-fanned — that's what makes a
 *  Google Group / alias / shared mailbox work. */
function EmailAnswerRules({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const f = channel.meta.email_filters ?? {};
  const [form, setForm] = useState({
    answer_addresses: (f.answer_addresses ?? []).join('\n'),
    sender_block: (f.sender_block ?? []).join('\n'),
    sender_allow: (f.sender_allow ?? []).join('\n'),
    subject_exclude: (f.subject_exclude ?? []).join('\n'),
    from_address: channel.meta.from_address ?? '',
    gmail_query: channel.meta.gmail_query ?? '',
    list_mail: f.list_mail ?? false,
  });
  const [msg, setMsg] = useState('');
  const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          from_address: form.from_address.trim(),
          email_filters: {
            answer_addresses: lines(form.answer_addresses),
            sender_block: lines(form.sender_block),
            sender_allow: lines(form.sender_allow),
            subject_exclude: lines(form.subject_exclude),
            list_mail: form.list_mail,
          },
          ...(channel.kind === 'gmail' ? { gmail_query: form.gmail_query.trim() } : {}),
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['channel', channel.id] });
      setMsg('Saved.');
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'Save failed'),
  });
  const field = (key: keyof typeof form, label: string, hint: string, placeholder: string) => (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      <textarea
        className="input"
        rows={2}
        style={{ width: '100%', marginTop: 4, fontFamily: 'inherit', fontSize: 13 }}
        placeholder={placeholder}
        value={form[key] as string}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{hint}</div>
    </div>
  );
  return (
    <div style={{ marginTop: 8, fontSize: 13 }}>
      {field(
        'answer_addresses',
        'Only answer mail addressed to',
        'One address per line — e.g. support@you.com or the Google Group address. ' +
          'Mail delivered to a listed address is answered even when it arrives via a ' +
          'mailing list — this is what makes group/alias/shared-mailbox setups work. ' +
          'Blank = answer everything that lands here.',
        'support@you.com',
      )}
      {field(
        'sender_block',
        'Never answer senders',
        'Addresses or @domains, one per line — e.g. @yourcompany.com to skip coworkers.',
        '@yourcompany.com',
      )}
      {field(
        'sender_allow',
        'Only answer senders (optional)',
        'When set, only these addresses/@domains reach the agent. Blank = everyone.',
        '@bigcustomer.com',
      )}
      {field(
        'subject_exclude',
        'Skip subjects containing',
        'Case-insensitive substrings, one per line — e.g. "out of office", "[newsletter]".',
        'out of office',
      )}
      <label className="muted" style={{ display: 'block', marginTop: 10, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={form.list_mail}
          onChange={(e) => setForm({ ...form, list_mail: e.target.checked })}
        />{' '}
        Answer mailing-list and bulk mail
        <div style={{ fontSize: 12, marginTop: 2 }}>
          Off by default — newsletters and list blasts stay out. Auto-replies and bounces
          are always skipped.
        </div>
      </label>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Send replies as</div>
        <input
          className="input"
          style={{ width: '100%', marginTop: 4 }}
          placeholder={
            channel.kind === 'email'
              ? channel.meta.inbound_address
              : channel.meta.email_address
          }
          value={form.from_address}
          onChange={(e) => setForm({ ...form, from_address: e.target.value })}
        />
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          {channel.kind === 'gmail'
            ? 'A send-as alias verified in Gmail settings (Settings → Accounts → Send mail as) — e.g. the group address.'
            : channel.kind === 'outlook'
              ? 'A shared mailbox or alias the account can Send As in Microsoft 365.'
              : `On the inbound domain, replies send from the channel's own reply address (${channel.meta.reply_address ?? 'auto-generated'}). For a custom-domain From, verify a domain below — customer replies still route to the reply address.`}
        </div>
      </div>
      {channel.kind === 'email' && (
        <MirrorRow channel={channel} />
      )}
      {channel.kind === 'email' && <EmailDomainCard channel={channel} />}
      {channel.kind === 'gmail' && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Gmail scope</div>
          <input
            className="input"
            style={{ width: '100%', marginTop: 4 }}
            placeholder='e.g. label:support -in:spam'
            value={form.gmail_query}
            onChange={(e) => setForm({ ...form, gmail_query: e.target.value })}
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            Extra Gmail search operators on top of "in:inbox" — scopes which mail the
            poller considers at all.
          </div>
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>
          Save rules
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
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
      void qc.invalidateQueries({ queryKey: ['channel', channel.id] });
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
Janis.identify({ id: user.id, name: user.name, email: user.email });
// pass extra context the agent can use (plan, company, page…):
Janis.identify({ id: user.id, name: user.name, email: user.email, sig,
  traits: { plan: 'pro', company: 'Acme Inc' } });`}
      />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
        <span className="mono">traits</span> reaches the agent as host-provided context —
        unsigned traits are labelled self-reported, so don't use them as proof of entitlement.
      </div>
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
    logo_padding: b.logo_padding ?? 2,
    logo_radius: b.logo_radius ?? 8,
    logo_border_width: b.logo_border_width ?? 0,
    logo_border_color: b.logo_border_color ?? '#d1d5db',
    quick_replies: (b.quick_replies ?? []).join(', '),
    teaser_text: b.teaser_text ?? '',
    proactive: b.proactive !== false,
    proactive_delay: b.proactive_delay ?? 20,
    sound: b.sound !== false,
    theme: b.theme ?? 'light',
    hide_powered_by: b.hide_powered_by === true,
    show_help_link: b.show_help_link !== false,
    dictation: b.dictation === true,
    // absent on channels saved before the engine switch — 'llm' matches
    // the server default so their behaviour is preserved
    dictation_advanced: b.dictation_engine !== 'browser',
  });
  const { data: wsDetail } = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api<{ workspace: { plan: string } }>('/api/workspace'),
  });
  const freePlan = wsDetail?.workspace.plan === 'free';
  const { data: articles } = useQuery({
    queryKey: ['articles', channel.agent_id],
    queryFn: () =>
      api<{ articles: { status: string }[] }>(
        `/api/articles?agent_id=${channel.agent_id}`,
      ),
  });
  const hasHelp = (articles?.articles ?? []).some((a) => a.status === 'published');
  // An agent-level external help link shows the button even with no
  // published articles — the preview should reflect that.
  const { data: agents } = useAgents();
  const externalHelp = agents?.agents.find((a) => a.id === channel.agent_id)?.config?.help_url;
  const showHelp = f.show_help_link && (hasHelp || !!externalHelp);
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
            logo_padding: f.logo_padding,
            logo_radius: f.logo_radius,
            logo_border_width: f.logo_border_width,
            logo_border_color: f.logo_border_color,
            quick_replies: parseReplies(f.quick_replies),
            teaser_text: f.teaser_text,
            proactive: f.proactive,
            proactive_delay: f.proactive_delay,
            sound: f.sound,
            theme: f.theme,
            hide_powered_by: f.hide_powered_by,
            show_help_link: f.show_help_link,
            dictation: f.dictation,
            dictation_engine: f.dictation_advanced ? 'llm' : 'browser',
          },
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['channel', channel.id] });
      // Ask Janis caches the bootstrap 5min — drop it so the rail reflects
      // the new branding immediately rather than looking broken.
      void qc.invalidateQueries({ queryKey: ['ask-janis-config', channel.id] });
      setMsg('Saved — the widget picks it up on the next page load.');
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'Save failed'),
  });
  return (
    <form
      className="branding-form"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, maxWidth: 460 }}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn save" disabled={save.isPending}>Save appearance</button>
      </div>
      <div className="row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Accent{' '}
          <input
            type="color"
            className="swatch"
            value={f.accent}
            onChange={(e) => setF({ ...f, accent: e.target.value })}
          />
          <span className="mono muted">{f.accent}</span>
        </label>
        <label className="grow" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Position
          <select value={f.position} onChange={(e) => setF({ ...f, position: e.target.value as 'left' | 'right' })}>
            <option value="right">Bottom right</option>
            <option value="left">Bottom left</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Theme
          <select
            value={f.theme}
            onChange={(e) => setF({ ...f, theme: e.target.value as 'light' | 'dark' | 'auto' })}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="auto">Match visitor's OS</option>
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
        <>
          <div className="row">
            <img
              src={f.logo_url}
              alt="logo preview"
              style={{
                width: 32, height: 32, objectFit: 'contain',
                background: '#fff',
                padding: f.logo_padding,
                borderRadius: f.logo_radius,
                border: f.logo_border_width ? `${f.logo_border_width}px solid ${f.logo_border_color}` : '1px solid var(--border, #ddd)',
              }}
            />
            <button type="button" className="btn" onClick={() => setF({ ...f, logo_url: '' })}>
              Remove logo
            </button>
          </div>
          <div className="row wrap" style={{ gap: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              Inset
              <input
                type="number" min={0} max={16} style={{ width: 56 }}
                value={f.logo_padding}
                onChange={(e) => setF({ ...f, logo_padding: Math.max(0, Math.min(16, Number(e.target.value) || 0)) })}
              />
              px
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              Corners
              <input
                type="number" min={0} max={16} style={{ width: 56 }}
                value={f.logo_radius}
                onChange={(e) => setF({ ...f, logo_radius: Math.max(0, Math.min(16, Number(e.target.value) || 0)) })}
              />
              px
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              Outline
              <input
                type="number" min={0} max={4} style={{ width: 56 }}
                value={f.logo_border_width}
                onChange={(e) => setF({ ...f, logo_border_width: Math.max(0, Math.min(4, Number(e.target.value) || 0)) })}
              />
              px
              <input
                type="color" className="swatch" value={f.logo_border_color}
                onChange={(e) => setF({ ...f, logo_border_color: e.target.value })}
              />
            </label>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Inset also sets the breathing room around the logo inside the
            circular launcher button — the accent ring.
          </div>
        </>
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
      <div className="row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: freePlan ? 0.55 : 1 }}>
          <input
            type="checkbox"
            checked={f.hide_powered_by}
            disabled={freePlan}
            onChange={(e) => setF({ ...f, hide_powered_by: e.target.checked })}
          />
          Remove "Powered by Janis"
        </label>
        {freePlan && (
          <span className="muted" style={{ fontSize: 12 }}>paid plans only</span>
        )}
      </div>
      <div className="row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={f.show_help_link}
            onChange={(e) => setF({ ...f, show_help_link: e.target.checked })}
          />
          Show help link
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          {externalHelp
            ? 'links to the agent\'s external help centre'
            : hasHelp
              ? 'links to the agent\'s published help articles'
              : 'appears once an article is published — or set an external help link on the agent\'s Help page'}
        </span>
      </div>
      {f.proactive && (
        <input
          placeholder="Teaser text (optional — defaults to the greeting)"
          value={f.teaser_text}
          onChange={(e) => setF({ ...f, teaser_text: e.target.value })}
        />
      )}
      <div className="row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={f.dictation}
            onChange={(e) => setF({ ...f, dictation: e.target.checked })}
          />
          Microphone dictation
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          adds a mic so visitors can dictate — free via the browser's speech
          recognition (Chrome/Edge)
        </span>
      </div>
      {f.dictation && (
        <div className="row" style={{ paddingLeft: 22 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={f.dictation_advanced}
              onChange={(e) => setF({ ...f, dictation_advanced: e.target.checked })}
            />
            Advanced speech recognition (uses LLM tokens)
          </label>
          <span className="muted" style={{ fontSize: 12 }}>
            transcribes on Janis's keys so the mic also works on Safari and
            Firefox — metered per minute of audio on your plan, even when the
            agent's own LLM is BYOK
          </span>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {msg && <span className="muted">{msg}</span>}
        <button className="btn save" disabled={save.isPending}>Save appearance</button>
      </div>
      <WidgetPreview
        accent={f.accent}
        title={f.title || channel.name}
        subtitle={f.subtitle || `${channel.agent_name} · replies in seconds`}
        greeting={f.greeting}
        logo_url={f.logo_url}
        logo_padding={f.logo_padding}
        logo_radius={f.logo_radius}
        logo_border_width={f.logo_border_width}
        logo_border_color={f.logo_border_color}
        quick_replies={parseReplies(f.quick_replies)}
        position={f.position}
        theme={f.theme}
        hidePoweredBy={f.hide_powered_by && !freePlan}
        agentName={channel.agent_name}
        hasHelp={showHelp}
      />
    </form>
  );
}

/** Static mock of the embedded widget — mirrors public/widget.js 1:1 so the
 *  operator sees exactly what ships: header (logo only when set), greeting
 *  with author label, quick replies, composer with attach/emoji/Send, the
 *  help-center link when articles exist, the powered-by footer, and the
 *  launcher bubble below the panel on the configured side. */
function WidgetPreview({
  accent,
  title,
  subtitle,
  greeting,
  logo_url,
  logo_padding,
  logo_radius,
  logo_border_width,
  logo_border_color,
  quick_replies,
  position,
  theme,
  hidePoweredBy,
  agentName,
  hasHelp,
}: {
  accent: string;
  title: string;
  subtitle: string;
  greeting: string;
  logo_url: string;
  logo_padding: number;
  logo_radius: number;
  logo_border_width: number;
  logo_border_color: string;
  quick_replies: string[];
  position: 'left' | 'right';
  theme: 'light' | 'dark' | 'auto';
  hidePoweredBy: boolean;
  agentName: string;
  hasHelp: boolean;
}) {
  // Neutral palette — mirrors the hardcoded values in public/widget.js.
  const dark =
    theme === 'dark' ||
    (theme === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const pal = dark
    ? { panel: '#1f2937', msgs: '#111827', out: '#374151', text: '#f3f4f6', muted: '#6b7280', border: '#374151', help: '#60a5fa', author: '#93c5fd' }
    : { panel: '#fff', msgs: '#f9fafb', out: '#e5e7eb', text: '#1f2937', muted: '#9ca3af', border: '#e5e7eb', help: '#2563eb', author: '#1e40af' };
  const tileStyle: CSSProperties = {
    borderRadius: logo_radius,
    padding: logo_padding,
    // Inset logos float on the header colour — the white matte only backs
    // edge-to-edge letterboxing (mirrors widget.js).
    background: logo_padding > 0 ? 'transparent' : '#fff',
    objectFit: 'contain',
    border: logo_border_width ? `${logo_border_width}px solid ${logo_border_color}` : undefined,
  };
  return (
    <div className="wp-stage">
      <div className="widget-preview" style={{ background: pal.panel, color: pal.text }}>
        <div className="wp-head" style={{ background: accent }}>
          {logo_url && <img src={logo_url} alt="" className="wp-logo" style={tileStyle} />}
          <div className="grow">
            <div className="wp-title">{title}</div>
            {subtitle && <div className="wp-sub">{subtitle}</div>}
          </div>
          <span className="wp-expand" title="Expand">⤢</span>
        </div>
        <div className="wp-body" style={{ background: pal.msgs }}>
          {greeting && (
            <div className="wp-msg-wrap">
              <div className="wp-author" style={{ color: pal.author }}>{agentName}</div>
              <div className="wp-msg wp-msg-out" style={{ background: pal.out, color: pal.text }}>
                {greeting}
              </div>
            </div>
          )}
          <div className="wp-msg wp-msg-in" style={{ background: accent }}>
            Hi — how much is the pro plan?
          </div>
          {quick_replies.length > 0 && (
            <div className="wp-qr">
              {quick_replies.map((q) => (
                <span key={q} className="wp-qr-btn" style={{ borderColor: accent, color: accent }}>
                  {q}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="wp-foot" style={{ background: pal.panel, borderTopColor: pal.border }}>
          <span className="wp-ico" style={{ color: pal.muted }}>📎</span>
          <span className="wp-ico" style={{ color: pal.muted }}>😊</span>
          <span className="wp-input" style={{ color: pal.muted }}>Type a message…</span>
          <span className="wp-ico" style={{ color: pal.muted, display: 'flex' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
          </span>
          <span className="wp-send" style={{ background: accent }}>Send</span>
        </div>
        {hasHelp && (
          <div className="wp-help" style={{ background: pal.panel, borderTopColor: pal.border, color: pal.help }}>
            Browse help articles
          </div>
        )}
        {!hidePoweredBy && (
          <div className="wp-power" style={{ background: pal.panel, color: pal.muted }}>
            Powered by Janis
          </div>
        )}
      </div>
      <div className="wp-launcher" style={{ justifyContent: position === 'left' ? 'flex-start' : 'flex-end' }}>
        <div className="wp-bubble" style={{ background: accent }}>
          {logo_url ? (
            <img
              src={logo_url}
              alt=""
              style={logo_padding > 0 ? { width: `calc(100% - ${logo_padding * 2}px)`, height: `calc(100% - ${logo_padding * 2}px)` } : undefined}
            />
          ) : '💬'}
        </div>
      </div>
    </div>
  );
}

/** Custom sending domain for email channels — register a client domain on
 *  the platform Resend account, show the DNS records to add, verify.
 *  Replies still route through the channel's inbound address (Reply-To),
 *  so only sending-side records are needed. */
/** Forwarded-mail mirror — auto-detected when mail arrives via a forwarder,
 *  but also settable/removable by hand. Replies get BCC'd to the mirror so
 *  the upstream mailbox keeps a complete copy of the thread. */
function MirrorRow({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(channel.meta.mirror_address ?? '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const current = channel.meta.mirror_address;
  const save = async (value: string) => {
    setBusy(true);
    setErr('');
    try {
      await api(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ mirror_address: value }),
      });
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['channel', channel.id] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };
  if (current && !editing) {
    return (
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Mail looks forwarded from <strong>{current}</strong> — replies are
        BCC'd there so its copy of the thread stays complete.{' '}
        <button className="btn sm" onClick={() => setEditing(true)}>Change</button>{' '}
        <button className="btn sm" disabled={busy} onClick={() => void save('')}>
          Stop mirroring
        </button>
        {err && <span className="error" style={{ marginLeft: 8 }}>{err}</span>}
      </div>
    );
  }
  if (!editing && !current) {
    return (
      <div style={{ marginTop: 8 }}>
        <button
          className="muted"
          style={{ fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
          onClick={() => setEditing(true)}
        >
          Mirror replies to a mailbox →
        </button>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        Mirror replies to a mailbox — BCC's every reply so that mailbox keeps a
        complete copy of each thread.
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          style={{ maxWidth: 280 }}
          type="email"
          placeholder="you@company.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="btn sm"
          disabled={busy || !/^\S+@\S+\.\S+$/.test(draft.trim())}
          onClick={() => void save(draft.trim().toLowerCase())}
        >
          {busy ? 'Saving…' : 'Mirror replies'}
        </button>
        <button className="btn ghost sm" onClick={() => { setEditing(false); setErr(''); }}>
          Cancel
        </button>
      </div>
      {err && <div className="error" style={{ fontSize: 12, marginTop: 4 }}>{err}</div>}
    </div>
  );
}

type DomainResp = {
  email_domain?: string;
  status?: string;
  records?: { type: string; name: string; value: string; status?: string }[];
  created?: number;
  skipped?: number;
  zone?: string;
};

function EmailDomainCard({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const [domain, setDomain] = useState(channel.meta.email_domain ?? '');
  const [registered, setRegistered] = useState(channel.meta.email_domain ?? '');
  const [status, setStatus] = useState(channel.meta.email_domain_status ?? '');
  const [records, setRecords] = useState(channel.meta.email_domain_records ?? []);
  const [cfToken, setCfToken] = useState('');
  const [cfOpen, setCfOpen] = useState(false);
  const [msg, setMsg] = useState('');
  // Local copies exist for instant feedback after a mutation — but re-sync
  // whenever the channel prop changes, or a stale query snapshot freezes the
  // card on whatever domain was registered at mount.
  useEffect(() => {
    setRegistered(channel.meta.email_domain ?? '');
    setStatus(channel.meta.email_domain_status ?? '');
    if (channel.meta.email_domain_records) setRecords(channel.meta.email_domain_records);
    // A refetch that lands on verified makes any lingering "add the DNS
    // records" instruction stale — the verified state speaks for itself.
    if (channel.meta.email_domain_status === 'verified') setMsg('');
  }, [channel.id, channel.meta.email_domain, channel.meta.email_domain_status, channel.meta.email_domain_records]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['channel', channel.id] });
    void qc.invalidateQueries({ queryKey: ['channels'] });
  };
  const apply = (d: DomainResp) => {
    if (d.email_domain !== undefined) setRegistered(d.email_domain);
    if (d.status !== undefined) setStatus(d.status);
    if (d.records) setRecords(d.records);
  };
  const act = (path: string, body?: unknown, okMsg: string | ((d: DomainResp) => string) = 'Done.') =>
    api(`/api/channels/${channel.id}${path}`, {
      method: body === undefined ? 'DELETE' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
      .then((d) => {
        const r = d as DomainResp;
        setMsg(typeof okMsg === 'function' ? okMsg(r) : okMsg);
        apply(r);
        refresh();
        return true;
      })
      .catch((e) => {
        setMsg(friendlyError(e instanceof Error ? e.message : 'failed').text);
        return false;
      });
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        Custom sending domain
        {registered && (
          <span
            className="muted"
            style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}
          >
            {registered} · {status === 'verified' ? '✓ verified' : status || 'pending'}
          </span>
        )}
      </div>
      {!registered ? (
        <>
          <input
            className="input"
            style={{ width: '100%', marginTop: 4 }}
            placeholder="mail.acme.com — a domain you own"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <div className="row" style={{ marginTop: 6 }}>
            <button
              className="btn sm"
              disabled={!domain.trim()}
              onClick={() => act('/email-domain', { domain: domain.trim() }, 'Registered — add the DNS records below.')}
            >
              Register domain
            </button>
          </div>
        </>
      ) : status !== 'verified' ? (
        <>
          {records.length > 0 ? (
            <table style={{ width: '100%', fontSize: 12, marginTop: 6 }}>
              <thead>
                <tr className="muted" style={{ textAlign: 'left' }}>
                  <th />
                  <th>Type</th>
                  <th>Name</th>
                  <th>Value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={i}>
                    <td style={{ padding: '2px 6px 2px 0', width: 16 }}>
                      {r.status === 'verified' ? '✓' : '·'}
                    </td>
                    <td style={{ padding: '2px 6px 2px 0' }}>{r.type}</td>
                    <td style={{ padding: '2px 6px 2px 0', wordBreak: 'break-all' }}>{r.name}</td>
                    <td style={{ padding: '2px 6px 2px 0', wordBreak: 'break-all' }}>{r.value}</td>
                    <td style={{ padding: '2px 0', width: 22 }}>
                      <button
                        className="btn sm"
                        title="Copy"
                        onClick={() => void navigator.clipboard.writeText(r.value)}
                      >
                        ⧉
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Waiting on DNS records from the mail provider — try Verify DNS to refresh.
            </div>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            <button
              className="btn sm"
              onClick={() =>
                act('/email-domain/verify', {}, (d) => {
                  if (d.status === 'verified')
                    return 'Verified — replies can send from this domain.';
                  // count from the fresh response — `records` state is still
                  // the pre-verify snapshot at this point
                  const recs = d.records ?? records;
                  const confirmed = recs.filter((r) => r.status === 'verified').length;
                  return `Still ${d.status ?? 'pending'} — ${confirmed} of ${recs.length} records confirmed. DNS can take a few minutes.`;
                })
              }
            >
              Verify DNS
            </button>
            {channel.meta.cf_connected ? (
              <button
                className="btn sm"
                onClick={() =>
                  act('/email-domain/cf-setup', {}, (d) =>
                    `Cloudflare: ${d.created ?? 0} record${d.created === 1 ? '' : 's'} created on ${d.zone ?? 'the zone'}${d.skipped ? `, ${d.skipped} already existed` : ''}.`,
                  )
                }
              >
                Push records via Cloudflare
              </button>
            ) : (
              <button
                className="btn sm"
                onClick={() =>
                  api(`/api/channels/${channel.id}/email-domain/dns-setup`, { method: 'POST' })
                    .then((d) => {
                      const r = d as { mode: string; url?: string };
                      if (r.url) window.location.href = r.url;
                      else if (r.mode === 'manual')
                        setMsg('DNS is not on Cloudflare — add the records above at your provider.');
                    })
                    .catch((e) => setMsg(e instanceof Error ? e.message : 'failed'))
                }
              >
                Set up DNS automatically
              </button>
            )}
            <button
              className="btn sm"
              onClick={() =>
                act('/email-domain', undefined, 'Domain removed.').then(() => {
                  setRegistered('');
                  setStatus('');
                  setRecords([]);
                })
              }
            >
              Remove
            </button>
          </div>
          {!cfOpen && !channel.meta.cf_connected && (
            <button
              className="muted"
              style={{ fontSize: 12, marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
              onClick={() => setCfOpen(true)}
            >
              On Cloudflare? Connect or paste a token →
            </button>
          )}
          {cfOpen && (
            <div style={{ marginTop: 8, border: '1px solid var(--border, #333)', borderRadius: 6, padding: 8 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                If the domain's DNS is on Cloudflare, connect once — we'll create every record
                for you (asks for zone read + DNS write only).
              </div>
              <button
                className="btn sm"
                style={{ marginTop: 6 }}
                onClick={() =>
                  api(`/api/channels/${channel.id}/email-domain/cf-connect`, { method: 'POST' })
                    .then((d) => { window.location.href = (d as { url: string }).url; })
                    .catch((e) => setMsg(e instanceof Error ? e.message : 'failed'))
                }
              >
                Connect Cloudflare →
              </button>
              <details style={{ marginTop: 8 }}>
                <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
                  or paste an API token instead
                </summary>
                <input
                  className="input"
                  style={{ width: '100%', marginTop: 4 }}
                  placeholder="Cloudflare API token — used once, never stored"
                  type="password"
                  value={cfToken}
                  onChange={(e) => setCfToken(e.target.value)}
                />
                <button
                  className="btn sm"
                  style={{ marginTop: 6 }}
                  disabled={!cfToken.trim()}
                  onClick={() =>
                    act('/email-domain/cf-setup', { api_token: cfToken.trim() }, (d) =>
                      `Cloudflare: ${d.created ?? 0} record${d.created === 1 ? '' : 's'} created on ${d.zone ?? 'the zone'}${d.skipped ? `, ${d.skipped} already existed` : ''} — verification may take a minute.`,
                    ).then((ok) => {
                      if (!ok) return;
                      setCfToken('');
                      setCfOpen(false);
                    })
                  }
                >
                  Add records
                </button>
              </details>
            </div>
          )}
        </>
      ) : status === 'verified' ? (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Set "Send replies as" to any @{registered} address — replies still
            route to this channel.
          </span>
          <button
            className="btn sm"
            onClick={() =>
              act('/email-domain', undefined, 'Domain removed.').then(() => {
                setRegistered('');
                setStatus('');
                setRecords([]);
              })
            }
          >
            Remove
          </button>
        </div>
      ) : null}
      {msg && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{msg}</div>}
    </div>
  );
}
