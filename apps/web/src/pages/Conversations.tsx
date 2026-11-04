import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Conversation, SavedView } from '@janis/shared';
import { useConversations, useConversationsPage, useAgents, useMe, useSearch, useViews } from '../api/hooks';
import { api } from '../api/client';
import { Avatar, displayName, Empty, Md, SearchInput } from '../components/bits';
import Onboarding from '../components/Onboarding';
import DiscoveryCards from '../components/DiscoveryCards';
import { Archive, ArchiveRestore, Bot, Check, ChevronLeft, ChevronRight, Cog, Headset, ListFilter, Mail, MailOpen, Moon, Save, Star, Tag, Trash2, User, UserCheck, UserX, X } from 'lucide-react';
import { useConfirm, usePrompt } from '../components/Prompt';
import { clearLastAgent, setLastAgent, useContextAgent } from '../lib/agentContext';
import { isEditableTarget } from '../lib/keys';
import { usePageTitle } from '../lib/title';

/** Multi-select filter model — each group's values ride its own csv list
 * param (states/flags/signals); values OR inside a group, groups AND. An
 * empty selection everywhere is the default browse view (no archived).
 * Labels match the conversation detail Status dropdown (Agent = agent-driven). */
export type ConvFilters = { states: string[]; flags: string[]; signals: string[] };
export const EMPTY_FILTERS: ConvFilters = { states: [], flags: [], signals: [] };

export const FILTER_GROUPS: {
  key: keyof ConvFilters;
  label: string;
  options: [value: string, label: string][];
}[] = [
  {
    key: 'states',
    label: 'State',
    options: [
      ['needs_human', 'Needs human'],
      ['human', 'Human'],
      ['active', 'Agent'],
      ['snoozed', 'Snoozed'],
      ['archived', 'Archived'],
    ],
  },
  {
    key: 'flags',
    label: 'Flags',
    options: [
      ['unread', 'Unread'],
      ['starred', 'Starred'],
    ],
  },
  {
    key: 'signals',
    label: 'Signals',
    options: [
      ['handoff_offer', 'Handoff offered'],
      ['failure', 'Errors'],
      ['overdue', 'Overdue'],
      ['negative_sentiment', 'Negative sentiment'],
    ],
  },
];

/** Map a legacy single-select `state` value (saved view, deep link, old
 * sticky) onto the group bucket it belongs to. */
function bucketFor(value: string): keyof ConvFilters | null {
  for (const g of FILTER_GROUPS) if (g.options.some(([v]) => v === value)) return g.key;
  return null;
}

function withFilterValue(f: ConvFilters, value: string): ConvFilters {
  const key = bucketFor(value);
  if (!key || f[key].includes(value)) return f;
  return { ...f, [key]: [...f[key], value] };
}

export function filterCount(f: ConvFilters): number {
  return f.states.length + f.flags.length + f.signals.length;
}

/** Snooze presets for the bulk bar + detail page — values are minutes,
 * except 'morning'/'week' which are computed client-side. */
export const SNOOZE_OPTIONS: [label: string, minutes: number][] = [
  ['1 hour', 60],
  ['4 hours', 240],
  ['Tomorrow 9am', -1], // resolved below
  ['Next week', 10_080],
];

export function snoozeMinutes(minutes: number): number {
  if (minutes !== -1) return minutes;
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return Math.max(1, Math.round((d.getTime() - Date.now()) / 60_000));
}

/** useState persisted to localStorage — filters survive navigation.
 * `initial` may be lazy (a migration reader) — it only runs when nothing
 * is stored under `key`. */
export function useSticky<T>(key: string, initial: T | (() => T)): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      if (s !== null) return JSON.parse(s) as T;
    } catch {
      /* fall through to initial */
    }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  return [
    v,
    (next: T) => {
      setV(next);
      localStorage.setItem(key, JSON.stringify(next));
    },
  ];
}

/** Gmail-style list stamp — clock time today, "Nov 2" this year, "11/2/25" older. */
function listTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

