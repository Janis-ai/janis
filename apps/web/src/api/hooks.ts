import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Agent,
  Alert,
  AlertRule,
  Channel,
  Conversation,
  Digest,
  Message,
  SavedReply,
  Suggestion,
  WebhookDelivery,
  WorkspaceUser,
} from '@janis/shared';
import { api, ApiError } from './client';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api<{
        user: WorkspaceUser;
        workspace: { id: string; name: string } | null;
        workspaces: { id: string; name: string; role: 'admin' | 'member' }[];
        /** Set when the user holds no workspace membership — only these
         *  agents are visible (agent-scoped grants via the Team override). */
        agent_scope: { id: string; name: string; role: string }[] | null;
        invites: { id: string; workspace_name: string }[];
        support_channel_id: string | null;
      }>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}

export function useConversations(filter: {
  state?: string;
  agent_id?: string;
  attention?: boolean;
  mine?: boolean;
}) {
  const params = new URLSearchParams();
  if (filter.state) params.set('state', filter.state);
  if (filter.agent_id) params.set('agent_id', filter.agent_id);
  if (filter.attention) params.set('attention', '1');
  if (filter.mine) params.set('assignee', 'me');
  return useQuery({
    queryKey: ['conversations', filter],
    queryFn: () => api<{ conversations: Conversation[] }>(`/api/conversations?${params}`),
    refetchInterval: 30_000,
  });
}

export function useConversation(id: string) {
  return useQuery({
    queryKey: ['conversation', id],
    queryFn: () =>
      api<{
        conversation: Conversation;
        messages: Message[];
        messages_has_more?: boolean;
        alerts: Alert[];
        suggestions: Suggestion[];
      }>(`/api/conversations/${id}`),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 3,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: Agent[] }>('/api/agents'),
  });
}

export function useAlertRules() {
  return useQuery({
    queryKey: ['rules'],
    queryFn: () => api<{ rules: AlertRule[] }>('/api/rules'),
  });
}

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: WorkspaceUser[] }>('/api/users'),
  });
}

export function useSavedReplies(agentId?: string) {
  return useQuery({
    queryKey: ['savedReplies', agentId ?? null],
    queryFn: () =>
      api<{ saved_replies: SavedReply[] }>(
        `/api/saved-replies${agentId ? `?agent_id=${agentId}` : ''}`,
      ),
  });
}

export interface AgentMember {
  user_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  /** null = inherit the workspace role */
  role: 'admin' | 'member' | null;
  display_name: string | null;
  avatar_override: string | null;
  show_identity: boolean | null;
  notify: { push?: boolean; email?: boolean; sound?: boolean } | null;
  status: 'active' | 'invited';
}

/** Per-agent grants/overrides — one row per (agent, user). */
export function useAgentMembers(agentId: string | undefined) {
  return useQuery({
    queryKey: ['agentMembers', agentId],
    enabled: !!agentId,
    queryFn: () => api<{ members: AgentMember[] }>(`/api/agents/${agentId}/members`),
  });
}

export function useDigests() {
  return useQuery({
    queryKey: ['digests'],
    queryFn: () => api<{ digests: Digest[] }>('/api/digests'),
  });
}

export function useSearch(
  q: string,
  filter: { state?: string; agent_id?: string; attention?: boolean; mine?: boolean } = {},
) {
  const params = new URLSearchParams();
  params.set('q', q);
  if (filter.state) params.set('state', filter.state);
  if (filter.agent_id) params.set('agent_id', filter.agent_id);
  if (filter.attention) params.set('attention', '1');
  if (filter.mine) params.set('assignee', 'me');
  return useQuery({
    queryKey: ['search', q, filter],
    queryFn: () =>
      api<{ conversations: Conversation[]; messages: Message[] }>(`/api/search?${params}`),
    enabled: q.trim().length > 0,
  });
}

export function useSlackStatus() {
  return useQuery({
    queryKey: ['slackStatus'],
    queryFn: () =>
      api<{ connected: boolean; team_id: string | null; alert_channel_id: string | null; configured: boolean }>(
        '/api/slack/status',
      ),
  });
}

export function useChannels() {
  return useQuery({
    queryKey: ['channels'],
    queryFn: () => api<{ channels: Channel[] }>('/api/channels'),
  });
}

export function useDeliveries(agentId: string | null) {
  return useQuery({
    queryKey: ['deliveries', agentId],
    queryFn: () => api<{ deliveries: WebhookDelivery[] }>(`/api/agents/${agentId}/deliveries`),
    enabled: !!agentId,
    refetchInterval: 15_000,
  });
}

export function useSlackChannels(enabled: boolean) {
  return useQuery({
    queryKey: ['slackChannels'],
    queryFn: () => api<{ channels: { id: string; name: string }[] }>('/api/slack/channels'),
    enabled,
  });
}

export function useAttentionCount() {
  return useQuery({
    queryKey: ['attention-count'],
    queryFn: () => api<{ count: number }>('/api/conversations/attention-count'),
    refetchInterval: 60_000,
  });
}

export function useInvalidateConversations() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['conversation'] });
  };
}
