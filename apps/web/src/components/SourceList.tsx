import { Fragment, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, AgentConfig, HelpArticle } from '@janis/shared';
import { api } from '../api/client';
import { HelpCenter } from './HelpCenter';
import { Modal } from './Modal';
import { FileText, Globe, Newspaper, RefreshCw, StickyNote, Trash2 } from 'lucide-react';
import { timeAgo } from './bits';

export interface KnowledgeFile {
  id: string;
  name: string;
  chars: number;
  size_bytes: number;
  status: string;
  error: string | null;
  source_url: string | null;
  /** Set on crawled pages — they nest under their site row (the parent). */
  parent_id: string | null;
  mime_type: string;
  topic: string | null;
  enabled: boolean;
  refresh_hours: number | null;
  has_headers?: boolean;
  last_fetched_at: string | null;
  text_changed_at?: string | null;
  next_fetch_at: string | null;
  created_at: string;
}

export interface KnowledgeBudget {
  limit: number;
  notes_limit: number;
  notes_chars: number;
  docs_chars: number;
  used_chars: number;
}

export interface Topic {
  id: string;
  text: string;
  priority?: 'high' | 'normal';
}

const looksLikeUrl = (s: string) =>
  /^https?:\/\/\S+$/i.test(s) || /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/\S*)?$/i.test(s);

const tok = (chars: number) =>
  chars >= 40_000 ? `${Math.round(chars / 4000)}k` : Math.round(chars / 4).toLocaleString();

/** One row's stored text, fetched on first expand — the list endpoint
 *  deliberately ships only metadata so a page of sources stays light. */
function SourceText({ agentId, fileId }: { agentId: string; fileId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['knowledge-text', fileId],
    queryFn: () => api<{ text: string }>(`/api/agents/${agentId}/knowledge/${fileId}`),
  });
  return (
    <pre
      className="muted"
      style={{
        marginTop: 8,
        marginBottom: 0,
        maxHeight: 260,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontSize: 12,
        fontFamily: 'inherit',
        lineHeight: 1.5,
      }}
    >
      {isLoading ? 'Loading…' : isError ? 'Could not load this source.' : data?.text || '(empty)'}
    </pre>
  );
}

/** One list for every knowledge source — websites, uploaded files, the
 *  owner's notes (one expandable row; dozens of one-line facts shouldn't
 *  bury the sources), and help-center articles as a first-party row.
 *  Notes self-save per line; files/websites manage themselves like the
 *  old tabs did. Over budget, rows sort by size — the biggest row is the
 *  likeliest fix. */
