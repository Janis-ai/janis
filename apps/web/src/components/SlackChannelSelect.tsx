import { useState } from 'react';

/** Channel dropdown with an inline "create a channel" flow. `onPick(null)`
 * means the inherit/default option was chosen (only present when
 * `inheritLabel` is set). `onCreate` may return a promise — the create form
 * stays open while it's pending and closes on success. */
export function SlackChannelSelect({
  channels,
  value,
  onPick,
  onCreate,
  inheritLabel,
  defaultName = 'janis-alerts',
  busy,
}: {
  channels: { id: string; name: string }[] | undefined;
  value: string;
  onPick: (channelId: string | null) => void;
  onCreate: (name: string) => void | Promise<void>;
  inheritLabel?: string;
  defaultName?: string;
  busy?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(defaultName);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // Strict name matches — what the visible results list shows while typing.
  const matches = q ? (channels ?? []).filter((ch) => ch.name.toLowerCase().includes(q)) : [];
  // Select options: matches plus the current selection, which always survives
  // the filter so the select never loses its value mid-search.
  const options = q
    ? (channels ?? []).filter((ch) => ch.name.toLowerCase().includes(q) || ch.id === value)
    : (channels ?? []);
  const showSearch = (channels?.length ?? 0) > 8;
  return (
    <>
      {showSearch && (
        <input
          style={{ flexBasis: '100%', display: 'block', width: '100%', marginBottom: 4, boxSizing: 'border-box' }}
          placeholder={`Search ${channels?.length} channels…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {q && (
        <div
          style={{
            flexBasis: '100%',
            border: '1px solid var(--border)',
            borderRadius: 8,
            marginBottom: 4,
            maxHeight: 180,
            overflowY: 'auto',
          }}
        >
          {matches.length === 0 ? (
            <div className="muted" style={{ padding: '8px 10px' }}>
              No channels match “{query.trim()}”.
            </div>
          ) : (
            matches.map((ch, i) => (
              <button
                key={ch.id}
                type="button"
                onClick={() => {
                  setQuery('');
                  onPick(ch.id);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 10px',
                  background: 'none',
                  border: 'none',
                  borderBottom: i < matches.length - 1 ? '1px solid var(--border)' : 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                #{ch.name}
                {ch.id === value && <span className="muted"> — selected</span>}
              </button>
            ))
          )}
        </div>
      )}
      <select
        value={value}
        disabled={busy}
        onChange={(e) => onPick(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">{inheritLabel ?? 'Pick alert channel…'}</option>
        {options.map((ch) => (
          <option key={ch.id} value={ch.id}>#{ch.name}</option>
        ))}
        {q && options.length === 0 && <option disabled>no matches</option>}
      </select>
      <button
        className="btn"
        onClick={() => {
          setName(defaultName);
          setCreating((v) => !v);
        }}
      >
        ＋ New
      </button>
      {creating && (
        <div className="row" style={{ marginTop: 8, flexBasis: '100%' }}>
          <input
            style={{ width: 200 }}
            value={name}
            placeholder="e.g. janis-alerts"
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={!name.trim() || pending}
            onClick={async () => {
              setPending(true);
              try {
                await onCreate(name.trim());
                setCreating(false);
              } catch {
                // parent mutation surfaces the error — keep the form open
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Creating…' : 'Create & use'}
          </button>
          <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}
    </>
  );
}
