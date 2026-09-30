import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Conversation, SavedView } from '@janis/shared';
import { useConversations, useAgents, useSearch, useViews } from '../api/hooks';
import { api } from '../api/client';
import { Avatar, channelLabel, displayName, Empty, StateBadge, timeAgo } from '../components/bits';
import Onboarding from '../components/Onboarding';
import DiscoveryCards from '../components/DiscoveryCards';
import { Moon, Save, Star } from 'lucide-react';
import { usePrompt } from '../components/Prompt';
import { isEditableTarget } from '../lib/keys';

/** Filter options grouped by kind — values map to the `state` list param.
 * Labels match the conversation detail Status dropdown (Agent = agent-driven). */
const STATE_GROUPS: { label: string; options: [value: string, label: string][] }[] = [
  {
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
    label: 'Signals',
    options: [
      ['handoff_offer', 'Handoff offered'],
      ['failure', 'Errors'],
      ['overdue', 'Overdue'],
    ],
  },
  {
    label: 'Flags',
    options: [
      ['unread', 'Unread'],
      ['starred', 'Starred'],
    ],
  },
];

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

/** useState persisted to localStorage — filters survive navigation. */
function useSticky<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s !== null ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (next: T) => {
      setV(next);
      localStorage.setItem(key, JSON.stringify(next));
    },
  ];
}

