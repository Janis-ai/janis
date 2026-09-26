import { useEffect, useRef, useState } from 'react';
import type { LlmEffort } from '@janis/shared';
import type { ModelOption } from '../lib/llmProviders';

/** Vendor badge glyphs for the picker rows — approximations of the brand
 *  marks, colored per vendor. */
const VENDOR_ICON: Record<string, { glyph: string; color: string }> = {
  openai: { glyph: '◉', color: '#e6e9f0' },
  anthropic: { glyph: '✳', color: '#d97757' },
  google: { glyph: '✦', color: '#4b90ff' },
  xai: { glyph: 'X', color: '#e6e9f0' },
  deepseek: { glyph: '◆', color: '#4d6bfe' },
  moonshot: { glyph: 'K', color: '#a88bff' },
  zai: { glyph: 'Z', color: '#ffd34d' },
  nvidia: { glyph: 'N', color: '#76b900' },
  mistral: { glyph: 'M', color: '#ff7000' },
  meta: { glyph: '∞', color: '#66a0ff' },
};

const VENDOR_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  zai: 'Z.ai',
  nvidia: 'NVIDIA',
  mistral: 'Mistral',
  meta: 'Meta',
};

type SortKey = 'provider' | 'cost-asc' | 'cost-desc' | 'name';

const usd = (n: number) => n.toFixed(2).replace(/\.?0+$/, '');
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const ctxFmt = (n: number) =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;
/** Blended per-1M cost used for meters + cost sorts — chat traffic is
 *  mostly input (system prompt + transcript), roughly 3:1. */
const cost = (o: ModelOption) =>
  o.price ? o.price.input * 0.75 + o.price.output * 0.25 : null;

/** Searchable model dropdown — search + order-by on top, rows with vendor
 *  icon, display name and a cost meter. Hovering (or tapping ⓘ) opens a
 *  detail panel with context size, reasoning-effort selection and an
 *  input/cached/output price breakdown; a "Use '<typed>'" row keeps
 *  freehand ids usable. On narrow screens the panel is a bottom sheet and
 *  the detail view slides over the list. */
