import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Agent, AgentConfig } from '@janis/shared';
import { api } from '../api/client';
import { useAgentMembers, useAlertRules, useUsers } from '../api/hooks';

/** Deploy-step card — the escalation baseline the onboarding flow never
 *  asked about: who gets paged on a handoff, whether an unclaimed one
 *  re-alerts, and the one place a first-timer meets "invite a teammate"
 *  (scoped to this agent by default — the client-operator/VA case — since
 *  that's who escalations usually go to). Everything writes immediately;
 *  the full rule engine stays in Agent settings → Escalation. */
export function DeployEscalation({
  agent,
  cfg,
  setCfg,
  isAdmin,
}: {
  agent: Agent;
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const { data: users } = useUsers();
  const { data: members } = useAgentMembers(agent.id);
  const { data: rulesData } = useAlertRules();
  const [err, setErr] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteScope, setInviteScope] = useState<'agent' | 'workspace'>('agent');
  const [invitedFlash, setInvitedFlash] = useState('');

  const handoffRule = (rulesData?.rules ?? []).find(
    (r) => r.agent_id === agent.id && r.kind === 'handoff_request',
  );
  const routedIds = [
    ...(handoffRule?.config.assign_to ? [handoffRule.config.assign_to] : []),
    ...(handoffRule?.config.assignees ?? []),
  ];
  const routed = routedIds.length > 0 || (handoffRule?.config.group_ids?.length ?? 0) > 0;

  // Roster — the same union the Escalation settings picker draws from:
  // workspace members (incl. pending invites) plus agent-scoped grants
  // (client operators, VAs — users who see only this agent).
  const roster = [
    ...(users?.users ?? []).map((u) => ({
      id: u.id,
      label: u.name,
      invited: u.status === 'invited',
    })),
    ...(members?.members ?? [])
      .filter((m) => !(users?.users ?? []).some((u) => u.id === m.user_id))
      .map((m) => ({
        id: m.user_id,
        label: m.name || m.email,
        invited: m.status === 'invited',
      })),
  ];

  // Routing writes — a handoff_request rule carries assign_to/assignees.
  // No rule (or routing keys cleared) = the built-in default: page the
  // whole workspace. PATCH replaces config wholesale, so unrelated keys
  // (tag, enabled, next) ride along untouched.
  const saveRouting = useMutation({
    mutationFn: (ids: string[]) => {
      if (handoffRule) {
        const config = {
          ...handoffRule.config,
          assign_to: ids.length === 1 ? ids[0] : undefined,
          assignees: ids.length > 1 ? ids : undefined,
          group_ids: undefined, // group rosters are a settings-page power feature
        };
        return api(`/api/rules/${handoffRule.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ config }),
        });
      }
      if (!ids.length) return Promise.resolve();
      return api('/api/rules', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agent.id,
          kind: 'handoff_request',
          config: {
            enabled: true,
            ...(ids.length === 1
              ? { assign_to: ids[0] }
              : { assignees: ids, next: 0 }),
          },
        }),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['rules'] }),
    onError: (e) => setErr(e.message),
  });

  const togglePerson = (id: string) => {
    const next = routedIds.includes(id)
      ? routedIds.filter((x) => x !== id)
      : [...routedIds, id];
    saveRouting.mutate(next);
  };

  // SLA + auto-assign are agent config — write through immediately (the
  // deploy step has no Save button) and mirror into the shared draft so a
  // later teach/guide save doesn't clobber them.
  const saveEscConfig = useMutation({
    mutationFn: (patch: Pick<AgentConfig, 'sla_minutes' | 'auto_assign'>) => {
      const config = { ...agent.config, ...patch } as AgentConfig;
      return api(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      }).then(() => patch);
    },
    onSuccess: (patch) => {
      setCfg({ ...cfg, ...patch });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (e) => setErr(e.message),
  });

  // Invite — agent scope is the default: the person who handles THIS
  // agent's escalations sees only its inbox (auto-accepted on sign-in).
  // Workspace scope is a full teammate — pending until they accept.
  const invite = useMutation({
    mutationFn: (b: { email: string; name?: string; scope: 'agent' | 'workspace' }) =>
      b.scope === 'agent'
        ? api(`/api/agents/${agent.id}/members`, {
            method: 'POST',
            body: JSON.stringify({ email: b.email, ...(b.name ? { name: b.name } : {}), role: 'member' }),
          })
        : api('/api/users', {
            method: 'POST',
            body: JSON.stringify({ email: b.email, ...(b.name ? { name: b.name } : {}), role: 'member' }),
          }),
    onSuccess: (_, b) => {
      setInvitedFlash(b.email);
      setInviteEmail('');
      setInviteName('');
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['agentMembers', agent.id] });
    },
    onError: (e) => setErr(e.message),
  });

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>When the agent needs a human</strong>
      <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
        Handoffs happen — a customer asks for a person, the agent hits
        something it can't do, or a rule trips. Who should be told?
      </div>

      <div style={{ marginTop: 10 }}>
        <label className="check-label" style={{ display: 'flex', gap: 6 }}>
          <input
            type="radio"
            name="esc-route"
            disabled={!isAdmin || saveRouting.isPending}
            checked={!routed}
            onChange={() => saveRouting.mutate([])}
          />
          <span>
            <strong>Everyone</strong>
            <span className="muted">
              {' '}
              — lands in the workspace Inbox for whoever's watching
              {roster.length <= 1 ? ' (just you right now)' : ''}
            </span>
          </span>
        </label>
        <label className="check-label" style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            type="radio"
            name="esc-route"
            disabled={!isAdmin || saveRouting.isPending}
            checked={routed}
            onChange={() => {
              // Switching modes needs at least one person — no-op until
              // they check a name below.
            }}
          />
          <span>
            <strong>Specific people</strong>
            <span className="muted"> — pages just them (rotates when more than one)</span>
          </span>
        </label>
        {routed && (
          <div style={{ margin: '6px 0 0 24px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {roster.map((p) => (
              <label key={p.id} className="check-label" style={{ display: 'flex', gap: 6 }}>
                <input
                  type="checkbox"
                  disabled={!isAdmin || saveRouting.isPending}
                  checked={routedIds.includes(p.id)}
                  onChange={() => togglePerson(p.id)}
                />
                <span>
                  {p.label}
                  {p.invited && <span className="badge" style={{ marginLeft: 6 }}>invited</span>}
                </span>
              </label>
            ))}
            {roster.length === 0 && (
              <span className="muted" style={{ fontSize: 12 }}>
                Nobody to route to yet — invite someone below.
              </span>
            )}
          </div>
        )}
      </div>

      <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="muted" style={{ fontSize: 13 }}>Re-alert if nobody picks it up in</label>
        <input
          type="number"
          min={1}
          className="num-input"
          style={{ width: 64 }}
          placeholder="min"
          disabled={!isAdmin || saveEscConfig.isPending}
          defaultValue={cfg.sla_minutes ?? ''}
          key={`sla-${cfg.sla_minutes ?? 'x'}`}
          onBlur={(e) => {
            const v = e.target.value ? Number(e.target.value) : undefined;
            if (v !== cfg.sla_minutes) saveEscConfig.mutate({ sla_minutes: v });
          }}
        />
        <span className="muted" style={{ fontSize: 12 }}>minutes — blank = never</span>
      </div>
      <label className="check-label" style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          type="checkbox"
          disabled={!isAdmin || saveEscConfig.isPending}
          checked={cfg.auto_assign ?? false}
          onChange={(e) => saveEscConfig.mutate({ auto_assign: e.target.checked })}
        />
        <span>Auto-assign each handoff to the least-loaded person</span>
      </label>
      {handoffRule?.config.enabled === false && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Heads up — the handoff alert is muted in Settings → Escalation.
        </div>
      )}

      <div style={{ marginTop: 14, borderTop: '1px solid var(--line, #333)', paddingTop: 12 }}>
        <strong style={{ fontSize: 13 }}>Need someone on escalations?</strong>
        <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
          <input
            type="email"
            placeholder="email"
            required
            style={{ minWidth: 200 }}
            value={inviteEmail}
            disabled={!isAdmin || invite.isPending}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <input
            placeholder="name (optional)"
            style={{ minWidth: 120 }}
            value={inviteName}
            disabled={!isAdmin || invite.isPending}
            onChange={(e) => setInviteName(e.target.value)}
          />
          <select
            value={inviteScope}
            disabled={!isAdmin || invite.isPending}
            onChange={(e) => setInviteScope(e.target.value as 'agent' | 'workspace')}
          >
            <option value="agent">this agent only</option>
            <option value="workspace">all agents</option>
          </select>
          <button
            className="btn"
            disabled={!isAdmin || invite.isPending || !inviteEmail.trim()}
            onClick={() =>
              invite.mutate({
                email: inviteEmail.trim(),
                name: inviteName.trim() || undefined,
                scope: inviteScope,
              })
            }
          >
            {invite.isPending ? 'Inviting…' : 'Invite'}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          "This agent only" shows them just this agent's inbox — a client
          operator or VA. "All agents" is a full workspace teammate. They
          sign in with Google or Slack.
        </div>
        {invitedFlash && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            ✓ Invite sent to {invitedFlash}
          </div>
        )}
      </div>
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
