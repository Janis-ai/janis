import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ScenarioTest } from './ScenarioRow';
import { REVEAL_SCENARIO } from '../lib/scenarioRing';

/** The scenario suite — shared list chrome for the builder's Try-it
 *  checklist and the deployed agent's Test tab. Owns the toolbar
 *  (status filters, fold-all, sort) and the grouping; callers render
 *  each row through renderRow so each surface keeps its own actions. */

// Try-it scenario categories — safety leads so an elevated-risk agent
// can't look tested on office-hours questions alone.
export const CAT_ORDER = ['safety', 'knowledge', 'actions', 'out_of_scope', 'tone', 'general'];
export const CAT_LABELS: Record<string, string> = {
  safety: 'Safety & escalation',
  knowledge: 'Knowledge',
  actions: 'Actions',
  out_of_scope: 'Out of scope',
  tone: 'Tone & style',
  general: 'General',
};

export type FoldSignal = { seq: number; open: boolean };
export type Filter = 'all' | 'failing' | 'passing' | 'unrun';
export type Sort = 'attention' | 'newest' | 'oldest';

export type ScenarioCounts = {
  all: number;
  failing: number;
  passing: number;
  unrun: number;
};

/** Paged mode — the server holds the full suite and the list shows a
 *  growing slice. Counts/filters/sort delegate to the server so the
 *  toolbar never lies about rows that aren't loaded yet. */
export interface ScenarioListPaging {
  counts: ScenarioCounts;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onQueryChange: (q: { filter: Filter; sort: Sort }) => void;
  /** A reveal named a row beyond the loaded pages — fetch by id + mount. */
  onRevealMissing: (id: string) => void;
}

// The human verdict outranks the machine verdict — an approved row is
// 'approved' even if its last replay failed. Stale rows count in
// neither bucket: both verdicts were earned against an old config.
export const isFailing = (t: ScenarioTest) =>
  !t.stale &&
  (t.human_result === 'fail' || (t.human_result !== 'pass' && t.last_run?.passed === false));
export const isPassing = (t: ScenarioTest) =>
  !t.stale &&
  (t.human_result === 'pass' || (t.human_result !== 'fail' && t.last_run?.passed === true));

const matchesFilter = (t: ScenarioTest, f: Filter) =>
  f === 'all' ? true
  : f === 'failing' ? isFailing(t)
  : f === 'passing' ? isPassing(t)
  : !t.last_run;

const rank = (ts: ScenarioTest[]) =>
  ts.some(isFailing) ? 0 : ts.some((t) => t.stale || !t.last_run) ? 1 : 2;
const newest = (ts: ScenarioTest[]) =>
  Math.max(...ts.map((t) => Date.parse(t.created_at ?? '') || 0));
const oldest = (ts: ScenarioTest[]) =>
  Math.min(...ts.map((t) => Date.parse(t.created_at ?? '') || Number.MAX_SAFE_INTEGER));

const sortTests = (ts: ScenarioTest[], sort: Sort) =>
  [...ts].sort((a, b) =>
    sort === 'attention'
      ? rank([a]) - rank([b]) || (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0)
      : sort === 'newest'
        ? (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0)
        : (Date.parse(a.created_at ?? '') || 0) - (Date.parse(b.created_at ?? '') || 0),
  );