export function ModelPicker({
  value,
  options,
  onChange,
  disabled,
  effort,
  onEffort,
  rateScale = 1,
  locked,
  unlockIds,
}: {
  value: string;
  options: ModelOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Saved reasoning effort (config.llm.effort). */
  effort?: string;
  /** Called when an effort level is chosen in a model's detail panel —
   *  selects that model and stores the effort. */
  onEffort?: (id: string, effort?: LlmEffort) => void;
  /** Display multiplier for prices — hosted mode passes 1+margin so the
   *  breakdown shows what the customer is actually billed. */
  rateScale?: number;
  /** Free-plan gate: rows render grayed with a lock and can't be selected —
   *  except ids in unlockIds (the Janis default stays reachable). */
  locked?: boolean;
  unlockIds?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>(
    () => (localStorage.getItem('janis.modelSort') as SortKey) || 'provider',
  );
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? options.filter(
        (m) =>
          m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle),
      )
    : options;
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'cost-asc') return (cost(a) ?? Infinity) - (cost(b) ?? Infinity);
    if (sort === 'cost-desc') return (cost(b) ?? -Infinity) - (cost(a) ?? -Infinity);
    if (sort === 'name') return a.name.localeCompare(b.name);
    return 0; // provider — catalog order, already vendor-grouped
  });

  // Cost meter positions: log scale across the priced options so $0.1 and
  // $50 models land at the ends.
  const scores = options.map(cost).filter((c): c is number => c != null);
  const lo = scores.length ? Math.log(Math.min(...scores)) : 0;
  const hi = scores.length ? Math.log(Math.max(...scores)) : 0;
  const meterPos = (o: ModelOption) => {
    const s = cost(o);
    return s == null ? null : hi === lo ? 0.5 : (Math.log(s) - lo) / (hi - lo);
  };

  const selected = options.find((m) => m.id === value);
  const detail = options.find((m) => m.id === (pinnedId ?? hoverId)) ?? selected;

  // Locked plan: only the current value and explicitly unlocked ids pick.
  const canPick = (id: string) =>
    !locked || id === value || (unlockIds ?? []).includes(id);

  const pick = (id: string) => {
    if (!canPick(id)) return;
    onChange(id);
    setOpen(false);
    setQ('');
  };
  const openPop = () => {
    setOpen((o) => !o);
    setHoverId(null);
    setPinnedId(null);
  };

  const selEffort =
    effort && selected?.efforts?.includes(effort as LlmEffort) ? effort : undefined;

  return (
    <div className="model-picker grow" ref={wrap}>
      <button
        type="button"
        className="model-picker-btn"
        disabled={disabled}
        onClick={openPop}
      >
        {selected?.vendor && <VendorMark vendor={selected.vendor} />}
        <span className="model-picker-value">
          {selected ? selected.name : value || 'Choose model…'}
          {selEffort ? ` · ${cap(selEffort)}` : ''}
        </span>
        <span className="model-picker-chev">▾</span>
      </button>
      {open && (
        <div className="model-picker-pop">
          <div className="model-picker-top">
            <input
              autoFocus
              placeholder="Search all models…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // Enter picks the top hit, or the typed id when nothing matches
                if (e.key === 'Enter' && needle) {
                  e.preventDefault();
                  pick(sorted[0]?.id ?? q.trim());
                }
              }}
            />
            <select
              className="model-sort"
              aria-label="Order by"
              title="Order by"
              value={sort}
              onChange={(e) => {
                const v = e.target.value as SortKey;
                setSort(v);
                localStorage.setItem('janis.modelSort', v);
              }}
            >
              <option value="provider">Provider</option>
              <option value="cost-asc">Cost ↑</option>
              <option value="cost-desc">Cost ↓</option>
              <option value="name">Name</option>
            </select>
          </div>
          <div className="model-picker-body">
            <div className="model-picker-list">
              {locked && (
                <div className="model-lock-note">
                  🔒 Hosted models are fixed on the Free plan — upgrade to choose
                  a different LLM.
                </div>
              )}
              {sorted.map((m) => {
              const pos = meterPos(m);
              const open = canPick(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`model-item${m.id === value ? ' active' : ''}${open ? '' : ' locked'}`}
                  onMouseEnter={() => setHoverId(m.id)}
                  onClick={() => pick(m.id)}
                  title={open ? undefined : 'Upgrade your Janis plan to use this model'}
                >
                  {m.vendor && <VendorMark vendor={m.vendor} />}
                  <span className="model-name">{m.name}</span>
                  {m.id === value && <span className="model-check">✓</span>}
                  {pos != null && <CostMeter pos={pos} />}
                  {!open && <span className="model-lock">🔒</span>}
                  <span
                    role="button"
                    className="model-info"
                    title="Details"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPinnedId((p) => (p === m.id ? null : m.id));
                    }}
                  >
                    ⓘ
                  </span>
                </button>
              );
            })}
            {needle && !sorted.some((m) => m.id === q.trim()) && (!locked || canPick(q.trim())) && (
              <button type="button" className="model-item" onClick={() => pick(q.trim())}>
                <span className="model-name">Use “{q.trim()}”</span>
              </button>
            )}
            {!sorted.length && !needle && (
              <div className="muted" style={{ padding: '10px 12px' }}>
                no models — click Refresh to fetch the endpoint's list
              </div>
            )}
            </div>
            {detail && (
              <DetailPanel
                m={detail}
                rateScale={rateScale}
                meterPos={meterPos(detail)}
                effort={detail.id === value ? effort : undefined}
                onEffort={onEffort}
                effortDisabled={!canPick(detail.id)}
                pinned={Boolean(pinnedId)}
                onClose={() => setPinnedId(null)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The Devin-style side panel: context size, reasoning-effort select and
 *  the input/cached/output price breakdown under a cost meter. */
function DetailPanel({
  m,
  rateScale,
  meterPos,
  effort,
  onEffort,
  effortDisabled,
  pinned,
  onClose,
}: {
  m: ModelOption;
  rateScale: number;
  meterPos: number | null;
  effort?: string;
  onEffort?: (id: string, effort?: LlmEffort) => void;
  /** Locked-plan rows can't be selected, so their effort select is inert. */
  effortDisabled?: boolean;
  pinned: boolean;
  onClose: () => void;
}) {
  const canEffort = Boolean(m.efforts?.length);
  const effortValue = effort && m.efforts?.includes(effort as LlmEffort) ? effort : '';
  return (
    <div className={`model-detail${pinned ? ' pinned' : ''}`}>
      <button type="button" className="model-detail-back" onClick={onClose}>
        ← models
      </button>
      <div className="model-detail-name">
        {m.vendor && <VendorMark vendor={m.vendor} />}
        {m.name}
      </div>
      <div className="muted model-detail-sub">
        {[m.vendor ? VENDOR_LABEL[m.vendor] ?? m.vendor : null, m.ctx ? `${ctxFmt(m.ctx)} context` : null]
          .filter(Boolean)
          .join(' · ')}
      </div>
      {canEffort && (
        <div className="model-detail-row">
          <span>Reasoning effort</span>
          <select
            value={effortValue}
            disabled={effortDisabled}
            onChange={(e) =>
              onEffort?.(m.id, (e.target.value || undefined) as LlmEffort | undefined)
            }
          >
            <option value="">Default</option>
            {m.efforts!.map((l) => (
              <option key={l} value={l}>
                {cap(l)}
              </option>
            ))}
          </select>
        </div>
      )}
      {m.price && (
        <>
          <div className="muted model-detail-note">
            Cost{canEffort ? ' — higher effort consumes more tokens' : ''}
          </div>
          {meterPos != null && <CostMeter pos={meterPos} big />}
          <div className="model-detail-prices">
            <span>
              Input
              <b>${usd(m.price.input * rateScale)}</b> / 1M
            </span>
            {m.price.cached != null && (
              <span>
                Cached input
                <b>${usd(m.price.cached * rateScale)}</b> / 1M
              </span>
            )}
            <span>
              Output
              <b>${usd(m.price.output * rateScale)}</b> / 1M
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Gradient cost meter with a position dot — Devin-style. */
function CostMeter({ pos, big }: { pos: number; big?: boolean }) {
  return (
    <span className={`cost-meter${big ? ' big' : ''}`}>
      <span
        className="cost-meter-dot"
        style={{ left: `${Math.min(96, Math.max(4, pos * 100))}%` }}
      />
    </span>
  );
}

function VendorMark({ vendor }: { vendor: string }) {
  const v = VENDOR_ICON[vendor];
  if (!v) return null;
  return (
    <span className="model-vendor" style={{ color: v.color }}>
      {v.glyph}
    </span>
  );
}
