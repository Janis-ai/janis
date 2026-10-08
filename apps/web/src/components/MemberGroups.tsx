import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, X } from 'lucide-react';
import { api } from '../api/client';
import { useGroups } from '../api/hooks';

/** Named teammate rosters. Routing rules reference groups so "rotate through
 *  Support Tier 1" survives roster edits — the rule holds the group id, the
 *  group's member list changes underneath it. agentId unset = workspace-wide
 *  groups (usable on every agent); set = rosters scoped to one agent, whose
 *  eligible members come from `roster` (workspace roster ∪ agent members). */
export function MemberGroups({
  agentId,
  roster,
  canManage,
}: {
  agentId?: string;
  roster: { id: string; name: string }[];
  canManage: boolean;
}) {
  const { data: groupsData } = useGroups();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const groups = (groupsData?.groups ?? []).filter((g) =>
    agentId ? g.agent_id === agentId : !g.agent_id,
  );
  const memberName = (id: string) => roster.find((u) => u.id === id)?.name ?? '…';

  const refresh = () => void qc.invalidateQueries({ queryKey: ['groups'] });
  const create = useMutation({
    mutationFn: (body: { name: string; member_ids: string[] }) =>
      api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ ...body, agent_id: agentId ?? null }),
      }),
    onSuccess: () => {
      setName('');
      setPicked([]);
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (body: { id: string; member_ids: string[] }) =>
      api(`/api/groups/${body.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ member_ids: body.member_ids }),
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/groups/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const togglePick = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>{agentId ? 'Agent groups' : 'Groups'}</strong>
      <div className="muted" style={{ margin: '6px 0 4px', fontSize: 13 }}>
        {agentId
          ? 'Named rosters this agent\u2019s routing rules rotate through. Workspace groups apply too — agent groups are for rosters only this agent should use.'
          : 'Named rosters that every agent\u2019s routing rules can rotate through — e.g. "Support Tier 1". Rules hold the group, so roster edits here apply everywhere the group is used.'}
      </div>
      {groups.map((g) => (
        <div key={g.id} className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <strong style={{ marginRight: 6 }}>{g.name}</strong>
          {g.member_ids.map((id) => (
            <span key={id} className="badge" style={{ marginRight: 4 }}>
              {memberName(id)}
              {canManage && (
                <button
                  className="btn ghost"
                  style={{ padding: '0 2px', marginLeft: 2 }}
                  aria-label={`Remove ${memberName(id)}`}
                  onClick={() =>
                    update.mutate({ id: g.id, member_ids: g.member_ids.filter((x) => x !== id) })
                  }
                >
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
          {canManage && (
            <>
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  update.mutate({ id: g.id, member_ids: [...new Set([...g.member_ids, e.target.value])] });
                }}
                style={{ width: 130 }}
              >
                <option value="">+ member…</option>
                {roster
                  .filter((u) => !g.member_ids.includes(u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
              </select>
              <button className="btn danger" onClick={() => remove.mutate(g.id)} aria-label="Delete group">
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      ))}
      {canManage && (
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 10 }}>
          <div className="row">
            <input
              style={{ width: 200 }}
              placeholder="Group name — e.g. Support Tier 1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            {roster.map((u) => (
              <label key={u.id} className="check-label" style={{ marginRight: 10 }}>
                <input
                  type="checkbox"
                  checked={picked.includes(u.id)}
                  onChange={() => togglePick(u.id)}
                />
                {u.name}
              </label>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn"
              disabled={!name.trim() || picked.length === 0}
              onClick={() => create.mutate({ name: name.trim(), member_ids: picked })}
            >
              Create group
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
