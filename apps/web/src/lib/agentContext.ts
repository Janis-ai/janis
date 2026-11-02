import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAgents, useMe } from '../api/hooks';

const LAST_AGENT_KEY = 'janis:last-agent';
const LAST_AGENTS_KEY = 'janis:last-agents';
// Explicit "All agents" — distinguished from "never chose" so a single-agent
// workspace auto-selects but can't trap a user who deliberately unscoped.
const UNSCOPED = '__none__';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Concierge/copilot replies link to console pages by name-slug
 *  (/agents/acme-returns/components) — agents have no slug field, so the
 *  param only resolves by matching the slugified name. */
/** True when Janis generates this agent's replies — hosted AND the default
 *  engine. False for external-webhook agents and migrated BYOK engines
 *  ('dialogflow' = legacy Dialogflow ES, 'monitor' = Chatfuel/ManyChat bots)
 *  where an outside platform owns the brain: knowledge, tools, components,
 *  tests, and prompt config don't apply to them. Note `hosted` alone is a
 *  transport flag — legacy engines are hosted:true because their inbound
 *  still flows through Janis ingest, inbox, and takeover tracking. */
export function janisBrain(
  a?: { hosted?: boolean; config?: { engine?: string } | null } | null,
): boolean {
  return !!a?.hosted && (a.config?.engine ?? 'hosted') === 'hosted';
}

/** Concierge/copilot replies link to console pages by name-slug
 *  (/agents/acme-returns/components) — agents have no slug field, so the
 *  param only resolves by matching the slugified name. */
export function agentSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Agent context is a single app-wide notion: the agent you're "inside".
 *  /agents/:id/* URLs carry it explicitly; everywhere else the persisted
 *  last-visited agent applies so the shared pages (Inbox, Contacts,
 *  Campaigns, Reports) still default to it and the sidebar keeps the
 *  agent's subsection. Cleared by the "All agents" scope pick or by
 *  choosing the workspace header in the switcher. */
/** The agent-id-or-slug segment of an /agents/… path. /agents/new/<id> is
 *  the builder's edit mode — the id being built IS the context agent so the
 *  sidebar's build nav tracks it; bare /agents/new (the path-choice and
 *  create screens) has no agent — 'new' is a route, never an agent name. */
export function agentPathParam(pathname: string): string | undefined {
  const built = pathname.match(/^\/agents\/new\/([^/]+)/)?.[1];
  if (built) return built;
  const p = pathname.match(/^\/agents\/([^/]+)/)?.[1];
  return p === 'new' ? undefined : p;
}

export function useAgentContext() {
  const location = useLocation();
  const navigate = useNavigate();
  const param = agentPathParam(location.pathname);
  const { data, isFetching } = useAgents();
  const wsId = useMe().data?.workspace?.id;
  // A non-uuid param is a name-slug — resolve it and swap the URL for the
  // canonical /agents/<uuid>/… so every downstream ?agent_id= call works.
  const resolved =
    param && !UUID_RE.test(param)
      ? data?.agents.find((a) => agentSlug(a.name) === param)?.id
      : param;
  useEffect(() => {
    if (!param || !resolved || !wsId) return;
    if (resolved !== param) {
      navigate(
        location.pathname.replace(`/agents/${param}`, `/agents/${resolved}`) +
          location.search +
          location.hash,
        { replace: true },
      );
    } else if (data && !isFetching && !data.agents.some((a) => a.id === resolved)) {
      // A uuid param absent from the settled list is a foreign or deleted
      // agent — bounce to the inbox instead of a dead 404, and never let
      // it into last-agent memory. isFetching gates the just-created race
      // (invalidate → navigate → refetch in flight); /agents/new/<id> is
      // the builder's own id and stays put.
      if (!location.pathname.startsWith('/agents/new/')) {
        navigate('/conversations', { replace: true });
      }
      return;
    }
    // Only real ids persist — a slug or typo stored here would poison the
    // workspace-wide badge/default until something else overwrote it.
    setLastAgent(resolved, wsId);
  }, [param, resolved, wsId, data, isFetching]);
  return resolved ?? param;
}

/** Where a stashed post-login deep link may replay: only for the account +
 *  workspace that captured it, and only when an /agents/<uuid> target
 *  still exists in that workspace's agent list. Returns null to drop —
 *  storage is per-origin, so an unverified stash replays foreign URLs, and
 *  an identity-matched stash of a bad URL replays its own 404 forever. */
export function postLoginTarget(
  raw: string | null,
  me: { userId: string; workspaceId: string | null },
  agentIds: string[],
): string | null {
  if (!raw) return null;
  let s: { next?: string; u?: string | null; w?: string | null };
  try {
    s = JSON.parse(raw);
  } catch {
    return null; // legacy plain-string stash — no identity to verify
  }
  const next = s.next;
  if (!next || s.u !== me.userId || s.w !== me.workspaceId) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  const agentId = next.match(/^\/agents\/(?:new\/)?([0-9a-f-]{36})(?:\/|$)/i)?.[1];
  if (agentId && !agentIds.includes(agentId)) return null;
  return next;
}

/** A persisted last-agent id is usable only while it names an agent in the
 *  current workspace's list — a foreign/stale id (workspace switch, revoked
 *  grant, deleted agent) sent as ?agent_id= correctly returns nothing
 *  server-side, which reads as an empty inbox. Undefined agents means the
 *  list is still loading; the stored id is trusted then (the common case)
 *  rather than flashing the unscoped view. */
