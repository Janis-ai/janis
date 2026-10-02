import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const LAST_AGENT_KEY = 'janis:last-agent';

/** Agent context is a single app-wide notion: the agent you're "inside".
 *  /agents/:id/* URLs carry it explicitly; everywhere else the persisted
 *  last-visited agent applies so the shared pages (Inbox, Contacts,
 *  Campaigns, Reports) still default to it and the sidebar keeps the
 *  agent's subsection. Cleared by the "All agents" scope pick or by
 *  choosing the workspace header in the switcher. */
export function useAgentContext() {
  const location = useLocation();
  const id = location.pathname.match(/^\/agents\/([^/]+)/)?.[1];
  useEffect(() => {
    if (id) setLastAgent(id);
  }, [id]);
  return id;
}

/** The effective context agent: the URL's when on an agent route, else the
 *  persisted last-visited agent. Not reactive on its own — context always
 *  changes alongside a navigation, which re-renders the tree. */
export function useContextAgent(): string | null {
  return useAgentContext() ?? lastAgentId();
}

export function lastAgentId(): string | null {
  try {
    return localStorage.getItem(LAST_AGENT_KEY);
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
