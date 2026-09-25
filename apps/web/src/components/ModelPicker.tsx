import { useEffect, useRef, useState } from 'react';
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

/** Searchable model dropdown — search box on top, rows with vendor icon +
 *  display name + price hint, checkmark on the selected value, and a
 *  "Use '<typed>'" row so any model id can be entered freehand. */
export function ModelPicker({
  value,
  options,
  onChange,
  disabled,
  hint,
}: {
  value: string;
  options: ModelOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
  hint?: (id: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
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
  const selected = options.find((m) => m.id === value);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="model-picker grow" ref={wrap}>
      <button
        type="button"
        className="model-picker-btn"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {selected?.vendor && (
          <VendorMark vendor={selected.vendor} />
        )}
        <span className="model-picker-value">
          {selected ? selected.name : value || 'Choose model…'}
        </span>
        <span className="model-picker-chev">▾</span>
      </button>
      {open && (
        <div className="model-picker-pop">
          <input
            autoFocus
            placeholder="Search all models…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Enter picks the top hit, or the typed id when nothing matches
              if (e.key === 'Enter' && needle) {
                e.preventDefault();
                pick(filtered[0]?.id ?? q.trim());
              }
            }}
          />
          <div className="model-picker-list">
            {filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`model-item${m.id === value ? ' active' : ''}`}
                onClick={() => pick(m.id)}
              >
                {m.vendor && <VendorMark vendor={m.vendor} />}
                <span className="model-name">{m.name}</span>
                {hint?.(m.id) && <span className="model-hint">{hint(m.id)}</span>}
                {m.id === value && <span className="model-check">✓</span>}
              </button>
            ))}
            {needle && !filtered.some((m) => m.id === q.trim()) && (
              <button type="button" className="model-item" onClick={() => pick(q.trim())}>
                <span className="model-name">Use “{q.trim()}”</span>
              </button>
            )}
            {!filtered.length && !needle && (
              <div className="muted" style={{ padding: '10px 12px' }}>
                no models — click Refresh to fetch the endpoint's list
              </div>
            )}
          </div>
        </div>
      )}
    </div>
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