export function contextAgentStale(
  stored: string | null,
  agents: { id: string }[] | undefined,
): boolean {
  return !!stored && !!agents && !agents.some((a) => a.id === stored);
}

/** The effective context agent: the URL's when on an agent route, else the
 *  persisted last-visited agent FOR THIS WORKSPACE (each workspace
 *  remembers its own — switching back restores it), dropped when stale.
 *  A single-agent workspace auto-selects that agent unless the user
 *  explicitly chose the "All agents" scope. */
export function useContextAgent(): string | null {
  const urlAgent = useAgentContext();
  const { data } = useAgents();
  const wsId = useMe().data?.workspace?.id;
  const stored = urlAgent || !wsId ? null : lastAgentId(wsId);
  const stale = contextAgentStale(stored, data?.agents);
  useEffect(() => {
    // Stale (deleted/foreign) isn't an explicit unscope — forget, don't mark.
    if (stale && wsId) forgetLastAgent(wsId);
  }, [stale, wsId]);
  const solo =
    !urlAgent && !stored && !stale && wsId && !agentUnscoped(wsId) && data?.agents.length === 1
      ? data.agents[0].id
      : null;
  useEffect(() => {
    if (solo && wsId) setLastAgent(solo, wsId);
  }, [solo, wsId]);
  return urlAgent ?? (stale ? null : stored) ?? solo;
}

function readAgentMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_AGENTS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeAgentMap(m: Record<string, string>) {
  try {
    localStorage.setItem(LAST_AGENTS_KEY, JSON.stringify(m));
  } catch {
    /* private mode */
  }
}

export function lastAgentId(workspaceId: string): string | null {
  const map = readAgentMap();
  let id = map[workspaceId];
  // Migrate the pre-map single key into this workspace's slot on first read.
  if (id === undefined) {
    try {
      const legacy = localStorage.getItem(LAST_AGENT_KEY);
      if (legacy) {
        id = legacy;
        map[workspaceId] = legacy;
        writeAgentMap(map);
        localStorage.removeItem(LAST_AGENT_KEY);
      }
    } catch {
      /* private mode */
    }
  }
  // Slugs/typos that slipped in before the uuid gate must not keep
  // poisoning ?agent_id= calls — drop them on read.
  return id && UUID_RE.test(id) ? id : null;
}

/** True when the user deliberately chose "All agents" for this workspace —
 *  blocks single-agent auto-select until they pick an agent again. */
export function agentUnscoped(workspaceId: string): boolean {
  return readAgentMap()[workspaceId] === UNSCOPED;
}

/** The four shared pages exist in both scopes — workspace path ↔ the
 *  agent-context section name used in /agents/:id/<section> URLs. */
const WS_TO_SECTION: Record<string, string> = {
  conversations: 'inbox',
  contacts: 'contacts',
  campaigns: 'campaigns',
  reports: 'reports',
};
export const SECTION_TO_WS = {
  inbox: 'conversations',
  contacts: 'contacts',
  campaigns: 'campaigns',
  reports: 'reports',
} as const;

/** Where a context-switcher pick should land so the surface survives the
 *  re-scope: a shared page maps to the same section on the new scope, an
 *  agent sub-page swaps the agent id. Entity detail paths (a selected
 *  conversation, contact or channel) can't follow INTO an agent's scope —
 *  the id may not belong to it — so agent picks get the section root;
 *  scoping OUT to all-agents keeps the entity (it's still visible there).
 *  Everything else falls back to the agent overview / workspace inbox. */
export function contextSwitchTarget(pathname: string, agentId: string | null): string {
  const ws = pathname.match(/^\/(conversations|contacts|campaigns|reports)(\/.*)?$/);
  if (ws) {
    return agentId ? `/agents/${agentId}/${WS_TO_SECTION[ws[1]]}` : `/${ws[1]}${ws[2] ?? ''}`;
  }
  const scoped = pathname.match(/^\/agents\/([^/]+)\/(.+)$/);
  if (scoped) {
    const [, id, sub] = scoped;
    if (id === 'new') return agentId ? `/agents/new/${agentId}` : '/conversations';
    const section = sub.split('/')[0];
    const rest = sub.slice(section.length);
    if (agentId) return `/agents/${agentId}/${section}`;
    const wsPath = (SECTION_TO_WS as Record<string, string>)[section];
    return wsPath ? `/${wsPath}${rest}` : '/conversations';
  }
  return agentId ? `/agents/${agentId}` : '/conversations';
}

export function setLastAgent(id: string, workspaceId: string) {
  const map = readAgentMap();
  map[workspaceId] = id;
  writeAgentMap(map);
}

/** Explicit unscope — remembers "All agents" per workspace. */
export function clearLastAgent(workspaceId: string) {
  const map = readAgentMap();
  map[workspaceId] = UNSCOPED;
  writeAgentMap(map);
}

/** Evict without intent — stale/deleted ids get removed, not marked
 *  unscoped, so auto-select logic can still apply. */
export function forgetLastAgent(workspaceId: string) {
  const map = readAgentMap();
  delete map[workspaceId];
  writeAgentMap(map);
}