export function ConvRow({
  c,
  agentName,
  selected,
  onToggle,
  focused,
  selMode,
  base,
  onAction,
}: {
  c: Conversation;
  agentName?: string;
  selected?: boolean;
  onToggle?: (id: string) => void;
  focused?: boolean;
  /** Multi-select active (mobile long-press grammar): taps toggle the row
   *  instead of navigating. */
  selMode?: boolean;
  /** Inbox base path — agent-scoped mounts link to /agents/:id/inbox/:conv
   *  so the sidebar keeps the agent context open on the detail page. */
  base: string;
  /** Hover-rail quick actions — same verbs as the bulk bar, single id. */
  onAction?: (c: Conversation, action: string, extra?: Record<string, unknown>) => void;
}) {
  const snoozed = c.snoozed_until && new Date(c.snoozed_until) > new Date();
  const archived = c.state === 'archived';
  // Same predicate the Needs-attention filter + badge count use:
  // human-needed/human-held states or any open alert.
  const needsAttention =
    c.open_alert_count > 0 || c.state === 'needs_human' || c.state === 'human';
  const rowRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);
  // Row actions live inside the <a> — every click must not navigate.
  const act = (action: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onAction?.(c, action);
  };
  // Long-press (mobile) flips this row into multi-select; in select mode
  // taps toggle rather than navigate — the link click is suppressed
  // either way once the press fires.
  const lp = useRef<{ t?: number; fired?: boolean }>({});
  return (
    <Link
      to={`${base}/${c.id}`}
      className={`conv-row${c.is_unread ? ' unread' : ''}${selected ? ' sel' : ''}${focused ? ' kbd-focus' : ''}`}
      ref={rowRef}
      onTouchStart={() => {
        lp.current.fired = false;
        lp.current.t = window.setTimeout(() => {
          lp.current.fired = true;
          onToggle?.(c.id);
        }, 450);
      }}
      onTouchEnd={() => window.clearTimeout(lp.current.t)}
      onTouchMove={() => window.clearTimeout(lp.current.t)}
      onTouchCancel={() => window.clearTimeout(lp.current.t)}
      onClick={(e) => {
        if (lp.current.fired) {
          e.preventDefault();
          lp.current.fired = false;
          return;
        }
        if (selMode) {
          e.preventDefault();
          onToggle?.(c.id);
        }
      }}
    >
      {onToggle && (
        <input
          type="checkbox"
          className="conv-check"
          checked={selected ?? false}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggle(c.id)}
        />
      )}
      <button
        type="button"
        className={`conv-star${c.is_starred ? ' on' : ''}`}
        title={c.is_starred ? 'Unstar' : 'Star'}
        aria-label={c.is_starred ? 'Unstar' : 'Star'}
        onClick={act('star')}
      >
        <Star size={15} fill={c.is_starred ? 'currentColor' : 'none'} />
      </button>
      {/* Fixed-width dot column — avatar doesn't shift when a row has no
          dot to show. Hidden on mobile, where the tail carries the dots. */}
      <span className="conv-dots">
        {needsAttention && (
          <span
            className="alert-dot"
            title={c.open_alert_count > 0 ? `${c.open_alert_count} open alert${c.open_alert_count === 1 ? '' : 's'}` : 'Needs attention'}
          />
        )}
      </span>
      <span className="conv-avatar-wrap">
        <Avatar c={c} size={32} />
        {/* Select-mode badge — mobile only; rows have no checkbox there. */}
        <span className="conv-sel-check" aria-hidden><Check size={16} /></span>
      </span>
      <div className="who">
        <div className="name">
          <span className="n">{displayName(c)}</span>
        </div>
        <span className="tags">
          {agentName && <span className="agent-tag">{agentName}</span>}
          {c.is_test && (
            <span className="channel-tag" title="Internal test channel — excluded from the Inbox badge">
              Test
            </span>
          )}
          {c.intent && <span className="channel-tag intent-tag" title="Classified intent">{c.intent}</span>}
          {c.tags?.map((t) => (
            <span key={t} className="channel-tag conv-tag" title="Tag">{t}</span>
          ))}
          {snoozed && (
            <span className="channel-tag" title={`Snoozed until ${new Date(c.snoozed_until!).toLocaleString()}`}>
              <Moon size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />
              {new Date(c.snoozed_until!).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
        </span>
        <div className="preview">
          {c.last_message_preview ? <Md>{c.last_message_preview}</Md> : null}
        </div>
      </div>
      <div className="tail">
        <span className="meta">{listTime(c.last_message_at)}</span>
        {/* Mobile-only marker column — dots in a fixed-width slot right of
            the stamp, its far edge lining up with the star beneath.
            Desktop carries unread by weight, attention in the left column. */}
        <span className="tail-dots">
          {needsAttention && <span className="alert-dot" title="Needs attention" />}
          {c.is_unread && <span className="unread-dot" title="Unread" />}
        </span>
        <span className="row-actions">
          <button
            type="button"
            className="row-act"
            title={archived ? 'Unarchive' : 'Archive'}
            aria-label={archived ? 'Unarchive' : 'Archive'}
            onClick={act(archived ? 'unarchive' : 'archive')}
          >
            {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          </button>
          <button
            type="button"
            className="row-act"
            title={c.is_unread ? 'Mark as read' : 'Mark as unread'}
            aria-label={c.is_unread ? 'Mark as read' : 'Mark as unread'}
            onClick={act('toggle_read')}
          >
            {c.is_unread ? <MailOpen size={15} /> : <Mail size={15} />}
          </button>
          <span className="row-act row-snz" title="Snooze" aria-label="Snooze">
            <Moon size={15} />
            <select
              value=""
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const m = Number(e.target.value);
                e.target.value = '';
                onAction?.(c, m === 0 ? 'unsnooze' : 'snooze', m === 0 ? {} : { minutes: snoozeMinutes(m) });
              }}
            >
              <option value="">Snooze…</option>
              {SNOOZE_OPTIONS.map(([l, m]) => <option key={l} value={m}>{l}</option>)}
              <option value="0">Unsnooze</option>
            </select>
          </span>
          <button
            type="button"
            className="row-act danger"
            title="Delete"
            aria-label="Delete"
            onClick={act('delete')}
          >
            <Trash2 size={15} />
          </button>
        </span>
      </div>
    </Link>
  );
}

