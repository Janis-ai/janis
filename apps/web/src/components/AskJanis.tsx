import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

interface ChatConfig {
  agent_name: string;
  title: string;
  greeting: string | null;
  quick_replies: string[];
  logo_url: string | null;
}

interface Attachment {
  name: string;
  url: string;
  type: string;
  size: number;
}

interface ChatMsg {
  id: string;
  direction: string;
  text: string;
  created_at: string;
  attachments?: Attachment[];
  quick_replies?: string[];
  author?: { name: string; avatar: string | null };
}

interface OutEntry {
  localId: string;
  text: string;
  attachments: Attachment[];
  status: 'pending' | 'failed' | 'delivered' | 'sent';
  ts: string;
}

interface PendingFile {
  name: string;
  uploading: boolean;
  url?: string;
  type?: string;
  size?: number;
}

const EMOJIS = (
  '😀 😄 😁 🙂 😉 😊 😍 🤩 😘 😜 🤪 😎 🤔 😅 😂 🤣 😢 😭 😮 😴' +
  ' 👍 👎 🙏 👏 🙌 🤝 💪 ✌️ 🤞 👋 👀 💬 ❤️ 💚 💙 💜 🖤 🤍 💯 ✅ 🎉 🔥 ⭐ 💡 📎 ❓'
).split(' ');

function visitorId(): string {
  const k = 'janis_console_visitor';
  let v = localStorage.getItem(k);
  if (!v) {
    v = (crypto.randomUUID?.() ?? `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`).replace(/-/g, '');
    localStorage.setItem(k, v);
  }
  return v;
}

/** Render [label](url) markdown links and bare https:// URLs as anchors —
 * same rules as the public widget, DOM-only so text can't inject markup.
 * Links on this origin (or app.janis.ai in dev) go through the SPA router so
 * the rail stays open; everything else opens in a new tab. */
/** Sentence punctuation glued to a URL — "see https://x.com/a." should link
 * the URL, not the period. Closers are only stripped when unbalanced, so
 * https://x.com/f_(b) keeps its parens while "(see https://x.com)" doesn't
 * eat the bracket. Returns [cleanUrl, trailingText]. */