function ConvRow({
  c,
  agentName,
  selected,
  onToggle,
  focused,
}: {
  c: Conversation;
  agentName?: string;
  selected?: boolean;
  onToggle?: (id: string) => void;
  focused?: boolean;
}) {
  const snoozed = c.snoozed_until && new Date(c.snoozed_until) > new Date();
  const rowRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);
  return (
    <Link to={`/conversations/${c.id}`} className={`conv-row${focused ? ' kbd-focus' : ''}`} ref={rowRef}>
      {onToggle && (
        <input
          type="checkbox"
          className="conv-check"
          checked={selected ?? false}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onChange={() => onToggle(c.id)}
        />
      )}
      {c.open_alert_count > 0 && <span className="alert-dot" />}
      {c.is_unread && <span className="unread-dot" title="Unread" />}
      <Avatar c={c} size={34} />
      <div className="who">
        <div className={`name ${c.is_unread ? 'unread' : ''}`}>
          {c.is_starred && <Star size={13} fill="currentColor" style={{ verticalAlign: '-1px', marginRight: 3, color: 'var(--accent)' }} />}
          {displayName(c)}
          {agentName && <span className="agent-tag">{agentName}</span>}
          {c.user_profile?.channel && (
            <span className="channel-tag">
              {channelLabel(c.user_profile.channel)}
              {/* the page/account — disambiguates same-person-different-page
                  PSID conversations that otherwise render identically */}
              {c.user_profile.channel_name && ` · ${c.user_profile.channel_name}`}
            </span>
          )}
          {c.intent && <span className="channel-tag" title="Classified intent">{c.intent}</span>}
          {snoozed && (
            <span className="channel-tag" title={`Snoozed until ${new Date(c.snoozed_until!).toLocaleString()}`}>
              <Moon size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />
              {new Date(c.snoozed_until!).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className="preview">{c.last_message_preview}</div>
      </div>
      <StateBadge state={c.state} />
      <div className="meta">{timeAgo(c.last_message_at)}</div>
    </Link>
  );
}

/** Conversations: triage (needs attention) + search/browse of everything. */
export default function Conversations() {
  const [tab, setTab] = useSticky<'attention' | 'all'>('conv.tab', 'all');
  const [state, setState] = useSticky('conv.state', '');
  const [activeView, setActiveView] = useSticky('conv.view', '');
  // Deep links seed the filter (e.g. Reports' "N overdue" badge → ?state=overdue)
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const s = params.get('state');
    if (!s) return;
    setState(s);
    params.delete('state');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [agentId, setAgentId] = useSticky('conv.agent', '');
  // Deep link: /conversations?agent=<id> seeds the sticky agent filter once,
  // then strips itself so the URL doesn't fight later filter changes.
  useEffect(() => {
    const a = params.get('agent');
    if (!a) return;
    setAgentId(a);
    params.delete('agent');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [mine, setMine] = useSticky('conv.mine', false);
  const [query, setQuery] = useSticky('conv.query', '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage } = useConversations({
    attention: tab === 'attention' || undefined,
    state: state || undefined,
    agent_id: agentId || undefined,
    mine,
  });
  const convList = data?.pages.flatMap((p) => p.conversations);
  const { data: agents } = useAgents();
  const { data: views } = useViews();
  const { data: hits } = useSearch(query, {
    attention: tab === 'attention' || undefined,
    state: state || undefined,
    agent_id: agentId || undefined,
    mine,
  });

  const searching = query.trim().length > 0;
  const agentName = (c: Conversation) =>
    agents?.agents.find((a) => a.id === c.agent_id)?.name;

  const applyView = (v: SavedView) => {
    const f = v.filters;
    setTab((f.tab as 'attention' | 'all') ?? 'all');
    setState(f.state ?? '');
    setAgentId(f.agent_id ?? '');
    setMine(f.assignee === 'me');
    setQuery(f.query ?? '');
    setActiveView(v.id);
    setSelected(new Set());
  };

  const [promptEl, ask] = usePrompt();

  const saveView = async () => {
    const name = await ask('Save current filters as a view:', 'My view');
    if (!name?.trim()) return;
    await api('/api/views', {
      method: 'POST',
      body: JSON.stringify({
        name: name.trim(),
        filters: {
          ...(tab !== 'all' ? { tab } : {}),
          ...(state ? { state } : {}),
          ...(agentId ? { agent_id: agentId } : {}),
          ...(mine ? { assignee: 'me' } : {}),
          ...(query.trim() ? { query: query.trim() } : {}),
        },
      }),
    });
    void qc.invalidateQueries({ queryKey: ['views'] });
  };

  const deleteView = async () => {
    if (!activeView) return;
    await api(`/api/views/${activeView}`, { method: 'DELETE' });
    setActiveView('');
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
  const visibleIds = (list ?? []).map((c) => c.id);
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  // Keyboard triage — j/k move, Enter opens, e archives, s stars, x selects.
  const navigate = useNavigate();
  const [focusIdx, setFocusIdx] = useState(-1);
  useEffect(() => setFocusIdx(-1), [tab, state, agentId, mine, query]);
  const focused = focusIdx >= 0 ? list?.[focusIdx] : undefined;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const cur = focusIdx >= 0 ? list?.[focusIdx] : undefined;
      const one = async (action: string, extra: Record<string, unknown> = {}) => {
        if (!cur) return;
        await api('/api/conversations/bulk', {
          method: 'POST',
          body: JSON.stringify({ ids: [cur.id], action, ...extra }),
        });
        void qc.invalidateQueries({ queryKey: ['conversations'] });
        void qc.invalidateQueries({ queryKey: ['attention-count'] });
      };
      const patch = async (fields: Record<string, unknown>) => {
        if (!cur) return;
        await api(`/api/conversations/${cur.id}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        });
        void qc.invalidateQueries({ queryKey: ['conversations'] });
      };
      if (e.key === 'j') setFocusIdx((i) => Math.min(i + 1, (list?.length ?? 1) - 1));
      else if (e.key === 'k') setFocusIdx((i) => Math.max(i - 1, 0));
      else if (e.key === 'Enter' && cur) navigate(`/conversations/${cur.id}`);
      else if (e.key === 'e' && cur) void one(cur.state === 'archived' ? 'unarchive' : 'archive');
      else if (e.key === 's' && cur) void patch({ is_starred: !cur.is_starred });
      else if (e.key === 'u' && cur) void patch({ is_unread: !cur.is_unread });
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

  return (
    <>
      {promptEl}
      <h1 className="page-title">Conversations</h1>
      <DiscoveryCards />
      <Onboarding />
      <div className="filters">
        <button
          className={`btn ${tab === 'all' ? 'primary' : ''}`}
          onClick={() => setTab('all')}
        >
          All
        </button>
        <button
          className={`btn ${tab === 'attention' ? 'primary' : ''}`}
          onClick={() => setTab('attention')}
        >
          Needs attention
        </button>
        {(views?.views.length ?? 0) > 0 && (
          <>
            <select
              value={activeView}
              onChange={(e) => {
                const v = views!.views.find((x) => x.id === e.target.value);
                if (v) applyView(v);
                else setActiveView('');
              }}
              title="Saved views"
            >
              <option value="">Views…</option>
              {views!.views.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            {activeView && (
              <button className="btn" title="Delete this view" onClick={deleteView}>✕</button>
            )}
          </>
        )}
        <button className="btn" title="Save current filters as a view" onClick={saveView}>
          <Save size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />Save view
        </button>
        <input
          className="search-box"
          placeholder="Search transcripts, users, ids…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {STATE_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">All agents</option>
          {[...(agents?.agents ?? [])]
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
            .map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Assigned to me
        </label>
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
          <button className="btn" disabled={busy} onClick={() => bulk('archive')}>Archive</button>
          <button className="btn" disabled={busy} onClick={() => bulk('unarchive')}>Unarchive</button>
          <button className="btn" disabled={busy} onClick={() => bulk('mark_read')}>Mark read</button>
          <button className="btn" disabled={busy} onClick={() => bulk('mark_unread')}>Mark unread</button>
          <button className="btn" disabled={busy} onClick={() => bulk('star')}>Star</button>
          <button className="btn" disabled={busy} onClick={() => bulk('assign_me')}>Assign to me</button>
          <button className="btn" disabled={busy} onClick={() => bulk('unassign')}>Unassign</button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              const t = await ask('Tag to add/remove (prefix with - to remove):');
              if (!t?.trim()) return;
              const remove = t.trim().startsWith('-');
              const tag = remove ? t.trim().slice(1) : t.trim();
              if (tag) void bulk(remove ? 'untag' : 'tag', { tag });
            }}
          >
            Tag…
          </button>
          <select
            className="btn"
            disabled={busy}
            value=""
            onChange={(e) => {
              const m = Number(e.target.value);
              e.target.value = '';
              if (m === 0) void bulk('unsnooze');
              else void bulk('snooze', { minutes: snoozeMinutes(m) });
            }}
          >
            <option value="">Snooze…</option>
            {SNOOZE_OPTIONS.map(([l, m]) => <option key={l} value={m}>{l}</option>)}
            <option value="0">Unsnooze</option>
          </select>
          <button className="btn" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {searching ? (
        <>
          {hits && hits.conversations.length === 0 && <Empty>No matches.</Empty>}
          {hits?.conversations.map((c, i) => (
            <ConvRow key={c.id} c={c} agentName={agentName(c)} selected={selected.has(c.id)} onToggle={toggle} focused={focusIdx === i} />
          ))}
          {hits && hits.messages.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <strong>Message hits</strong>
              {hits.messages.slice(0, 20).map((m) => (
                <div key={m.id} className="muted" style={{ marginTop: 6 }}>
                  <Link to={`/conversations/${m.conversation_id}?msg=${m.id}`}>
                    {m.flags.help_requested || m.flags.failure || m.flags.custom_alert || m.flags.handoff_offer || m.flags.handoff_cancelled
                      ? '⚙️'
                      : m.direction === 'in' ? '👤' : m.direction === 'out' ? '🤖' : '🧑'} {m.text}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {data && convList!.length === 0 && (
            <Empty>
              {tab === 'attention'
                ? 'No conversations need attention. When an agent fails or asks for help, it lands here.'
                : state === 'snoozed'
                  ? 'No snoozed conversations.'
                  : 'No conversations.'}
            </Empty>
          )}
          {(convList?.length ?? 0) > 0 && (
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
            </div>
          )}
          {convList?.map((c, i) => (
            <ConvRow key={c.id} c={c} agentName={agentName(c)} selected={selected.has(c.id)} onToggle={toggle} focused={focusIdx === i} />
          ))}
          {hasNextPage && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button
                className="btn"
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 14, textAlign: 'center' }}>
            j/k move · Enter open · e archive · s star · u read/unread · x select · ⌘K palette
          </div>
        </>
      )}
    </>
  );
}