export function SourceList({
  agentId,
  agent,
  cfg,
  onConfigSaved,
  isAdmin,
  forTopic,
  focusAdd,
  onTopicSettled,
  onFocusConsumed,
  articlesExtras,
}: {
  agentId: string;
  agent?: Agent;
  cfg: AgentConfig;
  /** Persist a config change (note adds/edits/removals) — the caller owns
   *  the actual PATCH so draft-vs-saved semantics stay local to it. */
  onConfigSaved: (next: AgentConfig) => Promise<unknown> | void;
  isAdmin: boolean;
  forTopic?: Topic | null;
  focusAdd?: 'url' | 'file' | 'note' | null;
  onTopicSettled?: () => void;
  /** The focus intent is one-shot — the caller clears it once we've
   *  aimed the affordance, so a dismiss + remount doesn't re-open the
   *  file dialog the user already declined. */
  onFocusConsumed?: () => void;
  /** Rendered inside the expanded Articles row — the builder passes the
   *  drafts-in-test toggle here. */
  articlesExtras?: React.ReactNode;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['knowledge', agentId],
    queryFn: () =>
      api<{ files: KnowledgeFile[]; budget: KnowledgeBudget }>(`/api/agents/${agentId}/knowledge`),
  });
  const { data: articlesData } = useQuery({
    queryKey: ['articles', agentId],
    queryFn: () => api<{ articles: HelpArticle[] }>(`/api/articles?agent_id=${agentId}`),
  });
  const articles = articlesData?.articles ?? [];
  const published = articles.filter((a) => a.status === 'published');
  const drafts = articles.filter((a) => a.status !== 'published');

  const [input, setInput] = useState('');
  // Optional auth for the next URL add (private docs/Notion) — sent as
  // Authorization, stored encrypted server-side, never read back.
  const [authHeader, setAuthHeader] = useState('');
  const [error, setError] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [articlesOpen, setArticlesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [editLine, setEditLine] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  // The pasted URL awaiting the "page or whole site?" popup decision.
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // A topic action ("Add website", "Write it") aims the right affordance —
  // the checklist above supplies forTopic + focusAdd together. The aim is
  // consumed on fire: leaving the step and coming back remounts this list,
  // and a dismissed file dialog must not reopen on every visit. The topic
  // itself stays in context until a source for it actually lands.
  const aimedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!forTopic || !focusAdd) {
      aimedFor.current = null;
      return;
    }
    const key = `${forTopic.id}:${focusAdd}`;
    if (aimedFor.current === key) return;
    aimedFor.current = key;
    if (focusAdd === 'note') {
      setNotesOpen(true);
      inputRef.current?.focus();
    } else if (focusAdd === 'file') {
      fileRef.current?.click();
    } else {
      inputRef.current?.focus();
    }
    onFocusConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forTopic, focusAdd]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['knowledge', agentId] });
    void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
    void qc.invalidateQueries({ queryKey: ['articles', agentId] });
  };

  const notes = cfg.knowledge ?? [];
  /** Note writes go straight through the caller's config save — per-line
   *  edits shouldn't wait on a Save button the row UI doesn't have. When a
   *  topic is in context the first saved line counts it covered. */
  const saveNotes = (next: string[]) => {
    const config: AgentConfig = {
      ...cfg,
      knowledge: next,
      ...(forTopic
        ? {
            builder: {
              ...cfg.builder,
              covered_topics: [
                ...new Set([...(cfg.builder?.covered_topics ?? []), forTopic.id]),
              ],
            },
          }
        : {}),
    };
    return Promise.resolve(onConfigSaved(config)).then(() => {
      invalidate();
      if (forTopic) onTopicSettled?.();
    });
  };

  const addUrl = useMutation({
    mutationFn: ({ url, auth }: { url: string; auth: string }) =>
      api(`/api/agents/${agentId}/knowledge-url`, {
        method: 'POST',
        body: JSON.stringify({
          url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
          refresh_hours: 24,
          ...(forTopic ? { topic: forTopic.id } : {}),
          ...(auth ? { headers: { Authorization: auth } } : {}),
        }),
      }),
    onSuccess: () => {
      setInput('');
      setAuthHeader('');
      setPendingUrl(null);
      setImportMsg('');
      invalidate();
      if (forTopic) onTopicSettled?.();
    },
    onError: (e) => setError(e.message),
  });

  const importCentre = useMutation({
    mutationFn: ({ url, auth }: { url: string; auth: string }) =>
      api<{
        kind: string;
        imported: number;
        queued: number;
        skipped: number;
        discovered: number;
        site: string;
      }>(`/api/agents/${agentId}/knowledge-import`, {
        method: 'POST',
        body: JSON.stringify({
          url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
          refresh_hours: 24,
          ...(forTopic ? { topic: forTopic.id } : {}),
          ...(auth ? { headers: { Authorization: auth } } : {}),
        }),
      }),
    onSuccess: (r) => {
      setInput('');
      setAuthHeader('');
      setPendingUrl(null);
      const dup = r.skipped ? ` (${r.skipped} already imported)` : '';
      setImportMsg(
        r.kind === 'zendesk'
          ? `Imported ${r.imported} article${r.imported === 1 ? '' : 's'} from the Zendesk API${dup} — they nest under the site row and re-crawl on this schedule.`
          : `Found ${r.discovered} pages${r.kind === 'crawl' ? ' by following links' : ''}${dup} — ${r.queued} queued under the site row and fetching now; sizes appear per page shortly. New pages join and dead pages drop on each re-check.`,
      );
      invalidate();
      if (forTopic) onTopicSettled?.();
    },
    onError: (e) => setError(e.message),
  });

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    setError('');
    for (const f of Array.from(list)) {
      const form = new FormData();
      form.append('file', f);
      if (forTopic) form.append('topic', forTopic.id);
      const res = await fetch(`/api/agents/${agentId}/knowledge`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(`${f.name}: ${body.error ?? `HTTP ${res.status}`}`);
        break;
      }
    }
    setUploading(false);
    invalidate();
    if (forTopic) onTopicSettled?.();
  };

  const toggle = useMutation({
    mutationFn: ({ fileId, enabled }: { fileId: string; enabled: boolean }) =>
      api(`/api/agents/${agentId}/knowledge/${fileId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: invalidate,
  });
  const refresh = useMutation({
    mutationFn: (fileId: string) =>
      api(`/api/agents/${agentId}/knowledge/${fileId}/refresh`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const setRefresh = useMutation({
    mutationFn: ({ fileId, refresh_hours }: { fileId: string; refresh_hours: number | null }) =>
      api(`/api/agents/${agentId}/knowledge/${fileId}`, {
        method: 'PATCH',
        body: JSON.stringify({ refresh_hours }),
      }),
    onSuccess: invalidate,
  });
  const removeBulk = useMutation({
    mutationFn: (ids: string[]) =>
      api<{ deleted: number }>(`/api/agents/${agentId}/knowledge/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => {
      setSelected(new Set());
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (fileId: string) =>
      api(`/api/agents/${agentId}/knowledge/${fileId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
  const submitSmart = () => {
    const v = input.trim();
    if (!v) return;
    if (looksLikeUrl(v)) {
      // Every pasted link gets the scope question — page or whole site.
      setError('');
      setImportMsg('');
      setPendingUrl(v);
    } else {
      void saveNotes([...notes, v]);
      setInput('');
    }
  };

  const overBudget = (data?.budget.used_chars ?? 0) > (data?.budget.limit ?? Infinity);
  const files = (data?.files ?? []).sort((a, b) => (overBudget ? b.chars - a.chars : 0));
  // Whole-site crawls land as a site row + one child per discovered page.
  // Children hide inside the parent's "site — N pages" expander rather
  // than listing flat; an orphaned child (parent already gone) falls back
  // to top-level so it never becomes unreachable.
  const siteIds = new Set(
    files.filter((f) => f.mime_type === 'text/url-site').map((f) => f.id),
  );
  const childrenOf = new Map<string, KnowledgeFile[]>();
  for (const f of files) {
    if (!f.parent_id || !siteIds.has(f.parent_id)) continue;
    const list = childrenOf.get(f.parent_id) ?? [];
    list.push(f);
    childrenOf.set(f.parent_id, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const topFiles = files.filter((f) => !f.parent_id || !siteIds.has(f.parent_id));
  const notesChars = notes.reduce((n, l) => n + l.length, 0);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (isAdmin) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (isAdmin) void upload(e.dataTransfer.files);
      }}
    >
      {forTopic && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Adding for: <strong>{forTopic.text}</strong>{' '}
          <button className="link small muted" onClick={onTopicSettled}>
            clear
          </button>
        </div>
      )}

      {isAdmin && (
        <>
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <input
              ref={inputRef}
              className="input grow"
              placeholder="Paste a link or write a fact…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSmart();
              }}
            />
            <button
              className="btn"
              disabled={!input.trim() || addUrl.isPending}
              onClick={submitSmart}
            >
              {addUrl.isPending ? 'Adding…' : 'Add'}
            </button>
            <button
              className="btn"
              title="Upload a document (PDF, text, markdown…)"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? 'Uploading…' : '📎 File'}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept=".txt,.md,.markdown,.csv,.json,.html,.pdf,.png,.jpg,.jpeg,.webp,.gif"
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              className="input"
              style={{ fontSize: 12, maxWidth: 260 }}
              type="password"
              placeholder="Auth header (private links)"
              title="Optional — sent as the Authorization header when the link is crawled; stored encrypted and never shown again"
              value={authHeader}
              onChange={(e) => setAuthHeader(e.target.value)}
            />
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            Links become website sources — anything else saves as a note. Drop
            files anywhere on this panel.
          </div>
          {importMsg && !error && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{importMsg}</div>
          )}
          {pendingUrl && (
            <Modal title="Add this link" onClose={() => setPendingUrl(null)} width={480}>
              <div className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
                {pendingUrl}
              </div>
              <div style={{ fontSize: 13, marginTop: 10 }}>
                Crawl just this page, or the whole site under it?
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                A whole-site crawl follows the sitemap or the site's own links and
                lands as one site row with a source per page — re-checked on
                schedule, so new pages join and dead pages drop on their own.
              </div>
              {error && (
                <div className="error" style={{ marginTop: 8 }}>
                  {error}
                </div>
              )}
              <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn ghost"
                  onClick={() => setPendingUrl(null)}
                  disabled={addUrl.isPending || importCentre.isPending}
                >
                  Cancel
                </button>
                <button
                  className="btn"
                  disabled={addUrl.isPending || importCentre.isPending}
                  onClick={() => addUrl.mutate({ url: pendingUrl, auth: authHeader.trim() })}
                >
                  {addUrl.isPending ? 'Adding…' : 'Just this page'}
                </button>
                <button
                  className="btn"
                  disabled={addUrl.isPending || importCentre.isPending}
                  onClick={() => importCentre.mutate({ url: pendingUrl, auth: authHeader.trim() })}
                >
                  {importCentre.isPending ? 'Discovering…' : 'Crawl the whole site'}
                </button>
              </div>
            </Modal>
          )}
        </>
      )}
      {error && (
        <div className="error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      {dragging && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Drop to add files…
        </div>
      )}

      {/* Notes — one row; dozens of one-line facts shouldn't bury sources */}
      {(notes.length > 0 || notesOpen || forTopic) && (
        <div className="card" style={{ marginTop: 12, padding: 10 }}>
          <button
            className="row"
            style={{
              width: '100%',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 13,
              padding: 0,
            }}
            onClick={() => setNotesOpen((v) => !v)}
          >
            <span className="muted" style={{ fontSize: 16, width: 14 }}>{notesOpen ? '▾' : '▸'}</span>
            <StickyNote size={14} />
            <span className="grow" style={{ marginLeft: 6 }}>
              <strong>Notes</strong>
              <span className="muted">
                {' '}— {notes.length} line{notes.length === 1 ? '' : 's'} · ~{tok(notesChars)} tok
              </span>
            </span>
          </button>
          {notesOpen && (
            <div style={{ marginTop: 8 }}>
              {isAdmin && (
                <div className="row" style={{ gap: 8 }}>
                  <input
                    className="input grow"
                    placeholder="Add a note — one fact, standalone sentence"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && noteDraft.trim()) {
                        void saveNotes([...notes, noteDraft.trim()]);
                        setNoteDraft('');
                      }
                    }}
                  />
                  <button
                    className="btn sm"
                    disabled={!noteDraft.trim()}
                    onClick={() => {
                      void saveNotes([...notes, noteDraft.trim()]);
                      setNoteDraft('');
                    }}
                  >
                    Add
                  </button>
                </div>
              )}
              {notes.map((line, i) => (
                <div key={i} className="row muted" style={{ marginTop: 6, gap: 6 }}>
                  {editLine === i ? (
                    <>
                      <input
                        className="input grow"
                        value={editValue}
                        autoFocus
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && editValue.trim()) {
                            const next = notes.slice();
                            next[i] = editValue.trim();
                            void saveNotes(next);
                            setEditLine(null);
                          }
                          if (e.key === 'Escape') setEditLine(null);
                        }}
                      />
                      <button
                        className="btn sm"
                        disabled={!editValue.trim()}
                        onClick={() => {
                          const next = notes.slice();
                          next[i] = editValue.trim();
                          void saveNotes(next);
                          setEditLine(null);
                        }}
                      >
                        Save
                      </button>
                      <button className="btn sm" onClick={() => setEditLine(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span
                        className="grow"
                        style={{ fontSize: 13, cursor: isAdmin ? 'text' : undefined }}
                        title={isAdmin ? 'Click to edit' : undefined}
                        onClick={() => {
                          if (!isAdmin) return;
                          setEditLine(i);
                          setEditValue(line);
                        }}
                      >
                        {line}
                      </span>
                      {isAdmin && (
                        <button
                          className="btn danger sm"
                          aria-label="Remove note"
                          onClick={() => {
                            const next = notes.slice();
                            next.splice(i, 1);
                            void saveNotes(next);
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
              {notes.length === 0 && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  No notes yet — write each fact as a standalone sentence.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Files + websites — bulk selection sits in this toolbar; the
          per-row checkbox only marks a row for the bulk action. */}
      {isAdmin && files.length > 0 && (
        <div className="row" style={{ marginTop: 10, gap: 8, fontSize: 12 }}>
          <input
            type="checkbox"
            aria-label="Select all sources"
            ref={(el) => {
              if (el)
                el.indeterminate =
                  selected.size > 0 && selected.size < files.length;
            }}
            checked={files.length > 0 && selected.size === files.length}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(files.map((f) => f.id)) : new Set())
            }
          />
          <span className="muted grow">
            {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
          </span>
          {selected.size > 0 && (
            <button
              className="btn danger sm"
              disabled={removeBulk.isPending}
              onClick={() => removeBulk.mutate([...selected])}
            >
              {removeBulk.isPending ? 'Deleting…' : `Delete ${selected.size} selected`}
            </button>
          )}
        </div>
      )}
      {topFiles.map((f) => {
        const isSite = f.mime_type === 'text/url-site';
        const kids = isSite ? childrenOf.get(f.id) ?? [] : [];
        const renderRow = (r: KnowledgeFile, indented = false) => (
          <div
            key={r.id}
            className="row"
            style={{ marginTop: 8, gap: 8, flexWrap: 'nowrap', ...(indented ? { marginLeft: 34 } : {}) }}
          >
            {/* Select-for-bulk lives OUTSIDE the card — it marks the row for
                the toolbar action above, it is not part of the source itself. */}
            {isAdmin && (
              <input
                type="checkbox"
                checked={selected.has(r.id)}
                aria-label={`Select ${r.name}`}
                title="Select for bulk delete"
                style={{ flexShrink: 0 }}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(r.id);
                    else next.delete(r.id);
                    return next;
                  })
                }
              />
            )}
            <div
              className="card"
              style={{ flex: 1, minWidth: 0, padding: 10, opacity: r.enabled ? 1 : 0.55 }}
            >
              <div className="row muted" style={{ fontSize: 13 }}>
                <button
                  className="link small muted"
                  style={{ padding: 0 }}
                  aria-label={openFiles.has(r.id) ? `Hide ${r.name} contents` : `View ${r.name} contents`}
                  title={
                    r.mime_type === 'text/url-site'
                      ? openFiles.has(r.id)
                        ? 'Hide pages'
                        : 'Show pages'
                      : openFiles.has(r.id)
                        ? 'Hide contents'
                        : 'View contents'
                  }
                  onClick={() =>
                    setOpenFiles((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.id)) next.delete(r.id);
                      else next.add(r.id);
                      return next;
                    })
                  }
                >
                  {openFiles.has(r.id) ? '▾' : '▸'}
                </button>
                {/* URLs-as-names are one long unbroken string — without a break
                    opportunity the text overflows its box and paints over the
                    row's buttons. */}
                <span className="grow" style={{ overflowWrap: 'anywhere' }}>
                  {r.source_url ? <Globe size={13} /> : <FileText size={13} />}{' '}
                  {/* URL sources name themselves — the visible text IS the
                      link; open the pasted page (not the normalized fetch
                      URL, which can be an export endpoint). */}
                  {r.source_url ? (
                    <a
                      className="src-link"
                      href={/^https?:\/\//i.test(r.name) ? r.name : r.source_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.name}
                    </a>
                  ) : (
                    r.name
                  )}
                  {r.topic ? <span className="badge" style={{ marginLeft: 6 }}>{r.topic}</span> : null}
                  {r.mime_type === 'text/url-site' ? (
                    <span className="muted">
                      {' '}— site · {kids.length} page{kids.length === 1 ? '' : 's'}
                      {kids.some((k) => k.chars)
                        ? ` · ~${tok(kids.reduce((n, k) => n + k.chars, 0))} tok`
                        : ''}
                    </span>
                  ) : (
                    <span className="muted">
                      {' '}— {r.chars.toLocaleString()} chars (~{tok(r.chars)} tok)
                    </span>
                  )}
                  {!r.enabled && <span className="muted"> · excluded</span>}
                  {r.enabled && data?.budget && r.chars > data.budget.limit && (
                    <span className="error"> · larger than the whole budget — always truncated</span>
                  )}
                  {r.has_headers && (
                    <span className="badge" style={{ marginLeft: 6 }} title="Crawls with stored auth headers">
                      auth
                    </span>
                  )}
                  {r.source_url && (
                    <span className="muted">
                      {' '}· fetched {r.last_fetched_at ? timeAgo(r.last_fetched_at) : 'never'}
                    </span>
                  )}
                  {r.source_url && r.text_changed_at && (
                    <span className="muted"> · updated {timeAgo(r.text_changed_at)}</span>
                  )}
                  {r.status === 'failed' && <span className="error"> {r.error}</span>}
                  {r.status === 'degraded' && <span className="error"> stale — {r.error}</span>}
                  {/* A page that left the site's listing explains why it's
                      excluded; plain user-excluded rows carry no error. */}
                  {r.error && !r.enabled && r.status !== 'failed' && r.status !== 'degraded' && (
                    <span className="muted"> · {r.error}</span>
                  )}
                </span>
                {/* The include/exclude checkbox read as an unlabeled third
                    box next to the select box — exclusion stays API-only, but
                    an already-excluded row always offers the way back. */}
                {!r.enabled && isAdmin && (
                  <button
                    className="btn sm"
                    title="Re-include this source in the agent's context"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ fileId: r.id, enabled: true })}
                  >
                    Re-include
                  </button>
                )}
                {r.source_url && isAdmin && (
                  <button
                    className="btn sm"
                    title={r.mime_type === 'text/url-site' ? 'Re-discover pages now' : 'Re-crawl now'}
                    aria-label="Re-crawl now"
                    disabled={refresh.isPending}
                    onClick={() => refresh.mutate(r.id)}
                  >
                    <RefreshCw size={13} className={refresh.isPending ? 'spin-ic' : ''} />
                  </button>
                )}
                {isAdmin && (
                  <button
                    className="btn danger sm"
                    onClick={() => remove.mutate(r.id)}
                    aria-label="Delete source"
                    title={r.mime_type === 'text/url-site' ? 'Delete site and all its pages' : 'Delete source'}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {/* Re-crawl cadence lives on its own row — the checkbox IS the
                  toggle (null = manual only), left-aligned under the globe so
                  it reads as this source's setting. On a site row it drives
                  re-discovery: new pages join, dead pages drop. */}
              {r.source_url && (
                <div className="row" style={{ marginTop: 6, fontSize: 12 }}>
                  {isAdmin ? (
                    <label className="row muted" style={{ gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={r.refresh_hours != null}
                        disabled={setRefresh.isPending}
                        aria-label={`Auto re-check ${r.name}`}
                        onChange={(e) =>
                          setRefresh.mutate({
                            fileId: r.id,
                            refresh_hours: e.target.checked ? 24 : null,
                          })
                        }
                      />
                      {r.mime_type === 'text/url-site'
                        ? `Re-check site every ${r.refresh_hours ?? 24}h`
                        : `Re-check every ${r.refresh_hours ?? 24}h`}
                      {!r.refresh_hours && <span> · manual only</span>}
                    </label>
                  ) : (
                    <span className="muted">
                      {r.refresh_hours ? `Re-checks every ${r.refresh_hours}h` : 'Manual refresh only'}
                    </span>
                  )}
                </div>
              )}
              {openFiles.has(r.id) && r.mime_type !== 'text/url-site' && (
                <SourceText agentId={agentId} fileId={r.id} />
              )}
              {openFiles.has(r.id) && isSite && kids.length === 0 && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  No pages under this site yet — the next re-check runs discovery again.
                </div>
              )}
            </div>
          </div>
        );
        return (
          <Fragment key={f.id}>
            {renderRow(f)}
            {isSite && openFiles.has(f.id) && kids.map((k) => renderRow(k, true))}
          </Fragment>
        );
      })}

      {/* Help-center articles — first-party row. Published articles inject
          into the prompt like any doc, and the same text serves the public
          help page. */}
      <div className="card" style={{ marginTop: 8, padding: 10 }}>
        <button
          className="row"
          style={{
            width: '100%',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: 13,
            padding: 0,
          }}
          onClick={() => setArticlesOpen((v) => !v)}
        >
          <span className="muted" style={{ fontSize: 16, width: 14 }}>{articlesOpen ? '▾' : '▸'}</span>
          <Newspaper size={14} />
          <span className="grow" style={{ marginLeft: 6 }}>
            <strong>Articles</strong>
            <span className="muted">
              {' '}— {published.length} published{drafts.length ? ` · ${drafts.length} draft${drafts.length === 1 ? '' : 's'}` : ''}
              {published.length ? ` · ~${tok(published.reduce((n, a) => n + a.body.length, 0))} tok` : ''}
            </span>
          </span>
        </button>
        {articlesOpen && articlesExtras}
        {articlesOpen && agent && (
          <div style={{ marginTop: 8 }}>
            <HelpCenter agent={agent} />
          </div>
        )}
      </div>

      {files.length === 0 && notes.length === 0 && articles.length === 0 && (
        <div className="card muted" style={{ marginTop: 10, fontSize: 13 }}>
          Nothing here yet — paste a link, drop a file, or write a note above.
        </div>
      )}
    </div>
  );
}
