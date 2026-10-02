import { Bot } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAgents } from '../api/hooks';
import { clearLastAgent, setLastAgent } from '../lib/agentContext';

const WS_PATH: Record<string, string> = {
  inbox: 'conversations',
  contacts: 'contacts',
  campaigns: 'campaigns',
  reports: 'reports',
};

/** The agent-context control on the shared pages (Inbox, Contacts,
 *  Campaigns, Reports). This is not a local filter — picking an agent puts
 *  the whole app inside that agent's context (sidebar subsection, Copilot
 *  scoping) and "All agents" clears it. */
export function AgentScopePicker({ slug, value }: { slug: keyof typeof WS_PATH; value?: string }) {
  const { data } = useAgents();
  const navigate = useNavigate();
  const agents = [...(data?.agents ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  if (!agents.length) return null;
  return (
    <div className="scope-picker" title="Agent context — applies across Inbox, Contacts, Campaigns, Reports and the sidebar">
      <Bot size={14} />
      <select
        aria-label="Agent context"
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v) {
            setLastAgent(v);
            navigate(`/agents/${v}/${slug}`);
          } else {
            clearLastAgent();
            navigate(`/${WS_PATH[slug]}`);
          }
        }}
      >
        <option value="">All agents</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
    </div>
  );
}
