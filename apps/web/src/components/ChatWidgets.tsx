// Console renderer for in-conversation widgets — the React mirror of the
// component renderers in apps/api/public/widget.js. Same five declarative
// shapes (cards, options, form, status, receipt), same interaction model:
// taps/submits go back through the normal message-send path so the agent
// reads them as ordinary customer turns.
import { useEffect, useRef, useState } from 'react';

export interface WidgetCardItem {
  title: string;
  subtitle?: string;
  image?: string;
  price?: string;
  link?: string;
  link_label?: string;
  select_label?: string;
}
export interface WidgetOption {
  label: string;
  description?: string;
}
export interface WidgetField {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'tel' | 'textarea' | 'select';
  options?: string[];
  required?: boolean;
}
export interface WidgetStep {
  label: string;
  state?: 'done' | 'current' | 'todo';
  note?: string;
}
export type ChatWidget =
  | { type: 'cards'; items: WidgetCardItem[] }
  | { type: 'options'; title?: string; items: WidgetOption[] }
  | { type: 'form'; title?: string; submit_label?: string; fields: WidgetField[] }
  | { type: 'status'; title?: string; steps: WidgetStep[] }
  | {
      type: 'receipt';
      title?: string;
      rows: { label: string; value: string }[];
      total?: { label: string; value: string };
    };

export function Widgets({
  widgets,
  onSend,
}: {
  widgets: ChatWidget[];
  onSend: (text: string) => void;
}) {
  return (
    <>
      {widgets.map((w, i) => (
        <Widget key={i} w={w} onSend={onSend} />
      ))}
    </>
  );
}

function Widget({ w, onSend }: { w: ChatWidget; onSend: (t: string) => void }) {
  return (
    <div className={`wgt wgt-${w.type}`}>
      {w.type === 'cards' && <Cards w={w} onSend={onSend} />}
      {w.type === 'options' && <Options w={w} onSend={onSend} />}
      {w.type === 'form' && <WForm w={w} onSend={onSend} />}
      {w.type === 'status' && <Status w={w} />}
      {w.type === 'receipt' && <Receipt w={w} />}
    </div>
  );
}

function Cards({ w, onSend }: { w: Extract<ChatWidget, { type: 'cards' }>; onSend: (t: string) => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ prev: false, next: false, over: false });
  const sync = () => {
    const row = rowRef.current;
    if (!row) return;
    const over = row.scrollWidth > row.clientWidth + 4;
    setEdges({
      over,
      prev: over && row.scrollLeft > 0,
      next: over && row.scrollLeft + row.clientWidth < row.scrollWidth - 2,
    });
  };
  useEffect(() => {
    sync();
    // The rail can mount while Ask Janis is collapsed (scrollWidth 0) or
    // resize later — observe so the arrows appear whenever the row
    // actually overflows, not just at mount.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    if (rowRef.current) ro?.observe(rowRef.current);
    // scrollWidth settles once fonts/images paint — re-check after a tick
    const t = setTimeout(sync, 300);
    return () => {
      ro?.disconnect();
      clearTimeout(t);
    };
  }, [w.items.length]);
  const step = (dir: number) => rowRef.current?.scrollBy({ left: dir * 168, behavior: 'smooth' });
  return (
    <div className="wgt-cards-wrap">
      <div className="wgt-cards" ref={rowRef} onScroll={sync}>
      {w.items.map((item, i) => (
        <div key={i} className="wgt-card">
          {item.image && <img src={item.image} alt="" loading="lazy" />}
          <div className="wgt-card-body">
            <div className="wgt-card-t">{item.title}</div>
            {item.subtitle && <div className="wgt-card-s">{item.subtitle}</div>}
            {item.price && <div className="wgt-card-p">{item.price}</div>}
          </div>
          {(item.link || item.select_label) && (
            <div className="wgt-card-btns">
              {item.link && (
                <a className="wgt-btn" href={item.link} target="_blank" rel="noopener noreferrer">
                  {item.link_label || 'View'}
                </a>
              )}
              {item.select_label && (
                <button
                  type="button"
                  className="wgt-btn wgt-btn-primary"
                  onClick={() => onSend(item.select_label!)}
                >
                  {item.select_label}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      </div>
      {edges.over && (
        <>
          <button
            type="button"
            className="wgt-scroll wgt-prev"
            aria-label="Scroll left"
            disabled={!edges.prev}
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="wgt-scroll wgt-next"
            aria-label="Scroll right"
            disabled={!edges.next}
            onClick={() => step(1)}
          >
            ›
          </button>
        </>
      )}
    </div>
  );
}

function Options({ w, onSend }: { w: Extract<ChatWidget, { type: 'options' }>; onSend: (t: string) => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <>
      {w.title && <div className="wgt-title">{w.title}</div>}
      <div className={`wgt-opts${picked !== null ? ' wgt-done' : ''}`}>
        {w.items.map((item, i) => (
          <button
            key={i}
            type="button"
            className={`wgt-opt${picked === i ? ' wgt-sel' : ''}`}
            onClick={() => {
              if (picked !== null) return;
              setPicked(i);
              onSend(item.label);
            }}
          >
            {item.label}
            {item.description && <small>{item.description}</small>}
          </button>
        ))}
      </div>
    </>
  );
}

function WForm({ w, onSend }: { w: Extract<ChatWidget, { type: 'form' }>; onSend: (t: string) => void }) {
  const [sent, setSent] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  if (sent) return <div className="wgt-sent">Sent ✓</div>;
  const submit = () => {
    const pairs: string[] = [];
    for (const f of w.fields) {
      const v = (vals[f.name] ?? '').trim();
      if (f.required && !v) return;
      if (f.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return;
      if (v) pairs.push(`${f.label}: ${v}`);
    }
    if (!pairs.length) return;
    setSent(true);
    onSend(`${w.title ? `Form "${w.title}"` : 'Form'} — ${pairs.join(' · ')}`);
  };
  return (
    <>
      {w.title && <div className="wgt-title">{w.title}</div>}
      <div className="wgt-form">
        {w.fields.map((f) => (
          <label key={f.name}>
            {f.label}
            {f.required ? ' *' : ''}
            {f.type === 'textarea' ? (
              <textarea value={vals[f.name] ?? ''} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
            ) : f.type === 'select' && f.options?.length ? (
              <select value={vals[f.name] ?? f.options[0]} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text'}
                value={vals[f.name] ?? ''}
                onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}
              />
            )}
          </label>
        ))}
        <button type="button" className="wgt-btn wgt-btn-primary" onClick={submit}>
          {w.submit_label || 'Submit'}
        </button>
      </div>
    </>
  );
}

function Status({ w }: { w: Extract<ChatWidget, { type: 'status' }> }) {
  return (
    <>
      {w.title && <div className="wgt-title">{w.title}</div>}
      <div className="wgt-steps">
        {w.steps.map((st, i) => (
          <div key={i} className={`wgt-step ${st.state ?? 'todo'}`}>
            <div className="wgt-dot" />
            <div>
              {st.label}
              {st.note && <small>{st.note}</small>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Receipt({ w }: { w: Extract<ChatWidget, { type: 'receipt' }> }) {
  return (
    <div className="wgt-receipt">
      {w.title && <div className="wgt-title">{w.title}</div>}
      {w.rows.map((r, i) => (
        <div key={i} className="wgt-row">
          <span>{r.label}</span>
          <span className="wgt-v">{r.value}</span>
        </div>
      ))}
      {w.total && (
        <div className="wgt-row wgt-total">
          <span>{w.total.label}</span>
          <span className="wgt-v">{w.total.value}</span>
        </div>
      )}
    </div>
  );
}
