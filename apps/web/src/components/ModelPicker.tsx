import { useEffect, useRef, useState } from 'react';

/** Searchable model dropdown — search box on top, pick-list rows with an
 *  optional right-side hint (price), checkmark on the selected value, and a
 *  "Use '<typed>'" row so any model id can be entered freehand. */
export function ModelPicker({
  value,
  options,
  onChange,
  disabled,
  hint,
}: {
  value: string;
  options: string[];
  onChange: (m: string) => void;
  disabled?: boolean;
  hint?: (model: string) => string | null;
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
    ? options.filter((m) => m.toLowerCase().includes(needle))
    : options;

  const pick = (m: string) => {
    onChange(m);
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
        <span className="model-picker-value">{value || 'Choose model…'}</span>
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
                pick(filtered[0] ?? q.trim());
              }
            }}
          />
          <div className="model-picker-list">
            {filtered.map((m) => (
              <button
                key={m}
                type="button"
                className={`model-item${m === value ? ' active' : ''}`}
                onClick={() => pick(m)}
              >
                <span className="model-name">{m}</span>
                {hint?.(m) && <span className="model-hint">{hint(m)}</span>}
                {m === value && <span className="model-check">✓</span>}
              </button>
            ))}
            {needle && !filtered.some((m) => m === q.trim()) && (
              <button
                type="button"
                className="model-item"
                onClick={() => pick(q.trim())}
              >
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
