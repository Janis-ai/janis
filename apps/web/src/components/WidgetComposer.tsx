import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { api } from '../api/client';
import { Widgets, type ChatWidget } from './ChatWidgets';

interface WidgetToolBinding {
  name: string;
  args?: Record<string, string>;
  props?: Record<string, string>;
  items?: string;
  item_map?: Record<string, string>;
}

interface SavedWidget {
  id: string;
  agentId: string;
  name: string;
  spec: ChatWidget;
  states?: { name: string; spec: ChatWidget }[] | null;
  tool?: WidgetToolBinding | null;
  autoGreet: boolean;
}

/** {prop} placeholders inside a spec — the data-binding surface the agent
 *  fills via WIDGET_REF data or a bound tool's result. */
function specPropNames(v: unknown): string[] {
  const found = new Set<string>();
  const walk = (x: unknown): void => {
    if (typeof x === 'string') {
      for (const m of x.matchAll(/\{([a-z][a-z0-9_]{0,39})\}/g)) found.add(m[1]);
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return [...found].filter((p) => p !== 'state');
}

const inputStyle = { fontSize: 13 } as const;
const rowStyle = { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' as const };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11.5, color: 'var(--muted)', flex: '1 1 120px' }}>
      {label}
      {children}
    </label>
  );
}

/** Hand-built in-conversation components. A saved widget renders verbatim
 *  when the agent emits "WIDGET_REF: <name>" — deterministic content, the
 *  model only chooses the moment. "Show when the chat opens" pins it under
 *  the greeting on an empty webchat thread. */
export function SavedWidgets({ agentId, isAdmin, tools = [] }: { agentId: string; isAdmin: boolean; tools?: string[] }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['agent-widgets', agentId],
    queryFn: () => api<{ widgets: SavedWidget[] }>(`/api/agents/${agentId}/widgets`),
  });
  const [editing, setEditing] = useState<SavedWidget | 'new' | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['agent-widgets', agentId] });
  const save = useMutation({
    mutationFn: (w: {
      id?: string;
      name: string;
      spec: ChatWidget;
      states: { name: string; spec: ChatWidget }[];
      tool: WidgetToolBinding | null;
      auto_greet: boolean;
    }) =>
      w.id
        ? api(`/api/agents/${agentId}/widgets/${w.id}`, { method: 'PATCH', body: JSON.stringify(w) })
        : api(`/api/agents/${agentId}/widgets`, { method: 'POST', body: JSON.stringify(w) }),
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
  });
  const del = useMutation({
    mutationFn: (id: string) =>
      api(`/api/agents/${agentId}/widgets/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
  const toggleGreet = useMutation({
    mutationFn: (w: SavedWidget) =>
      api(`/api/agents/${agentId}/widgets/${w.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_greet: !w.autoGreet }),
      }),
    onSuccess: invalidate,
  });

  const widgets = data?.widgets ?? [];
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
      <label>
        Chat components — hand-built cards, pickers and forms the agent shows by name{' '}
        <span className="mono">WIDGET_REF: name</span>. Fixed content: the agent picks the moment,
        the component always renders exactly as built. "Show on open" pins one under the chat
        greeting.
      </label>
      {widgets.map((w) =>
        // Editing swaps the row for the composer in place — the form sits
        // where the component lives instead of jumping to the page bottom.
        editing !== 'new' && editing?.id === w.id ? (
          <Composer
            key={w.id}
            initial={w}
            tools={tools}
            saving={save.isPending}
            error={save.error instanceof Error ? save.error.message : save.isError ? 'save failed' : ''}
            onCancel={() => setEditing(null)}
            onSave={(v) => save.mutate(v)}
          />
        ) : (
          <div key={w.id} className="card" style={{ background: 'var(--panel-2)', padding: 10 }}>
            <div className="row">
              <span className="mono grow" style={{ fontSize: 13 }}>{w.name}</span>
              <span className="badge">{w.spec.type}</span>
              {w.tool && <span className="badge" title={`Bound to ${w.tool.name}`}>⚡ {w.tool.name}</span>}
              {!!w.states?.length && (
                <span className="badge" title={w.states.map((s) => s.name).join(', ')}>
                  {w.states.length} states
                </span>
              )}
              {isAdmin && (
                <>
                  <button
                    className="btn sm"
                    title={w.autoGreet ? 'Shows under the chat greeting' : 'Show under the chat greeting'}
                    style={w.autoGreet ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                    onClick={() => toggleGreet.mutate(w)}
                  >
                    on open
                  </button>
                  <button className="btn sm" onClick={() => setEditing(w)}>edit</button>
                  <button
                    className="btn sm"
                    title="Delete component"
                    onClick={() => del.mutate(w.id)}
                    aria-label={`Delete component ${w.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
            <div style={{ marginTop: 6, pointerEvents: 'none' }}>
              <Widgets widgets={[w.spec]} onSend={() => {}} />
            </div>
          </div>
        ),
      )}
      {isAdmin && editing === null && (
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing('new')}>
          <Plus size={14} /> New component
        </button>
      )}
      {editing === 'new' && (
        <Composer
          initial={null}
          tools={tools}
          saving={save.isPending}
          error={save.error instanceof Error ? save.error.message : save.isError ? 'save failed' : ''}
          onCancel={() => setEditing(null)}
          onSave={(v) => save.mutate(v)}
        />
      )}
    </div>
  );
}

const TYPES: { value: ChatWidget['type']; label: string }[] = [
  { value: 'cards', label: 'Cards — horizontal carousel' },
  { value: 'options', label: 'Options — tappable picker' },
  { value: 'form', label: 'Form — collects fields' },
  { value: 'status', label: 'Status — progress tracker' },
  { value: 'receipt', label: 'Receipt — line-item summary' },
];

function emptySpec(type: ChatWidget['type']): ChatWidget {
  switch (type) {
    case 'cards':
      return { type, items: [{ title: 'Free', subtitle: 'For trying things out', price: '$0/mo', select_label: 'Choose Free' }] };
    case 'options':
      return { type, title: 'What can I help with?', items: [{ label: 'Track my order' }, { label: 'Talk to a human' }] };
    case 'form':
      return { type, title: 'Contact us', fields: [{ name: 'email', label: 'Email', type: 'email', required: true }] };
    case 'status':
      return { type, title: 'Order #1234', steps: [{ label: 'Ordered', state: 'done' }, { label: 'Shipped', state: 'current' }, { label: 'Delivered', state: 'todo' }] };
    case 'receipt':
      return { type, title: 'Order summary', rows: [{ label: 'Widget', value: '$29.00' }], total: { label: 'Total', value: '$29.00' } };
  }
}

function Composer({
  initial,
  tools,
  saving,
  error,
  onCancel,
  onSave,
}: {
  initial: SavedWidget | null;
  tools: string[];
  saving: boolean;
  error: string;
  onCancel: () => void;
  onSave: (w: {
    id?: string;
    name: string;
    spec: ChatWidget;
    states: { name: string; spec: ChatWidget }[];
    tool: WidgetToolBinding | null;
    auto_greet: boolean;
  }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [spec, setSpec] = useState<ChatWidget>(initial?.spec ?? emptySpec('cards'));
  const [states, setStates] = useState<{ name: string; spec: ChatWidget }[]>(initial?.states ?? []);
  const [toolName, setToolName] = useState(initial?.tool?.name ?? '');
  const [toolCfg, setToolCfg] = useState(() => {
    if (!initial?.tool) return '';
    const rest = Object.fromEntries(
      Object.entries(initial.tool).filter(([k, v]) => k !== 'name' && v != null),
    );
    return Object.keys(rest).length ? JSON.stringify(rest) : '';
  });
  const [autoGreet, setAutoGreet] = useState(initial?.autoGreet ?? false);
  const [jsonErr, setJsonErr] = useState('');

  const setType = (t: ChatWidget['type']) => {
    if (t !== spec.type) setSpec(emptySpec(t));
  };
  const nameOk = /^[a-z][a-z0-9_-]{0,39}$/.test(name.trim().toLowerCase());
  const save = () => {
    let tool: WidgetToolBinding | null = null;
    if (toolName) {
      let extra: Record<string, unknown> = {};
      if (toolCfg.trim()) {
        try {
          const parsed: unknown = JSON.parse(toolCfg);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          extra = parsed as Record<string, unknown>;
        } catch {
          setJsonErr('tool mapping is not valid JSON');
          return;
        }
      }
      tool = { name: toolName, ...(extra as Omit<WidgetToolBinding, 'name'>) };
    }
    if (states.some((s) => !s.name.trim())) {
      setJsonErr('every state needs a name');
      return;
    }
    try {
      JSON.parse(JSON.stringify(spec)); // shape sanity
      setJsonErr('');
      onSave({
        id: initial?.id,
        name: name.trim().toLowerCase(),
        spec,
        states: states.map((s) => ({
          name: s.name.trim().toLowerCase().replace(/[\s_]+/g, '-'),
          spec: s.spec,
        })),
        tool,
        auto_greet: autoGreet,
      });
    } catch {
      setJsonErr('component data is not serialisable');
    }
  };

  return (
    <div className="card" style={{ background: 'var(--panel-2)', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="row">
        <strong className="grow">{initial ? `Edit ${initial.name}` : 'New component'}</strong>
        <button className="btn sm" onClick={onCancel} aria-label="Cancel"><X size={14} /></button>
      </div>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="name (the agent types WIDGET_REF: this)">
          <input
            className="input"
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="plans"
          />
        </Field>
        <Field label="type">
          <select className="input" style={inputStyle} value={spec.type} onChange={(e) => setType(e.target.value as ChatWidget['type'])}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
      </div>
      {!nameOk && name && <div className="error">lowercase letters, numbers, - and _ — starts with a letter</div>}

      <SpecEditor spec={spec} onChange={setSpec} />

      {/* Data binding — {prop} placeholders fill from ref data or a bound
          tool's result. */}
      {(() => {
        const props = specPropNames(spec);
        return (
          <div className="muted" style={{ fontSize: 11.5 }}>
            {props.length ? (
              <>
                data props: <span className="mono">{props.join(', ')}</span> — the agent fills them
                via <span className="mono">{'WIDGET_REF: ' + (name || 'name') + ' {"prop":"…"}'}</span>
                {' '}or a bound tool's result
              </>
            ) : (
              <>tip: put {'{prop}'} placeholders in fields (e.g. {'{order_id}'}) to make the component data-bound</>
            )}
          </div>
        );
      })()}

      {/* Named states — the agent picks a variant with {"state":"name"}. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="muted" style={{ fontSize: 11.5 }}>
          States — named variants the agent selects with {'{"state":"name"}'} (e.g. a
          &quot;not found&quot; state with different steps or no buttons)
        </div>
        {states.map((st, i) => (
          <div key={i} className="card" style={{ padding: 8, borderStyle: 'dashed' }}>
            <div className="row" style={{ marginBottom: 2 }}>
              <input
                className="input grow"
                style={inputStyle}
                placeholder="state name (e.g. in_transit)"
                value={st.name}
                onChange={(e) =>
                  setStates(states.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
              <button
                className="btn sm"
                onClick={() => setStates(states.filter((_, j) => j !== i))}
                aria-label={`Remove state ${i + 1}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
            <SpecEditor
              spec={st.spec}
              onChange={(s) => setStates(states.map((x, j) => (j === i ? { ...x, spec: s } : x)))}
            />
          </div>
        ))}
        <button
          className="btn sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() =>
            setStates([...states, { name: '', spec: JSON.parse(JSON.stringify(spec)) as ChatWidget }])
          }
        >
          <Plus size={12} /> Add state
        </button>
      </div>

      {/* Tool binding — the component IS a tool invocation when bound. */}
      {tools.length > 0 && (
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="bound tool — runs when the component is referenced, fills {props} from its result">
            <select
              className="input"
              style={inputStyle}
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
            >
              <option value="">none — static / prop-filled</option>
              {tools.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          {toolName && (
            <Field label='mapping JSON — {"args":{"prop":"param"},"props":{"prop":"result.path"},"items":"rows.path","item_map":{"field":"row.path"}}'>
              <textarea
                className="input"
                style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
                rows={3}
                value={toolCfg}
                onChange={(e) => setToolCfg(e.target.value)}
                placeholder='{"props":{"status":"order.status"},"items":"orders","item_map":{"title":"name","price":"total"}}'
              />
            </Field>
          )}
        </div>
      )}

      <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
        <input type="checkbox" checked={autoGreet} onChange={(e) => setAutoGreet(e.target.checked)} />
        Show when the chat opens (under the greeting)
      </label>

      <div className="muted" style={{ fontSize: 11.5 }}>Preview</div>
      <div className="card" style={{ padding: 10, maxWidth: 340, pointerEvents: 'none' }}>
        <Widgets widgets={[spec]} onSend={() => {}} />
      </div>

      {jsonErr && <div className="error">{jsonErr}</div>}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={!nameOk || saving} onClick={save}>
          {saving ? 'Saving…' : initial ? 'Save component' : 'Create component'}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function SpecEditor({ spec, onChange }: { spec: ChatWidget; onChange: (s: ChatWidget) => void }) {
  switch (spec.type) {
    case 'cards':
      return (
        <ItemsEditor
          items={spec.items}
          empty={{ title: '' }}
          addLabel="card"
          onChange={(items) => onChange({ ...spec, items })}
          render={(it, set) => (
            <>
              <Field label="title"><input className="input" style={inputStyle} value={it.title} onChange={(e) => set({ ...it, title: e.target.value })} /></Field>
              <Field label="subtitle"><input className="input" style={inputStyle} value={it.subtitle ?? ''} onChange={(e) => set({ ...it, subtitle: e.target.value || undefined })} /></Field>
              <Field label="price"><input className="input" style={inputStyle} value={it.price ?? ''} onChange={(e) => set({ ...it, price: e.target.value || undefined })} /></Field>
              <Field label="image URL"><input className="input" style={inputStyle} value={it.image ?? ''} onChange={(e) => set({ ...it, image: e.target.value || undefined })} placeholder="https://…" /></Field>
              <Field label="link URL"><input className="input" style={inputStyle} value={it.link ?? ''} onChange={(e) => set({ ...it, link: e.target.value || undefined })} placeholder="https://…" /></Field>
              <Field label="link label"><input className="input" style={inputStyle} value={it.link_label ?? ''} onChange={(e) => set({ ...it, link_label: e.target.value || undefined })} placeholder="View" /></Field>
              <Field label="select button (sends this as a message)"><input className="input" style={inputStyle} value={it.select_label ?? ''} onChange={(e) => set({ ...it, select_label: e.target.value || undefined })} placeholder="Choose Free" /></Field>
            </>
          )}
        />
      );
    case 'options':
      return (
        <>
          <Field label="heading"><input className="input" style={inputStyle} value={spec.title ?? ''} onChange={(e) => onChange({ ...spec, title: e.target.value || undefined })} /></Field>
          <ItemsEditor
            items={spec.items}
            empty={{ label: '' }}
            addLabel="option"
            onChange={(items) => onChange({ ...spec, items })}
            render={(it, set) => (
              <>
                <Field label="label (tap sends this)"><input className="input" style={inputStyle} value={it.label} onChange={(e) => set({ ...it, label: e.target.value })} /></Field>
                <Field label="description"><input className="input" style={inputStyle} value={it.description ?? ''} onChange={(e) => set({ ...it, description: e.target.value || undefined })} /></Field>
              </>
            )}
          />
        </>
      );
    case 'form':
      return (
        <>
          <div className="row" style={rowStyle}>
            <Field label="heading"><input className="input" style={inputStyle} value={spec.title ?? ''} onChange={(e) => onChange({ ...spec, title: e.target.value || undefined })} /></Field>
            <Field label="submit label"><input className="input" style={inputStyle} value={spec.submit_label ?? ''} onChange={(e) => onChange({ ...spec, submit_label: e.target.value || undefined })} placeholder="Send" /></Field>
          </div>
          <ItemsEditor
            items={spec.fields}
            empty={{ name: '', label: '', type: 'text' as const }}
            addLabel="field"
            onChange={(fields) => onChange({ ...spec, fields })}
            render={(f, set) => (
              <>
                <Field label="name"><input className="input" style={inputStyle} value={f.name} onChange={(e) => set({ ...f, name: e.target.value })} placeholder="email" /></Field>
                <Field label="label"><input className="input" style={inputStyle} value={f.label} onChange={(e) => set({ ...f, label: e.target.value })} placeholder="Email" /></Field>
                <Field label="type">
                  <select className="input" style={inputStyle} value={f.type} onChange={(e) => set({ ...f, type: e.target.value as typeof f.type })}>
                    {['text', 'email', 'tel', 'textarea', 'select'].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                {f.type === 'select' && (
                  <Field label="options (comma-separated)"><input className="input" style={inputStyle} value={(f.options ?? []).join(', ')} onChange={(e) => set({ ...f, options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
                )}
                <label className="row" style={{ gap: 4, fontSize: 12, alignSelf: 'flex-end' }}>
                  <input type="checkbox" checked={!!f.required} onChange={(e) => set({ ...f, required: e.target.checked || undefined })} /> required
                </label>
              </>
            )}
          />
        </>
      );
    case 'status':
      return (
        <>
          <Field label="heading"><input className="input" style={inputStyle} value={spec.title ?? ''} onChange={(e) => onChange({ ...spec, title: e.target.value || undefined })} /></Field>
          <ItemsEditor
            items={spec.steps}
            empty={{ label: '', state: 'todo' as const }}
            addLabel="step"
            onChange={(steps) => onChange({ ...spec, steps })}
            render={(s, set) => (
              <>
                <Field label="label"><input className="input" style={inputStyle} value={s.label} onChange={(e) => set({ ...s, label: e.target.value })} /></Field>
                <Field label="state">
                  <select className="input" style={inputStyle} value={s.state} onChange={(e) => set({ ...s, state: e.target.value as typeof s.state })}>
                    {['done', 'current', 'todo'].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                <Field label="note"><input className="input" style={inputStyle} value={s.note ?? ''} onChange={(e) => set({ ...s, note: e.target.value || undefined })} /></Field>
              </>
            )}
          />
        </>
      );
    case 'receipt':
      return (
        <>
          <Field label="heading"><input className="input" style={inputStyle} value={spec.title ?? ''} onChange={(e) => onChange({ ...spec, title: e.target.value || undefined })} /></Field>
          <ItemsEditor
            items={spec.rows}
            empty={{ label: '', value: '' }}
            addLabel="row"
            onChange={(rows) => onChange({ ...spec, rows })}
            render={(r, set) => (
              <>
                <Field label="label"><input className="input" style={inputStyle} value={r.label} onChange={(e) => set({ ...r, label: e.target.value })} /></Field>
                <Field label="value"><input className="input" style={inputStyle} value={r.value} onChange={(e) => set({ ...r, value: e.target.value })} /></Field>
              </>
            )}
          />
          <div className="row" style={rowStyle}>
            <Field label="total label"><input className="input" style={inputStyle} value={spec.total?.label ?? ''} onChange={(e) => onChange({ ...spec, total: e.target.value ? { label: e.target.value, value: spec.total?.value ?? '' } : undefined })} placeholder="Total" /></Field>
            <Field label="total value"><input className="input" style={inputStyle} value={spec.total?.value ?? ''} onChange={(e) => onChange({ ...spec, total: spec.total ? { ...spec.total, value: e.target.value } : e.target.value ? { label: 'Total', value: e.target.value } : undefined })} placeholder="$0.00" /></Field>
          </div>
        </>
      );
  }
}

/** Generic add/remove row list editor shared by the per-type editors. */
function ItemsEditor<T>({
  items,
  empty,
  addLabel,
  onChange,
  render,
}: {
  items: T[];
  // Blank template for a new row — needed when the list has been emptied
  // and there's no previous row to derive the shape from.
  empty: T;
  addLabel: string;
  onChange: (items: T[]) => void;
  render: (item: T, set: (item: T) => void) => React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it, i) => (
        <div key={i} className="card" style={{ padding: 8, borderStyle: 'dashed' }}>
          <div className="row" style={{ marginBottom: 2 }}>
            <span className="muted grow" style={{ fontSize: 11 }}>{addLabel} {i + 1}</span>
            <button className="btn sm" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${addLabel} ${i + 1}`}>
              <Trash2 size={12} />
            </button>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {render(it, (next) => onChange(items.map((x, j) => (j === i ? next : x))))}
          </div>
        </div>
      ))}
      <button
        className="btn sm"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => onChange([...items, items.length ? emptyItem(items[0]) : empty])}
      >
        <Plus size={12} /> Add {addLabel}
      </button>
    </div>
  );
}

function emptyItem<T>(proto: T | undefined): T {
  // New rows copy the previous row's keys with values blanked — keeps the
  // editor shape-driven without a per-type factory.
  if (!proto || typeof proto !== 'object') return proto as T;
  return Object.fromEntries(
    Object.entries(proto as Record<string, unknown>).map(([k, v]) => [
      k,
      // enum-ish fields can't blank — fall back to their first sensible value
      k === 'state' ? 'todo'
        : k === 'type' ? 'text'
        : Array.isArray(v) ? []
        : typeof v === 'boolean' ? undefined
        : '',
    ]),
  ) as T;
}
