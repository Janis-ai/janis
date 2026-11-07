import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api/client';
import { Widgets, type ChatWidget } from './ChatWidgets';

interface WidgetToolBinding {
  name?: string;
  args?: Record<string, string>;
  props?: Record<string, string>;
  items?: string;
  item_map?: Record<string, string>;
  submit?: { name: string; args?: Record<string, string> };
}

/** The subset of a ToolDef the composer needs — name + declared params for
 *  the args hint. */
export interface WidgetTool {
  name: string;
  params?: Record<string, string>;
  method?: string;
  approval?: boolean;
}

interface TestResult {
  widget?: ChatWidget;
  tool_args?: Record<string, unknown>;
  tool_result?: string;
  error?: string;
}

interface SavedWidget {
  id: string;
  agentId: string;
  name: string;
  description?: string | null;
  spec: ChatWidget;
  states?: { name: string; spec: ChatWidget }[] | null;
  tool?: WidgetToolBinding | null;
  autoGreet: boolean;
}

/** {prop} placeholders inside a spec — the data-binding surface the agent
 *  fills via WIDGET_REF data or a bound tool's result. */
export function specPropNames(v: unknown): string[] {
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

/** Comma-separated options editor — keeps the raw text so the comma
 *  you're typing survives (binding value to the parsed array ate every
 *  comma before it rendered). Parses into the spec on each change. */
export function OptionsInput({
  className,
  style,
  value,
  onChange,
  placeholder,
}: {
  className?: string;
  style?: CSSProperties;
  value: string[] | undefined;
  onChange: (opts: string[]) => void;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState((value ?? []).join(', '));
  return (
    <input
      className={className}
      style={style}
      placeholder={placeholder}
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(
          e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}
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
export function SavedWidgets({ agentId, isAdmin, tools = [] }: { agentId: string; isAdmin: boolean; tools?: WidgetTool[] }) {
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
      description?: string;
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
            agentId={agentId}
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
              {w.description && (
                <span className="muted" style={{ fontSize: 11.5 }} title={w.description}>
                  {w.description}
                </span>
              )}
              <span className="badge">{w.spec.type}</span>
              {(w.tool?.name ?? w.tool?.submit?.name) && (
                <span
                  className="badge"
                  title={w.tool?.name ? `Bound to ${w.tool.name}` : `Submit saves via ${w.tool?.submit?.name}`}
                >
                  ⚡ {w.tool?.name ?? w.tool?.submit?.name}
                </span>
              )}
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
          agentId={agentId}
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
  { value: 'pricing', label: 'Pricing — plan cards with monthly/annual' },
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
    case 'pricing':
      return {
        type,
        items: [
          { name: 'Starter', price: '$29/mo', price_alt: '$290/yr — pay 10, get 12', blurb: 'For growing teams', features: ['2,000 messages/mo'], select_label: 'Tell me about Starter' },
          { name: 'Pro', price: '$99/mo', price_alt: '$990/yr — pay 10, get 12', highlight: true, features: ['20,000 messages/mo'], select_label: 'Tell me about Pro' },
        ],
      };
    // Not in TYPES — the agent emits cart widgets; it isn't authored here.
    case 'cart':
      return { type, title: 'Your cart' };
  }
}

/** Which spec array the bound tool's result rows fill — the composer tells
 *  the builder where item_map lands instead of leaving them to guess. */
const LIST_FIELD_LABEL: Record<string, string> = {
  cards: 'items',
  options: 'items',
  pricing: 'items',
  status: 'steps',
  receipt: 'rows',
};

function mappingExample(type: string): string {
  switch (type) {
    case 'status':
      return '{"items":"events","item_map":{"label":"name","state":"{status:stepstate}","note":"eta"}}';
    case 'receipt':
      return '{"items":"lines","item_map":{"label":"name","value":"{amount:money}"}}';
    case 'options':
      return '{"items":"rows","item_map":{"label":"name","description":"desc"}}';
    case 'cards':
      return '{"items":"products","item_map":{"title":"title","price":"{price:money}","cart_variant_id":"{id:gidnum}"}}';
    default:
      return '{"props":{"title":"result.title"}}';
  }
}

function prettyJson(raw?: string): string {
  try {
    return JSON.stringify(JSON.parse(raw ?? ''), null, 2);
  } catch {
    return raw ?? '';
  }
}

function Composer({
  initial,
  agentId,
  tools,
  saving,
  error,
  onCancel,
  onSave,
}: {
  initial: SavedWidget | null;
  agentId: string;
  tools: WidgetTool[];
  saving: boolean;
  error: string;
  onCancel: () => void;
  onSave: (w: {
    id?: string;
    name: string;
    description?: string;
    spec: ChatWidget;
    states: { name: string; spec: ChatWidget }[];
    tool: WidgetToolBinding | null;
    auto_greet: boolean;
  }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [spec, setSpec] = useState<ChatWidget>(initial?.spec ?? emptySpec('cards'));
  const [states, setStates] = useState<{ name: string; spec: ChatWidget }[]>(initial?.states ?? []);
  // A non-GET tool parked in the read slot of a FORM binding is the write
  // side (pre-submit-block rows, and submit-only saves from when `name`
  // was required) — it never ran at render and belongs in the submit slot.
  // Unknown tools (not in the list) keep the old read assumption.
  const boundIsWrite =
    initial?.spec.type === 'form' &&
    !!initial?.tool?.name &&
    (tools.find((t) => t.name === initial.tool!.name)?.method ?? 'GET') !== 'GET';
  const initSubmit =
    initial?.tool?.submit ??
    (boundIsWrite ? { name: initial!.tool!.name!, args: initial!.tool!.args } : undefined);
  const [toolName, setToolName] = useState(boundIsWrite ? '' : (initial?.tool?.name ?? ''));
  const [toolCfg, setToolCfg] = useState(() => {
    if (!initial?.tool || boundIsWrite) return '';
    const rest = Object.fromEntries(
      Object.entries(initial.tool).filter(([k, v]) => k !== 'name' && k !== 'submit' && v != null),
    );
    return Object.keys(rest).length ? JSON.stringify(rest) : '';
  });
  const [submitName, setSubmitName] = useState(initSubmit?.name ?? '');
  // Submit args as a plain record — one input per tool param, no JSON for
  // the builder to get wrong (a hand-edited blob is how stray quotes and
  // brackets used to leak into sheet cells).
  const [submitArgs, setSubmitArgs] = useState<Record<string, string>>(() => ({
    ...(initSubmit?.args ?? {}),
  }));
  // Read-side arg mapping per param — tool.args maps a ref-data KEY to
  // the param it feeds, so the UI inverts it: value = the key the agent
  // passes. Blank = "supplied by its own name" (identity, omitted).
  const [readArgs, setReadArgs] = useState<Record<string, string>>(() => {
    const inv: Record<string, string> = {};
    if (!boundIsWrite)
      for (const [k, p] of Object.entries(initial?.tool?.args ?? {}))
        if (k !== p) inv[p] = k;
    return inv;
  });
  // Fetched pick rows per arg — a _id param becomes a name-picker, never
  // a typed id (undefined = loading, null = fetch failed → text input).
  const [listRows, setListRows] = useState<Record<string, { id: string; label: string }[] | null>>({});
  // Tab pick rows for a range arg once a spreadsheet is picked.
  const [tabRows, setTabRows] = useState<{ id: string; label: string }[] | null | undefined>(undefined);
  const [autoGreet, setAutoGreet] = useState(initial?.autoGreet ?? false);
  const [jsonErr, setJsonErr] = useState('');
  const [testData, setTestData] = useState('{}');
  const [testBusy, setTestBusy] = useState(false);
  const [testOut, setTestOut] = useState<TestResult | null>(null);
  // States edit collapsed by default — a variant is a full spec, so showing
  // every editor inline made the composer twice as tall as it is.
  const [openStates, setOpenStates] = useState<Set<number>>(new Set());
  const toggleState = (i: number) =>
    setOpenStates((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const removeState = (i: number) => {
    setStates(states.filter((_, j) => j !== i));
    setOpenStates((prev) => new Set([...prev].filter((j) => j !== i).map((j) => (j > i ? j - 1 : j))));
  };
  // Forms lead with the submit wiring; the read-side binding and named
  // variants sit under "advanced" — open it only when one is already set.
  const [advOpen, setAdvOpen] = useState(!!toolName || states.length > 0);

  const setType = (t: ChatWidget['type']) => {
    if (t !== spec.type) setSpec(emptySpec(t));
  };
  const nameOk = /^[a-z][a-z0-9_-]{0,39}$/.test(name.trim().toLowerCase());

  /** toolName + the mapping textarea → binding object, or an error string. */
  const buildTool = (): { tool: WidgetToolBinding | null; err?: string } => {
    let extra: Record<string, unknown> = {};
    if (toolCfg.trim()) {
      try {
        const parsed: unknown = JSON.parse(toolCfg);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        extra = parsed as Record<string, unknown>;
      } catch {
        return { tool: null, err: 'tool mapping is not valid JSON' };
      }
      // Per-param arg inputs win over the JSON's args key — a typed key
      // renames that param's ref data; blanks keep whatever JSON says.
      const argMap = { ...(extra.args as Record<string, string> | undefined) };
      for (const [param, key] of Object.entries(readArgs)) {
        const k = key.trim();
        if (k && k !== param) argMap[k] = param;
      }
      if (Object.keys(argMap).length) extra.args = argMap;
    }
    // Blank arg values drop out — a `values` arg left empty is what makes
    // the submit write the form's fields in order.
    const cleanArgs = Object.fromEntries(
      Object.entries(submitArgs).filter(([k, v]) => k.trim() && v.trim()),
    );
    if (!toolName && toolCfg.trim())
      return { tool: null, err: 'mapping JSON needs a bound tool — pick one or clear the box' };
    if (!toolName && !submitName) return { tool: null };
    return {
      tool: {
        // `name` stays unset on a submit-only form — parking the write
        // tool there made the read slot echo it back as "bound".
        ...(toolName ? { name: toolName } : {}),
        ...(extra as Omit<WidgetToolBinding, 'name' | 'submit'>),
        ...(submitName
          ? {
              submit: {
                name: submitName,
                ...(Object.keys(cleanArgs).length ? { args: cleanArgs } : {}),
              },
            }
          : {}),
      },
    };
  };

  const normStates = () =>
    states.map((s) => ({
      name: s.name.trim().toLowerCase().replace(/[\s_]+/g, '-'),
      spec: s.spec,
    }));

  /** The sibling read tool a write tool's list comes from — gsheets_append
   *  → gsheets_list, hubspot_create_contact → hubspot_list, etc. */
  const listToolFor = (toolName: string): string | undefined => {
    const prefix = toolName.replace(
      /_(append|update|read|create|add|write|delete|get|set|find|search|put|post)$/i,
      '',
    );
    return tools.find((t) => t.name === `${prefix}_list`)?.name;
  };

  /** The sibling tab tool a write tool's tabs come from — gsheets_append
   *  → gsheets_tabs (tab names for the range arg). */
  const tabToolFor = (toolName: string): string | undefined => {
    const prefix = toolName.replace(
      /_(append|update|read|create|add|write|delete|get|set|find|search|put|post)$/i,
      '',
    );
    return tools.find((t) => t.name === `${prefix}_tabs`)?.name;
  };

  /** The sibling create tool — gsheets_append → gsheets_create — feeding
   *  the "＋ create new" option on id pickers. */
  const createToolFor = (toolName: string): string | undefined => {
    const prefix = toolName.replace(
      /_(append|update|read|create|add|write|delete|get|set|find|search|put|post|list|tabs)$/i,
      '',
    );
    return tools.find((t) => t.name === `${prefix}_create`)?.name;
  };

  // "＋ create new" on an id picker — inline name input → POST
  // /tools/create → the new id lands as the arg's value.
  const [creating, setCreating] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState('');
  const createResource = async (param: string) => {
    const ct = submitName ? createToolFor(submitName) : undefined;
    if (!ct || !createName.trim()) return;
    setCreateBusy(true);
    setCreateErr('');
    try {
      const out = await api<{ result: string }>(`/api/agents/${agentId}/tools/create`, {
        method: 'POST',
        body: JSON.stringify({ tool: ct, args: { title: createName.trim() } }),
      });
      const j = JSON.parse(out.result) as { spreadsheetId?: string; id?: string };
      const newId = j.spreadsheetId ?? j.id ?? '';
      if (!newId) throw new Error('created, but no id came back');
      setListRows((p) => ({
        ...p,
        [param]: [...(p[param] ?? []), { id: newId, label: createName.trim() }],
      }));
      setSubmitArgs({ ...submitArgs, [param]: newId });
      setCreating(null);
      setCreateName('');
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : 'create failed');
    } finally {
      setCreateBusy(false);
    }
  };

  /** Run a read tool and normalize its rows to {id,label} pick options —
   *  covers files rows (id/name) and tab rows ({properties:{title}}). */
  const fetchRows = async (tool: string, args: Record<string, unknown> = {}) => {
    const out = await api<{ result: string }>(`/api/agents/${agentId}/tools/run`, {
      method: 'POST',
      body: JSON.stringify({ tool, args }),
    });
    const j: unknown = JSON.parse(out.result);
    const rows = (
      Array.isArray(j) ? j : Object.values(j as object).find(Array.isArray)
    ) as Record<string, unknown>[] | undefined;
    return (rows ?? [])
      .slice(0, 40)
      .map((r) => {
        const title = (r as { properties?: { title?: string } }).properties?.title;
        return {
          id: String(r.id ?? r.spreadsheetId ?? title ?? r.name ?? r.title ?? ''),
          label: String(r.name ?? r.title ?? title ?? r.id ?? ''),
        };
      })
      .filter((r) => r.id);
  };

  // Fetch pick options for every _id arg when the submit tool changes —
  // the select IS the control, no browse button to discover.
  useEffect(() => {
    if (!submitName) return;
    const lt = listToolFor(submitName);
    const tp = tools.find((t) => t.name === submitName)?.params ?? {};
    for (const k of Object.keys(tp)) {
      if (!/(^id$|_id$)/.test(k) || listRows[k] !== undefined) continue;
      if (!lt) {
        setListRows((p) => ({ ...p, [k]: null }));
        continue;
      }
      fetchRows(lt)
        .then((rows) => setListRows((p) => ({ ...p, [k]: rows })))
        .catch(() => setListRows((p) => ({ ...p, [k]: null })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitName]);

  // Tab options follow the picked spreadsheet — repick refetches.
  useEffect(() => {
    const tt = submitName ? tabToolFor(submitName) : undefined;
    const sid = submitArgs.spreadsheet_id?.trim();
    if (!tt || !sid) {
      setTabRows(undefined);
      return;
    }
    fetchRows(tt, { spreadsheet_id: sid })
      .then((rows) => setTabRows(rows.map((r) => ({ id: `'${r.label}'!A1`, label: r.label }))))
      .catch(() => setTabRows(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitName, submitArgs.spreadsheet_id]);

  const runTest = async () => {
    const { tool, err } = buildTool();
    if (err) {
      setJsonErr(err);
      return;
    }
    if (states.some((s) => !s.name.trim())) {
      setJsonErr('every state needs a name');
      return;
    }
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(testData || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      data = parsed as Record<string, unknown>;
    } catch {
      setJsonErr('test data is not a JSON object');
      return;
    }
    setJsonErr('');
    setTestBusy(true);
    try {
      const out = await api<TestResult>(`/api/agents/${agentId}/widgets/test`, {
        method: 'POST',
        body: JSON.stringify({ spec, states: normStates(), tool, data }),
      });
      setTestOut(out);
    } catch (e) {
      setTestOut({
        error:
          e instanceof Error && e.message !== '[object Object]'
            ? e.message
            : 'test failed — check state names and the mapping',
      });
    } finally {
      setTestBusy(false);
    }
  };

  const save = () => {
    const { tool, err } = buildTool();
    if (err) {
      setJsonErr(err);
      return;
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
        description: description.trim() || undefined,
        spec,
        states: normStates(),
        tool,
        auto_greet: autoGreet,
      });
    } catch {
      setJsonErr('component data is not serialisable');
    }
  };

  // Section bodies — a form leads with the write side and
  // collapses the read-side machinery under "advanced".
  const statesSection = (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="muted" style={{ fontSize: 11.5 }}>
              States — named variants the agent selects with {'{"state":"name"}'} (e.g. a
              &quot;not found&quot; state with different steps or no buttons)
            </div>
            {states.map((st, i) => {
              const open = openStates.has(i);
              return (
                <div key={i} className="card" style={{ padding: 8, borderStyle: 'dashed' }}>
                  <div className="row" style={{ marginBottom: open ? 4 : 0 }}>
                    <button
                      className="btn sm"
                      onClick={() => toggleState(i)}
                      aria-label={open ? `Collapse state ${i + 1}` : `Expand state ${i + 1}`}
                      title={open ? 'Collapse' : 'Expand'}
                    >
                      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
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
                      onClick={() => removeState(i)}
                      aria-label={`Remove state ${i + 1}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {open && (
                    <SpecEditor
                      spec={st.spec}
                      onChange={(s) => setStates(states.map((x, j) => (j === i ? { ...x, spec: s } : x)))}
                    />
                  )}
                </div>
              );
            })}
            <button
              className="btn sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                setStates([...states, { name: '', spec: JSON.parse(JSON.stringify(spec)) as ChatWidget }]);
                setOpenStates((prev) => new Set(prev).add(states.length));
              }}
            >
              <Plus size={12} /> Add state
            </button>
          </div>
  );
  const boundSection = tools.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="prefill from a tool — it runs when the component shows, filling {placeholders} and list rows">
              <select
                className="input"
                style={inputStyle}
                value={toolName}
                onChange={(e) => {
                  setToolName(e.target.value);
                  setTestOut(null);
                }}
              >
                <option value="">none — static / prop-filled</option>
                {tools.map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {toolName &&
            (() => {
              // Per-param arg inputs — Zapier-style inferred-but-editable:
              // blank means "the agent supplies <param> by that name"; a
              // typed key renames the ref data feeding it. props/items/
              // item_map stay in the collapsed mapping JSON.
              const params = tools.find((t) => t.name === toolName)?.params ?? {};
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {Object.keys(params).map((k) => (
                    <Field key={k} label={k}>
                      <input
                        className="input"
                        style={inputStyle}
                        value={readArgs[k] ?? ''}
                        onChange={(e) => setReadArgs({ ...readArgs, [k]: e.target.value })}
                        placeholder={`agent supplies "${k}"`}
                      />
                    </Field>
                  ))}
                  {Object.keys(params).length > 0 && (
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      blank — the agent supplies each arg by name; type a key to rename what feeds it
                    </div>
                  )}
                  <details>
                    <summary className="muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
                      advanced — result mapping (JSON): props, rows path, row fields
                    </summary>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                      <Field label="mapping JSON">
                        <textarea
                          className="input"
                          style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
                          rows={3}
                          value={toolCfg}
                          onChange={(e) => setToolCfg(e.target.value)}
                          placeholder={mappingExample(spec.type)}
                        />
                      </Field>
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        {'{"args":{},"props":{},"items":"rows.path","item_map":{}}'}
                        {LIST_FIELD_LABEL[spec.type] ? ` — rows fill ${LIST_FIELD_LABEL[spec.type]}` : ' — scalar props only'}
                      </div>
                    </div>
                  </details>
                  <details>
                    <summary className="muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
                      test — run the bound tool once to see what it fills
                    </summary>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                      <div className="row" style={{ alignItems: 'flex-end' }}>
                        <Field label="sample values — the JSON the agent passes in the ref">
                          <input
                            className="input"
                            style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
                            value={testData}
                            onChange={(e) => setTestData(e.target.value)}
                            placeholder='{"order_id":"#1234"}'
                          />
                        </Field>
                        <button className="btn" disabled={testBusy} onClick={runTest}>
                          {testBusy ? 'Running…' : 'Run with real data'}
                        </button>
                      </div>
                      {testOut?.error && <div className="error">{testOut.error}</div>}
                      {testOut && !testOut.error && !testOut.widget && (
                        <div className="error">resolved to nothing — check the mapping and required props</div>
                      )}
                      {testOut?.tool_result !== undefined && (
                        <details>
                          <summary className="muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
                            raw tool result{testOut.tool_args ? ` — args ${JSON.stringify(testOut.tool_args)}` : ''}
                          </summary>
                          <pre className="card" style={{ padding: 8, fontSize: 11, overflow: 'auto', maxHeight: 220, whiteSpace: 'pre-wrap' }}>
                            {prettyJson(testOut.tool_result)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </details>
                </div>
              );
            })()}
        </div>
  );
  const submitSection = spec.type === 'form' && tools.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="on submit — save the answers with this tool">
              <select
                className="input"
                style={inputStyle}
                value={submitName}
                onChange={(e) => setSubmitName(e.target.value)}
              >
                <option value="">none — answers just arrive as a chat message</option>
                {tools.map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {/* One input per declared arg, each with its own helper — ids
              lead (pick the destination first), `values` last. */}
          {submitName &&
            (() => {
              const params = tools.find((t) => t.name === submitName)?.params ?? {};
              const listTool = listToolFor(submitName);
              const tabsTool = tabToolFor(submitName);
              const argKeys = [...new Set([...Object.keys(params), ...Object.keys(submitArgs)])].sort(
                (a, b) =>
                  (a === 'values' ? 1 : 0) - (b === 'values' ? 1 : 0) ||
                  Number(/(^id$|_id$)/.test(b)) - Number(/(^id$|_id$)/.test(a)),
              );
              const helperFor = (k: string): string | null =>
                k === 'range'
                  ? 'which tab or area to write — blank writes to A1 (appends after the last row)'
                  : k === 'values'
                    ? '{name} puts that answer in a column · blank = one column per field, in order'
                    : /(^id$|_id$)/.test(k) && listTool
                      ? null
                      : params[k] ?? null;
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {!argKeys.length && (
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      this tool takes no args — it runs as-is
                    </div>
                  )}
                  {argKeys.map((k) => {
                    // A _id arg with a fetched list is a name-picker —
                    // the operator picks "Leads — Property inquiries",
                    // the id never surfaces.
                    const rows = listRows[k];
                    const idPick = /(^id$|_id$)/.test(k) && listTool;
                    const tabPick = k === 'range' && tabsTool && submitArgs.spreadsheet_id?.trim();
                    return (
                      <div key={k}>
                        <div className="row" style={{ alignItems: 'flex-end' }}>
                          <Field
                            label={
                              k === 'values'
                                ? "values — the sheet's columns"
                                : k === 'spreadsheet_id'
                                  ? 'spreadsheet — the file to write to'
                                  : k === 'range'
                                    ? 'tab — where in the file to write'
                                    : k
                            }
                          >
                            {idPick ? (
                              rows === undefined ? (
                                <div className="muted" style={{ fontSize: 12 }}>loading…</div>
                              ) : rows === null || !rows.length ? (
                                <input
                                  className="input"
                                  style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
                                  value={submitArgs[k] ?? ''}
                                  onChange={(e) => setSubmitArgs({ ...submitArgs, [k]: e.target.value })}
                                  placeholder={params[k]}
                                />
                              ) : (
                                <select
                                  className="input"
                                  style={inputStyle}
                                  value={submitArgs[k] ?? ''}
                                  onChange={(e) => {
                                    if (e.target.value === '__create') {
                                      setCreating(k);
                                      setCreateErr('');
                                      return;
                                    }
                                    setSubmitArgs({ ...submitArgs, [k]: e.target.value });
                                  }}
                                >
                                  <option value="">— pick one —</option>
                                  {rows.map((r) => (
                                    <option key={r.id} value={r.id}>{r.label}</option>
                                  ))}
                                  {submitArgs[k] && !rows.some((r) => r.id === submitArgs[k]) && (
                                    <option value={submitArgs[k]}>{submitArgs[k]}</option>
                                  )}
                                  {createToolFor(submitName) && (
                                    <option value="__create">＋ create new…</option>
                                  )}
                                </select>
                              )
                            ) : tabPick && tabRows !== undefined && tabRows !== null && tabRows.length ? (
                              <select
                                className="input"
                                style={inputStyle}
                                value={submitArgs[k] ?? ''}
                                onChange={(e) => setSubmitArgs({ ...submitArgs, [k]: e.target.value })}
                              >
                                <option value="">blank → A1 (after the last row)</option>
                                {tabRows.map((r) => (
                                  <option key={r.id} value={r.id}>{r.label}</option>
                                ))}
                                {submitArgs[k] && !tabRows.some((r) => r.id === submitArgs[k]) && (
                                  <option value={submitArgs[k]}>{submitArgs[k]}</option>
                                )}
                              </select>
                            ) : (
                              <input
                                className="input"
                                style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
                                value={submitArgs[k] ?? ''}
                                onChange={(e) => setSubmitArgs({ ...submitArgs, [k]: e.target.value })}
                                placeholder={
                                  k === 'values'
                                    ? `[["${(spec.fields ?? [])
                                        .map((f) => `{${f.name || '?'}}`)
                                        .join('","')}"]]`
                                    : params[k]
                                }
                              />
                            )}
                          </Field>
                        </div>
                        {helperFor(k) && (
                          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                            {helperFor(k)}
                          </div>
                        )}
                        {creating === k && (
                          <div className="row" style={{ alignItems: 'flex-end', gap: 6, marginTop: 4 }}>
                            <Field label="name it">
                              <input
                                autoFocus
                                className="input"
                                style={inputStyle}
                                value={createName}
                                onChange={(e) => setCreateName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void createResource(k);
                                }}
                                placeholder="Intake responses"
                              />
                            </Field>
                            <button
                              className="btn"
                              disabled={!createName.trim() || createBusy}
                              onClick={() => void createResource(k)}
                            >
                              {createBusy ? 'creating…' : 'create'}
                            </button>
                            <button className="btn sm" onClick={() => setCreating(null)}>
                              cancel
                            </button>
                          </div>
                        )}
                        {creating === k && createErr && (
                          <div className="error" style={{ fontSize: 11 }}>{createErr}</div>
                        )}
                        {k === 'spreadsheet_id' && submitArgs[k]?.trim() && (
                          <a
                            className="muted"
                            style={{ fontSize: 11 }}
                            target="_blank"
                            rel="noreferrer"
                            href={`https://docs.google.com/spreadsheets/d/${submitArgs[k].trim()}`}
                          >
                            open the sheet ↗
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
        </div>
  );

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
        <Field label="when to use — one line; the agent reads this to pick this component over prose or another widget">
          <input
            className="input"
            style={{ ...inputStyle, minWidth: 220 }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="customer asks where their order is"
            maxLength={200}
          />
        </Field>
      </div>
      {!nameOk && name && <div className="error">lowercase letters, numbers, - and _ — starts with a letter</div>}

      {/* Prefill first — "what fills this component" is the decision the
          operator makes before laying out fields, not an advanced extra. */}
      {boundSection}

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

      {/* The submit wiring — "collect answers, save them somewhere" is
          the common build. Named variants stay advanced for every type. */}
      {submitSection}
      {spec.type === 'form' ? (
        <>
          <button
            className="btn sm"
            style={{ alignSelf: 'flex-start', fontSize: 11.5 }}
            onClick={() => setAdvOpen((v) => !v)}
            aria-expanded={advOpen}
          >
            {advOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} advanced — named
            variants
          </button>
          {advOpen && statesSection}
        </>
      ) : (
        statesSection
      )}

      <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
        <input type="checkbox" checked={autoGreet} onChange={(e) => setAutoGreet(e.target.checked)} />
        Show when the chat opens (under the greeting)
      </label>

      <div className="muted" style={{ fontSize: 11.5 }}>Preview{testOut?.widget ? ' — template' : ''}</div>
      <div className="card" style={{ padding: 10, maxWidth: 340, pointerEvents: 'none' }}>
        <Widgets widgets={[spec]} onSend={() => {}} />
      </div>
      {testOut?.widget && (
        <>
          <div className="muted" style={{ fontSize: 11.5 }}>Preview — with live data</div>
          <div className="card" style={{ padding: 10, maxWidth: 340, pointerEvents: 'none' }}>
            <Widgets widgets={[testOut.widget]} onSend={() => {}} />
          </div>
        </>
      )}

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
                    {[
                      ['text', 'text'],
                      ['email', 'email'],
                      ['tel', 'phone'],
                      ['textarea', 'long text'],
                      ['select', 'dropdown — one pick'],
                      ['radio', 'radio buttons — one pick'],
                      ['multiselect', 'checkboxes — multiple picks'],
                    ].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
                {(f.type === 'select' || f.type === 'multiselect' || f.type === 'radio') && (
                  <Field label="options (comma-separated)"><OptionsInput className="input" style={inputStyle} value={f.options} onChange={(opts) => set({ ...f, options: opts })} /></Field>
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
          <div className="muted" style={{ fontSize: 11 }}>
            Breakdown rows render after the items, above the total — bind tool props like {'{subtotal}'}; rows whose value resolves empty drop out.
          </div>
          <ItemsEditor
            items={spec.summary ?? []}
            empty={{ label: '', value: '' }}
            addLabel="breakdown row"
            onChange={(summary) => onChange({ ...spec, summary: summary.length ? summary : undefined })}
            render={(r, set) => (
              <>
                <Field label="label"><input className="input" style={inputStyle} value={r.label} onChange={(e) => set({ ...r, label: e.target.value })} placeholder="Subtotal" /></Field>
                <Field label="value"><input className="input" style={inputStyle} value={r.value} onChange={(e) => set({ ...r, value: e.target.value })} placeholder="{subtotal}" /></Field>
              </>
            )}
          />
          <div className="row" style={rowStyle}>
            <Field label="total label"><input className="input" style={inputStyle} value={spec.total?.label ?? ''} onChange={(e) => onChange({ ...spec, total: e.target.value ? { label: e.target.value, value: spec.total?.value ?? '' } : undefined })} placeholder="Total" /></Field>
            <Field label="total value"><input className="input" style={inputStyle} value={spec.total?.value ?? ''} onChange={(e) => onChange({ ...spec, total: spec.total ? { ...spec.total, value: e.target.value } : e.target.value ? { label: 'Total', value: e.target.value } : undefined })} placeholder="$0.00" /></Field>
          </div>
        </>
      );
    case 'pricing':
      return (
        <>
          <Field label="heading"><input className="input" style={inputStyle} value={spec.title ?? ''} onChange={(e) => onChange({ ...spec, title: e.target.value || undefined })} /></Field>
          <ItemsEditor
            items={spec.items}
            empty={{ name: '', price: '' }}
            addLabel="plan"
            onChange={(items) => onChange({ ...spec, items })}
            render={(p, set) => (
              <>
                <div className="row" style={rowStyle}>
                  <Field label="plan"><input className="input" style={inputStyle} value={p.name} onChange={(e) => set({ ...p, name: e.target.value })} /></Field>
                  <Field label="price"><input className="input" style={inputStyle} value={p.price} onChange={(e) => set({ ...p, price: e.target.value })} placeholder="$29/mo" /></Field>
                </div>
                <Field label="alt price"><input className="input" style={inputStyle} value={p.price_alt ?? ''} onChange={(e) => set({ ...p, price_alt: e.target.value || undefined })} placeholder="$290/yr — pay 10, get 12" /></Field>
                <Field label="blurb"><input className="input" style={inputStyle} value={p.blurb ?? ''} onChange={(e) => set({ ...p, blurb: e.target.value || undefined })} /></Field>
                <Field label="features — one per line">
                  <textarea
                    className="input"
                    style={inputStyle}
                    rows={3}
                    value={(p.features ?? []).join('\n')}
                    onChange={(e) => {
                      const features = e.target.value.split('\n').map((f) => f.trim()).filter(Boolean);
                      set({ ...p, features: features.length ? features : undefined });
                    }}
                  />
                </Field>
                <Field label="select button"><input className="input" style={inputStyle} value={p.select_label ?? ''} onChange={(e) => set({ ...p, select_label: e.target.value || undefined })} placeholder="Tell me about this plan" /></Field>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                  <input type="checkbox" checked={!!p.highlight} onChange={(e) => set({ ...p, highlight: e.target.checked || undefined })} /> featured plan
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                  <input type="checkbox" checked={!!p.current} onChange={(e) => set({ ...p, current: e.target.checked || undefined })} /> visitor's current plan
                </label>
              </>
            )}
          />
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
