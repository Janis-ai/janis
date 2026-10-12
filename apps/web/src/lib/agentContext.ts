import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAgents } from '../api/hooks';

const LAST_AGENT_KEY = 'janis:last-agent';
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
  const { data } = useAgents();
  // A non-uuid param is a name-slug — resolve it and swap the URL for the
  // canonical /agents/<uuid>/… so every downstream ?agent_id= call works.
  const resolved =
    param && !UUID_RE.test(param)
      ? data?.agents.find((a) => agentSlug(a.name) === param)?.id
      : param;
  useEffect(() => {
    if (!param || !resolved) return;
    if (resolved !== param) {
      navigate(
        location.pathname.replace(`/agents/${param}`, `/agents/${resolved}`) +
          location.search +
          location.hash,
        { replace: true },
      );
    }
    // Only real ids persist — a slug or typo stored here would poison the
    // workspace-wide badge/default until something else overwrote it.
    setLastAgent(resolved);
  }, [param, resolved]);
  return resolved ?? param;
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
 *  persisted last-visited agent, dropped (and cleared) when stale. */
export function useContextAgent(): string | null {
  const urlAgent = useAgentContext();
  const { data } = useAgents();
  const stored = urlAgent ? null : lastAgentId();
  const stale = contextAgentStale(stored, data?.agents);
  useEffect(() => {
    if (stale) clearLastAgent();
  }, [stale]);
  return urlAgent ?? (stale ? null : stored);
}

export function lastAgentId(): string | null {
  try {
    const id = localStorage.getItem(LAST_AGENT_KEY);
    // Slugs/typos that slipped in before the uuid gate must not keep
    // poisoning ?agent_id= calls — drop them on read.
    return id && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function setLastAgent(id: string) {
  try {
    localStorage.setItem(LAST_AGENT_KEY, id);
  } catch {
    /* private mode */
  }
}

export function clearLastAgent() {
  try {
    localStorage.removeItem(LAST_AGENT_KEY);
  } catch {
    /* private mode */
  }
}
