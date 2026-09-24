import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Attachment, Conversation, ConversationState, Message } from '@janis/shared';
import { api, ApiError } from '../api/client';
import { useAgents, useConversation, useInvalidateConversations, useMe, useUsers } from '../api/hooks';
import { Avatar, channelLabel, displayName, fmtTime, StateBadge } from '../components/bits';
import Composer from '../components/Composer';
import { typingBus } from '../lib/typingBus';

const WHO: Record<Message['direction'], string> = {
  in: 'Customer',
  out: 'Agent',
  human: 'Operator',
};

// Optimistic outbound entries — render immediately, reconcile against the
// server's echoed row once the post-send refetch lands (same model the
// webchat widget uses).
interface OutEntry {
  localId: string;
  text: string;
  attachments: Attachment[];
  mode: 'human' | 'agent' | 'note' | 'teach';
  status: 'pending' | 'failed' | 'delivered';
  /** channel rejection reason when the send was stored but not delivered */
  error?: string;
  /** false when the channel says retrying can't help (closed 24h window) */
  retryable?: boolean;
  ts: number;
}

export default function ConversationPage() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const jumpMsg = searchParams.get('msg'); // search-result deep link
  const { data, error: loadError } = useConversation(id);
  const { data: agents } = useAgents();
  const { data: users } = useUsers();
  const { data: me } = useMe();
  const [draft, setDraft] = useState('');
  const [sendAs, setSendAs] = useState<'human' | 'agent' | 'note' | 'teach'>('human');
  const [error, setError] = useState('');
  const qc = useQueryClient();
  const invalidate = useInvalidateConversations();
  const bottomRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // stay glued to the bottom while the user is near it — attachments loading
  // late (images) grow the transcript, so we re-snap whenever they render
  const stickRef = useRef(true);
  const snapToBottom = (behavior: ScrollBehavior = 'auto') => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ behavior });
  };

  // Optimistic outbound entries + which one currently owns the receipt.
  const [outbox, setOutbox] = useState<OutEntry[]>([]);
  const outboxRef = useRef<OutEntry[]>([]);
  const setOb = (fn: (o: OutEntry[]) => OutEntry[]) => {
    outboxRef.current = fn(outboxRef.current);
    setOutbox(outboxRef.current);
  };
  const receiptFor = useRef<string | null>(null); // localId

  // Visitor typing pings — routed here by useStream via typingBus; the dots
  // expire unless another ping keeps them alive. Agent pings (a dispatched
  // message.user awaiting reply) are a real state, not a burst — they hold
  // until a reply lands, with a long safety timer matching the server TTL.
  const [visitorTyping, setVisitorTyping] = useState(false);
  const [agentTyping, setAgentTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const agentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () =>
      typingBus.subscribe((p) => {
        if (p.conversation_id !== id) return;
        if (p.kind === 'agent') {
          setAgentTyping(true);
          clearTimeout(agentTimer.current);
          agentTimer.current = setTimeout(() => setAgentTyping(false), 90_000);
          return;
        }
        setVisitorTyping(true);
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setVisitorTyping(false), 4500);
      }),
    [id],
  );

  // A fresh reply ends the agent-working dots — the reply is on screen, so
  // the indicator's job is done. Keyed on the non-'in' count: the inbound
  // visitor message that TRIGGERED the work lands at dispatch time too, and
  // its refetch must not wipe the flag the typing ping just set.
  const replyCount = (data?.messages ?? []).filter((m) => m.direction !== 'in').length;
  useEffect(() => {
    setAgentTyping(false);
    clearTimeout(agentTimer.current);
  }, [replyCount]);
  // Same for "visitor is typing" — a stored inbound means they sent, not
  // that they're still composing.
  const inboundCount = (data?.messages ?? []).length - replyCount;
  useEffect(() => {
    setVisitorTyping(false);
    clearTimeout(typingTimer.current);
  }, [inboundCount]);

  // First paint per conversation snaps instantly — a smooth scroll across a
  // long transcript crawls and gets interrupted by refetches. Later arrivals
  // scroll smoothly. The mount effect runs before the fetch resolves, so
  // don't record the snap until messages actually exist — otherwise the real
  // first paint is treated as incremental and smooth-scrolls the whole list.
  const snappedFor = useRef('');
  useEffect(() => {
    if (!data?.messages.length) return;
    const initial = snappedFor.current !== id;
    snappedFor.current = id;
    // jump windows clear stickRef, so this is a no-op until "Jump to latest"
    snapToBottom(initial ? 'auto' : 'smooth');
  }, [data?.messages.length, outbox.length, visitorTyping, agentTyping, id]);

  // History back-fill — the initial query returns the latest page; scrolling
  // to the top fetches the page before the oldest rendered message and
  // prepends it, holding the scroll position steady.
  const [older, setOlder] = useState<Message[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null); // null = server flag
  const [fetchingOlder, setFetchingOlder] = useState(false);
  const pendingAdjust = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  // ?msg=<id> deep link — a message-anchored slice replaces the transcript;
  // scrolling pages outward in both directions until it meets the live tail.
  const [win, setWin] = useState<{
    msgs: Message[];
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
  } | null>(null);
  const [fetchingNewer, setFetchingNewer] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const jumpedFor = useRef('');
  const olderFor = useRef('');
  if (olderFor.current !== id) {
    olderFor.current = id;
    setOlder([]);
    setOlderHasMore(null);
    setWin(null);
    jumpedFor.current = '';
  }
  const hasMore = win ? win.hasMoreBefore : (olderHasMore ?? data?.messages_has_more ?? false);

  const loadOlder = async () => {
    const oldest = win
      ? win.msgs[0]?.created_at
      : (older[0]?.created_at ?? data?.messages[0]?.created_at);
    if (!hasMore || fetchingOlder || !oldest) return;
    setFetchingOlder(true);
    const el = transcriptRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const d = await api<{ messages: Message[]; has_more: boolean }>(
        `/api/conversations/${id}/messages?before=${encodeURIComponent(oldest)}`,
      );
      const known = new Set(
        [...(win?.msgs ?? []), ...older, ...(data?.messages ?? [])].map((m) => m.id),
      );
      const fresh = d.messages.filter((m) => !known.has(m.id));
      if (fresh.length) pendingAdjust.current = { prevHeight, prevTop };
      if (win) {
        setWin((w) => w && { ...w, msgs: [...fresh, ...w.msgs], hasMoreBefore: d.has_more });
      } else {
        if (fresh.length) setOlder((cur) => [...fresh, ...cur]);
        setOlderHasMore(d.has_more);
      }
    } catch {
      /* next scroll-to-top retries */
    } finally {
      setFetchingOlder(false);
    }
  };

  // Forward paging — only meaningful inside a jump window; fetches the chunk
  // after the newest loaded row until the window catches the live tail.
  const loadNewer = async () => {
    const newest = win?.msgs[win.msgs.length - 1]?.created_at;
    if (!win?.hasMoreAfter || fetchingNewer || !newest) return;
    setFetchingNewer(true);
    try {
      const d = await api<{ messages: Message[]; has_more: boolean }>(
        `/api/conversations/${id}/messages?after=${encodeURIComponent(newest)}`,
      );
      const known = new Set(win.msgs.map((m) => m.id));
      const fresh = d.messages.filter((m) => !known.has(m.id));
      setWin((w) => w && { ...w, msgs: [...w.msgs, ...fresh], hasMoreAfter: d.has_more });
    } catch {
      /* next bottom-scroll retries */
    } finally {
      setFetchingNewer(false);
    }
  };

  // Consume the ?msg= deep link once per conversation+target: if the hit is
  // already in the loaded pages just scroll to it, otherwise fetch the
  // centered window and render that instead of the latest page.
  useEffect(() => {
    if (!jumpMsg || !data) return;
    const key = `${id}:${jumpMsg}`;
    if (jumpedFor.current === key) return;
    jumpedFor.current = key;
    if ([...older, ...data.messages].some((m) => m.id === jumpMsg)) {
      stickRef.current = false;
      setHighlight(jumpMsg);
      return;
    }
    void api<{ messages: Message[]; has_more: boolean; has_more_after: boolean }>(
      `/api/conversations/${id}/messages?around=${encodeURIComponent(jumpMsg)}`,
    )
      .then((d) => {
        if (!d.messages.length) return;
        stickRef.current = false;
        setWin({ msgs: d.messages, hasMoreBefore: d.has_more, hasMoreAfter: d.has_more_after });
        setHighlight(jumpMsg);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpMsg, data, id]);

  // Center the target and flash it briefly once rendered.
  useLayoutEffect(() => {
    if (!highlight) return;
    transcriptRef.current
      ?.querySelector(`[data-mid="${highlight}"]`)
      ?.scrollIntoView({ block: 'center' });
    const t = setTimeout(() => setHighlight(null), 2800);
    return () => clearTimeout(t);
  }, [highlight, win]);

  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (el && pendingAdjust.current) {
      el.scrollTop = pendingAdjust.current.prevTop + (el.scrollHeight - pendingAdjust.current.prevHeight);
      pendingAdjust.current = null;
    }
  }, [older, win]);

  const refresh = () => {
    invalidate();
    void qc.invalidateQueries({ queryKey: ['conversation', id] });
  };

  const act = useMutation({
    mutationFn: (action: 'takeover' | 'resume' | 'archive') =>
      action === 'archive'
        ? api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ state: 'archived' }) })
        : api(`/api/conversations/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => { setError(''); refresh(); },
    onError: (e) => setError(e.message),
  });

  const patch = useMutation({
    mutationFn: (body: {
      tags?: string[];
      assignee_id?: string | null;
      state?: 'active' | 'needs_human' | 'archived';
      is_starred?: boolean;
      is_unread?: boolean;
    }) =>
      api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (_d, body) => {
      // Viewing a conversation auto-marks it read server-side on every
      // fetch — refetching after "mark unread" would instantly undo it.
      // Patch the cache instead; the list still invalidates for the dot.
      if (body.is_unread !== undefined) {
        qc.setQueryData(
          ['conversation', id],
          (old: { conversation?: { is_unread?: boolean } } | undefined) =>
            old?.conversation
              ? { ...old, conversation: { ...old.conversation, is_unread: body.is_unread } }
              : old,
        );
        invalidate();
      } else {
        refresh();
      }
    },
    onError: (e) => setError(e.message),
  });

  // Opening a conversation marks it read — once per open, so the
  // "Mark unread" toggle can't be undone by a later refetch.
  const markedReadFor = useRef('');
  useEffect(() => {
    if (data?.conversation.is_unread && markedReadFor.current !== id) {
      markedReadFor.current = id;
      patch.mutate({ is_unread: false });
    }
  }, [data?.conversation.is_unread, id]);

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      api(`/api/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: archived ? 'archived' : 'active' }),
      }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  // Status control — routes each target through the endpoint that owns its
  // side effects: takeover claims the channel thread, resume releases it,
  // PATCH handles plain flag changes (and resolves open alerts on 'active').
  const setState = (target: ConversationState) => {
    if (!data || target === data.conversation.state) return;
    if (target === 'human') act.mutate('takeover');
    else if (target === 'active' && data.conversation.state === 'human') act.mutate('resume');
    else patch.mutate({ state: target });
  };

  // Operator typing ping — the widget/rail show visitor-side dots. Only
  // customer-facing modes ping; internal notes and teaches must not leak
  // operator activity to the visitor.
  const typingPingAt = useRef(0);
  const pingTyping = () => {
    if (sendAs !== 'human' && sendAs !== 'agent') return;
    if (Date.now() - typingPingAt.current < 2500) return;
    typingPingAt.current = Date.now();
    void api(`/api/conversations/${id}/typing`, { method: 'POST' }).catch(() => {});
  };

  const [suggestOpen, setSuggestOpen] = useState(false);

  const suggest = useMutation({
    mutationFn: () => api(`/api/conversations/${id}/suggest`, { method: 'POST' }),
    onSuccess: () => { setError(''); void qc.invalidateQueries({ queryKey: ['conversation', id] }); },
    onError: (e) => { setError(e.message); setSuggestOpen(false); },
  });

  const askSuggestion = () => {
    setSuggestOpen(true);
    suggest.mutate();
  };

  // Dismiss EVERY pending suggestion — otherwise the next one in the queue
  // slides into the card and it feels like dismiss loads another iteration.
  const dismissSuggestions = async () => {
    const pending = data?.suggestions ?? [];
    await Promise.all(
      pending.map((s) =>
        api(`/api/conversations/${id}/suggestions/${s.id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'dismissed' }),
        }).catch(() => {}),
      ),
    );
    void qc.invalidateQueries({ queryKey: ['conversation', id] });
  };

  const suggestionStatus = useMutation({
    mutationFn: ({ sid, status }: { sid: string; status: 'used' | 'dismissed' }) =>
      api(`/api/conversations/${id}/suggestions/${sid}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['conversation', id] }),
  });

  const send = (attachments: Attachment[], retryOf?: OutEntry) => {
    const mode = retryOf?.mode ?? sendAs;
    const entry: OutEntry =
      retryOf ??
      {
        localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: draft,
        attachments,
        mode,
        status: 'pending',
        ts: Date.now(),
      };
    setOb((o) =>
      retryOf ? o.map((x) => (x.localId === retryOf.localId ? { ...x, status: 'pending' } : x)) : [...o, entry],
    );
    const endpoint =
      mode === 'agent' ? 'agent-send' : mode === 'note' ? 'note' : mode === 'teach' ? 'teach' : 'reply';
    api<{ delivery?: { delivered: boolean; error?: string; retryable?: boolean } }>(
      `/api/conversations/${id}/${endpoint}`,
      {
        method: 'POST',
        body: JSON.stringify({ text: entry.text, attachments: entry.attachments }),
      },
    )
      .then((res) => {
        // The message row is stored either way, but "Delivered" is only
        // honest once the channel accepted the send — a Meta rejection
        // (e.g. the closed 24h window) reports the real error.
        if (res?.delivery && !res.delivery.delivered) {
          setOb((o) =>
            o.map((x) =>
              x.localId === entry.localId
                ? {
                    ...x,
                    status: 'failed',
                    error: res.delivery!.error ?? 'the channel rejected the send',
                    retryable: res.delivery!.retryable,
                  }
                : x,
            ),
          );
          setError('');
          void qc.invalidateQueries({ queryKey: ['conversation', id] });
          return;
        }
        setOb((o) => o.map((x) => (x.localId === entry.localId ? { ...x, status: 'delivered' } : x)));
        receiptFor.current = entry.localId;
        if (!retryOf) setDraft('');
        setError('');
        void qc.invalidateQueries({ queryKey: ['conversation', id] });
      })
      .catch((e) => {
        setOb((o) => o.map((x) => (x.localId === entry.localId ? { ...x, status: 'failed' } : x)));
        setError(e.message);
      });
  };

  // Re-attempt delivery of a stored message the channel rejected — resends
  // the same row rather than duplicating it in the transcript.
  const resending = useRef(new Set<string>());
  const resend = async (messageId: string) => {
    if (resending.current.has(messageId)) return;
    resending.current.add(messageId);
    try {
      // a failed resend re-stamps delivery_error on the row — the bubble's
      // own error line updates on refetch, no page-level error needed
      await api(`/api/conversations/${id}/messages/${messageId}/resend`, { method: 'POST' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'resend failed');
    } finally {
      resending.current.delete(messageId);
      void qc.invalidateQueries({ queryKey: ['conversation', id] });
    }
  };

  if (loadError instanceof ApiError && loadError.status === 404) {
    return (
      <div className="muted">
        Conversation not found. <Link to="/conversations">Back to conversations</Link>
      </div>
    );
  }
  if (!data) return <div className="muted">Loading conversation…</div>;
  const { conversation: c, messages, alerts, suggestions } = data;
  const p = c.user_profile ?? {};
  const name = displayName(c);
  const KNOWN = new Set([
    'id', 'name', 'first_name', 'last_name', 'username', 'email', 'phone',
    'channel', 'channel_name', 'profile_fetched_at', 'metadata',
  ]);
  const extraProfile = Object.entries(p).filter(([k]) => !KNOWN.has(k));
  const agent = agents?.agents.find((a) => a.id === c.agent_id);
  const assignee = users?.users.find((u) => u.id === c.assignee_id);
  const openAlerts = alerts.filter((a) => a.status === 'open');
  const canSend = c.state === 'human' || sendAs === 'agent' || sendAs === 'note' || sendAs === 'teach';
  const canTeach = me?.user.role === 'admin';

  // Reconcile: an outbox entry drops once its server echo lands in the
  // refetched transcript; the receipt follows whichever bubble — optimistic
  // or echo — is the newest confirmed send.
  const echoFor = new Map<string, Message>();
  const echoIds = new Set<string>();
  // In a jump window the latest page isn't rendered — match echoes against
  // the window instead so a fresh send doesn't vanish from view.
  const echoPool = win ? win.msgs : messages;
  for (const o of outbox) {
    const echo = echoPool.find(
      (m) =>
        m.direction !== 'in' &&
        m.text === o.text &&
        !echoIds.has(m.id) &&
        Math.abs(Date.parse(m.created_at) - o.ts) < 60_000,
    );
    if (echo) {
      echoIds.add(echo.id);
      echoFor.set(o.localId, echo);
    }
  }
  const visibleOutbox = outbox.filter((o) => !echoFor.has(o.localId));
  const items = [
    ...(win ? win.msgs : [...older, ...messages]).map((m) => ({ key: m.id, ts: Date.parse(m.created_at), kind: 'msg' as const, m })),
    ...visibleOutbox.map((o) => ({ key: o.localId, ts: o.ts, kind: 'out' as const, o })),
  ].sort((a, b) => a.ts - b.ts);

  // A .who label opens each run of consecutive same-sender messages;
  // system/internal lines always break the run so the next real message
  // re-introduces its author.
  const senderKey = (it: (typeof items)[number]): string => {
    if (it.kind === 'out') return `o:${it.o.mode}`;
    const m = it.m;
    const sys =
      m.payload.internal === true ||
      m.flags.failure ||
      m.flags.help_requested ||
      m.flags.custom_alert ||
      m.flags.handoff_offer ||
      m.flags.handoff_cancelled;
    return sys ? `sys:${m.id}` : `m:${m.direction}:${m.author ?? ''}`;
  };
  // "Delivered" rides under the newest message known to have reached the
  // customer — payload.delivered covers push and pull-model channels, the
  // echo match covers a just-sent row whose stamp hasn't landed.
  let lastDeliveredIdx = -1;
  items.forEach((it, i) => {
    if (
      it.kind === 'msg' &&
      it.m.direction !== 'in' &&
      (it.m.payload.delivered === true ||
        (receiptFor.current !== null && echoFor.get(receiptFor.current)?.id === it.m.id))
    ) {
      lastDeliveredIdx = i;
    }
  });

  return (
    <div className="conv-layout">
      <div className="conv-main">
        <div className="row">
          <h1 className="page-title grow">{name}</h1>
          <button
            className="btn icon"
            title={c.is_starred ? 'Unstar' : 'Star'}
            onClick={() => patch.mutate({ is_starred: !c.is_starred })}
          >
            {c.is_starred ? '⭐' : '☆'}
          </button>
          <button
            className="btn"
            onClick={() => patch.mutate({ is_unread: !c.is_unread })}
            title={c.is_unread ? 'Mark as read' : 'Mark unread'}
          >
            {c.is_unread ? 'Mark as read' : 'Mark unread'}
          </button>
          <StateBadge state={c.state} />
        </div>

        {openAlerts.length > 0 && (
          <div className="card" style={{ borderColor: 'var(--warn)' }}>
            {openAlerts.map((a) => (
              <div key={a.id} className="muted">
                ⚠ {a.type.replace('_', ' ')}{a.detail ? ` — ${a.detail}` : ''}
              </div>
            ))}
          </div>
        )}

        <div
          className="transcript"
          ref={transcriptRef}
          onScroll={() => {
            const el = transcriptRef.current;
            if (!el) return;
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            stickRef.current = nearBottom;
            if (el.scrollTop < 60) void loadOlder();
            if (nearBottom && win?.hasMoreAfter) void loadNewer();
          }}
        >
          {fetchingOlder && <div className="muted" style={{ textAlign: 'center', fontSize: 12, padding: '8px 0' }}>Loading earlier messages…</div>}
          {items.map((item, i) => {
            const showWho = i === 0 || senderKey(items[i - 1]) !== senderKey(item);
            if (item.kind === 'out') {
              const o = item.o;
              return (
                <Fragment key={o.localId}>
                  <div
                    className={`msg ${o.mode === 'human' ? 'human' : 'out'} ${o.status === 'pending' ? 'pending' : ''} ${o.status === 'failed' ? 'failed' : ''}`}
                    onClick={
                      o.status === 'failed' && o.retryable !== false
                        ? () => send(o.attachments, o)
                        : undefined
                    }
                  >
                    {showWho && (
                      <div className="who">
                        {me?.user.name ?? WHO.human}
                        {o.mode === 'note' ? ' 🔒 internal' : o.mode === 'teach' ? ' 🧠 taught the agent' : ''}
                        <span className="time">{fmtTime(new Date(o.ts).toISOString())}</span>
                      </div>
                    )}
                    {o.text}
                    {o.attachments.map((a, i) => (
                      <div key={i}>
                        {a.type.startsWith('image/') ? (
                          <a href={a.url} target="_blank" rel="noreferrer">
                            <img
                              src={a.url}
                              alt={a.name}
                              style={{ maxWidth: 220, borderRadius: 8, marginTop: 6 }}
                              onLoad={() => snapToBottom()}
                            />
                          </a>
                        ) : (
                          <a href={a.url} target="_blank" rel="noreferrer" className="attach-chip">
                            📎 {a.name}
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                  {o.localId === receiptFor.current &&
                    o.status === 'delivered' &&
                    (o.mode === 'human' || o.mode === 'agent') && (
                      <div className="receipt">Delivered</div>
                    )}
                  {o.status === 'failed' && (
                    <div
                      className="receipt receipt-fail"
                      onClick={
                        o.retryable !== false ? () => send(o.attachments, o) : undefined
                      }
                    >
                      Not delivered{o.error ? ` — ${o.error}` : ''}
                      {o.retryable !== false ? ' · tap to retry' : ''}
                    </div>
                  )}
                </Fragment>
              );
            }
            const m = item.m;
            const isInternal = m.payload.internal === true;
            const isSystem = m.flags.failure || m.flags.help_requested || m.flags.custom_alert || m.flags.handoff_offer || m.flags.handoff_cancelled || isInternal;
            const authorUser =
              m.direction === 'human' ? users?.users.find((u) => u.id === m.author) : undefined;
            const who =
              m.direction === 'in'
                ? c.user_profile.name ?? WHO.in
                : m.direction === 'out'
                  ? agent?.name ?? WHO.out
                  : authorUser?.name ?? WHO.human;
            return (
            <>
            <div
              key={m.id}
              data-mid={m.id}
              className={`msg ${isSystem ? 'system' : m.direction}${highlight === m.id ? ' msg-hit' : ''}`}
            >
              {(!isSystem || isInternal) && showWho && (
                <div className="who">
                  {m.direction === 'in' && c.has_avatar && (
                    <img className="who-avatar" src={`/api/conversations/${c.id}/avatar`} alt="" />
                  )}
                  {authorUser?.avatar_url && (
                    <img className="who-avatar" src={authorUser.avatar_url} alt="" />
                  )}
                  {who}
                  {m.direction === 'out' && m.payload.via === 'operator' ? ' (via operator)' : ''}
                  {isInternal
                    ? m.payload.teach
                      ? ' 🧠 taught the agent'
                      : m.payload.event
                        ? ` ⚡ ${String(m.payload.event)}`
                        : ' 🔒 internal'
                    : ''}
                  <span className="time" title={new Date(m.created_at).toLocaleString()}>
                    {fmtTime(m.created_at)}
                  </span>
                </div>
              )}
              {m.text}
              {isSystem && !isInternal && (
                <span className="time" title={new Date(m.created_at).toLocaleString()}>
                  {' '}· {fmtTime(m.created_at)}
                </span>
              )}
              {m.flags.help_requested && m.payload.summary ? (
                <div className="muted" style={{ marginTop: 4 }}>
                  {String(m.payload.summary)}
                </div>
              ) : null}
              {(m.payload.attachments as Attachment[] | undefined)?.map((a, i) => (
                <div key={i}>
                  {a.type.startsWith('image/') ? (
                    <a href={a.url} target="_blank" rel="noreferrer">
                      <img
                        src={a.url}
                        alt={a.name}
                        style={{ maxWidth: 220, borderRadius: 8, marginTop: 6 }}
                        onLoad={() => snapToBottom()}
                      />
                    </a>
                  ) : (
                    <a href={a.url} target="_blank" rel="noreferrer" className="attach-chip">
                      📎 {a.name}
                    </a>
                  )}
                </div>
              ))}
            </div>
            {i === lastDeliveredIdx && (
              <div className="receipt">Delivered</div>
            )}
            {typeof m.payload.delivery_error === 'string' && m.payload.delivery_error && (
              <div
                className="receipt receipt-fail"
                onClick={
                  m.payload.delivery_retryable !== false
                    ? () => void resend(m.id)
                    : undefined
                }
              >
                Not delivered — {String(m.payload.delivery_error)}
                {m.payload.delivery_retryable !== false ? ' · tap to retry' : ''}
              </div>
            )}
            </>
            );
          })}
          {visitorTyping && (
            <div className="msg in conv-typing">
              <span className="dot" /><span className="dot" /><span className="dot" />
            </div>
          )}
          {agentTyping && (
            <div className="msg out conv-typing">
              <span className="dot" /><span className="dot" /><span className="dot" />
            </div>
          )}
          {fetchingNewer && <div className="muted" style={{ textAlign: 'center', fontSize: 12, padding: '8px 0' }}>Loading newer messages…</div>}
          {win && (
            <button
              className="btn jump-latest"
              onClick={() => {
                setWin(null);
                setOlder([]);
                setOlderHasMore(null);
                stickRef.current = true;
                void qc.invalidateQueries({ queryKey: ['conversation', id] });
                setTimeout(() => bottomRef.current?.scrollIntoView(), 80);
              }}
            >
              ↓ Jump to latest
            </button>
          )}
          <div ref={bottomRef} />
        </div>

        {error && <div className="error">{error}</div>}

        {canSend && (suggestOpen || suggestions?.length > 0) && (
          <div className="card suggestion">
            {suggestions?.length > 0 ? (
              <>
                <div className="muted" style={{ marginBottom: 6 }}>
                  Suggested ({suggestions[0].source === 'agent' ? 'your agent' : 'AI'})
                </div>
                <div>{suggestions[0].text}</div>
              </>
            ) : (
              <div className="muted">Thinking…</div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn primary"
                disabled={!(suggestions?.length > 0)}
                onClick={() => {
                  setDraft(suggestions[0].text);
                  suggestionStatus.mutate({ sid: suggestions[0].id, status: 'used' });
                  setSuggestOpen(false);
                }}
              >
                Use
              </button>
              <button
                className="btn icon"
                title="Try another suggestion"
                disabled={suggest.isPending}
                onClick={() => { void dismissSuggestions(); suggest.mutate(); }}
              >
                ↻
              </button>
              <button
                className="btn"
                onClick={() => { setSuggestOpen(false); void dismissSuggestions(); }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {canSend && !suggestOpen && !(suggestions?.length > 0) && (
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn" onClick={askSuggestion} disabled={suggest.isPending}>
              ✨ Suggest reply
            </button>
          </div>
        )}

        {canSend ? (
          <>
            <Composer
              value={draft}
              onChange={(v) => {
                setDraft(v);
                pingTyping();
              }}
              onSend={send}
              onResume={c.state === 'human' ? () => act.mutate('resume') : undefined}
              sendAs={sendAs}
              setSendAs={setSendAs}
              showModeSelect={true}
              canTeach={canTeach}
              sending={outbox.some((o) => o.status === 'pending')}
            />
            {c.state !== 'human' && (
              <button className="btn" style={{ marginTop: 8 }} onClick={() => setSendAs('human')}>Cancel</button>
            )}
          </>
        ) : (
          <div className="row">
            {c.state !== 'archived' && (
              <>
                <button className="btn primary" onClick={() => act.mutate('takeover')}>Take over</button>
                <button className="btn" onClick={() => { setSendAs('agent'); }}>Send via agent</button>
                <button className="btn" onClick={() => { setSendAs('note'); }}>🔒 Internal note</button>
                {canTeach && (
                  <button className="btn" onClick={() => { setSendAs('teach'); }}>🧠 Teach agent</button>
                )}
                <button className="btn danger" onClick={() => act.mutate('archive')}>Archive</button>
              </>
            )}
            {c.state === 'archived' && (
              <>
                <span className="muted">Archived</span>
                <button className="btn" disabled={archive.isPending} onClick={() => archive.mutate(false)}>
                  {archive.isPending ? 'Working…' : 'Unarchive'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <aside className="conv-side">
        <div className="card">
          <strong>Details</strong>
          <div className="profile-head">
            <Avatar c={c} size={44} />
            <div>
              <div className="profile-name">{name}</div>
              {p.username && !name.startsWith('@') && (
                <div className="muted">@{p.username}</div>
              )}
            </div>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {(p.channel || p.channel_name) && (
              <div>
                Channel: {channelLabel(p.channel)}
                {p.channel_name ? ` · ${p.channel_name}` : ''}
              </div>
            )}
            <div>Email: {p.email ?? '—'}</div>
            {p.phone && <div>Phone: {p.phone}</div>}
            <div>User id: {p.id ?? c.external_id}</div>
            <div>Agent: {agent?.name ?? '—'}</div>
            {extraProfile.map(([k, v]) => (
              <div key={k}>{k}: {String(v)}</div>
            ))}
            <div>Assigned: {assignee?.name ?? 'unassigned'}</div>
            {c.human_since && <div>Human since: {new Date(c.human_since).toLocaleTimeString()}</div>}
            {agent?.auto_resume_minutes && (
              <div>Auto-resume after {agent.auto_resume_minutes}m</div>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Status</strong>
          <select
            style={{ width: '100%', marginTop: 8 }}
            value={c.state}
            disabled={act.isPending || patch.isPending}
            onChange={(e) => setState(e.target.value as ConversationState)}
          >
            <option value="active">Agent</option>
            <option value="needs_human" disabled={c.state === 'archived'}>Needs human</option>
            <option value="human" disabled={c.state === 'archived'}>Human</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        <div className="card">
          <strong>Assign to</strong>
          <select
            style={{ width: '100%', marginTop: 8 }}
            value={c.assignee_id ?? ''}
            onChange={(e) => patch.mutate({ assignee_id: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {users?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}{u.id === me?.user.id ? ' (me)' : ''}
              </option>
            ))}
          </select>
        </div>

        <TagEditor conversation={c} onSave={(tags) => patch.mutate({ tags })} />

      </aside>
    </div>
  );
}

function TagEditor({
  conversation,
  onSave,
}: {
  conversation: Conversation;
  onSave: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div className="card">
      <strong>Tags</strong>
      <div style={{ marginTop: 8 }}>
        {conversation.tags.map((t) => (
          <span key={t} className="badge active" style={{ marginRight: 6 }}>
            {t}{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onSave(conversation.tags.filter((x) => x !== t));
              }}
            >
              ✕
            </a>
          </span>
        ))}
      </div>
      <form
        className="row"
        style={{ marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          const tag = draft.trim();
          if (tag && !conversation.tags.includes(tag)) {
            onSave([...conversation.tags, tag]);
          }
          setDraft('');
        }}
      >
        <input className="grow" placeholder="add tag" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn">+</button>
      </form>
    </div>
  );
}
