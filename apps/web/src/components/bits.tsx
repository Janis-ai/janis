import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import type { Conversation, ConversationState, UserProfile } from '@janis/shared';
import { friendlyName } from '@janis/shared';
import { currentTheme, THEME_CHANGE_EVENT } from '../lib/theme';
import { highlight, type CodeLang } from '../lib/highlight';
import { linkifyParts, splitEmphasis, stripStrayMarkers } from '../lib/richText';

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
  slack: 'Slack',
  email: 'Email',
  gmail: 'Gmail',
};

export function channelLabel(kind?: string): string {
  if (!kind) return '';
  return CHANNEL_LABELS[kind] ?? kind;
}

/** What surface the conversation actually arrived on — concierge threads
 * can ride the webchat channel but originate in Slack; the `surface` trait
 * the ingress stamps is more honest than the transport channel kind. */
export function surfaceLabel(p?: Pick<UserProfile, 'channel'> & { metadata?: Record<string, unknown> }): string {
  const surface = p?.metadata?.surface;
  return channelLabel(typeof surface === 'string' && surface ? surface : p?.channel);
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

/** Titled code card with a copy button — used for embed snippets and docs.
 *  `lang` syntax-highlights (js/html/sh) via the tiny tokenizer in
 *  lib/highlight; omitted for plain mono text. */
/** Docs-style two-column table — head row, then rows keyed on the first
 *  cell (mono) with the rest muted. Shared by the guide pages. */
export function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table className="docs-table">
      <thead>
        <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[0]}>
            {r.map((c, i) => (
              <td key={i} className={i === 0 ? 'mono' : 'muted'}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Framed guide screenshot — platform UI captures inside the docs. */
export function DocShot({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      style={{
        display: 'block',
        maxWidth: 560,
        width: '100%',
        borderRadius: 8,
        border: '1px solid var(--border)',
        margin: '10px 0 4px',
      }}
    />
  );
}

export function CodeBlock({ title, code, lang }: { title: string; code: string; lang?: CodeLang }) {
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
      <pre>
        {lang
          ? highlight(code, lang).map((t, i) =>
              t.t ? (
                <span key={i} className={t.t}>
                  {t.s}
                </span>
              ) : (
                t.s
              ),
            )
          : code}
      </pre>
    </div>
  );
}

/** Bare code block with a copy button — the docs-page grammar (used by the
 *  API/automation/operator guides). CodeBlock above is the titled variant
 *  for console cards. */
export function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
    } catch {
      // clipboard API needs a secure context — fall back for older setups
      const ta = document.createElement('textarea');
      ta.value = children;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="docs-code-wrap">
      <button className="docs-copy" onClick={copy} title="Copy to clipboard" aria-label="Copy code">
        {copied ? '✓' : '⧉'}
      </button>
      <pre className="docs-code">{children}</pre>
    </div>
  );
}

/** Inline markdown-ish emphasis for one-line contexts — conversation
 *  previews, list rows. No links: these render inside row links already,
 *  and nested <a> is invalid. */
export function Md({ children }: { children: string }) {
  return (
    <>
      {splitEmphasis(children.replace(/^#{1,6}\s+/, '')).map((seg, i) => {
        if (seg.kind === 'text') return stripStrayMarkers(seg.text);
        if (seg.kind === 'math') return <span key={i} className="md-math">{seg.text}</span>;
        const Tag =
          seg.kind === 'bold'
            ? 'b'
            : seg.kind === 'italic'
              ? 'em'
              : seg.kind === 'strike'
                ? 's'
                : 'code';
        return (
          <Tag key={i} className={seg.kind === 'code' ? 'md-code' : undefined}>
            {seg.text}
          </Tag>
        );
      })}
    </>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card muted" style={{ textAlign: 'center', padding: 40 }}>{children}</div>;
}

/** Canonical agent text is markdown-ish — **bold**, *italic*, ~~strike~~ and
 *  `code`, plus real links (lists are handled one level up by splitBlocks).
 *  The transcript renderer shared by the console conversation page and the
 *  embedded Shopify inbox. */
export function mdSpans(text: string, keyBase = 0) {
  return splitEmphasis(text).flatMap((seg, i) => {
    if (seg.kind === 'math')
      return [
        <span key={keyBase * 1000 + i} className="md-math">
          {seg.text}
        </span>,
      ];
    const inner = linkifyParts(seg.text).map((p, j) =>
      typeof p === 'string' ? (
        p
      ) : (
        <a
          key={keyBase * 1000 + i * 100 + j}
          href={p.href}
          target="_blank"
          rel="noreferrer"
        >
          {p.label}
        </a>
      ),
    );
    if (seg.kind === 'text') return inner;
    const Tag =
      seg.kind === 'bold'
        ? 'b'
        : seg.kind === 'italic'
          ? 'em'
          : seg.kind === 'strike'
            ? 's'
            : 'code';
    return [
      <Tag key={keyBase * 1000 + i} className={seg.kind === 'code' ? 'md-code' : undefined}>
        {inner}
      </Tag>,
    ];
  });
}

/** Tool-call args as readable key → value rows instead of a JSON blob.
 *  Label over value — the approval card lives in the chat rail where a
 *  side-by-side column wraps values mid-word. Non-scalar values
 *  stringify inline so structure stays visible. */
/** gid://shopify/Order/6790076760241 → "Order 6790076760241" — the resource
 *  kind matters, the gid prefix doesn't. */
function shortId(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.replace(/gid:\/\/shopify\/([A-Za-z]+)\/(\d+)/g, '$1 $2');
}

/** Flatten nested tool args into readable key → value rows — approvers
 *  decide on a refund/return from "what for, how much, why", not a JSON
 *  blob. Single-level objects flatten into parent.key; arrays of objects
 *  list their meaningful fields inline. */
function flattenArgs(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
      (v as Record<string, unknown>[]).forEach((item, i) =>
        out.push(...flattenArgs(item, `${key}[${i}]`)),
      );
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenArgs(v as Record<string, unknown>, key));
    } else {
      out.push([key, v]);
    }
  }
  return out;
}

const NOISE_KEYS = /^(id|return_request$|gid|fulfillmentLineItemId|lineItemId|orderId)$/i;
const LABEL_KEY = /customerNote|reason|note|quantity|returnReason|restockType|notify|title|code|name|email|order/i;

export function ArgsRows({ args }: { args: Record<string, unknown> }) {
  const flat = flattenArgs(args).filter(([k]) => {
    const leaf = k.split(/[.\[]/).pop() ?? k;
    return !NOISE_KEYS.test(leaf) || LABEL_KEY.test(leaf);
  });
  if (!flat.length) return null;
  return (
    <div style={{ margin: '4px 0 2px', fontSize: 12.5 }}>
      {flat.map(([k, v]) => {
        const leaf = (k.split(/[.\[]/).pop() ?? k).replace(/_/g, ' ');
        const shown = shortId(v);
        const isNote = /customerNote|reason|note/i.test(leaf);
        return (
          <div key={k} style={{ padding: '2px 0', display: 'flex', gap: 8 }}>
            <span className="muted" style={{ minWidth: 90, flexShrink: 0 }}>
              {leaf}
            </span>
            <span
              style={{
                overflowWrap: 'anywhere',
                fontWeight: isNote ? 600 : 400,
              }}
            >
              {shown}
            </span>
          </div>
        );
      })}
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