/** Conversations: triage (needs attention) + search/browse of everything.
 *  `scopeAgent` pins the list to one agent — the /agents/:id/inbox mount —
 *  and turns the agent picker into a whole-context switcher. */
export default function Conversations({ agentId: scopeAgent }: { agentId?: string } = {}) {
  usePageTitle(scopeAgent ? 'Agent inbox' : 'Conversations');
  const [tab, setTab] = useSticky<'attention' | 'all'>('conv.tab', 'all');
  // Multi-select filter sets (states/flags/signals). The legacy conv.state
  // sticky holds a single pre-popover value — migrate it on first read.
  const [filters, setFilters] = useSticky<ConvFilters>('conv.filters', () => {
    try {
      const s = localStorage.getItem('conv.state');
      localStorage.removeItem('conv.state');
      const v = s ? (JSON.parse(s) as string) : '';
      return v ? withFilterValue(EMPTY_FILTERS, v) : EMPTY_FILTERS;
    } catch {
      return EMPTY_FILTERS;
    }
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeView, setActiveView] = useSticky('conv.view', '');
  // Deep links seed the filter (e.g. Reports' "N overdue" badge → ?state=overdue)
  const [params, setParams] = useSearchParams();
  // The agent dimension IS app context, not a local filter: on a scoped
  // route it's the URL agent; on /conversations it's the persisted context.
  const ctxAgent = useContextAgent();
  const wsId = useMe().data?.workspace?.id;
  const agentId = scopeAgent ?? ctxAgent ?? '';
  const inboxBase = agentId ? `/agents/${agentId}/inbox` : '/conversations';
  // Deep link: /conversations?agent=<id> means "inside that agent" —
  // redirect to the scoped inbox carrying the remaining params. Runs first
  // so state/intent params survive the remount instead of being stripped.
  useEffect(() => {
    const a = params.get('agent');
    if (!a) return;
    if (scopeAgent) {
      params.delete('agent');
      setParams(params, { replace: true });
      return;
    }
    const rest = new URLSearchParams(params);
    rest.delete('agent');
    if (wsId) setLastAgent(a, wsId);
    navigate(`/agents/${a}/inbox${rest.size ? `?${rest}` : ''}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const s = params.get('state');
    if (!s) return;
    setFilters(withFilterValue(filters, s));
    params.delete('state');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Reports drill-down: ?intent=&from=&to= seed a topic+window filter that
  // shows as a chip row; clearing navigates back to the bare list.
  const [drill, setDrill] = useState<{ intent: string; from: string; to: string } | null>(null);
  useEffect(() => {
    const intent = params.get('intent');
    if (!intent) return;
    setDrill({ intent, from: params.get('from') ?? '', to: params.get('to') ?? '' });
    params.delete('intent');
    params.delete('from');
    params.delete('to');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [mine, setMine] = useSticky('conv.mine', false);
  const [query, setQuery] = useSticky('conv.query', '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSnzOpen, setBulkSnzOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const filterParams = {
    states: filters.states.join(',') || undefined,
    flags: filters.flags.join(',') || undefined,
    signals: filters.signals.join(',') || undefined,
    agent_id: agentId || undefined,
    mine,
    intent: drill?.intent || undefined,
    from: drill?.from || undefined,
    to: drill?.to || undefined,
  };
  // Two list grammars: desktop pages via a cursor stack (Gmail ‹ ›),
  // mobile infinite-scrolls — a bottom sentinel keeps fetching.
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const fn = () => setIsMobile(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const [pageIdx, setPageIdx] = useState(0);
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const filterKey = `${tab}|${JSON.stringify(filterParams)}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setPageIdx(0);
    setCursorStack([undefined]);
  }
  const convFilter = { attention: tab === 'attention' || undefined, ...filterParams };
  const pageQ = useConversationsPage(convFilter, cursorStack[pageIdx], !isMobile);
  const infQ = useConversations(convFilter, isMobile);
  const data = isMobile ? undefined : pageQ.data;
  const convList = isMobile
    ? infQ.data?.pages.flatMap((p) => p.conversations)
    : pageQ.data?.conversations;
  const convsPending = isMobile ? infQ.isPending : pageQ.isPending;
  const total = (isMobile ? infQ.data?.pages[0]?.total : pageQ.data?.total) ?? 0;
  const pageStart = total === 0 ? 0 : pageIdx * 50 + 1;
  const pageEnd = pageIdx * 50 + (convList?.length ?? 0);
  // Scroll-sentinel: mobile's pager replacement — bottom hit fetches the
  // next page while more rows exist.
  const listRef = useRef<HTMLDivElement>(null);
  const sentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isMobile) return;
    const el = sentRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (es) => {
        if (es[0].isIntersecting && infQ.hasNextPage && !infQ.isFetchingNextPage) {
          void infQ.fetchNextPage();
        }
      },
      { root: listRef.current, rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [isMobile, infQ.hasNextPage, infQ.isFetchingNextPage, infQ.fetchNextPage]);
  const knownTags = [...new Set((convList ?? []).flatMap((c) => c.tags ?? []))].sort();
  const { data: agents, isPending: agentsPending } = useAgents();
  const { data: views } = useViews();
  const { data: hits, isPending: searchPending } = useSearch(query, {
    attention: tab === 'attention' || undefined,
    ...filterParams,
  });

  const searching = query.trim().length > 0;
  // The agent tag only earns its width on the all-agents view — inside a
  // scoped inbox every row carries the same one, so it hides entirely.
  const agentName = (c: Conversation) =>
    agentId ? undefined : agents?.agents.find((a) => a.id === c.agent_id)?.name;

  const applyView = (v: SavedView) => {
    const f = v.filters;
    setTab((f.tab as 'attention' | 'all') ?? 'all');
    // New-shape arrays apply directly; a legacy single `state` value folds
    // into its group bucket.
    let next: ConvFilters = {
      states: f.states ?? [],
      flags: f.flags ?? [],
      signals: f.signals ?? [],
    };
    if (f.state) next = withFilterValue(next, f.state);
    setFilters(next);
    // A view's agent dimension is context, not a filter: one that names an
    // agent moves into it, one that doesn't is workspace-wide.
    if (f.agent_id) {
      if (wsId) setLastAgent(f.agent_id, wsId);
      if (scopeAgent !== f.agent_id) navigate(`/agents/${f.agent_id}/inbox`);
    } else {
      if (wsId) clearLastAgent(wsId);
      if (scopeAgent) navigate('/conversations');
    }
    setMine(f.assignee === 'me');
    setQuery(f.query ?? '');
    setActiveView(v.id);
    setSelected(new Set());
  };

  const [promptEl, ask] = usePrompt();
  const [confirmEl, confirm] = useConfirm();
  const [tagDlg, setTagDlg] = useState<{ tag: string } | null>(null);

  const saveView = async () => {
    const name = await ask('Save current filters as a view:', 'My view');
    if (!name?.trim()) return;
    await api('/api/views', {
      method: 'POST',
      body: JSON.stringify({
        name: name.trim(),
        filters: {
          ...(tab !== 'all' ? { tab } : {}),
          ...(filters.states.length ? { states: filters.states } : {}),
          ...(filters.flags.length ? { flags: filters.flags } : {}),
          ...(filters.signals.length ? { signals: filters.signals } : {}),
          ...(agentId ? { agent_id: agentId } : {}),
          ...(mine ? { assignee: 'me' } : {}),
          ...(query.trim() ? { query: query.trim() } : {}),
        },
      }),
    });
    void qc.invalidateQueries({ queryKey: ['views'] });
  };

  const deleteView = async (id?: string) => {
    const vid = id ?? activeView;
    if (!vid) return;
    await api(`/api/views/${vid}`, { method: 'DELETE' });
    if (vid === activeView) setActiveView('');
    void qc.invalidateQueries({ queryKey: ['views'] });
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const list = searching ? hits?.conversations : convList;
  // The funnel's badge counts the assignee flag too — it lives in the
  // popover since the header went icon-only.
  const activeFilters = filterCount(filters) + (mine ? 1 : 0);
  // "Save view" only earns a slot when there's a filter set worth saving —
  // an empty view is never useful.
  const dirtyForView =
    filterCount(filters) > 0 || mine || query.trim().length > 0 || tab !== 'all';
  const visibleIds = (list ?? []).map((c) => c.id);
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  // Keyboard triage — j/k move, Enter opens, e archives, s stars, x selects.
  const navigate = useNavigate();
  const [focusIdx, setFocusIdx] = useState(-1);
  useEffect(() => setFocusIdx(-1), [tab, filters, agentId, mine, query]);
  const focused = focusIdx >= 0 ? list?.[focusIdx] : undefined;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const cur = focusIdx >= 0 ? list?.[focusIdx] : undefined;
      if (e.key === 'j') setFocusIdx((i) => Math.min(i + 1, (list?.length ?? 1) - 1));
      else if (e.key === 'k') setFocusIdx((i) => Math.max(i - 1, 0));
      else if (e.key === 'Enter' && cur) navigate(`${inboxBase}/${cur.id}`);
      else if (e.key === 'e' && cur) void actOne(cur.id, cur.state === 'archived' ? 'unarchive' : 'archive');
      else if (e.key === 's' && cur) void patchOne(cur.id, { is_starred: !cur.is_starred });
      else if (e.key === 'u' && cur) void patchOne(cur.id, { is_unread: !cur.is_unread });
      else if (e.key === 'x' && cur) toggle(cur.id);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const bulk = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!selected.size) return;
    setBusy(true);
    try {
      await api('/api/conversations/bulk', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selected], action, ...extra }),
      });
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['attention-count'] });
    } finally {
      setBusy(false);
    }
  };

  // Single-row verbs — the hover rail and the j/k/x keyboard triage share
  // these; bulk() above is only for the checked-set bar.
  const actOne = async (id: string, action: string, extra: Record<string, unknown> = {}) => {
    await api('/api/conversations/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], action, ...extra }),
    });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['attention-count'] });
  };
  const patchOne = async (id: string, fields: Record<string, unknown>) => {
    await api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
  };
  const rowAction = async (c: Conversation, action: string, extra: Record<string, unknown> = {}) => {
    if (action === 'star') return patchOne(c.id, { is_starred: !c.is_starred });
    if (action === 'toggle_read') return patchOne(c.id, { is_unread: !c.is_unread });
    if (action === 'delete') {
      const ok = await confirm(
        "Delete this conversation permanently? This can't be undone.",
        [{ key: 'delete', label: 'Delete', danger: true }],
        true,
      );
      if (ok !== 'delete') return;
    }
    return actOne(c.id, action, extra);
  };

  // Zero agents = nothing to inbox — first-run workspaces land on the
  // welcome page with the create-agent CTA instead of an empty list.
  // Pending = don't render the inbox shell only to redirect (flash).
  if (agentsPending) return <div className="login-wrap muted">Loading…</div>;
  if (agents && agents.agents.length === 0) {
    return <Navigate to="/welcome" replace />;
  }

  return (
    <>
      {promptEl}
      {confirmEl}
      {tagDlg && (
        <div className="modal-backdrop" onClick={() => setTagDlg(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Tag selected conversations"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setTagDlg(null);
            }}
          >
            <div className="modal-msg">Tag {selected.size} selected conversation{selected.size === 1 ? '' : 's'}</div>
            <input
              className="input"
              style={{ width: '100%', marginTop: 10 }}
              placeholder="Tag name…"
              value={tagDlg.tag}
              autoFocus
              onChange={(e) => setTagDlg({ tag: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tagDlg.tag.trim()) {
                  void bulk('tag', { tag: tagDlg.tag.trim() });
                  setTagDlg(null);
                }
              }}
            />
            {knownTags.length > 0 && (
              <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                {knownTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="chip"
                    style={{ cursor: 'pointer', border: 'none' }}
                    onClick={() => setTagDlg({ tag: t })}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setTagDlg(null)}>Cancel</button>
              <button
                className="btn danger"
                disabled={!tagDlg.tag.trim()}
                onClick={() => {
                  void bulk('untag', { tag: tagDlg.tag.trim() });
                  setTagDlg(null);
                }}
              >
                Remove tag
              </button>
              <button
                className="btn primary"
                disabled={!tagDlg.tag.trim()}
                onClick={() => {
                  void bulk('tag', { tag: tagDlg.tag.trim() });
                  setTagDlg(null);
                }}
              >
                Add tag
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Pinned under the mobile-bar on phones — the list scrolls beneath. */}
      <div className="inbox-head">
      {drill && (
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="chip">
            Topic: {drill.intent}
            {drill.from || drill.to ? ` · ${drill.from || '…'} → ${drill.to || '…'}` : ''}
          </span>
          <button className="btn" aria-label="Clear topic filter" onClick={() => setDrill(null)}>
            <X size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />Clear
          </button>
        </div>
      )}
      <div className="filters">
        <SearchInput
          className="search-box"
          placeholder="Search transcripts, users, ids, tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
        />
        <span className="src-menu-wrap">
          <button
            className={`btn${activeFilters ? ' primary' : ''}`}
            onClick={() => setFilterOpen((o) => !o)}
            title="Filter conversations — states, flags and signals combine (each group's boxes are 'any of')"
            aria-label="Filter conversations"
          >
            <ListFilter size={14} style={{ verticalAlign: '-2px' }} />
            <span className="btn-label">
              Filter
            </span>
            {(activeFilters + (tab === 'attention' ? 1 : 0)) > 0 && <span className="filter-badge">{activeFilters + (tab === 'attention' ? 1 : 0)}</span>}
          </button>
          {filterOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setFilterOpen(false)} />
              <div
                className="menu-pop filter-pop"
                ref={(el) => {
                  if (!el) return;
                  const r = el.getBoundingClientRect();
                  const over = r.right - (window.innerWidth - 12);
                  el.style.left = over > 0 ? `${-over}px` : '0px';
                }}
              >
                <div className="filter-group">
                  <label className="check filter-group-head">
                    <input
                      type="checkbox"
                      checked={tab === 'attention'}
                      onChange={() => setTab(tab === 'attention' ? 'all' : 'attention')}
                    />
                    Needs attention
                  </label>
                </div>
                {(views?.views.length ?? 0) > 0 && (
                  <div className="filter-group">
                    <div className="filter-group-head muted">Saved views</div>
                    {views!.views.map((v) => (
                      <div key={v.id} className="check filter-opt filter-view-row">
                        <button
                          className="filter-view-name"
                          onClick={() => {
                            applyView(v);
                            setFilterOpen(false);
                          }}
                        >
                          {v.name}
                        </button>
                        <button
                          className="filter-view-del"
                          title="Delete this view"
                          aria-label={`Delete view ${v.name}`}
                          onClick={() => deleteView(v.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {dirtyForView && (
                  <button className="filter-save-view" onClick={saveView}>
                    <Save size={13} style={{ verticalAlign: '-2px' }} /> Save current filters as a view
                  </button>
                )}
                {FILTER_GROUPS.map((g) => {
                  const sel = filters[g.key];
                  const values = g.options.map(([v]) => v);
                  const all = values.every((v) => sel.includes(v));
                  const some = values.some((v) => sel.includes(v));
                  return (
                    <div key={g.key} className="filter-group">
                      <label className="check filter-group-head">
                        <input
                          type="checkbox"
                          checked={all}
                          ref={(el) => {
                            if (el) el.indeterminate = some && !all;
                          }}
                          onChange={() =>
                            setFilters({ ...filters, [g.key]: all ? [] : values })
                          }
                        />
                        {g.label}
                      </label>
                      {g.options.map(([v, l]) => (
                        <label key={v} className="check filter-opt">
                          <input
                            type="checkbox"
                            checked={sel.includes(v)}
                            onChange={() =>
                              setFilters({
                                ...filters,
                                [g.key]: sel.includes(v)
                                  ? sel.filter((x) => x !== v)
                                  : [...sel, v],
                              })
                            }
                          />
                          {l}
                        </label>
                      ))}
                    </div>
                  );
                })}
                <div className="filter-group">
                  <label className="check filter-opt">
                    <input
                      type="checkbox"
                      checked={mine}
                      onChange={(e) => setMine(e.target.checked)}
                    />
                    Assigned to me
                  </label>
                </div>
                <div className="filter-foot">
                  <button
                    className="link small"
                    onClick={() => {
                      setFilters(EMPTY_FILTERS);
                      setMine(false);
                    }}
                  >
                    Clear all
                  </button>
                  <span className="filter-hint">Search covers archived threads automatically; this filter only scopes the browse list</span>
                </div>
              </div>
            </>
          )}
        </span>
        {/* The agent dimension is whole-app context — this picker switches
            it everywhere (nav subsection, Copilot, the other shared pages),
            and "All agents" leaves context entirely. */}
      </div>
      </div>

      {selected.size > 0 && (
        <div className="filters bulk-bar">
          <label className="check">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={() =>
                setSelected(allChecked ? new Set() : new Set(visibleIds))
              }
            />
            <strong>{selected.size} selected</strong>
          </label>
          <div className="bulk-actions">
          <button className="btn" title="Archive" aria-label="Archive" disabled={busy} onClick={() => bulk('archive')}><Archive size={14} /></button>
          <button className="btn" title="Unarchive" aria-label="Unarchive" disabled={busy} onClick={() => bulk('unarchive')}><ArchiveRestore size={14} /></button>
          <button className="btn" title="Mark read" aria-label="Mark read" disabled={busy} onClick={() => bulk('mark_read')}><MailOpen size={14} /></button>
          <button className="btn" title="Mark unread" aria-label="Mark unread" disabled={busy} onClick={() => bulk('mark_unread')}><Mail size={14} /></button>
          <button className="btn" title="Star" aria-label="Star" disabled={busy} onClick={() => bulk('star')}><Star size={14} /></button>
          <button className="btn" title="Assign to me" aria-label="Assign to me" disabled={busy} onClick={() => bulk('assign_me')}><UserCheck size={14} /></button>
          <button className="btn" title="Unassign" aria-label="Unassign" disabled={busy} onClick={() => bulk('unassign')}><UserX size={14} /></button>
          <button
            className="btn danger"
            title="Delete"
            aria-label="Delete"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm(
                `Delete ${selected.size} conversation${selected.size === 1 ? '' : 's'} permanently? This can't be undone.`,
                [{ key: 'delete', label: 'Delete', danger: true }],
                true,
              );
              if (ok === 'delete') void bulk('delete');
            }}
          >
            <Trash2 size={14} />
          </button>
          <button
            className="btn"
            disabled={busy}
            title="Tag"
            aria-label="Tag"
            onClick={() => setTagDlg({ tag: '' })}
          >
            <Tag size={14} />
          </button>
          <span className="src-menu-wrap bulk-snz-wrap">
            <button
              className="btn"
              disabled={busy}
              title="Snooze…"
              aria-label="Snooze"
              onClick={() => setBulkSnzOpen((o) => !o)}
            >
              <Moon size={14} />
            </button>
            {bulkSnzOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setBulkSnzOpen(false)} />
                <div className="menu-pop bulk-snz-pop">
                  {SNOOZE_OPTIONS.map(([l, m]) => (
                    <button
                      key={l}
                      className="menu-item"
                      onClick={() => { setBulkSnzOpen(false); void bulk('snooze', { minutes: snoozeMinutes(m) }); }}
                    >
                      {l}
                    </button>
                  ))}
                  <button
                    className="menu-item"
                    onClick={() => { setBulkSnzOpen(false); void bulk('unsnooze'); }}
                  >
                    Unsnooze
                  </button>
                </div>
              </>
            )}
          </span>
          </div>
          <button className="btn bulk-close" title="Clear selection" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
        </div>
      )}

      {/* The list is the scroll region — .main locks when .inbox-head is
          present, so only rows move. */}
      <div className={`conv-list${selected.size ? ' sel' : ''}`} ref={listRef}>
      {searching ? (
        searchPending ? (
          <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}>
            <span className="spin" />
            <span className="muted">Searching…</span>
          </div>
        ) : (
        <>
          {hits && hits.conversations.length === 0 && <Empty>No matches.</Empty>}
          {hits?.conversations.map((c, i) => (
            <ConvRow key={c.id} c={c} agentName={agentName(c)} selected={selected.has(c.id)} onToggle={toggle} focused={focusIdx === i} selMode={selected.size > 0} base={inboxBase} onAction={rowAction} />
          ))}
          {hits && hits.messages.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <strong>Message hits</strong>
              {hits.messages.slice(0, 20).map((m) => (
                <div key={m.id} className="muted" style={{ marginTop: 6 }}>
                  <Link to={`${inboxBase}/${m.conversation_id}?msg=${m.id}`}>
                    {(() => {
                      const HitIcon =
                        m.flags.help_requested || m.flags.failure || m.flags.custom_alert || m.flags.handoff_offer || m.flags.handoff_cancelled
                          ? Cog
                          : m.direction === 'in' ? User : m.direction === 'out' ? Bot : Headset;
                      return <HitIcon size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />;
                    })()}
                    {m.text}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </>
        )
      ) : convsPending ? (
        <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}>
          <span className="spin" />
          <span className="muted">Loading conversations…</span>
        </div>
      ) : (
        <>
          {data && convList!.length === 0 && (
            <Empty>
              {tab === 'attention'
                ? 'No conversations need attention. When an agent fails or asks for help, it lands here.'
                : filters.states.length === 1 && filters.states[0] === 'snoozed'
                  ? 'No snoozed conversations.'
                  : 'No conversations.'}
            </Empty>
          )}
          {/* Select-all only exists to enter bulk mode — once something is
              checked the bulk bar carries its own select-all, so this row
              yields its space. */}
          {selected.size === 0 && (convList?.length ?? 0) > 0 && (
            <div className="conv-select-all">
              <label className="check">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() =>
                    setSelected(allChecked ? new Set() : new Set(visibleIds))
                  }
                />
                Select all loaded
              </label>
              {!searching && total > 0 && (
                <div className="inbox-pager">
                  <span className="muted">{pageStart}–{Math.min(pageEnd, total)} of {total.toLocaleString()}</span>
                  <button
                    className="btn icon"
                    aria-label="Previous page"
                    title="Previous page"
                    disabled={pageIdx === 0}
                    onClick={() => setPageIdx((i) => i - 1)}
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <button
                    className="btn icon"
                    aria-label="Next page"
                    title="Next page"
                    disabled={!data?.next_cursor}
                    onClick={() => {
                      setCursorStack((s) => [...s.slice(0, pageIdx + 1), data!.next_cursor!]);
                      setPageIdx((i) => i + 1);
                    }}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              )}
            </div>
          )}
          {convList?.map((c, i) => (
            <ConvRow key={c.id} c={c} agentName={agentName(c)} selected={selected.has(c.id)} onToggle={toggle} focused={focusIdx === i} selMode={selected.size > 0} base={inboxBase} onAction={rowAction} />
          ))}
          {/* Mobile's pager is the scroll itself — this sentinel fires
              fetchNextPage when the bottom enters view. */}
          {isMobile && <div ref={sentRef} style={{ height: 1 }} />}
          {isMobile && infQ.isFetchingNextPage && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
              <span className="spin" />
            </div>
          )}
          {!isMobile && data?.next_cursor && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button
                className="btn"
                onClick={() => {
                  setCursorStack((s) => [...s.slice(0, pageIdx + 1), data.next_cursor!]);
                  setPageIdx((i) => i + 1);
                }}
              >
                Next page
              </button>
            </div>
          )}
          <div className="muted kb-hints" style={{ fontSize: 11, marginTop: 14, textAlign: 'center' }}>
            j/k move · Enter open · e archive · s star · u read/unread · x select · ⌘K palette
          </div>
        </>
      )}
      </div>
    </>
  );
}