export function ScenarioList({
  tests,
  groupBy,
  renderRow,
  onDeleteGroup,
  deletingGroup,
  paged,
}: {
  tests: ScenarioTest[];
  /** 'category' — coverage sections (builder Try-it); 'conversation' —
   *  transcript-split groups cluster under one card (Test tab). */
  groupBy: 'category' | 'conversation';
  renderRow: (t: ScenarioTest, foldSignal: FoldSignal) => ReactNode;
  /** Conversation mode only — delete-every-row-in-this-group. */
  onDeleteGroup?: (convId: string) => void;
  deletingGroup?: boolean;
  paged?: ScenarioListPaging;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('attention');
  const [foldAll, setFoldAll] = useState<FoldSignal>({ seq: 0, open: false });
  const applyFilter = (f: Filter) => {
    setFilter(f);
    if (f !== filter) paged?.onQueryChange({ filter: f, sort });
  };
  const applySort = (s: Sort) => {
    setSort(s);
    if (s !== sort) paged?.onQueryChange({ filter, sort: s });
  };
  // "See matched scenario" deep links — a filter that would hide the
  // target row drops back to All so the reveal can find it. Paged mode:
  // loaded rows are all visible (the server filtered), so only a row
  // beyond the pages needs fetching by id.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      if (tests.some((t) => t.id === id)) {
        if (!paged) setFilter('all');
      } else paged?.onRevealMissing(id);
    };
    window.addEventListener(REVEAL_SCENARIO, onReveal);
    return () => window.removeEventListener(REVEAL_SCENARIO, onReveal);
  }, [tests, paged]);
  // Load-more sentinel — auto-appends the next page as it nears view;
  // the button stays as the no-observer fallback.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(paged?.onLoadMore);
  loadMoreRef.current = paged?.onLoadMore;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !paged?.hasMore) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((x) => x.isIntersecting)) loadMoreRef.current?.();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [paged?.hasMore]);

  const counts = paged?.counts ?? {
    all: tests.length,
    failing: tests.filter(isFailing).length,
    passing: tests.filter(isPassing).length,
    unrun: tests.filter((t) => !t.last_run).length,
  };

  const toolbar = (
    <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
      {(['all', 'failing', 'passing', 'unrun'] as const).map((f) => (
        <button
          key={f}
          className={`btn sm${filter === f ? ' filter-on' : ' ghost'}`}
          aria-pressed={filter === f}
          onClick={() => applyFilter(f)}
        >
          {f === 'unrun' ? 'Not run' : f[0].toUpperCase() + f.slice(1)} {counts[f]}
        </button>
      ))}
      <button
        className="btn ghost sm"
        onClick={() => setFoldAll((s) => ({ seq: s.seq + 1, open: true }))}
      >
        Expand all
      </button>
      <button
        className="btn ghost sm"
        onClick={() => setFoldAll((s) => ({ seq: s.seq + 1, open: false }))}
      >
        Collapse all
      </button>
      <span className="grow" />
      <label className="row" style={{ gap: 4 }}>
        <span className="muted">Sort</span>
        <select value={sort} onChange={(e) => applySort(e.target.value as Sort)}>
          <option value="attention">attention first</option>
          <option value="newest">newest</option>
          <option value="oldest">oldest</option>
        </select>
      </label>
    </div>
  );

  if (groupBy === 'category') {
    // Coverage checklist — fixed section order; filtering hides rows
    // (a section with no matching members drops entirely) and sort
    // orders within each section.
    const visible = sortTests(tests.filter((t) => matchesFilter(t, filter)), sort);
    return (
      <>
        {toolbar}
        {CAT_ORDER.filter((cat) => visible.some((s) => (s.category ?? 'general') === cat)).map(
          (cat) => (
            <div key={cat} style={{ marginTop: 16 }}>
              <div className="scenario-cat">{CAT_LABELS[cat] ?? cat}</div>
              {visible
                .filter((s) => (s.category ?? 'general') === cat)
                .map((s) => renderRow(s, foldAll))}
            </div>
          ),
        )}
        {visible.length === 0 && tests.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Nothing matches this filter.
          </div>
        )}
      </>
    );
  }

  // Conversation mode — transcript splits cluster under one collapsible
  // card (a rescue can yield a batch that would flood the list). An active
  // filter trims a group to its matching members — and hides "Delete all",
  // since it would delete rows the filter makes invisible.
  const byConv = new Map<string, ScenarioTest[]>();
  const items: { convId: string | null; ts: ScenarioTest[] }[] = [];
  for (const t of tests) {
    if (t.source_conversation_id) {
      const g = byConv.get(t.source_conversation_id) ?? [];
      g.push(t);
      byConv.set(t.source_conversation_id, g);
    } else items.push({ convId: null, ts: [t] });
  }
  for (const [convId, ts] of byConv) items.push({ convId, ts });
  // Paged mode: the server already filtered + ordered — client-side
  // re-passes would hide deliberately injected rows and lie about order
  // beyond the loaded slice.
  const visible = items
    .map((it) => ({
      ...it,
      shown: paged ? it.ts : it.ts.filter((t) => matchesFilter(t, filter)),
    }))
    .filter((it) => it.shown.length > 0);
  if (!paged)
    visible.sort((a, b) =>
      sort === 'attention'
        ? rank(a.shown) - rank(b.shown) || newest(b.ts) - newest(a.ts)
        : sort === 'newest'
          ? newest(b.ts) - newest(a.ts)
          : oldest(a.ts) - oldest(b.ts),
    );
  return (
    <>
      {toolbar}
      {visible.map(({ convId, ts, shown }) =>
        !convId || ts.length === 1 ? (
          <Fragment key={shown[0].id}>{renderRow(shown[0], foldAll)}</Fragment>
        ) : (
          <details
            key={`${convId}-${foldAll.seq}`}
            open={foldAll.open}
            className="card"
            style={{ background: 'var(--panel-2)', padding: 12 }}
          >
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              {ts[0].name.replace(/\s+#\d+$/, '')} — {ts.length} tests
              <span className="muted" style={{ fontWeight: 400 }}>
                {' '}· {ts.filter(isPassing).length} passing
                {ts.some(isFailing) && ` · ${ts.filter(isFailing).length} failing`}
                {shown.length < ts.length && ` · ${shown.length} shown`}
              </span>
            </summary>
            <div className="row" style={{ margin: '8px 0 8px 16px' }}>
              <span className="grow muted" style={{ fontSize: 12 }}>
                split from one conversation — one rescue point each
              </span>
              {onDeleteGroup && shown.length === ts.length && (
                <button
                  className="btn sm"
                  disabled={deletingGroup}
                  onClick={() => onDeleteGroup(convId)}
                >
                  {deletingGroup ? 'Deleting…' : 'Delete all'}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginLeft: 16 }}>
              {shown.map((t) => renderRow(t, foldAll))}
            </div>
          </details>
        ),
      )}
      {visible.length === 0 && tests.length > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          Nothing matches this filter.
        </div>
      )}
      {paged?.hasMore && (
        <div ref={sentinelRef} style={{ textAlign: 'center', padding: '10px 0' }}>
          {paged.loadingMore ? (
            <span className="muted" style={{ fontSize: 12 }}>Loading…</span>
          ) : (
            <button className="btn ghost sm" onClick={() => paged.onLoadMore()}>
              Load more
            </button>
          )}
        </div>
      )}
    </>
  );
}
