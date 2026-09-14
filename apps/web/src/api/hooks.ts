import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Agent,
  Alert,
  AlertRule,
  Conversation,
  Digest,
  Message,
  SavedReply,
  Suggestion,
  WorkspaceUser,
} from '@janis/shared';
import { api } from './client';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ user: WorkspaceUser; workspace: { id: string; name: string } }>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}

export function useConversations(filter: { state?: string; agent_id?: string; attention?: boolean }) {
  const params = new URLSearchParams();
  if (filter.state) params.set('state', filter.state);
  if (filter.agent_id) params.set('agent_id', filter.agent_id);
  if (filter.attention) params.set('attention', '1');
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
        alerts: Alert[];
        suggestions: Suggestion[];
      }>(`/api/conversations/${id}`),
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

export function useSavedReplies() {
  return useQuery({
    queryKey: ['savedReplies'],
    queryFn: () => api<{ saved_replies: SavedReply[] }>('/api/saved-replies'),
  });
}

export function useDigests() {
  return useQuery({
    queryKey: ['digests'],
    queryFn: () => api<{ digests: Digest[] }>('/api/digests'),
  });
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: ['search', q],
    queryFn: () =>
      api<{ conversations: Conversation[]; messages: Message[] }>(
        `/api/search?q=${encodeURIComponent(q)}`,
      ),
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

export function useSlackChannels(enabled: boolean) {
  return useQuery({
    queryKey: ['slackChannels'],
    queryFn: () => api<{ channels: { id: string; name: string }[] }>('/api/slack/channels'),
    enabled,
  });
}

export function useInvalidateConversations() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['conversation'] });
  };
}
