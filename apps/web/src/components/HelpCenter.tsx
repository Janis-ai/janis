import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, HelpArticle } from '@janis/shared';
import { api } from '../api/client';

/**
 * Help-center manager for one agent — article CRUD + publish toggle. The
 * public URL is shown so operators can link it from their site or widget.
 */
export function HelpCenter({ agent }: { agent: Agent }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['articles', agent.id],
    queryFn: () => api<{ articles: HelpArticle[] }>(`/api/articles?agent_id=${agent.id}`),
  });
  const [editing, setEditing] = useState<HelpArticle | 'new' | null>(null);
  const [form, setForm] = useState({ title: '', category: 'General', body: '' });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['articles', agent.id] });

  const save = useMutation({
    mutationFn: (publish: boolean) =>
      editing === 'new'
        ? api('/api/articles', {
            method: 'POST',
            body: JSON.stringify({ agent_id: agent.id, ...form, status: publish ? 'published' : 'draft' }),
          })
        : api(`/api/articles/${(editing as HelpArticle).id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ...form, ...(publish ? { status: 'published' } : {}) }),
          }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });

  const toggle = useMutation({
    mutationFn: (a: HelpArticle) =>
      api(`/api/articles/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: a.status === 'published' ? 'draft' : 'published' }),
      }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (a: HelpArticle) => api(`/api/articles/${a.id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const publicUrl = `${window.location.origin}/help/${agent.id}`;
  const articles = data?.articles ?? [];

  return (
    <div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <strong>Public help center</strong>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              Articles customers can self-serve at{' '}
              <a href={publicUrl} target="_blank" rel="noreferrer">{publicUrl}</a>
              . Published articles also feed the agent's knowledge — answers
              never contradict the public KB.
            </p>
          </div>
          <button
            className="btn primary"
            onClick={() => {
              setForm({ title: '', category: 'General', body: '' });
              setEditing('new');
            }}
          >
            New article
          </button>
        </div>
      </div>

      {editing && (
        <div className="card">
          <strong>{editing === 'new' ? 'New article' : 'Edit article'}</strong>
          <input
            placeholder="Title — e.g. How do I return an order?"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            style={{ width: '100%', marginTop: 10 }}
          />
          <input
            placeholder="Category — e.g. Shipping, Billing"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            style={{ width: '100%', marginTop: 8 }}
          />
          <textarea
            rows={12}
            placeholder="Article body — plain text. The agent answers from this verbatim once published."
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            style={{ width: '100%', marginTop: 8 }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn primary sm"
              disabled={!form.title.trim() || save.isPending}
              onClick={() => save.mutate(true)}
            >
              {save.isPending ? 'Saving…' : 'Save & publish'}
            </button>
            <button
              className="btn sm"
              disabled={!form.title.trim() || save.isPending}
              onClick={() => save.mutate(false)}
            >
              Save draft
            </button>
            <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {articles.map((a) => (
        <div key={a.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{a.title}</strong>
              <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                {a.category} · {a.status}
                {a.published_at ? ` · published ${new Date(a.published_at).toLocaleDateString()}` : ''}
              </span>
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => toggle.mutate(a)}>
                {a.status === 'published' ? 'Unpublish' : 'Publish'}
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  setForm({ title: a.title, category: a.category, body: a.body });
                  setEditing(a);
                }}
              >
                Edit
              </button>
              <button className="btn sm danger" onClick={() => remove.mutate(a)}>Delete</button>
            </div>
          </div>
        </div>
      ))}
      {articles.length === 0 && !editing && (
        <div className="card muted">No articles yet — publish your FAQ here and the agent will answer from it too.</div>
      )}
    </div>
  );
}
