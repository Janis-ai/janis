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
export function useAgentContext() {
  const location = useLocation();
  const navigate = useNavigate();
  const param = location.pathname.match(/^\/agents\/([^/]+)/)?.[1];
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

/** The effective context agent: the URL's when on an agent route, else the
 *  persisted last-visited agent. Not reactive on its own — context always
 *  changes alongside a navigation, which re-renders the tree. */
export function useContextAgent(): string | null {
  return useAgentContext() ?? lastAgentId();
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
