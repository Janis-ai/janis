import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import type { Conversation, ConversationState, UserProfile } from '@janis/shared';
import { friendlyName } from '@janis/shared';
import { currentTheme, THEME_CHANGE_EVENT } from '../lib/theme';

/** The wordmark/mark PNGs are white-on-transparent — invisible in light mode.
 *  Swaps to the ink variant when the theme flips (or on first render). */
export function BrandImg({ mark, ...rest }: { mark?: boolean } & ImgHTMLAttributes<HTMLImageElement>) {
  const [theme, setTheme] = useState(currentTheme());
  useEffect(() => {
    const on = () => setTheme(currentTheme());
    window.addEventListener(THEME_CHANGE_EVENT, on);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, on);
  }, []);
  const src = mark
    ? theme === 'light' ? '/img/janis-mark-dark.png' : '/img/janis-mark.png'
    : theme === 'light' ? '/img/janis-top-dark.png' : '/img/janis-top.png';
  return <img src={src} {...rest} />;
}

export function StateBadge({ state }: { state: ConversationState }) {
  const label = { active: 'Agent', needs_human: 'Needs human', human: 'Human', archived: 'Archived' }[state];
  return <span className={`badge ${state}`}>{label}</span>;
}

/** Display name for a conversation: real name → @handle → email → external id. */
export function displayName(c: Pick<Conversation, 'external_id' | 'user_profile'>): string {
  const p = (c.user_profile ?? {}) as UserProfile;
  if (p.name) return p.name;
  if (p.username) return `@${p.username}`;
  if (p.email) return p.email;
  // anonymous visitors have no profile — show a short stable handle
  // ("Calm Otter a48f") instead of the raw `webchat:<uuid>` external id
  return friendlyName(c.external_id);
}

const CHANNEL_LABELS: Record<string, string> = {
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  webchat: 'Bubble',
  email: 'Email',
  gmail: 'Gmail',
};

export function channelLabel(kind?: string): string {
  if (!kind) return '';
  return CHANNEL_LABELS[kind] ?? kind;
}

/** Profile picture via the API proxy, falling back to an initial. */
export function Avatar({
  c,
  size = 32,
}: {
  c: Pick<Conversation, 'id' | 'has_avatar' | 'external_id' | 'user_profile'>;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (c.has_avatar && !failed) {
    return (
      <img
        className="avatar"
        style={{ width: size, height: size }}
        src={`/api/conversations/${c.id}/avatar`}
        onError={() => setFailed(true)}
        alt=""
      />
    );
  }
  return (
    <span
      className="avatar fallback"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {displayName(c)[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

/** Titled code card with a copy button — used for embed snippets and docs. */
export function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{title}</span>
        <button type="button" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card muted" style={{ textAlign: 'center', padding: 40 }}>{children}</div>;
}

/** Tool-call args as readable key → value rows instead of a JSON blob.
 *  Non-scalar values stringify inline so structure stays visible. */
export function ArgsRows({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args);
  if (!entries.length) return null;
  return (
    <div style={{ margin: '4px 0 2px', fontSize: 12.5 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 8, padding: '1px 0' }}>
          <span className="muted" style={{ minWidth: 110, flexShrink: 0 }}>{k.replace(/_/g, ' ')}</span>
          <span className="mono" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Shared footer for the public pages (home, docs, legal) — one place to
 * update the year logic and link set. */
export function SiteFooter({ style }: { style?: React.CSSProperties }) {
  return (
    <footer className="landing-footer muted" style={style}>
      <BrandImg alt="Janis" style={{ height: 20, opacity: 0.8 }} />
      <span>© {new Date().getFullYear()} Janis</span>
      <Link to="/">Home</Link>
      <Link to="/docs">Docs</Link>
      <a href="/slack/add">Add to Slack</a>
      <Link to="/privacy">Privacy Policy</Link>
      <Link to="/terms">Terms of Service</Link>
    </footer>
  );
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Absolute timestamp for transcript lines: "2:34 PM" today,
 * "Sep 19, 2:34 PM" older (year appended when it differs). */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const date = d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${date}, ${time}`;
}

/** Multiline text field that grows with its content (cap 160px) — wider than
 *  the default input so longer copy isn't truncated mid-sentence. */
export function AutosizeText(props: { value: string; placeholder: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const t = ref.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
    t.style.overflowY = t.scrollHeight > 160 ? 'auto' : 'hidden';
  };
  useEffect(grow, [props.value]);
  return (
    <textarea
      ref={ref}
      className="input"
      rows={1}
      style={{ width: '100%', resize: 'vertical', minHeight: 38 }}
      value={props.value}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      onInput={grow}
    />
  );
}