function splitTrail(u: string): [string, string] {
  let trail = '';
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  while (u.length) {
    const c = u[u.length - 1];
    if ('.,;:!?\'"'.includes(c)) {
      trail = c + trail;
      u = u.slice(0, -1);
      continue;
    }
    const open = pairs[c];
    if (open && u.split(c).length - 1 > u.split(open).length - 1) {
      trail = c + trail;
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  return [u, trail];
}

function linkify(text: string, onNav: (to: string) => void) {
  const parts: (string | { label: string; href: string })[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"']+)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [href, trail] = splitTrail(m[2] ?? m[3]!);
    if (!href) {
      parts.push(m[0]); // nothing left after trimming — emit the raw match
    } else {
      parts.push({ label: m[1] ?? href, href });
      if (trail) parts.push(trail);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((p, i) => {
    if (typeof p === 'string') return p;
    let internal: string | null = null;
    try {
      const u = new URL(p.href);
      if (u.origin === location.origin || u.hostname === 'app.janis.ai') {
        internal = u.pathname + u.search + u.hash;
      }
    } catch {
      /* not a parseable url — treat as external */
    }
    return internal ? (
      <a
        key={i}
        href={internal}
        onClick={(e) => {
          e.preventDefault();
          onNav(internal!);
        }}
      >
        {p.label}
      </a>
    ) : (
      <a key={i} href={p.href} target="_blank" rel="noreferrer">
        {p.label}
      </a>
    );
  });
}

function AttachmentNodes({ atts }: { atts: Attachment[] }) {
  return (
    <>
      {atts.map((a, i) =>
        a.type?.startsWith('image/') ? (
          <a key={i} href={a.url} target="_blank" rel="noreferrer">
            <img className="ask-att-img" src={a.url} alt={a.name} />
          </a>
        ) : (
          <a key={i} className="ask-att" href={a.url} target="_blank" rel="noreferrer">
            📎 {a.name}
          </a>
        ),
      )}
    </>
  );
}

/** "Ask Janis" — the concierge agent's webchat, docked as a right rail.
 * Feature-parity with the public widget: multiline input, emoji, uploads,
 * optimistic send with Delivered/retry, typing dots, per-message quick replies. */
export function AskJanis({
  channelId,
  badge,
  onClose,
}: {
  channelId: string;
  badge?: string;
  onClose?: () => void; // omitted when the rail's own tab strip handles close
}) {
  const navigate = useNavigate();
  const visitor = useRef(visitorId()).current;
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [outbox, setOutbox] = useState<OutEntry[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [convState, setConvState] = useState('agent');
  const [convId, setConvId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  // an operator composing a reply in the console — visitor-side dots
  const [opTyping, setOpTyping] = useState<string | null>(null); // '' = anonymous
  // server-side "message dispatched to the agent, no reply yet" — unlike the
  // post-send `typing` guess this also covers slow runs and silent failures
  const [agentTyping, setAgentTyping] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [chips, setChips] = useState<string[] | null>(null);
  const [loaded, setLoaded] = useState(false); // composer disabled until first poll lands
  const [hasMore, setHasMore] = useState(false); // older pages exist — scroll up to back-fill
  const [fetchingOlder, setFetchingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seen = useRef(new Set<string>());
  const lastTs = useRef<string | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollBusy = useRef(false);
  const loadStart = useRef(0);
  const oldestTs = useRef<string | null>(null); // before-cursor for history back-fill
  const loadingOlder = useRef(false);
  // stay glued to the bottom while the user is near it — a poll landing while
  // they're scrolled up reading history must not yank them back down
  const stick = useRef(true);
  const pendingAdjust = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const participantRef = useRef<string | null>(null);
  const lastTypingPing = useRef(0);
  // Mirror of outbox — state updaters run at render time, so poll() needs a
  // synchronous view of pending entries to reconcile server echoes.
  const outboxRef = useRef<OutEntry[]>([]);
  const setOb = (fn: (o: OutEntry[]) => OutEntry[]) => {
    outboxRef.current = fn(outboxRef.current);
    setOutbox(outboxRef.current);
  };

  const { data: cfg } = useQuery({
    queryKey: ['ask-janis-config', channelId],
    queryFn: () => api<ChatConfig>(`/chat/${channelId}`),
    staleTime: 300_000,
  });

  const hideTyping = () => {
    setTyping(false);
    setAgentTyping(false);
    setOpTyping(null);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
  };
  const showTyping = () => {
    if (convState === 'human') return;
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(hideTyping, 45_000);
  };

  // Incremental poll — same reconciliation as the widget: a server echo of an
  // 'in' message promotes the matching outbox entry to Delivered; any non-'in'
  // message clears the typing dots; per-message quick_replies replace the chips.
  const poll = async () => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    if (!loadStart.current) loadStart.current = Date.now();
    try {
      let url = `/chat/${channelId}/messages?visitor_id=${visitor}`;
      if (lastTs.current) url += `&after=${encodeURIComponent(lastTs.current)}`;
      const d = await api<{
        messages: ChatMsg[];
        state: string;
        participant?: string;
        conversation_id?: string;
        has_more?: boolean;
        operator_typing?: { name: string | null } | null;
        agent_typing?: boolean;
      }>(url);
      // The first fetch usually lands in <100ms — without a floor the loading
      // row never paints and history reads as popping in with no indicator.
      const delay = Math.max(0, 500 - (Date.now() - loadStart.current));
      if (delay) await new Promise((r) => setTimeout(r, delay));
      // The server tells us which participant this transcript belongs to — a
      // switch (session expired, identity change) invalidates the cursor,
      // dedupe set and outbox; reset and re-poll the new thread from scratch.
      if (d.participant && participantRef.current && participantRef.current !== d.participant) {
        seen.current = new Set();
        setMsgs([]);
        setOb(() => []);
        hideTyping();
        // This response's messages are valid for the new thread (just sliced
        // by the old cursor) — process them below, and leave lastTs null so
        // the next poll back-fills the latest page without a gap.
        lastTs.current = null;
        oldestTs.current = null;
        setHasMore(false);
      }
      if (d.participant) participantRef.current = d.participant;
      setConvState(d.state);
      if (d.conversation_id) setConvId(d.conversation_id);
      if (d.has_more !== undefined) setHasMore(d.has_more);
      const fresh: ChatMsg[] = [];
      const next = [...outboxRef.current];
      for (const m of d.messages) {
        if (m.direction === 'in') {
          const i = next.findIndex(
            (o) =>
              o.status === 'pending' &&
              (o.text === m.text ||
                (o.attachments.length > 0 && (m.attachments ?? []).length > 0)),
          );
          if (i >= 0) {
            // one receipt at a time — demote any prior 'delivered' to 'sent'
            for (let j = 0; j < next.length; j++) {
              if (next[j].status === 'delivered') next[j] = { ...next[j], status: 'sent' };
            }
            next[i] = { ...next[i], status: 'delivered' };
            if (m.id) seen.current.add(m.id);
            if (!lastTs.current || m.created_at > lastTs.current) lastTs.current = m.created_at;
            continue;
          }
        }
        if (m.id && seen.current.has(m.id)) continue;
        if (m.id) seen.current.add(m.id);
        fresh.push(m);
        if (!lastTs.current || m.created_at > lastTs.current) lastTs.current = m.created_at;
        if (!oldestTs.current || m.created_at < oldestTs.current) oldestTs.current = m.created_at;
      }
      setOb(() => next);
      // A reply landing this round ends the dots — and the typing flags in
      // this same response may be stale relative to it, so don't re-assert
      // them; a still-typing operator or newly dispatched agent re-marks on
      // the next poll anyway.
      const gotReply = fresh.some((m) => m.direction !== 'in');
      if (fresh.length) {
        setMsgs((cur) => [...cur, ...fresh]);
        if (gotReply) hideTyping();
      }
      // Chips belong to the newest message only — a visitor send (including
      // an echo swallowed by the outbox match above) or any newer message
      // without its own quick replies retires the offer.
      const sawInbound = d.messages.some((m) => m.direction === 'in');
      if (fresh.length || sawInbound) {
        const last = fresh[fresh.length - 1];
        setChips(last && last.direction !== 'in' && last.quick_replies?.length ? last.quick_replies : null);
      }
      setOpTyping(gotReply ? null : d.operator_typing ? (d.operator_typing.name ?? '') : null);
      setAgentTyping(gotReply ? false : !!d.agent_typing);
    } catch {
      /* keep polling */
    } finally {
      pollBusy.current = false;
      setLoaded(true); // unlock the composer after the first poll attempt resolves
    }
  };

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, visitor]);

  // Older history back-fill — the initial poll returns the latest page; at
  // the scroll top we fetch the page before the oldest rendered message and
  // prepend it, holding the scroll position steady.
  const loadOlder = async () => {
    if (!hasMore || loadingOlder.current || !oldestTs.current) return;
    loadingOlder.current = true;
    setFetchingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const d = await api<{ messages: ChatMsg[]; has_more?: boolean }>(
        `/chat/${channelId}/messages?visitor_id=${visitor}&before=${encodeURIComponent(oldestTs.current)}`,
      );
      const fresh = d.messages.filter((m) => {
        if (m.id && seen.current.has(m.id)) return false;
        if (m.id) seen.current.add(m.id);
        return true;
      });
      if (fresh.length) {
        pendingAdjust.current = { prevHeight, prevTop };
        setMsgs((cur) => [...fresh, ...cur]);
        oldestTs.current = fresh[0].created_at;
      }
      if (d.has_more !== undefined) setHasMore(d.has_more);
    } catch {
      /* keep polling */
    } finally {
      loadingOlder.current = false;
      setFetchingOlder(false);
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && loaded) void loadOlder();
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pendingAdjust.current) {
      // history prepended above — keep the viewport on the same message
      el.scrollTop = pendingAdjust.current.prevTop + (el.scrollHeight - pendingAdjust.current.prevHeight);
      pendingAdjust.current = null;
    } else if (stick.current) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [msgs.length, outbox.length, typing]);

  const autoresize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    // no scrollbar until content actually overflows the cap
    el.style.overflowY = el.scrollHeight > 110 ? 'auto' : 'hidden';
  };

  const insertEmoji = (em: string) => {
    const el = inputRef.current;
    if (!el) return setText((t) => t + em);
    const s = el.selectionStart ?? text.length;
    const e = el.selectionEnd ?? s;
    setText(text.slice(0, s) + em + text.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = s + em.length;
      autoresize();
    });
  };

  const pickFiles = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const slot: PendingFile = { name: f.name, uploading: true };
      setPending((cur) => (cur.length >= 5 ? cur : [...cur, slot]));
      const fd = new FormData();
      fd.append('visitor_id', visitor);
      fd.append('file', f);
      fetch(`/chat/${channelId}/uploads`, { method: 'POST', body: fd })
        .then((r) => (r.ok ? r.json() : null))
        .then((a) => {
          setPending((p) =>
            a
              ? p.map((x) =>
                  x === slot ? { ...x, name: a.name, url: a.url, type: a.type, size: a.size, uploading: false } : x,
                )
              : p.filter((x) => x !== slot),
          );
        })
        .catch(() => setPending((p) => p.filter((x) => x !== slot)));
    }
  };

  const send = async (body: string, atts: Attachment[], retryOf?: OutEntry) => {
    const t = body.trim();
    if ((!t && !atts.length) || sending || !loaded) return;
    setSending(true);
    setText('');
    requestAnimationFrame(autoresize);
    setChips(null);
    const entry: OutEntry =
      retryOf ?? {
        localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: t,
        attachments: atts,
        status: 'pending' as const,
        ts: new Date().toISOString(),
      };
    if (retryOf) {
      setOb((ob) =>
        ob.map((o) => (o.localId === retryOf.localId ? { ...o, status: 'pending' as const } : o)),
      );
    } else {
      setOb((ob) => [
        ...ob.map((o) => (o.status === 'delivered' ? { ...o, status: 'sent' as const } : o)),
        entry,
      ]);
    }
    try {
      await api(`/chat/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ visitor_id: visitor, text: t, attachments: atts }),
      });
      showTyping();
      await poll();
      // The awaited poll can race the store — verify once more, then mark failed
      // if the echo never arrived (e.g. plan cap dropped the message).
      setTimeout(async () => {
        await poll();
        setOb((ob) =>
          ob.map((o) => (o.localId === entry.localId && o.status === 'pending' ? { ...o, status: 'failed' as const } : o)),
        );
      }, 1500);
    } catch {
      setOb((ob) => ob.map((o) => (o.localId === entry.localId ? { ...o, status: 'failed' as const } : o)));
      hideTyping();
    } finally {
      setSending(false);
    }
  };

  const submit = () => {
    const ready = pending.filter((p) => !p.uploading);
    setPending((p) => p.filter((x) => x.uploading));
    void send(text, ready.map((p) => ({ name: p.name, url: p.url!, type: p.type!, size: p.size! })));
  };

  const deliveredEntry = [...outbox].reverse().find((o) => o.status === 'delivered');

  return (
    <div className="ask-pane">
      <div className="ask-head">
        <strong className="grow">{cfg?.agent_name ?? 'Ask Janis'}</strong>
        {badge && <span className="badge">{badge}</span>}
        {onClose && (
          <button className="btn" onClick={onClose} title="Close">✕</button>
        )}
      </div>
      <div className="ask-scroll" ref={scrollRef} onScroll={onScroll}>
        {!loaded && <div className="ask-loading muted">Loading conversation…</div>}
        {fetchingOlder && <div className="ask-loading muted">Loading earlier messages…</div>}
        {/* Placeholder greeting — only until the transcript lands. On an
            internal test channel the stored greeting row arrives with the
            first poll after sending (same text: bootstrap resolves it
            synchronously to warm the cache), so this swaps seamlessly rather
            than vanishing when the outbox fills. */}
        {loaded && cfg?.greeting && !msgs.length && (
          <div className="ask-msg them">
            {cfg.agent_name && (
              <div className="ask-author">
                {cfg.logo_url && <img className="ask-author-img" src={cfg.logo_url} alt="" />}
                {cfg.agent_name}
              </div>
            )}
            {linkify(cfg.greeting, navigate)}
          </div>
        )}
        {[...msgs.map((m) => ({ key: m.id, ts: m.created_at, kind: 'msg' as const, m })),
          ...outbox.map((o) => ({ key: o.localId, ts: o.ts, kind: 'out' as const, o }))]
          .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
          .map((item, idx, arr) => {
            // Sender label only opens a run — consecutive bubbles from the
            // same sender don't each need the name/avatar. Human replies get
            // the operator's identity; agent replies get the agent's.
            const prev = arr[idx - 1];
            const sameRun =
              item.kind === 'msg' &&
              prev?.kind === 'msg' &&
              prev.m.direction === item.m.direction &&
              (item.m.direction !== 'human' ||
                (prev.m.author?.name ?? '') === (item.m.author?.name ?? ''));
            const author =
              item.kind === 'msg'
                ? item.m.direction === 'human'
                  ? item.m.author
                  : item.m.direction === 'out' && cfg?.agent_name
                    ? { name: cfg.agent_name, avatar: cfg.logo_url }
                    : undefined
                : undefined;
            const firstOfRun = !!author && !sameRun;
            return item.kind === 'msg' ? (
              <div
                key={item.key}
                className={`ask-msg ${item.m.direction === 'in' ? 'me' : item.m.direction === 'human' ? 'human' : 'them'}`}
              >
                {firstOfRun && (
                  <div className="ask-author">
                    {author!.avatar && <img className="ask-author-img" src={author!.avatar} alt="" />}
                    {author!.name}
                  </div>
                )}
                {linkify(item.m.text, navigate)}
                <AttachmentNodes atts={item.m.attachments ?? []} />
              </div>
            ) : (
              <Fragment key={item.key}>
                <div
                  className={`ask-msg me ${item.o.status === 'pending' ? 'pending' : ''} ${item.o.status === 'failed' ? 'failed' : ''}`}
                  onClick={item.o.status === 'failed' ? () => void send(item.o.text, item.o.attachments, item.o) : undefined}
                >
                  {linkify(item.o.text, navigate)}
                  <AttachmentNodes atts={item.o.attachments} />
                </div>
                {item.o.status === 'delivered' && deliveredEntry === item.o && <div className="ask-status">Delivered</div>}
                {item.o.status === 'failed' && (
                  <div className="ask-status ask-status-fail" onClick={() => void send(item.o.text, item.o.attachments, item.o)}>
                    Not delivered — tap to retry
                  </div>
                )}
              </Fragment>
            );
          })}
        {(typing || agentTyping || opTyping !== null) && (
          <div className="ask-msg them ask-typing">
            {/* the dots must sit in a flex container — plain inline spans
                ignore width/height and render at 0×0 (invisible) */}
            <span className="ask-dots">
              <span className="ask-dot" /><span className="ask-dot" /><span className="ask-dot" />
            </span>
          </div>
        )}
        {convState !== 'human' && (chips ?? (!loaded || msgs.length ? null : cfg?.quick_replies ?? null))?.length ? (
          <div className="ask-qrs">
            {(chips ?? cfg?.quick_replies ?? []).map((q) => (
              <button key={q} className="btn" onClick={() => void send(q, [])}>{q}</button>
            ))}
          </div>
        ) : null}
        {convState === 'human' && (
          <div className="muted" style={{ padding: '4px 12px', fontSize: 12 }}>
            a human has taken over this conversation — the agent is paused
            {convId && (
              <>
                {' — '}
                <Link to={`/conversations/${convId}`}>open in console</Link>
              </>
            )}
          </div>
        )}
        {convState === 'needs_human' && (
          <div className="muted" style={{ padding: '4px 12px', fontSize: 12 }}>
            flagged for a human
            {convId && (
              <>
                {' — '}
                <Link to={`/conversations/${convId}`}>open in console</Link>
              </>
            )}
          </div>
        )}
      </div>
      {pending.length > 0 && (
        <div className="ask-attach">
          {pending.map((p, i) => (
            <span key={i} className="ask-chip">
              {p.uploading ? '⏳ ' : '📎 '}{p.name}
              <button aria-label="Remove" onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      {emojiOpen && (
        <div className="ask-emoji">
          {EMOJIS.map((em) => (
            <button key={em} type="button" onClick={() => insertEmoji(em)}>{em}</button>
          ))}
        </div>
      )}
      <div className="ask-input">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          disabled={!loaded}
          placeholder={`Message ${cfg?.agent_name ?? 'Janis'}…`}
          onChange={(e) => {
            setText(e.target.value);
            autoresize();
            // throttled ping — the console shows "visitor is typing" dots
            if (Date.now() - lastTypingPing.current > 2500 && visitor) {
              lastTypingPing.current = Date.now();
              void api(`/chat/${channelId}/typing`, {
                method: 'POST',
                body: JSON.stringify({ visitor_id: visitor }),
              }).catch(() => {});
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="ask-input-row">
          <button className="btn" title="Emoji" disabled={!loaded} onClick={() => setEmojiOpen((o) => !o)}>☺</button>
          <button className="btn" title="Attach" disabled={!loaded} onClick={() => fileRef.current?.click()}>📎</button>
          <input
            ref={fileRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              pickFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <span className="grow" />
          <button
            className="btn primary"
            disabled={!loaded || sending || (!text.trim() && !pending.some((p) => !p.uploading))}
            onClick={submit}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
