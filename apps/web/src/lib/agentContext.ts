import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const LAST_AGENT_KEY = 'janis:last-agent';

/** Agent context is URL-driven: every /agents/:id/* path is "inside" that
 *  agent, and anything else is workspace context. The last visited agent
 *  persists so the switcher can check it and Copilot stays scoped after a
 *  refresh deep-link into the workspace layer. */
export function useAgentContext() {
  const location = useLocation();
  const id = location.pathname.match(/^\/agents\/([^/]+)/)?.[1];
  useEffect(() => {
    if (id) {
      try {
        localStorage.setItem(LAST_AGENT_KEY, id);
      } catch {
        /* private mode */
      }
    }
  }, [id]);
  return id;
}

export function lastAgentId(): string | null {
  try {
    return localStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}
