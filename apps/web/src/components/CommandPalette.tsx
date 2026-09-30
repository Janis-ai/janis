import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3, Bot, CreditCard, Inbox, Megaphone, Search, Settings, Users,
} from 'lucide-react';
import { useAgents, useSearch } from '../api/hooks';
import { displayName } from './bits';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

/** ⌘K / Ctrl+K command palette — navigation, agent jump, and conversation
 *  search in one box. Operator-muscle-memory feature: hands stay on keys. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { data: agents } = useAgents();
  const { data: hits } = useSearch(q.trim().length >= 2 ? q : '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const close = () => setOpen(false);
  const go = (path: string) => {
    close();
    navigate(path);
  };

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const nav: Item[] = [
      { id: 'nav-conv', label: 'Conversations', icon: <Inbox size={15} />, run: () => go('/conversations') },
      { id: 'nav-contacts', label: 'Contacts', icon: <Users size={15} />, run: () => go('/contacts') },
      { id: 'nav-campaigns', label: 'Campaigns', icon: <Megaphone size={15} />, run: () => go('/campaigns') },
      { id: 'nav-agents', label: 'Agents', icon: <Bot size={15} />, run: () => go('/agents') },
      { id: 'nav-reports', label: 'Reports', icon: <BarChart3 size={15} />, run: () => go('/reports') },
      { id: 'nav-billing', label: 'Billing', icon: <CreditCard size={15} />, run: () => go('/billing') },
      { id: 'nav-settings', label: 'Settings', icon: <Settings size={15} />, run: () => go('/settings') },
    ];
    const agentItems: Item[] = (agents?.agents ?? []).map((a) => ({
      id: `agent-${a.id}`,
      label: `Agent: ${a.name}`,
      icon: <Bot size={15} />,
      run: () => go(`/agents/${a.id}`),
    }));
    const convItems: Item[] = (hits?.conversations ?? []).slice(0, 8).map((c) => ({
      id: `conv-${c.id}`,
      label: displayName(c),
      hint: c.last_message_preview ?? undefined,
      icon: <Search size={15} />,
      run: () => go(`/conversations/${c.id}`),
    }));
    const all = [...nav, ...agentItems, ...convItems];
    if (!needle) return all;
    return all.filter((i) => i.label.toLowerCase().includes(needle));
  }, [q, agents, hits]);

  useEffect(() => setIdx(0), [items.length]);

  if (!open) return null;
  const active = items[Math.min(idx, items.length - 1)];

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIdx((i) => Math.min(i + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            active?.run();
          }
        }}
      >
        <input
          ref={inputRef}
          className="input palette-input"
          aria-label="Search pages, agents, and conversations"
          placeholder="Jump to a page, agent, or conversation…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="muted" style={{ padding: '10px 4px' }}>No matches.</div>}
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              className={`palette-item${i === Math.min(idx, items.length - 1) ? ' active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={it.run}
            >
              <span className="palette-icon">{it.icon}</span>
              <span className="grow" style={{ textAlign: 'left' }}>{it.label}</span>
              {it.hint && <span className="muted palette-hint">{it.hint.slice(0, 40)}</span>}
            </button>
          ))}
        </div>
        <div className="muted palette-foot">
          ↑↓ navigate · Enter open · Esc close · ⌘K anywhere toggles this
        </div>
      </div>
    </div>
  );
}
