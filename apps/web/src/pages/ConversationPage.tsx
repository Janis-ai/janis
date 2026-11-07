import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_INTENTS } from '@janis/shared';
import type { Alert, Attachment, Conversation, ConversationState, Message } from '@janis/shared';
import { api, ApiError } from '../api/client';
import { useAgents, useAgentWidgets, useConversation, useConversationBrief, useInvalidateConversations, useMe, useUsers, patchConversationCaches } from '../api/hooks';
import { ArgsRows, Avatar, displayName, fmtTime, mdSpans, SearchInput, surfaceLabel } from '../components/bits';
import { Widgets, type ChatWidget } from '../components/ChatWidgets';
import Composer from '../components/Composer';
import { CorrectThisCard } from '../components/CorrectThis';
import { type ScenarioTest, type ScenarioTurn } from '../components/ScenarioRow';
import { useScenarioMatch } from '../lib/scenarioMatch';
import { SNOOZE_OPTIONS, snoozeMinutes } from './Conversations';
import { usePanelWidth, storedPanelWidth } from '../lib/panelLayout';
import { ALERT_LABELS } from '../components/Layout';
import { janisBrain } from '../lib/agentContext';
import { typingBus, presenceBus } from '../lib/typingBus';
import { railBus } from '../lib/railBus';
import { splitBlocks } from '../lib/richText';
import { usePageTitle } from '../lib/title';
import { useConfirm } from '../components/Prompt';
import { BookmarkPlus, Bot, Brain, ChevronLeft, Headset, Info, Lock, Mail, MailOpen, Moon, PanelRightClose, Paperclip, RefreshCw, ScrollText, Sparkles, Star, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-react';

const WHO: Record<Message['direction'], string> = {
  in: 'Customer',
  out: 'Agent',
  human: 'Operator',
};

/** Alert type -> the transcript flag the same event writes. Anchored alerts
 *  wrap that row in the warn box; dismissing just unwraps it. */
const ALERT_FLAG: Partial<Record<Alert['type'], keyof Message['flags']>> = {
  failure: 'failure',
  help_request: 'help_requested',
  handoff_offer: 'handoff_offer',
  custom: 'custom_alert',
};

const alertLabel = (a: Alert) => ALERT_LABELS[a.type] ?? a.type.replaceAll('_', ' ');

/** Why a summary request came back empty — shown in the card so a click
 *  always produces visible feedback. */
const BRIEF_REASON: Record<string, string> = {
  short: 'Nothing to summarize yet — this thread is still short.',
  no_llm: "This agent has no LLM configured, so Janis can't write a summary.",
  over_cap: 'Summaries are paused — the workspace hit its 24h AI spend limit.',
  error: "Couldn't write a summary — try again.",
};

/** Canonical markdown-ish block renderer — the same shape message bubbles
 *  and the operator brief share (para / heading / list + inline mdSpans). */
function MdBlocks({ text }: { text: string }) {
  return (
    <>
      {splitBlocks(text).map((blk, bi) => {
        const cls = blk.breakBefore ? ' md-gap' : '';
        if (blk.kind === 'heading')
          return (
            <div key={bi} className={`md-head${cls}`}>
              {mdSpans(blk.text ?? '', bi)}
            </div>
          );
        if (blk.kind !== 'list')
          return (
            <div key={bi} className={`md-para${cls}`}>
              {mdSpans(blk.text ?? '', bi)}
            </div>
          );
        const Tag = blk.ordered ? 'ol' : 'ul';
        return (
          <Tag key={bi} className={`md-list${blk.loose ? ' md-loose' : ''}${cls}`}>
            {(blk.items ?? []).map((item, ii) => (
              <li key={ii}>{mdSpans(item)}</li>
            ))}
          </Tag>
        );
      })}
    </>
  );
}

/** Canonical transcript renderer lives in components/bits (mdSpans) — shared
 *  with the embedded Shopify inbox. */

// Optimistic outbound entries — render immediately, reconcile against the
// server's echoed row once the post-send refetch lands (same model the
// webchat widget uses).
interface OutEntry {
  localId: string;
  text: string;
  attachments: Attachment[];
  widgets?: unknown[];
  quick_replies?: unknown[];
  mode: 'human' | 'agent' | 'note' | 'teach';
  status: 'pending' | 'failed' | 'delivered';
  /** channel rejection reason when the send was stored but not delivered */
  error?: string;
  /** false when the channel says retrying can't help (closed 24h window) */
  retryable?: boolean;
  ts: number;
}

/** Cold-load placeholder — mirrors the real .conv-layout columns (split
    inbox, head + actions + transcript + composer, details rail) so the
    conversation lands without a page-level jump or a blank void. The
    cmh-* icon classes ride the real conditional-visibility rules, so the
    rail/dock presence already hides what the loaded head would hide. */
const SKEL_BUBBLES: [dir: 'in' | 'out', width: string, height: number][] = [
  ['in', '46%', 42], ['out', '62%', 56], ['in', '38%', 40], ['out', '55%', 42],
  ['in', '52%', 56], ['out', '34%', 40], ['in', '28%', 38], ['out', '48%', 42],
];

function ConversationSkeleton() {
  // The split inbox column is real content (the parent Conversations
  // owns it) — the skeleton only stands in for the conversation side.
  return (
    <>
      <div className="conv-main" role="status" aria-label="Loading conversation" aria-busy="true">
        <div className="conv-mobile-head">
          <span className="skel skel-ic" />
          <span className="skel skel-field" />
          <span className="skel skel-ic cmh-info cmh-copilot" />
          <span className="skel skel-ic cmh-info" />
        </div>
        <div className="row conv-actions">
          {Array.from({ length: 6 }, (_, i) => <span key={i} className="skel skel-ic" />)}
        </div>
        <div className="transcript">
          {SKEL_BUBBLES.map(([d, w, h], i) => (
            <div key={i} className={`skel skel-msg ${d}`} style={{ width: w, height: h }} />
          ))}
        </div>
        <div className="conv-foot">
          <span className="skel skel-composer" />
        </div>
      </div>
      <aside className="conv-side" aria-hidden>
        <div className="card skel-card">
          <div className="profile-head">
            <span className="skel skel-avatar lg" />
            <span className="skel skel-line" style={{ width: '42%' }} />
          </div>
          <span className="skel skel-line thin" style={{ width: '72%' }} />
          <span className="skel skel-line thin" style={{ width: '58%' }} />
          <span className="skel skel-line thin" style={{ width: '64%' }} />
        </div>
        {['Status', 'Assign to', 'Intent', 'Tags'].map((t) => (
          <div key={t} className="card skel-card">
            <strong>{t}</strong>
            <span className="skel skel-field" />
          </div>
        ))}
      </aside>
    </>
  );
}

export default function ConversationPage() {
  const params = useParams();
  // The split inbox column is owned by the parent Conversations route —
  // this page renders only .conv-main + .conv-side inside its .conv-layout.
  // Route shapes: /conversations/:id (params.id = conv) and
  // /agents/:agentId/inbox/:cid or /agents/:id/inbox/:cid nested
  // (params.cid = conv, params.agentId/params.id = agent).
  const agentParam = params.agentId ?? (params.cid ? params.id : undefined);
  const id = params.cid ?? params.id ?? '';
  // Details rail is user-resizable — --rail-w feeds the ≥681px container
  // rule (drawer widths keep their own). The grip lands in the parent's
  // .conv-layout beside the aside's left edge. The max is live too: the
  // rail can't be dragged past inbox-col + 420px conv floor, so the drag
  // itself can't squeeze the transcript out of existence.
  const { width: railW, gripProps: railGrip } = usePanelWidth('conv.railw', 280, 240, () => {
    const layout = document.querySelector('.conv-layout');
    const colW = storedPanelWidth('conv.colw', 290, 220, 480);
    return Math.min(560, Math.max(240, (layout?.clientWidth ?? 560) - colW - 420 - 32));
  }, -1);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const jumpMsg = searchParams.get('msg'); // search-result deep link
  const returnScroll = searchParams.get('scroll'); // agent-page breadcrumb round-trip
  const { data, error: loadError, isPlaceholderData } = useConversation(id);
  // Operator brief — on demand via the Summarize button. Enabled flips the
  // query on; the server decides whether there's anything worth writing.
  const [briefOpen, setBriefOpen] = useState(false);
  const briefQ = useConversationBrief(id, briefOpen);
  // A merged conversation (visitor adoption) returns the survivor with
  // merged_from set — swap the URL to the surviving id silently.
  useEffect(() => {
    if (!isPlaceholderData && data?.merged_from && data.conversation.id !== id) {
      navigate(`/conversations/${data.conversation.id}`, { replace: true });
    }
  }, [data, id, isPlaceholderData, navigate]);
  usePageTitle(data ? displayName(data.conversation) : 'Conversation');
  const { data: agents } = useAgents();
  const { data: users } = useUsers();
  const { data: me } = useMe();
  const [draft, setDraft] = useState('');
  const [sendAs, setSendAs] = useState<'human' | 'agent' | 'note' | 'teach'>('human');
  const [wsSwitch, setWsSwitch] = useState<'idle' | 'trying' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [convQ, setConvQ] = useState('');
  const [convHits, setConvHits] = useState<Message[] | null>(null);
  const qc = useQueryClient();
  const invalidate = useInvalidateConversations();
  const bottomRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // stay glued to the bottom while the user is near it — attachments loading
  // late (images) grow the transcript, so we re-snap whenever they render
  const stickRef = useRef(true);
  // Returning via the agent-page breadcrumb restores scroll — disarm the
  // bottom-stick before the snap effect below can run.
  if (returnScroll) stickRef.current = false;
  // A message taller than the pane anchors at its top — the iMessage-style
  // bottom snap would land the reader on the signature of a long email.
  const snapToLatest = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const rows = el.querySelectorAll('.msg');
    const last = rows[rows.length - 1];
    if (
      last instanceof HTMLElement &&
      last.classList.contains('in') &&
      last.offsetHeight > el.clientHeight
    ) {
      el.scrollTop += last.getBoundingClientRect().top - el.getBoundingClientRect().top;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  };
  // Late-loading media grows the transcript while pinned — stick to the
  // literal bottom. NOT snapToLatest: its tall-inbound top-anchor is for
  // arrivals (jump-to-latest); firing it on image load yanks a reader at
  // the bottom back to the top of the last message.
  const snapToBottom = () => {
    const el = transcriptRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
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
  const [operatorTyping, setOperatorTyping] = useState<string | null>(null);
  const [viewers, setViewers] = useState<{ id: string; name: string | null }[]>([]);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const agentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () =>
      typingBus.subscribe((p) => {
        if (p.conversation_id !== id) return;
        if (p.kind === 'operator') {
          // Collision detection — another teammate composing here. Your own
          // composer pings come back on the same stream; suppress them.
          if (p.user_id && p.user_id === me?.user.id) return;
          setOperatorTyping(p.name ?? 'A teammate');
          clearTimeout(opTimer.current);
          opTimer.current = setTimeout(() => setOperatorTyping(null), 5000);
          return;
        }
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
    [id, me?.user.id],
  );

  // Presence — heartbeat while this conversation is open (server TTL ~20s)
  // and render who's co-viewing when the stream broadcasts a change.
  useEffect(() => {
    const ping = () =>
      void api(`/api/conversations/${id}/viewing`, { method: 'POST' })
        .then((r) => setViewers((r as { viewers: { id: string; name: string | null }[] }).viewers))
        .catch(() => {});
    ping();
    const t = setInterval(ping, 15_000);
    return () => clearInterval(t);
  }, [id]);
  useEffect(
    () =>
      presenceBus.subscribe((p) => {
        if (p.conversation_id === id) setViewers(p.viewers);
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
  // Re-snap on EVERY commit while pinned, not just when the dep list changes:
  // the messages page is capped server-side (PAGE=100), so once full a new
  // arrival rotates the window without changing length, and bubbles keep
  // growing a render after the text lands (verdict box, embeds). Skips when
  // stickRef is off (scrolled up / jump window) or a prepend is holding the
  // scroll position. Same pattern as AskJanis, for the same reason.
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!el || !data?.messages.length || !stickRef.current || pendingAdjust.current) return;
    el.scrollTop = el.scrollHeight;
  });

  // ?scroll=<px> return trip — restore the transcript position once the
  // messages render, then drop the param so refetches don't re-pin it.
  const restoredFor = useRef('');
  useLayoutEffect(() => {
    if (!returnScroll || !data?.messages.length || data.conversation.id !== id || restoredFor.current === id) return;
    const el = transcriptRef.current;
    if (!el) return;
    restoredFor.current = id;
    el.scrollTop = Number(returnScroll) || 0;
    const p = new URLSearchParams(searchParams);
    p.delete('scroll');
    setSearchParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, returnScroll, id]);

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
  const [inspectorFor, setInspectorFor] = useState<string | null>(null);
  // "Correct this" on a live agent reply — same routing as the test chat
  // (note / draft article / instruction rule). Bad replies in real
  // conversations are the highest-signal corrections there are.
  const [correctFor, setCorrectFor] = useState<{
    id: string;
    agentText: string;
    customerText?: string;
    turns?: ScenarioTurn[];
    scenario?: { id: string; expectation: string };
  } | null>(null);
  // Per-reply "Save as scenario" — message ids saved this session get a
  // "✓ in tests" marker instead of the button.
  const [scenarioSavedFor, setScenarioSavedFor] = useState<Set<string>>(new Set());
  const [testSaveOpen, setTestSaveOpen] = useState(false);
  const [testName, setTestName] = useState('');
  const [testExpectation, setTestExpectation] = useState('');
  const [testSaved, setTestSaved] = useState(0);
  const jumpedFor = useRef('');
  const olderFor = useRef('');
  const [briefBusy, setBriefBusy] = useState(false);
  if (olderFor.current !== id) {
    olderFor.current = id;
    setOlder([]);
    setOlderHasMore(null);
    setWin(null);
    jumpedFor.current = '';
    setBriefOpen(false);
    // Fresh thread pins to the latest — without this, scrolling up in the
    // previous conversation leaves stickRef off and the new transcript
    // keeps the old scrollTop instead of snapping to the tail. A ?scroll=
    // return trip keeps its restore instead.
    stickRef.current = !returnScroll;
  }
  const hasMore = win ? win.hasMoreBefore : (olderHasMore ?? data?.messages_has_more ?? false);

  const loadOlder = async () => {
    const oldest = win
      ? win.msgs[0]?.created_at
      : (older[0]?.created_at ?? data?.messages[0]?.created_at);
    if (!hasMore || fetchingOlder || !oldest || data?.conversation.id !== id) return;
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
    if (!jumpMsg || !data || data.conversation.id !== id) {
      if (!jumpMsg) jumpedFor.current = '';
      return;
    }
    const key = `${id}:${jumpMsg}`;
    if (jumpedFor.current === key) return;
    jumpedFor.current = key;
    // Consume the param immediately — jumping to the same message again (e.g.
    // clicking the same search hit twice) needs the param absent so a fresh
    // ?msg= re-triggers this effect.
    const p = new URLSearchParams(searchParams);
    p.delete('msg');
    setSearchParams(p, { replace: true });
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

  // In-conversation search — server-side so unloaded transcript history hits
  // too; results jump through the same ?msg=/around path as the global search.
  useEffect(() => {
    const q = convQ.trim();
    if (q.length < 2) {
      setConvHits(null);
      return;
    }
    const t = setTimeout(() => {
      void api<{ hits: Message[] }>(
        `/api/conversations/${id}/messages?q=${encodeURIComponent(q)}`,
      )
        .then((d) => setConvHits(d.hits))
        .catch(() => setConvHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [convQ, id]);

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
      snoozed_until?: string | null;
      intent?: string | null;
    }) =>
      api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onMutate: (body) => {
      // The inbox row + this page's icon repaint before the round-trip —
      // the invalidate in onSuccess still reconciles with the server.
      if (body.is_unread !== undefined) {
        patchConversationCaches(qc, id, { is_unread: body.is_unread });
        qc.setQueryData(
          ['conversation', id],
          (old: { conversation?: { is_unread?: boolean } } | undefined) =>
            old?.conversation
              ? { ...old, conversation: { ...old.conversation, is_unread: body.is_unread } }
              : old,
        );
      }
    },
    onSuccess: (_d, body) => {
      // is_unread already patched every cache in onMutate — refetches
      // can't undo a manual "mark unread" (the mark-read-on-open effect
      // only fires on first load), they just reconcile the rest.
      if (body.is_unread !== undefined) invalidate();
      else refresh();
    },
    onError: (e) => setError(e.message),
  });

  // Opening a conversation marks it read — once per open, so the
  // "Mark unread" toggle can't be undone by a later refetch. The ref marks
  // the initial-load STATE, not the firing: opening an already-read conv
  // never set it, so the first manual "mark unread" looked exactly like an
  // unread conv freshly opened and got re-read immediately.
  const markedReadFor = useRef('');
  useEffect(() => {
    if (!data || data.conversation.id !== id || markedReadFor.current === id) return;
    markedReadFor.current = id;
    if (data.conversation.is_unread) patch.mutate({ is_unread: false });
  }, [data, id]);

  const [confirmEl, confirm] = useConfirm();
  const del = useMutation({
    mutationFn: () => api(`/api/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      navigate('/conversations');
    },
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
  // The operator handed the draft off to Copilot — the card shows a quiet
  // receipt until a staged draft lands.
  const [routedToCopilot, setRoutedToCopilot] = useState(false);
  // The guide text behind the current draft — the Copilot hand-off seed
  // carries it forward so the concierge knows what the draft is for.
  const [lastInstruction, setLastInstruction] = useState<string | null>(null);
  // Components a used suggestion carries — ride along on the next reply
  // send, dismissed with ✕ or consumed on success.
  const [pendingComponents, setPendingComponents] = useState<{
    widgets?: unknown[];
    quick_replies?: unknown[];
  } | null>(null);
  const [actionResults, setActionResults] = useState<Record<number, string>>({});
  const [editAction, setEditAction] = useState<number | null>(null);
  const [actionArgsDraft, setActionArgsDraft] = useState('');
  // A picked saved component staged as an inline draft — resolves via the
  // send-component preview and waits for the operator's Send/Dismiss.
  const [componentDraft, setComponentDraft] = useState<{ name: string; widget: unknown } | null>(null);
  // Sent the draft's text but undecided proposed actions remain — the card
  // stays open showing just the actions until they're all decided.
  const [draftSent, setDraftSent] = useState(false);
  // Regenerating: the hosted path returns before the LLM finishes, so
  // isPending clears early and the STALE draft reappears until the fresh
  // row lands via refetch. Track the row being replaced — while it still
  // tops the list the card stays on Thinking.
  const [replacedSid, setReplacedSid] = useState<string | null>(null);
  // Inline draft editing — Preview/Edit tabs on the card. Edits apply to
  // the card itself (never pushed into the reply composer).
  const [draftEditing, setDraftEditing] = useState(false);
  const [editText, setEditText] = useState('');
  // The draft's instruction — editable inline on the card; refresh drafts
  // from it (blank falls back to the prompt that produced this draft).
  const [instr, setInstr] = useState<string | null>(null);
  const [editWidgets, setEditWidgets] = useState<Record<number, string>>({});
  const [editErr, setEditErr] = useState('');
  const [draftEdits, setDraftEdits] = useState<{
    text: string;
    widgets: Record<number, unknown>;
  } | null>(null);
  // Component JSON carrying a `tool` block can't ride the visitor-facing
  // spec (it holds resource ids) — on apply we save it as a real bound
  // component and stamp collect so submissions route through the binding.
  const [editSaving, setEditSaving] = useState(false);
  // The draft prompt is a field, not a caption — an auto-growing textarea
  // (one row tall until the content wraps) styled like every other input
  // so it reads as editable at a glance.
  const instrRef = useRef<HTMLTextAreaElement>(null);
  const instrValue =
    instr ??
    ((data?.suggestions?.[0]?.payload as { instruction?: string } | undefined)?.instruction ?? '');
  useEffect(() => {
    const el = instrRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [instrValue]);
  // While a redraft is in flight the body swaps for a skeleton sized to
  // the last rendered body, so the card doesn't collapse and re-grow.
  const draftBodyRef = useRef<HTMLDivElement>(null);
  const draftBodyH = useRef(0);
  useLayoutEffect(() => {
    const el = draftBodyRef.current;
    if (el) draftBodyH.current = el.offsetHeight;
  });
  useEffect(() => {
    if (!replacedSid) return;
    const t = setTimeout(() => setReplacedSid(null), 30_000);
    return () => clearTimeout(t);
  }, [replacedSid]);
  // A fresh suggestion row IS the concierge's staged draft landing —
  // drop the receipt line once it's here, and drop any edits aimed at
  // the replaced draft.
  const topSuggestionId = data?.suggestions?.[0]?.id;
  useEffect(() => {
    setDraftEditing(false);
    setDraftEdits(null);
    setEditErr('');
    setInstr(null);
    if (topSuggestionId) setRoutedToCopilot(false);
  }, [topSuggestionId]);
  // Conversation switch — the page stays mounted, so every piece of
  // per-thread state must reset or a pending send/draft from the previous
  // conversation appears inside this one (a draft bubble that looks sent
  // in every thread you open).
  useEffect(() => {
    setDraft('');
    setPendingComponents(null);
    setComponentDraft(null);
    setDraftSent(false);
    setActionResults({});
    setEditAction(null);
    setSuggestOpen(false);
    setRoutedToCopilot(false);
    setLastInstruction(null);
    setInstr(null);
    setDraftEditing(false);
    setDraftEdits(null);
    setEditErr('');
    setOb(() => []);
    setError('');
    receiptFor.current = null;
  }, [id]);
  // Mobile details slide-over — the right column is a drawer on phones,
  // opened from the header's ⓘ. The page never scrolls; transcript only.
  const [sideOpen, setSideOpen] = useState(false);
  // User-hidden details rail (docked mode) — same grammar as rail-tight:
  // the ⓘ in the conv head reopens. Not persisted: a collapsed rail is a
  // "for this view" gesture, not a layout pref.
  const [sideClosed, setSideClosed] = useState(false);
  const sideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const layout = sideRef.current?.parentElement;
    if (!layout) return;
    layout.classList.toggle('rail-closed', sideClosed);
    // The fit cascade counts the rail's stored width — re-measure so a
    // closed rail frees its space for conv/inbox immediately.
    window.dispatchEvent(new Event('panel-resize'));
    return () => layout.classList.remove('rail-closed');
  }, [sideClosed]);
  useEffect(() => {
    if (!sideOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSideOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sideOpen]);
  // A wide→narrow flip hides the rail outright — the drawer never
  // carries an open/scrim state across the boundary.
  useEffect(() => {
    const hide = () => setSideOpen(false);
    window.addEventListener('conv-rail-hide', hide);
    return () => window.removeEventListener('conv-rail-hide', hide);
  }, []);

  const decide = useMutation({
    mutationFn: ({ actionId, decision }: { actionId: string; decision: 'approved' | 'denied' }) =>
      api(`/api/actions/${actionId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['conversation', id] }),
    onError: (e) => setError(e.message),
  });

  // Dismiss an alert without touching conversation state — resolving marks
  // it actioned and clears the list dot.
  const resolveAlert = useMutation({
    mutationFn: (alertId: string) =>
      api(`/api/alerts/${alertId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'resolved' }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversation', id] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (e) => setError(e.message),
  });

  const suggest = useMutation({
    mutationFn: (instruction?: string) =>
      api(`/api/conversations/${id}/suggest`, {
        method: 'POST',
        body: JSON.stringify(instruction ? { instruction } : {}),
      }),
    onSuccess: () => { setError(''); void qc.invalidateQueries({ queryKey: ['conversation', id] }); },
    onError: (e) => { setError(e.message); setSuggestOpen(false); },
  });

  // "Draft a reply with AI" — the composer's popover submits the operator's
  // guidance (blank = draft from conversation context). Any instruction
  // rides /suggest as `instruction`; the landed suggestion echoes it back
  // via payload.instruction. Copilot is the escalation path via "Continue
  // in Copilot" on the card, not the default route.
  const draftReply = (instruction?: string) => {
    if (suggest.isPending) return;
    const g = instruction?.trim();
    setLastInstruction(g || null);
    setInstr(g ?? null);
    setSuggestOpen(true);
    setReplacedSid(data?.suggestions?.[0]?.id ?? null);
    setDraftSent(false);
    setActionResults({});
    setRoutedToCopilot(false);
    suggest.mutate(g || undefined);
  };

  const saveTest = useMutation({
    mutationFn: () =>
      api(`/api/agents/${c.agent_id}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          name: testName.trim(),
          expectation: testExpectation.trim(),
          conversation_id: id,
        }),
      }),
    onSuccess: (d) => {
      const saved = (d as { tests?: unknown[] }).tests;
      setTestSaved(saved?.length ?? 1);
      setTestName('');
      setTestExpectation('');
    },
    onError: (e) => setError(e.message),
  });

  // Same suite the test dock reads — used to hide Save-as-scenario on a
  // reply whose prompt is already a scenario (and to mark fresh saves).
  const convTests = useQuery({
    queryKey: ['agent-tests', data?.conversation.agent_id],
    queryFn: () =>
      api<{ tests: ScenarioTest[] }>(
        `/api/agents/${data!.conversation.agent_id}/tests`,
      ),
    enabled: Boolean(data?.conversation.agent_id),
  });
  // Meaning-based lookup — fuzzy locally, semantic via the server queue,
  // so a paraphrased or typo'd prompt still finds its scenario.
  const matchScenario = useScenarioMatch(
    data?.conversation.agent_id,
    convTests.data?.tests ?? [],
  );
  // Owner verdict on a matched scenario — same human_result write the test
  // chat's thumbs make. 'Needs work' also opens the correction card with
  // the scenario context, like the test chat does.
  const verdictTest = useMutation({
    mutationFn: (b: { testId: string; result: 'pass' | 'fail' }) =>
      api(`/api/agents/${data!.conversation.agent_id}/tests/${b.testId}`, {
        method: 'PATCH',
        body: JSON.stringify({ human_result: b.result }),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: ['agent-tests', data?.conversation.agent_id],
      }),
  });
  const saveScenario = useMutation({
    mutationFn: (ctx: {
      msgId: string;
      agentText: string;
      customerText: string;
      turns?: ScenarioTurn[];
    }) =>
      api(`/api/agents/${data!.conversation.agent_id}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          // The inbound is the trigger; the reply it gave is the bar.
          // With exchange context the scenario replays the setup turns.
          ...((ctx.turns?.length ?? 0) > 1
            ? { turns: ctx.turns, original_reply: ctx.agentText.slice(0, 4000) }
            : { prompt: ctx.customerText.slice(0, 400) }),
          expectation: ctx.agentText.slice(0, 600),
          category: 'general',
          source: 'inbox',
        }),
      }),
    onSuccess: (_r, ctx) => {
      setScenarioSavedFor((s) => new Set(s).add(ctx.msgId));
      void qc.invalidateQueries({
        queryKey: ['agent-tests', data?.conversation.agent_id],
      });
    },
    onError: (e) => setError(e.message),
  });

  // Dismiss EVERY pending suggestion — otherwise the next one in the queue
  // slides into the card and it feels like dismiss loads another iteration.
  const dismissSuggestions = async () => {
    const pending = data?.suggestions ?? [];
    // Optimistic — the card closes on click, not on the server round-trip.
    qc.setQueryData(
      ['conversation', id],
      (old: { suggestions?: unknown[] } | undefined) =>
        old ? { ...old, suggestions: [] } : old,
    );
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

  // Inline approve (default) or park-for-teammate (park:true) on a gated
  // action the suggestion proposed.
  /** First sentence of a tool result — the rest is model-facing
   *  instruction ("then call check_verification_code…"), not an outcome
   *  the operator needs to read. */
  const actionResultLine = (r?: string | null) =>
    (r ?? 'done').split(/(?<=\.)\s|\n/)[0].slice(0, 140);

  const runAction = useMutation({
    mutationFn: ({ name, args, park }: { name: string; args: Record<string, unknown>; park?: boolean }) =>
      api<{ parked?: boolean; action?: { status: string; result?: string | null } }>(
        `/api/conversations/${id}/run-action`,
        { method: 'POST', body: JSON.stringify({ name, args, park }) },
      ),
    onError: (e) => setError(e.message),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['conversation', id] }),
  });

  // Resolve a saved component into a staged draft — nothing sends until the
  // operator hits Send on the inline draft bubble.
  const previewComponent = useMutation({
    mutationFn: ({ name, data }: { name: string; data?: Record<string, unknown> }) =>
      api<{ widget: unknown }>(`/api/conversations/${id}/send-component`, {
        method: 'POST',
        body: JSON.stringify({ name, data, preview: true }),
      }),
    onSuccess: (r, v) => setComponentDraft({ name: v.name, widget: r.widget }),
    onError: (e) => setError(e.message),
  });

  const send = (
    attachments: Attachment[],
    retryOf?: OutEntry,
    override?: { text?: string; widgets?: unknown[]; quick_replies?: unknown[] },
  ) => {
    stickRef.current = true; // your own send always lands at the tail
    const mode = retryOf?.mode ?? sendAs;
    const entry: OutEntry =
      retryOf ??
      {
        localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: override?.text ?? draft,
        attachments,
        widgets: override?.widgets ?? pendingComponents?.widgets,
        quick_replies: override?.quick_replies ?? pendingComponents?.quick_replies,
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
        body: JSON.stringify({
          text: entry.text,
          attachments: entry.attachments,
          widgets: entry.widgets,
          quick_replies: entry.quick_replies,
        }),
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
        if (!retryOf) {
          setDraft('');
          setPendingComponents(null);
          setComponentDraft(null);
        }
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

  // A 404 on a deep link usually means the conversation lives in another
  // workspace the user belongs to (alert emails point here regardless of
  // the session's active workspace). Ask the server to move the session to
  // the owning workspace — it 404s unless the user could see this
  // conversation there — then reload the same URL under it.
  useEffect(() => {
    if (
      !(loadError instanceof ApiError) ||
      loadError.status !== 404 ||
      wsSwitch !== 'idle' ||
      !id
    ) {
      return;
    }
    setWsSwitch('trying');
    void api('/auth/switch', {
      method: 'POST',
      body: JSON.stringify({ for_conversation: id }),
    })
      .then((r) => {
        const res = r as { ok?: boolean; unchanged?: boolean };
        // unchanged = the conv is already in the active workspace and the
        // 404 is real — don't reload-loop.
        if (!res.ok || res.unchanged) {
          setWsSwitch('failed');
          return;
        }
        // Each workspace remembers its own agent — nothing to clear; the
        // destination workspace restores whatever was selected there last.
        qc.clear();
        window.location.reload();
      })
      .catch(() => setWsSwitch('failed'));
  }, [loadError, wsSwitch, id, qc]);

  // Saved components on this agent — the draft card labels each staged
  // widget with its wiring (submits to / bound to) via payload.widget_refs.
  // Sits above every early return — hooks can't run conditionally.
  const { data: agentWidgets } = useAgentWidgets(data?.conversation.agent_id);

  if (loadError instanceof ApiError && loadError.status === 404) {
    if (wsSwitch !== 'failed') {
      // Deep link into another workspace (alert emails) — the switch attempt
      // is in flight (or hasn't started); hold the loading state.
      return <ConversationSkeleton />;
    }
    return (
      <div className="muted">
        Conversation not found. <Link to="/conversations">Back to conversations</Link>
      </div>
    );
  }
  if (!data) return <ConversationSkeleton />;
  const { conversation: c, messages, alerts, suggestions } = data;
  // Regenerating — the card keeps its prompt header visible but frozen
  // while the new draft is in flight (pending, or waiting for the fresh
  // row to replace the stale one at the top of the list).
  const draftBusy =
    suggest.isPending || (replacedSid !== null && suggestions?.[0]?.id === replacedSid);

  // Apply the operator's draft edits: validate each component's JSON, then
  // lift any `tool`/`submit` block out of the spec into a REAL saved
  // component — bindings carry resource ids and can't ship inside the
  // visitor-facing spec. The sent spec keeps a `collect` stamp so its
  // submissions route through the new binding.
  const applyDraftEdits = async (s: { payload?: unknown }) => {
    const parsed: Record<number, unknown> = {};
    const payload = s.payload as Record<string, unknown> | undefined;
    const refs = payload?.widget_refs as (string | null)[] | undefined;
    for (const [k, v] of Object.entries(editWidgets)) {
      if (!v.trim()) continue;
      const i = Number(k);
      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(v) as Record<string, unknown>;
      } catch {
        setEditErr(`component ${i + 1}: invalid JSON — fix or clear it`);
        return null;
      }
      let bind = spec.tool && typeof spec.tool === 'object' ? (spec.tool as Record<string, unknown>) : undefined;
      if (!bind && spec.submit) bind = { submit: spec.submit };
      if (bind && (bind.submit || bind.name)) {
        const { tool: _tool, submit: _sub, ...clean } = spec;
        const base = String(
          refs?.[i] ?? (clean.title as string | undefined) ?? (clean.type as string | undefined) ?? 'component',
        )
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || `component-${i + 1}`;
        const taken = new Set((agentWidgets?.widgets ?? []).map((w) => w.name));
        let name = base;
        for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
        try {
          await api(`/api/agents/${c.agent_id}/widgets`, {
            method: 'POST',
            body: JSON.stringify({ name, spec: clean, tool: bind }),
          });
        } catch (e) {
          setEditErr(`saving "${name}": ${e instanceof Error ? e.message : 'failed'}`);
          return null;
        }
        parsed[i] = { ...clean, collect: name };
      } else {
        parsed[i] = spec;
      }
    }
    if (Object.keys(parsed).length) void qc.invalidateQueries({ queryKey: ['agent-widgets'] });
    return { text: editText, widgets: parsed };
  };
  const brief = briefQ.data?.summary ?? null;
  const refreshBrief = async () => {
    if (briefBusy) return;
    setBriefBusy(true);
    try {
      const r = await api<{ summary: string | null; generated_at: string | null }>(
        `/api/conversations/${id}/summary?refresh=1`,
      );
      qc.setQueryData(['conv-brief', id], r);
    } catch {
      /* a failed refresh keeps the stale brief */
    } finally {
      setBriefBusy(false);
    }
  };
  const p = c.user_profile ?? {};
  const name = displayName(c);
  const snoozed = Boolean(c.snoozed_until && new Date(c.snoozed_until) > new Date());
  const KNOWN = new Set([
    'id', 'name', 'first_name', 'last_name', 'username', 'email', 'phone',
    'channel', 'channel_name', 'profile_fetched_at', 'metadata',
  ]);
  const extraProfile = Object.entries(p).filter(([k]) => !KNOWN.has(k));
  const agent = agents?.agents.find((a) => a.id === c.agent_id);
  // The operator's own concierge thread can't host a customer draft, and
  // accounts without a copilot have nowhere to hand off to — both hide
  // the "Continue in Copilot" CTA on the draft card.
  const selfThread =
    !!me?.user?.id &&
    (c.external_id === `webchat:u:${me.user.id}` ||
      c.external_id.startsWith(`webchat:u:${me.user.id}:`));
  const hasCopilot = !!me?.support_channel_id;
  const openAlerts = alerts.filter((a) => a.status === 'open');
  // Anchor each open alert to the transcript row its event wrote — flagged
  // system lines (handoffs, failures, offers, custom alert text), the
  // internal rule_trigger note rule/sweeper alerts stamp with the same
  // detail, or the pending-approval card. Anything left over renders as a
  // synthetic warn box sorted in at the alert's timestamp.
  const loadedMsgs = win ? win.msgs : [...older, ...messages];
  const alertAnchor = new Map<string, string>(); // alert id -> message id
  const orphanAlerts: Alert[] = [];
  for (const a of openAlerts) {
    const at = Date.parse(a.created_at);
    const flag = ALERT_FLAG[a.type];
    const cands = flag
      ? loadedMsgs.filter((m) => m.flags[flag])
      : a.type === 'approval_request'
        ? loadedMsgs.filter(
            (m) => (m.payload.action as { status?: string } | undefined)?.status === 'pending',
          )
        : loadedMsgs.filter(
            (m) =>
              m.payload.internal === true &&
              m.payload.event === 'rule_trigger' &&
              !!a.detail &&
              (m.text ?? '').includes(a.detail),
          );
    const anchor = cands.sort(
      (x, y) => Math.abs(Date.parse(x.created_at) - at) - Math.abs(Date.parse(y.created_at) - at),
    )[0];
    if (anchor) alertAnchor.set(a.id, anchor.id);
    else orphanAlerts.push(a);
  }
  const msgAlert = new Map<string, Alert>();
  for (const a of openAlerts) {
    const mid = alertAnchor.get(a.id);
    if (mid) msgAlert.set(mid, a);
  }
  // Suggestions draft a VISITOR-FACING reply — they fit the human/agent
  // reply modes (even before takeover), never an internal note or teach.
  const canSuggest =
    c.state !== 'archived' && (sendAs === 'human' || sendAs === 'agent');
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
    ...loadedMsgs.map((m) => ({ key: m.id, ts: Date.parse(m.created_at), kind: 'msg' as const, m })),
    ...visibleOutbox.map((o) => ({ key: o.localId, ts: o.ts, kind: 'out' as const, o })),
    ...orphanAlerts.map((a) => ({ key: `alert:${a.id}`, ts: Date.parse(a.created_at), kind: 'alert' as const, a })),
  ].sort((a, b) => a.ts - b.ts);

  // A .who label opens each run of consecutive same-sender messages;
  // system/internal lines always break the run so the next real message
  // re-introduces its author. Outbox entries key like the stored rows they
  // become so a pending send groups with its own stack.
  const senderKey = (it: (typeof items)[number]): string => {
    if (it.kind === 'alert') return `sys:${it.a.id}`;
    if (it.kind === 'out') {
      if (it.o.mode === 'note' || it.o.mode === 'teach') return `sys:${it.o.localId}`;
      return `m:${it.o.mode === 'agent' ? 'out' : 'human'}:${me?.user.id ?? ''}`;
    }
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
  // Exactly one "Delivered", under the newest item known to have reached
  // the customer — payload.delivered covers push and pull-model channels,
  // the echo match covers a stored row whose stamp hasn't landed, and a
  // delivered outbox bubble counts while its echo is still in flight.
  let lastDeliveredIdx = -1;
  items.forEach((it, i) => {
    const delivered =
      it.kind === 'msg'
        ? it.m.direction !== 'in' &&
          (it.m.payload.delivered === true ||
            (receiptFor.current !== null && echoFor.get(receiptFor.current)?.id === it.m.id))
        : it.kind === 'out' &&
          (it.o.mode === 'human' || it.o.mode === 'agent') &&
          it.o.status === 'delivered';
    if (delivered) lastDeliveredIdx = i;
  });

  // Mobile back (the ☰ bar is hidden on conversation pages) — prefer the
  // real history entry so list scroll/filters survive; a cold-opened deep
  // link (push, PWA) has none, so fall back to the inbox that owns this URL.
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(agentParam ? `/agents/${agentParam}/inbox` : '/conversations');
  };

  const hitWho = (m: Message): string =>
    m.direction === 'in'
      ? c.user_profile.name ?? WHO.in
      : m.direction === 'out'
        ? agent?.name ?? WHO.out
        : users?.users.find((u) => u.id === m.author)?.name ?? WHO.human;
  const jumpToHit = (mid: string) => {
    const p = new URLSearchParams(searchParams);
    p.set('msg', mid);
    setSearchParams(p, { replace: true });
  };
  // Chip click: anchored alerts ride the ?msg= deep link (loads history if
  // the row is outside the window); synthetic boxes always render, so just
  // center + flash them.
  const jumpToAlert = (a: Alert) => {
    const mid = alertAnchor.get(a.id);
    if (mid) return jumpToHit(mid);
    stickRef.current = false;
    setHighlight(`alert:${a.id}`);
  };
  const markHit = (text: string | null): ReactNode => {
    const t = text ?? '';
    const q = convQ.trim();
    const idx = t.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return t;
    return (
      <>
        {t.slice(0, idx)}
        <mark>{t.slice(idx, idx + q.length)}</mark>
        {t.slice(idx + q.length)}
      </>
    );
  };

  return (
    <>
      {confirmEl}
      <div className="conv-main">
        {/* Phone-only header (hidden ≥721px): back + who this is, pinned —
            the Slack-style frame the desktop sidebar provides for free. */}
        <div className="conv-mobile-head">
          <button
            className="cmh-back"
            aria-label="Back to inbox"
            title="Back to inbox"
            onClick={goBack}
          >
            <ChevronLeft size={20} />
          </button>
          {/* The who/channel/state block lives in the details panel — the
              head carries the conversation search instead. */}
          <SearchInput
            className="conv-search"
            placeholder="Search this conversation…"
            aria-label="Search this conversation"
            value={convQ}
            onChange={(e) => setConvQ(e.target.value)}
            onClear={() => { setConvQ(''); setConvHits(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && convHits?.length) jumpToHit(convHits[0].id);
              if (e.key === 'Escape') {
                setConvQ('');
                setConvHits(null);
              }
            }}
          />
          <button
            className="cmh-info cmh-copilot"
            aria-label="Ask Janis"
            title="Ask Janis"
            onClick={() => window.dispatchEvent(new CustomEvent('janis:open-copilot'))}
          >
            <Sparkles size={18} />
          </button>
          <button
            className="cmh-info"
            aria-label="Conversation details"
            title="Details — status, assignee, intent, tags"
            onClick={() => {
              setSideClosed(false);
              setSideOpen(true);
            }}
          >
            <Info size={18} />
          </button>
          {/* Same slot as the ⓘ — the two never coexist: docked rail
              shows a collapse glyph (matching the nav's PanelLeftClose
              size/treatment), hidden/drawered rail shows ⓘ instead. */}
          <button
            className="cmh-collapse"
            aria-label="Hide details panel"
            title="Hide details"
            onClick={() => { setSideClosed(true); setSideOpen(false); }}
          >
            <PanelRightClose size={16} />
          </button>
        </div>
        <div className="row conv-actions">
          {/* Copilot trigger — the dock strip is hidden at these widths, so
              the button rides with ⓘ when the rail collapses. */}
          <button
            className="btn copilot-btn"
            title="Ask Janis"
            aria-label="Ask Janis"
            onClick={() => window.dispatchEvent(new CustomEvent('janis:open-copilot'))}
          >
            <Sparkles size={15} />
          </button>
          <button
            className={`btn brief-toggle${briefOpen ? ' on' : ''}`}
            title="Summarize this conversation"
            aria-label="Summarize this conversation"
            aria-pressed={briefOpen}
            onClick={() => setBriefOpen((v) => !v)}
          >
            <ScrollText size={15} />
            <span className="btn-label">Summarize</span>
          </button>
          {viewers.filter((v) => v.id !== me?.user.id).length > 0 && (
            <span
              className="muted"
              style={{ fontSize: 12, whiteSpace: 'nowrap' }}
              title="Teammates who have this conversation open — check before replying"
            >
              👁 {viewers
                .filter((v) => v.id !== me?.user.id)
                .map((v) => v.name ?? 'Someone')
                .join(', ')}{' '}
              also viewing
            </span>
          )}
          <button
            className="btn icon"
            title={c.is_starred ? 'Unstar' : 'Star'}
            aria-label={c.is_starred ? 'Unstar conversation' : 'Star conversation'}
            onClick={() => patch.mutate({ is_starred: !c.is_starred })}
          >
            <Star size={16} fill={c.is_starred ? 'currentColor' : 'none'} color={c.is_starred ? 'var(--accent)' : 'currentColor'} />
          </button>
          <button
            className="btn"
            onClick={() => patch.mutate({ is_unread: !c.is_unread })}
            title={c.is_unread ? 'Mark as read' : 'Mark unread'}
            aria-label={c.is_unread ? 'Mark as read' : 'Mark unread'}
          >
            {c.is_unread ? <MailOpen size={15} /> : <Mail size={15} />}
            <span className="btn-label">{c.is_unread ? 'Mark as read' : 'Mark unread'}</span>
          </button>
          {/* The select IS the dropdown — invisible on mobile, stretched
              over the moon icon so the tap lands on the native picker. */}
          <div className={`snooze-wrap${snoozed ? ' on' : ''}`}>
            <Moon size={15} className="snz-ic" />
            <select
              className="btn"
              style={{ width: 'auto' }}
              title={
                snoozed
                  ? `Snoozed until ${new Date(c.snoozed_until!).toLocaleString()} — hidden from the queue until then`
                  : 'Snooze — hide from the queue until later; a customer reply wakes it'
              }
              value={snoozed ? 'snoozed' : ''}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'snoozed') return;
                patch.mutate({
                  snoozed_until:
                    v === 'wake'
                      ? null
                      : new Date(Date.now() + snoozeMinutes(Number(v)) * 60_000).toISOString(),
                });
              }}
            >
              <option value="">😴 Snooze…</option>
              {snoozed && (
                <option value="snoozed">
                  😴 until {new Date(c.snoozed_until!).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </option>
              )}
              {SNOOZE_OPTIONS.map(([l, m]) => (
                <option key={l} value={m}>{l}</option>
              ))}
              <option value="wake">Unsnooze</option>
            </select>
          </div>
          {janisBrain(agent) && (
            <button
              className="btn"
              title="Save this transcript as a scenario — replay it after prompt or knowledge changes"
              aria-label="Save this transcript as a scenario"
              onClick={() => setTestSaveOpen((v) => !v)}
            >
              <BookmarkPlus size={15} />
              <span className="btn-label">Save as scenario</span>
            </button>
          )}
        </div>

        {convHits !== null && convQ.trim().length >= 2 && (
          <div className="card conv-search-results">
            {convHits.length === 0 ? (
              <div className="muted">No matches in this conversation.</div>
            ) : (
              convHits.map((h) => (
                <button key={h.id} className="conv-search-hit" onClick={() => jumpToHit(h.id)}>
                  <span className="conv-search-meta muted">
                    {hitWho(h)} · {fmtTime(h.created_at)}
                  </span>
                  <span className="conv-search-text">{markHit(h.text)}</span>
                </button>
              ))
            )}
          </div>
        )}

        {testSaveOpen && (
          <div className="card" style={{ marginTop: 8 }}>
            {testSaved ? (
              <>
                <label>{testSaved > 1 ? `${testSaved} scenarios saved` : 'Scenario saved'}</label>
                <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
                  {testSaved > 1
                    ? 'One per point where a human had to step in — each replays the conversation up to that prompt. '
                    : 'It replays the conversation up to the customer\u2019s last message. '}
                  Run them from the agent's Test tab after a prompt or knowledge
                  change — replays never message the customer or call your APIs.
                </div>
                <div className="row" style={{ marginTop: 4 }}>
                  <Link
                    className="btn primary sm"
                    to={`/agents/${c.agent_id}/tests`}
                  >
                    Open Test tab →
                  </Link>
                  <button
                    className="btn sm"
                    onClick={() => setTestSaved(0)}
                  >
                    Save another
                  </button>
                  <button className="btn sm" onClick={() => { setTestSaveOpen(false); setTestSaved(0); }}>
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <label>Save this conversation as a scenario</label>
                <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
                  The transcript (up to the customer's last message) is replayed against the agent's
                  current setup — no customer sees it, no action runs. Use it to prove a prompt or
                  knowledge fix works, or to catch a regression later.
                </div>
                <input
                  placeholder="Scenario name — e.g. refund request must hand off"
                  value={testName}
                  onChange={(e) => setTestName(e.target.value)}
                  style={{ width: '100%', marginBottom: 8 }}
                />
                <textarea
                  rows={2}
                  placeholder="What a good reply does now — e.g. answers from the returns policy and never offers a refund without approval"
                  value={testExpectation}
                  onChange={(e) => setTestExpectation(e.target.value)}
                  style={{ width: '100%' }}
                />
                <div className="row" style={{ marginTop: 8 }}>
                  <button
                    className="btn primary sm"
                    disabled={!testName.trim() || saveTest.isPending}
                    onClick={() => saveTest.mutate()}
                  >
                    {saveTest.isPending ? 'Saving…' : 'Save scenario'}
                  </button>
                  <button className="btn sm" onClick={() => setTestSaveOpen(false)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}

        {openAlerts.length > 0 && (
          <div className="alert-strip">
            {openAlerts.map((a) => (
              <button
                key={a.id}
                className="alert-chip"
                title={a.detail ?? alertLabel(a)}
                onClick={() => jumpToAlert(a)}
              >
                ⚠ {alertLabel(a)}
              </button>
            ))}
          </div>
        )}

        {/* Operator brief — on demand from the Summarize button. Pinned
            above the transcript so it's visible wherever the scroll sits. */}
        {briefOpen && (
          <div className="card conv-brief">
            <div className="conv-brief-head">
              <ScrollText size={13} />
              <span>Summary</span>
              <span className="grow" />
              {brief && (
                <button
                  className="conv-brief-btn"
                  title="Regenerate the summary"
                  aria-label="Regenerate the summary"
                  disabled={briefBusy}
                  onClick={() => void refreshBrief()}
                >
                  <RefreshCw size={13} />
                </button>
              )}
              <button
                className="conv-brief-btn"
                title="Close the summary"
                aria-label="Close the summary"
                onClick={() => setBriefOpen(false)}
              >
                <X size={14} />
              </button>
            </div>
            {brief ? (
              <MdBlocks text={brief} />
            ) : briefQ.isFetching ? (
              <div className="muted" style={{ fontSize: 13 }}>Summarizing…</div>
            ) : (
              <div className="muted" style={{ fontSize: 13 }}>
                {BRIEF_REASON[briefQ.data?.reason ?? 'error'] ?? BRIEF_REASON.error}
              </div>
            )}
          </div>
        )}

        <div
          className={`transcript${isPlaceholderData ? ' switching' : ''}`}
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
          {/* Switch fetch: the previous thread stays mounted (placeholder)
              while the next conversation loads — the pill floats over it. */}
          {isPlaceholderData && (
            <div className="conv-fetch" role="status">
              <span className="conv-fetch-pill">
                <span className="spin" /> Loading…
              </span>
            </div>
          )}
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
                            <Paperclip size={12} style={{ verticalAlign: '-1px', marginRight: 3 }} />{a.name}
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                  {i === lastDeliveredIdx && (
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
            if (item.kind === 'alert') {
              const a = item.a;
              const aid = `alert:${a.id}`;
              return (
                <div
                  key={aid}
                  data-mid={aid}
                  className={`msg system alert-open${highlight === aid ? ' msg-hit' : ''}`}
                >
                  <div>
                    ⚠ {alertLabel(a)}
                    {a.detail ? ` — ${a.detail}` : ''}
                    <span className="time" title={new Date(a.created_at).toLocaleString()}>
                      {' '}· {fmtTime(a.created_at)}
                    </span>
                  </div>
                  <div className="alert-open-foot">
                    <span className="alert-open-tag">needs review</span>
                    <button
                      className="btn sm"
                      aria-label={`Dismiss ${alertLabel(a)} alert`}
                      disabled={resolveAlert.isPending}
                      onClick={() => resolveAlert.mutate(a.id)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            }
            const m = item.m;
            // The customer's message this reply answers — pairs Correct
            // this and Save as scenario the same way the test chat does.
            const prevIn = items
              .slice(0, i)
              .reverse()
              .find((x) => x.kind === 'msg' && x.m.direction === 'in');
            const prevPrompt =
              prevIn?.kind === 'msg' ? (prevIn.m.text ?? undefined) : undefined;
            // The exchange leading to this reply — a scenario saved from
            // the inbox replays the setup, not just the bare ask. Internal
            // notes are operator-only, never scenario context.
            const ctxTurns: ScenarioTurn[] = items
              .slice(0, i)
              .flatMap((x): ScenarioTurn[] => {
                // Outbox entries are the operator's pending sends — the
                // agent side of the exchange, same as a human reply.
                if (x.kind === 'out' && x.o.text) return [{ role: 'agent', text: x.o.text }];
                if (x.kind !== 'msg' || !x.m.text || x.m.payload.internal === true) return [];
                if (x.m.direction === 'in') return [{ role: 'customer', text: x.m.text }];
                if (x.m.direction === 'out' || x.m.direction === 'human')
                  return [{ role: 'agent', text: x.m.text }];
                return [];
              })
              .slice(-8);
            const isInternal = m.payload.internal === true;
            const isSystem = m.flags.failure || m.flags.help_requested || m.flags.custom_alert || m.flags.handoff_offer || m.flags.handoff_cancelled || m.flags.resolved || isInternal;
            const authorUser =
              m.direction === 'human' ? users?.users.find((u) => u.id === m.author) : undefined;
            const who =
              m.direction === 'in'
                ? c.user_profile.name ?? WHO.in
                : m.direction === 'out'
                  ? agent?.name ?? WHO.out
                  : (authorUser?.name ??
                    (isInternal
                      ? // The visitor decides their own concierge cards —
                        // their user id isn't a member, so authorUser can't
                        // resolve it. Unauthored internal notes (action
                        // proposed/requested) are posted by the agent.
                        ((m.author === c.user_profile.external_id
                          ? c.user_profile.name
                          : agent?.name) ?? WHO.human)
                      : WHO.human));
            return (
            <>
            <div
              key={m.id}
              data-mid={m.id}
              className={`msg ${isSystem ? 'system' : m.direction}${msgAlert.has(m.id) ? ' alert-open' : ''}${highlight === m.id ? ' msg-hit' : ''}`}
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
                        ? ` ⚡ ${String(m.payload.event).replace(/_/g, ' ')}`
                        : ' 🔒 internal'
                    : ''}
                  <span className="time" title={new Date(m.created_at).toLocaleString()}>
                    {fmtTime(m.created_at)}
                  </span>
                </div>
              )}
              <MdBlocks text={m.text ?? ''} />
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
              {(() => {
                const act = m.payload.action as
                  | { id: string; tool: string; args: Record<string, unknown>; status: string; decided_by?: string; result?: string; reason?: string }
                  | undefined;
                if (!act) return null;
                return (
                  <div className="action-card">
                    <div className="mono" style={{ fontSize: 12 }}>
                      {act.tool}
                    </div>
                    {act.reason ? (
                      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                        {act.reason}
                      </div>
                    ) : null}
                    <ArgsRows args={act.args} />
                    {act.status === 'pending' ? (
                      // Concierge 'action proposed' cards are the visitor's
                      // decision — the API 404s anyone but the verified
                      // visitor, so operators get the read-only card.
                      m.payload.event === 'action proposed' &&
                      c.user_profile.external_id !== me?.user?.id ? (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          Waiting on {c.user_profile.name ?? 'the visitor'} — only they can
                          approve this card
                        </div>
                      ) : (
                        <div className="row" style={{ marginTop: 6 }}>
                          <button
                            className="btn primary sm"
                            disabled={decide.isPending}
                            onClick={() =>
                              decide.mutate({ actionId: act.id, decision: 'approved' })
                            }
                          >
                            Approve & run
                          </button>
                          <button
                            className="btn sm"
                            disabled={decide.isPending}
                            onClick={() =>
                              decide.mutate({ actionId: act.id, decision: 'denied' })
                            }
                          >
                            Deny
                          </button>
                        </div>
                      )
                    ) : (
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        {act.status === 'approved' ? '✅ approved' : '⛔ denied'}
                        {act.decided_by ? ` by ${act.decided_by}` : ''}
                        {act.result ? ` — ${act.result}` : ''}
                      </div>
                    )}
                  </div>
                );
              })()}
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
                      <Paperclip size={12} style={{ verticalAlign: '-1px', marginRight: 3 }} />{a.name}
                    </a>
                  )}
                </div>
              ))}
              {!!(m.payload.widgets as ChatWidget[] | undefined)?.length && (
                <div className="transcript-widgets">
                  {/* Mirror of what the customer saw — controls are inert here
                      so an operator can't accidentally send as the visitor. */}
                  <Widgets widgets={m.payload.widgets as ChatWidget[]} onSend={() => {}} />
                  <div className="muted" style={{ fontSize: 11, marginTop: 2, opacity: 0.75 }}>
                    interactive for the customer — preview only here
                  </div>
                </div>
              )}
              {/* Suggested replies the customer was shown — echoed as a muted
                  italic "quick replies:" line, not pills: pill-shaped things
                  in the transcript are console actions, these are content. */}
              {!!(m.payload.quick_replies as (string | { type: 'email' | 'phone' })[] | undefined)?.length && (
                <div className="transcript-qrs">
                  <span className="transcript-qrs-label">quick replies:</span>
                  {(m.payload.quick_replies as (string | { type: 'email' | 'phone' })[]).map((q, i) => (
                    <span key={i} className="transcript-qr">
                      {typeof q === 'string' ? q : q.type === 'email' ? 'share email' : 'share phone'}
                    </span>
                  ))}
                </div>
              )}
              {/* The test chat's verdict + correction affordances, inside the
                  reply bubble: a matched scenario gets the Aim/thumbs box;
                  otherwise the prompt can be saved as a new one. */}
              {m.direction === 'out' && !isSystem && m.text?.trim() ? (() => {
                const sc = matchScenario(prevPrompt, ctxTurns);
                return (
                  <>
                    {sc && (
                      <div className="verdict-box">
                        {sc.expectation ? (
                          <div className="verdict-expect muted" title={sc.expectation}>
                            Expected: {sc.expectation}
                          </div>
                        ) : null}
                        <div className="verdict-btns">
                          <button
                            className={`btn sm${sc.human_result === 'pass' ? ' verdict-on' : ''}`}
                            title="Looks right — this reply passes"
                            disabled={verdictTest.isPending}
                            onClick={() => verdictTest.mutate({ testId: sc.id, result: 'pass' })}
                          >
                            <ThumbsUp size={12} />
                          </button>
                          <button
                            className={`btn sm verdict-fail${sc.human_result === 'fail' ? ' verdict-on' : ''}`}
                            title="Needs work — flag this reply and open the correction dialog"
                            disabled={verdictTest.isPending}
                            onClick={() => {
                              verdictTest.mutate({ testId: sc.id, result: 'fail' });
                              setCorrectFor({
                                id: m.id,
                                agentText: m.text ?? '',
                                customerText: prevPrompt,
                                turns: ctxTurns,
                                scenario: { id: sc.id, expectation: sc.expectation ?? '' },
                              });
                            }}
                          >
                            <ThumbsDown size={12} />
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="correct-row">
                      <button
                        className="correct-this"
                        title="Tell Janis what it should have said — opens the correction dialog"
                        onClick={() =>
                          setCorrectFor({
                            id: m.id,
                            agentText: m.text ?? '',
                            customerText: prevPrompt,
                            turns: ctxTurns,
                            scenario: sc ? { id: sc.id, expectation: sc.expectation ?? '' } : undefined,
                          })
                        }
                      >
                        Correct this
                      </button>
                      {sc && (
                        <button
                          className="correct-this"
                          title="Open the scenario this reply matched"
                          onClick={() =>
                            navigate(`/agents/${c.agent_id}/tests#sc-${sc.id}`)
                          }
                        >
                          see matched scenario
                        </button>
                      )}
                      {!sc && prevPrompt && !scenarioSavedFor.has(m.id) && (
                        <button
                          className="correct-this"
                          title="Keep this exchange as a scenario — re-run it after config changes"
                          disabled={saveScenario.isPending}
                          onClick={() =>
                            saveScenario.mutate({
                              msgId: m.id,
                              agentText: m.text!,
                              customerText: prevPrompt,
                              turns: ctxTurns,
                            })
                          }
                        >
                          Save as scenario
                        </button>
                      )}
                    </div>
                  </>
                );
              })() : null}
              {(() => {
                const a = msgAlert.get(m.id);
                // The pending-action card's own Approve/Deny resolves this
                // alert — a third button would just be noise.
                if (!a || a.type === 'approval_request') return null;
                return (
                  <div className="alert-open-foot">
                    <span className="alert-open-tag">needs review</span>
                    <button
                      className="btn sm"
                      aria-label={`Dismiss ${alertLabel(a)} alert`}
                      disabled={resolveAlert.isPending}
                      onClick={() => resolveAlert.mutate(a.id)}
                    >
                      Dismiss
                    </button>
                  </div>
                );
              })()}
            </div>
            {m.direction === 'out' && !isSystem && !!m.payload.inspector && (
              <div className="inspector-wrap">
                {(() => {
                  const note = toolNote(
                    (m.payload.inspector as InspectorData).tools ?? [],
                  );
                  return note ? <div className="tool-note">{note}</div> : null;
                })()}
                <button
                  className="inspector-toggle"
                  onClick={() => {
                    const opening = inspectorFor !== m.id;
                    setInspectorFor(opening ? m.id : null);
                    if (!opening) return;
                    // Reveal the panel: bottom-anchored when it fits the
                    // viewport, top-pinned when it's taller.
                    requestAnimationFrame(() => {
                      const el = transcriptRef.current;
                      const panel = el?.querySelector<HTMLElement>('.inspector-panel');
                      if (!el || !panel) return;
                      const elRect = el.getBoundingClientRect();
                      const pRect = panel.getBoundingClientRect();
                      const pTop = pRect.top - elRect.top + el.scrollTop;
                      const pBottom = pRect.bottom - elRect.top + el.scrollTop;
                      el.scrollTo({
                        top: pRect.height <= el.clientHeight ? pBottom - el.clientHeight : pTop - 12,
                        behavior: 'smooth',
                      });
                    });
                  }}
                >
                  ✦ why this reply
                </button>
                {inspectorFor === m.id && (
                  <InspectorPanel data={m.payload.inspector} />
                )}
              </div>
            )}
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
          {operatorTyping && (
            <div className="muted" style={{ fontSize: 12, padding: '2px 8px' }}>
              ✍ {operatorTyping} is typing…
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
                setTimeout(snapToLatest, 80);
              }}
            >
              ↓ Jump to latest
            </button>
          )}
          {canSuggest && (suggestOpen || suggestions?.length > 0) && (
            <div className="card suggestion draft">
              {(suggestions?.length > 0 || draftBusy) && (
                <>
                  <div className="muted" style={{ marginBottom: 4 }}>
                    <span className="draft-tag">draft</span> Suggested (
                    {suggestions?.[0]?.source === 'agent' ? 'your agent' : 'AI'})
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <textarea
                      ref={instrRef}
                      className="draft-inst"
                      rows={1}
                      value={instrValue}
                      disabled={draftBusy}
                      onChange={(e) => setInstr(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          const g = instrValue.trim();
                          setReplacedSid(suggestions?.[0]?.id ?? null);
                          setDraftSent(false);
                          setActionResults({});
                          setLastInstruction(g || null);
                          suggest.mutate(g || undefined);
                        }
                      }}
                      placeholder="blank — drafted from conversation context"
                      title="The prompt behind this draft — edit it, then Enter or ↻ to redraft (Shift+Enter for a new line)"
                      aria-label="Draft prompt"
                    />
                    {!draftSent && (
                      <button
                        className="btn icon"
                        title="Redraft with this prompt"
                        aria-label="Redraft with this prompt"
                        disabled={draftBusy}
                        onClick={() => {
                          const g = instrValue.trim();
                          setReplacedSid(suggestions?.[0]?.id ?? null);
                          setDraftSent(false);
                          setActionResults({});
                          setLastInstruction(g || null);
                          suggest.mutate(g || undefined);
                        }}
                      >
                        <RefreshCw size={13} />
                      </button>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                    draft prompt — Enter or ↻ to redraft · Shift+Enter for a new line
                  </div>
                </>
              )}
              {suggestions?.length > 0 && !draftBusy ? (
                <div ref={draftBodyRef}>
                  {suggestions[0].notes && (
                    <div className="muted" style={{ fontStyle: 'italic', marginBottom: 6 }}>
                      {suggestions[0].notes}
                    </div>
                  )}
                  {!suggestions[0].payload?.empty_draft && !draftSent && (
                    <div className="row" style={{ gap: 4, marginBottom: 8 }}>
                      <button
                        type="button"
                        className={`btn sm${draftEditing ? '' : ' primary'}`}
                        onClick={async () => {
                          // Leaving Edit validates + applies — component JSON
                          // carrying a tool/submit block saves as a real
                          // bound component (bind details strip before send).
                          if (!draftEditing) return;
                          setEditSaving(true);
                          const edits = await applyDraftEdits(suggestions[0]);
                          setEditSaving(false);
                          if (!edits) return;
                          setDraftEdits(edits);
                          setEditErr('');
                          setDraftEditing(false);
                        }}
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        className={`btn sm${draftEditing ? ' primary' : ''}`}
                        onClick={() => {
                          const s = suggestions[0];
                          setEditText(draftEdits?.text ?? s.text);
                          setEditWidgets(
                            Object.fromEntries(
                              (s.payload?.widgets ?? []).map((w, i) => [
                                i,
                                JSON.stringify(draftEdits?.widgets?.[i] ?? w, null, 1),
                              ]),
                            ),
                          );
                          setEditErr('');
                          setDraftEditing(true);
                        }}
                      >
                        Edit
                      </button>
                    </div>
                  )}
                  {suggestions[0].payload?.empty_draft ? (
                    <div className="muted" style={{ fontStyle: 'italic' }}>
                      The agent couldn't draft a reply this time — nothing usable came
                      back. Try again.
                    </div>
                  ) : draftSent ? (
                    <div className="muted" style={{ fontStyle: 'italic' }}>
                      reply sent — the actions below still need a decision
                    </div>
                  ) : draftEditing ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <textarea
                        rows={4}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        style={{ width: '100%', resize: 'vertical' }}
                      />
                      {(suggestions[0].payload?.widgets ?? []).map((w, wi) => {
                        const ref = (
                          suggestions[0].payload as { widget_refs?: (string | null)[] }
                        )?.widget_refs?.[wi];
                        return (
                          <label
                            key={wi}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2,
                              fontSize: 11.5,
                              color: 'var(--muted)',
                            }}
                          >
                            {ref ?? `component ${wi + 1}`}
                            <textarea
                              rows={6}
                              value={editWidgets[wi] ?? ''}
                              onChange={(e) =>
                                setEditWidgets({ ...editWidgets, [wi]: e.target.value })
                              }
                              style={{
                                width: '100%',
                                resize: 'vertical',
                                fontFamily: 'monospace',
                                fontSize: 11.5,
                              }}
                            />
                          </label>
                        );
                      })}
                      {editErr && (
                        <div className="muted" style={{ fontSize: 11.5 }}>{editErr}</div>
                      )}
                      <div className="muted" style={{ fontSize: 11 }}>
                        A "tool" or "submit" block in a form's JSON saves it as a bound
                        component on this agent — stripped from what the visitor sees.
                      </div>
                    </div>
                  ) : (
                    <div>{draftEdits?.text ?? suggestions[0].text}</div>
                  )}
                  {!draftSent && !draftEditing && (suggestions[0].payload?.widgets?.length ?? 0) > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <Widgets
                        widgets={(suggestions[0].payload!.widgets as ChatWidget[]).map(
                          (w, wi) => (draftEdits?.widgets?.[wi] as ChatWidget | undefined) ?? w,
                        )}
                        onSend={() => {}}
                      />
                      {/* Wiring check — what each staged component actually
                          does, so a form that's supposed to save somewhere is
                          verifiable before Send. */}
                      {suggestions[0].payload!.widgets!.map((_w, wi) => {
                        const ref = (suggestions[0].payload as { widget_refs?: (string | null)[] })
                          ?.widget_refs?.[wi];
                        if (!ref) {
                          const lifted = agentWidgets?.widgets.find(
                            (x) => x.name === (_w as { collect?: string }).collect,
                          );
                          if (lifted?.tool?.submit?.name) {
                            return (
                              <div key={wi} className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                                {lifted.name} · saves submissions via {lifted.tool.submit.name}
                              </div>
                            );
                          }
                          return (_w as { type?: string }).type === 'form' ? (
                            <div key={wi} className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                              inline form — answers arrive as a message, nothing saves them —
                              Copilot can build it as a bound component
                            </div>
                          ) : null;
                        }
                        const saved = agentWidgets?.widgets.find(
                          (x) => x.name.toLowerCase().replace(/[\s_-]+/g, '-') === ref,
                        );
                        const line = saved?.tool?.submit?.name
                          ? `saves submissions via ${saved.tool.submit.name}`
                          : saved?.tool?.name
                            ? `bound to ${saved.tool.name} — fetches when sent`
                            : saved
                              ? 'no tool wiring — answers just arrive as a message'
                              : 'not a saved component on this agent';
                        return (
                          <div key={wi} className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                            {ref} · {line}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {!draftSent && (suggestions[0].payload?.buttons?.length ?? 0) > 0 && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                      {suggestions[0].payload!.buttons!.map((b, i) => (
                        <span key={i} className="sug-chip" title="Sends as a quick reply">
                          {typeof b === 'string' ? b : `share ${b.type}`}
                        </span>
                      ))}
                    </div>
                  )}
                  {suggestions[0].payload?.proposed_actions?.map((a, ai) => {
                    // Local runAction state wins; a.status is the persisted
                    // decision hydrated on load so a refresh keeps the card
                    // resolved instead of resetting to the buttons.
                    const decided =
                      actionResults[ai] ??
                      (a.status === 'approved'
                        ? `ran — ${actionResultLine(a.result)}`
                        : a.status === 'denied'
                          ? 'declined'
                          : a.status === 'pending'
                            ? 'awaiting teammate approval'
                            : undefined);
                    return (
                    <div key={ai} className="action-card" style={{ marginTop: 8 }}>
                      <div className="mono" style={{ fontSize: 12 }}>
                        {a.name}
                      </div>
                      {decided ? (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          {decided}
                        </div>
                      ) : editAction === ai ? (
                        <>
                          <textarea
                            className="args-edit"
                            rows={5}
                            value={actionArgsDraft}
                            onChange={(e) => setActionArgsDraft(e.target.value)}
                          />
                          <div className="row" style={{ marginTop: 6 }}>
                            <button
                              className="btn sm primary"
                              disabled={runAction.isPending}
                              onClick={() => {
                                let args: Record<string, unknown>;
                                try {
                                  args = JSON.parse(actionArgsDraft) as Record<string, unknown>;
                                } catch {
                                  setError('args must be valid JSON');
                                  return;
                                }
                                runAction.mutate(
                                  { name: a.name, args },
                                  {
                                    onSuccess: (r) => {
                                      setActionResults((p) => ({
                                        ...p,
                                        [ai]: `ran — ${actionResultLine(r.action?.result)}`,
                                      }));
                                      setEditAction(null);
                                    },
                                  },
                                );
                              }}
                            >
                              Run edited
                            </button>
                            <button className="btn sm" onClick={() => setEditAction(null)}>
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <ArgsRows args={a.args} />
                          <div className="row" style={{ marginTop: 6 }}>
                            <button
                              className="btn sm primary"
                              disabled={runAction.isPending}
                              onClick={() =>
                                runAction.mutate(
                                  { name: a.name, args: a.args },
                                  {
                                    onSuccess: (r) =>
                                      setActionResults((p) => ({
                                        ...p,
                                        [ai]: `ran — ${actionResultLine(r.action?.result)}`,
                                      })),
                                  },
                                )
                              }
                            >
                              Approve & run
                            </button>
                            <button
                              className="btn sm"
                              onClick={() => {
                                setEditAction(ai);
                                setActionArgsDraft(JSON.stringify(a.args, null, 2));
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="btn sm"
                              title="Park a real approval card so another teammate decides"
                              disabled={runAction.isPending}
                              onClick={() =>
                                runAction.mutate(
                                  { name: a.name, args: a.args, park: true },
                                  {
                                    onSuccess: () =>
                                      setActionResults((p) => ({
                                        ...p,
                                        [ai]: 'parked for team approval',
                                      })),
                                  },
                                )
                              }
                            >
                              For teammate
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    );
                  })}
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: draftBodyH.current || undefined,
                    minHeight: draftBodyH.current ? 0 : 140,
                    overflow: 'hidden',
                  }}
                >
                  <div className="muted">Drafting…</div>
                  <div className="skel" style={{ flex: 1, marginTop: 8 }} />
                </div>
              )}
              <div className="draft-foot">
              <div className="row" style={{ marginTop: 10 }}>
                {!draftSent && !draftEditing && (
                <button
                  className="btn primary"
                  disabled={
                    draftBusy ||
                    !(suggestions?.length > 0) ||
                    !!suggestions[0].payload?.empty_draft ||
                    outbox.some((o) => o.status === 'pending')
                  }
                  onClick={() => {
                    const s = suggestions[0];
                    send([], undefined, {
                      text: draftEdits?.text ?? s.text,
                      ...(s.payload?.widgets?.length
                        ? { widgets: s.payload.widgets.map((w, i) => draftEdits?.widgets?.[i] ?? w) }
                        : {}),
                      ...(s.payload?.buttons?.length ? { quick_replies: s.payload.buttons } : {}),
                    });
                    const undecided = (s.payload?.proposed_actions ?? []).some(
                      (a, i) => !actionResults[i] && !a.status,
                    );
                    if (undecided) {
                      // Actions decide in place — the suggestion stays open
                      // (still 'pending') until they're all resolved.
                      setDraftSent(true);
                    } else {
                      suggestionStatus.mutate({ sid: s.id, status: 'used' });
                      setSuggestOpen(false);
                      setDraftSent(false);
                    }
                  }}
                >
                  Send
                </button>
                )}
                {!draftSent && draftEditing && (
                <button
                  className="btn primary"
                  disabled={
                    draftBusy ||
                    !(suggestions?.length > 0) ||
                    !!suggestions[0].payload?.empty_draft ||
                    outbox.some((o) => o.status === 'pending')
                  }
                  onClick={async () => {
                    const s = suggestions[0];
                    setEditSaving(true);
                    const edits = await applyDraftEdits(s);
                    setEditSaving(false);
                    if (!edits) return;
                    send([], undefined, {
                      text: edits.text,
                      ...(s.payload?.widgets?.length
                        ? { widgets: s.payload.widgets.map((w, i) => edits.widgets[i] ?? w) }
                        : {}),
                      ...(s.payload?.buttons?.length ? { quick_replies: s.payload.buttons } : {}),
                    });
                    setDraftEdits(null);
                    setDraftEditing(false);
                    setEditErr('');
                    const undecided = (s.payload?.proposed_actions ?? []).some(
                      (a, i) => !actionResults[i] && !a.status,
                    );
                    if (undecided) {
                      setDraftSent(true);
                    } else {
                      suggestionStatus.mutate({ sid: s.id, status: 'used' });
                      setSuggestOpen(false);
                      setDraftSent(false);
                    }
                  }}
                >
                  Send edits
                </button>
                )}
                <button
                  className="btn"
                  onClick={() => { setSuggestOpen(false); setDraftSent(false); void dismissSuggestions(); }}
                >
                  Dismiss
                </button>
                {!draftSent && !selfThread && hasCopilot && (
                  <button
                    className="btn"
                    disabled={draftBusy}
                    title="Hand this draft to Copilot — it composes and stages the reply back here"
                    onClick={() => {
                      const s = suggestions?.[0];
                      const instruction = lastInstruction || s?.payload?.instruction;
                      const draftText = s?.payload?.empty_draft ? '' : (s?.text ?? '');
                      railBus.publish({
                        channelId: '',
                        label: 'Copilot',
                        seed:
                          `Help me with my reply to ${displayName(c)} on ${agent?.name ?? 'its agent'} — the conversation I have open.` +
                          (instruction ? ` What I want: ${instruction}.` : '') +
                          (draftText ? ` Current draft: "${draftText.slice(0, 600)}".` : '') +
                          ` When it's ready, put it on that conversation's draft card with stage_reply — or send it with send_reply if I say to send it.`,
                      });
                      window.dispatchEvent(new CustomEvent('janis:open-copilot'));
                      setRoutedToCopilot(true);
                    }}
                  >
                    Continue in Copilot
                  </button>
                )}
              </div>
              {!draftSent && routedToCopilot && (
                <div className="muted" style={{ marginTop: 6 }}>
                  Opened in Copilot — a staged draft will land here.
                </div>
              )}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {error && <div className="error">{error}</div>}


        {/* Footer pins to the viewport bottom on phones while the page
            scrolls above it — composer or the ops row, whichever renders. */}
        <div className="conv-foot">
        {/* Composer is always up for non-archived threads — the reply-as
            dropdown inside it covers agent/note/teach modes, and the Take
            over ⇄ Resume toggle lives next to Send. Ops row is gone. */}
        {previewComponent.isPending && (
          <div className="card suggestion draft">
            <div className="muted">Resolving component…</div>
          </div>
        )}
        {componentDraft && (
          <div className="card suggestion draft">
            <div className="muted" style={{ marginBottom: 6 }}>
              <span className="draft-tag">draft</span> Component · {componentDraft.name}
            </div>
            <Widgets widgets={[componentDraft.widget] as ChatWidget[]} onSend={() => {}} />
            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn primary"
                disabled={outbox.some((o) => o.status === 'pending')}
                onClick={() =>
                  send([], undefined, { text: '', widgets: [componentDraft.widget] })
                }
              >
                Send
              </button>
              <button className="btn" onClick={() => setComponentDraft(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        {pendingComponents && (
          <div className="pending-comp muted">
            {[
              pendingComponents.widgets?.length
                ? `${pendingComponents.widgets.length} component${pendingComponents.widgets.length === 1 ? '' : 's'}`
                : null,
              pendingComponents.quick_replies?.length
                ? `${pendingComponents.quick_replies.length} quick repl${pendingComponents.quick_replies.length === 1 ? 'y' : 'ies'}`
                : null,
            ]
              .filter(Boolean)
              .join(' + ')}{' '}
            attached — sends with your reply
            <button
              className="btn icon sm"
              aria-label="Detach components"
              onClick={() => setPendingComponents(null)}
            >
              <X size={11} />
            </button>
          </div>
        )}
        {c.state !== 'archived' ? (
          <Composer
            agentId={c.agent_id}
            value={draft}
            onChange={(v) => {
              setDraft(v);
              pingTyping();
            }}
            onSend={send}
            onSuggest={draftReply}
            suggestBusy={suggest.isPending}
            suggestActive={suggestOpen || (suggestions?.length ?? 0) > 0}
            onResume={c.state === 'human' ? () => act.mutate('resume') : undefined}
            onTakeover={
              c.state !== 'human'
                ? () => {
                    setSendAs('human');
                    act.mutate('takeover');
                  }
                : undefined
            }
            sendAs={sendAs}
            setSendAs={(m) => {
              setSendAs(m);
              // Notes/teaches have no visitor reply to suggest — an open
              // card is dismissed, not just hidden behind the mode swap.
              if (m === 'note' || m === 'teach') {
                setSuggestOpen(false);
                void dismissSuggestions();
              }
            }}
            showModeSelect={true}
            canTeach={canTeach}
            onSendComponent={(name, data) => previewComponent.mutate({ name, data })}
            sending={outbox.some((o) => o.status === 'pending')}
          />
        ) : (
          <div className="row conv-ops"><span className="muted">Archived</span></div>
        )}
        </div>
      </div>

      {/* Mobile (≤720px): the details column is a right slide-over behind
          the header's ⓘ — scrim/Esc/X close it. On desktop it's the
          static rail, exactly as before. */}
      <div className="conv-rail-grip" style={{ right: railW - 4 }} {...railGrip} />
      {sideOpen && !sideClosed && (
        <button
          className="conv-side-scrim"
          aria-label="Close details"
          onClick={() => setSideOpen(false)}
        />
      )}
      <aside
        ref={sideRef}
        className={`conv-side${sideOpen ? ' open' : ''}`}
        style={{ '--rail-w': `${railW}px` } as CSSProperties}
      >
        <div className="conv-side-head">
          <button
            className="cmh-collapse"
            aria-label="Close details"
            title="Close details"
            onClick={() => setSideOpen(false)}
          >
            <PanelRightClose size={16} />
          </button>
        </div>
        {/* DOM order: Details leads — the rail is a reference panel first
            on desktop. The phone/narrow drawer re-orders the two control
            cards to the top via CSS (triage there is claim/status first). */}
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
                <strong>Channel:</strong>{' '}
                <span className="badge active">{surfaceLabel(p)}</span>
                {p.channel_name ? ` ${p.channel_name}` : ''}
              </div>
            )}
            <div>
              <strong>Agent:</strong>{' '}
              {agent ? (
                <Link
                  to={`/agents/${c.agent_id}/channels`}
                  style={{ color: 'var(--accent)' }}
                  onClick={(e) => {
                    // carry a return path + transcript offset so the agent
                    // page can offer "← back to conversation"
                    e.preventDefault();
                    const from = `${location.pathname}${location.search}`;
                    const sp = Math.round(transcriptRef.current?.scrollTop ?? 0);
                    navigate(
                      `/agents/${c.agent_id}/channels?from=${encodeURIComponent(from)}${sp ? `&scroll=${sp}` : ''}`,
                    );
                  }}
                >
                  {agent.name} →
                </Link>
              ) : (
                '—'
              )}
            </div>
            {p.email && (
              <div>
                <strong>Email:</strong> {p.email}
              </div>
            )}
            {p.phone && (
              <div>
                <strong>Phone:</strong> {p.phone}
              </div>
            )}
            {data?.member_plan && (
              <div>
                <strong>Plan:</strong> {data.member_plan}
              </div>
            )}
            <div>
              <strong>Sentiment:</strong>{' '}
              {c.sentiment ? (
                <span
                  className={`badge ${c.sentiment}`}
                  title="Latest classified tone of the customer's messages — updates each turn"
                >
                  {c.sentiment}
                </span>
              ) : (
                '—'
              )}
            </div>
            <details style={{ marginTop: 4 }}>
              <summary>Context</summary>
              <div style={{ marginTop: 4 }}>
                <div style={{ overflowWrap: 'anywhere' }}>
                  <strong>User id:</strong> {p.id ?? c.external_id}
                </div>
                {Object.entries(p.metadata ?? {})
                  .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v) !== '')
                  .map(([k, v]) => (
                    <div key={k} style={{ overflowWrap: 'anywhere' }}>
                      <strong>{k}:</strong> {String(v)}
                    </div>
                  ))}
                {extraProfile.map(([k, v]) => (
                  <div key={k} style={{ overflowWrap: 'anywhere' }}>
                    <strong>{k}:</strong> {String(v)}
                  </div>
                ))}
                {c.human_since && (
                  <div>
                    <strong>Human since:</strong> {new Date(c.human_since).toLocaleTimeString()}
                  </div>
                )}
                {agent?.auto_resume_minutes && (
                  <div>
                    <strong>Auto-resume after:</strong> {agent.auto_resume_minutes}m
                  </div>
                )}
              </div>
            </details>
          </div>
        </div>

        <div className="card conv-side-status">
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

        <div className="card conv-side-assign">
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

        <div className="card">
          <strong>
            Intent
            {(c.intent_source ?? 'ai') === 'manual' && (
              <span className="muted" style={{ fontWeight: 400 }}> · manual</span>
            )}
          </strong>
          <select
            style={{ width: '100%', marginTop: 8 }}
            value={c.intent ?? ''}
            disabled={patch.isPending}
            onChange={(e) => patch.mutate({ intent: e.target.value || null })}
          >
            <option value="">Unclassified</option>
            {[...new Set([...(agent?.config?.intents ?? []), ...DEFAULT_INTENTS])].map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
            {c.intent &&
              ![...(agent?.config?.intents ?? []), ...DEFAULT_INTENTS].includes(c.intent) && (
                <option value={c.intent}>{c.intent}</option>
              )}
          </select>
          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            Auto-classified from the conversation and re-checked as topics drift — a
            manual choice is never overwritten.
          </div>
        </div>

        <TagEditor conversation={c} onSave={(tags) => patch.mutate({ tags })} />

        {c.contact_id && (
          <div className="card">
            <strong>Customer</strong>
            <div style={{ marginTop: 8 }}>
              <Link to={`/contacts/${c.contact_id}`} style={{ color: 'var(--accent)' }}>
                View customer record →
              </Link>
            </div>
            <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              Unified across channels — all this person's conversations live there.
            </div>
          </div>
        )}

        {canTeach && (
          <div className="card">
            <button
              className="btn danger"
              title="Permanently delete this conversation and its transcript — archive keeps it searchable"
              aria-label="Delete conversation"
              disabled={del.isPending}
              onClick={async () => {
                if (await confirm('Permanently delete this conversation and its entire transcript? This cannot be undone — archive keeps it out of the inbox but searchable.', [{ key: 'ok', label: 'Delete', danger: true }])) {
                  del.mutate();
                }
              }}
            >
              <Trash2 size={15} /><span className="btn-label">{del.isPending ? 'Deleting…' : 'Delete conversation'}</span>
            </button>
            <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              Removes the transcript for good — archiving keeps it searchable instead.
            </div>
          </div>
        )}

      </aside>

      {/* Correct-this is a decision dialog, not transcript furniture —
          same modal the test dock uses instead of an inline card. */}
      {correctFor && agent && (
        <div className="modal-backdrop" onClick={() => setCorrectFor(null)}>
          <div
            className="modal"
            style={{ width: 560, maxHeight: '78vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <CorrectThisCard
              agentId={agent.id}
              cfg={agent.config}
              target={correctFor}
              onClose={() => setCorrectFor(null)}
            />
          </div>
        </div>
      )}
    </>
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
              aria-label={`Remove tag ${t}`}
              onClick={(e) => {
                e.preventDefault();
                onSave(conversation.tags.filter((x) => x !== t));
              }}
            >
              <X size={11} style={{ verticalAlign: -1 }} />
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

// "Why did it say that?" — per-reply trace stamped by the hosted pipeline
// (model, tokens, knowledge context, tool calls) rendered under the bubble.
interface InspectorData {
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  kb?: string[];
  knowledge?: string[];
  prompt?: 'custom' | 'default';
  tools?: { name: string; gated?: boolean; outcome: string; args?: Record<string, unknown> }[];
  esc_claim_stripped?: number;
}

const TOOL_OUTCOME: Record<string, string> = {
  ran: 'ran',
  failed: 'failed',
  proposed: 'proposed — needs approval',
  simulated: 'simulated (test run)',
};

/** Inline transcript note — the same phrasing toolCallAnnotation feeds the
 *  next turn ("searched the web for "q"; used x; y failed") so console and
 *  model read the run identically. */
function toolNote(tools: NonNullable<InspectorData['tools']>): string | null {
  if (!tools.length) return null;
  const ran: string[] = [];
  const bits: string[] = [];
  for (const t of tools) {
    if (t.outcome === 'ran') {
      const q =
        typeof t.args?.q === 'string'
          ? t.args.q
          : typeof t.args?.query === 'string'
            ? t.args.query
            : '';
      ran.push(t.name === 'web_search' && q ? `searched the web for "${q}"` : `used ${t.name}`);
      continue;
    }
    if (t.outcome === 'failed') bits.push(`${t.name} failed`);
    else if (t.outcome === 'proposed') bits.push(`${t.name} needs approval`);
    else if (t.outcome === 'simulated') bits.push(`${t.name} simulated`);
    else bits.push(t.name);
  }
  return [...ran, ...bits].join('; ');
}

function InspectorPanel({ data }: { data: unknown }) {
  const d = (data ?? {}) as InspectorData;
  return (
    <div className="inspector-panel">
      <div className="inspector-title">How this reply was produced</div>
      {d.model && (
        <div className="inspector-row">
          <span className="muted">model</span>
          <span className="mono">{d.model}</span>
        </div>
      )}
      {((d.prompt_tokens ?? 0) + (d.completion_tokens ?? 0)) > 0 && (
        <div className="inspector-row">
          <span className="muted">tokens</span>
          <span>
            {d.prompt_tokens ?? 0} in · {d.completion_tokens ?? 0} out
          </span>
        </div>
      )}
      {d.prompt && (
        <div className="inspector-row">
          <span className="muted">prompt</span>
          <span>{d.prompt === 'custom' ? 'custom system prompt' : 'default'}</span>
        </div>
      )}
      <div className="inspector-row">
        <span className="muted">knowledge</span>
        <span>
          {[
            ...(d.knowledge?.length
              ? [`${d.knowledge.length} snippet${d.knowledge.length === 1 ? '' : 's'}`]
              : []),
            ...(d.kb ?? []),
          ].join(' · ') || 'none loaded'}
        </span>
      </div>
      {d.knowledge?.length ? (
        <details className="inspector-knowledge">
          <summary>retrieved snippets ({d.knowledge.length})</summary>
          {d.knowledge.map((k, i) => (
            <div key={`k${i}`} className="inspector-tool">
              <span>{k}</span>
            </div>
          ))}
        </details>
      ) : null}
      <div className="inspector-row">
        <span className="muted">tools</span>
        <span>{d.tools?.length ? `${d.tools.length} called` : 'none'}</span>
      </div>
      {d.tools?.map((t, i) => (
        <div key={i} className="inspector-tool">
          <span className="mono">{t.name}</span>
          <span className={`inspector-outcome ${t.outcome}`}>
            {TOOL_OUTCOME[t.outcome] ?? t.outcome}
          </span>
        </div>
      ))}
      {!!d.esc_claim_stripped && (
        <div className="inspector-row">
          <span className="muted">guard</span>
          <span>
            removed {d.esc_claim_stripped} unbacked human-escalation claim
            {d.esc_claim_stripped === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </div>
  );
}
