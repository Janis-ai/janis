import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, HelpArticle } from '@janis/shared';
import { api } from '../api/client';

interface Form {
  title: string;
  slug: string;
  category: string;
  seo_title: string;
  seo_description: string;
  body: string;
}

const emptyForm: Form = { title: '', slug: '', category: 'General', seo_title: '', seo_description: '', body: '' };
const fromArticle = (a: HelpArticle): Form => ({
  title: a.title,
  slug: a.slug ?? '',
  category: a.category,
  seo_title: a.seo_title ?? '',
  seo_description: a.seo_description ?? '',
  body: a.body,
});

/**
 * Help-center manager for one agent — article CRUD + publish toggle, slug +
 * SEO fields, and the embed/custom-domain setup notes. The public URL is
 * shown so operators can link it from their site or widget.
 */
export function HelpCenter({ agent }: { agent: Agent }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['articles', agent.id],
    queryFn: () => api<{ articles: HelpArticle[] }>(`/api/articles?agent_id=${agent.id}`),
  });
  const { data: ws } = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api<{ workspace: { help_domain: string | null } }>('/api/workspace'),
  });
  const [editing, setEditing] = useState<HelpArticle | 'new' | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['articles', agent.id] });

  const payload = () => ({
    ...form,
    slug: form.slug.trim() || null,
    seo_title: form.seo_title.trim() || null,
    seo_description: form.seo_description.trim() || null,
  });

  const save = useMutation({
    mutationFn: (publish: boolean) =>
      editing === 'new'
        ? api('/api/articles', {
            method: 'POST',
            body: JSON.stringify({ agent_id: agent.id, ...payload(), status: publish ? 'published' : 'draft' }),
          })
        : api(`/api/articles/${(editing as HelpArticle).id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ...payload(), ...(publish ? { status: 'published' } : {}) }),
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
  const helpDomain = ws?.workspace.help_domain;
  const articles = data?.articles ?? [];

  return (
    <div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <strong>Public help center</strong>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              Articles customers can self-serve at{' '}
              <a href={publicUrl} target="_blank" rel="noreferrer">{publicUrl}</a>
              . Published articles also feed the agent's knowledge — answers
              never contradict the public KB.
            </p>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
              The chat widget links here automatically once an article is published.
              {helpDomain
                ? ` Custom domain: ${helpDomain} (CNAME → ${window.location.host}).`
                : ' Set a custom domain under Settings → Workspace to serve this at help.yourdomain.com.'}
            </p>
          </div>
          <button
            className="btn primary"
            onClick={() => {
              setForm(emptyForm);
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
          <div className="row" style={{ marginTop: 8 }}>
            <input
              placeholder="Category — e.g. Shipping, Billing"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              style={{ flex: 1 }}
            />
            <input
              placeholder="URL slug — blank generates from title"
              value={form.slug}
              onChange={(e) =>
                setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })
              }
              style={{ flex: 1 }}
            />
          </div>
          <input
            placeholder="SEO title (optional — defaults to article title)"
            value={form.seo_title}
            onChange={(e) => setForm({ ...form, seo_title: e.target.value })}
            style={{ width: '100%', marginTop: 8 }}
          />
          <input
            placeholder="SEO description (optional — defaults to the article opening)"
            value={form.seo_description}
            onChange={(e) => setForm({ ...form, seo_description: e.target.value })}
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
                {a.slug ? ` · /${a.slug}` : ''}
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
                  setForm(fromArticle(a));
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
