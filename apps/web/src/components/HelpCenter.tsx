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
  const [domainDraft, setDomainDraft] = useState<string | null>(null);
  const [domainMsg, setDomainMsg] = useState('');
  const [helpUrlDraft, setHelpUrlDraft] = useState<string | null>(null);
  const [helpUrlMsg, setHelpUrlMsg] = useState('');

  const saveAgentConfig = (key: 'help_domain' | 'help_url', value: string | null) =>
    api(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ config: { ...(agent.config ?? {}), [key]: value } }),
    });

  const saved = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['agent', agent.id] });
  };

  const saveDomain = useMutation({
    mutationFn: (value: string | null) => saveAgentConfig('help_domain', value),
    onSuccess: () => {
      setDomainMsg('Saved — point the domain\'s CNAME at this app host.');
      saved();
    },
    onError: (e) => setDomainMsg(e instanceof Error ? e.message : 'failed'),
  });

  const saveHelpUrl = useMutation({
    mutationFn: (value: string | null) => saveAgentConfig('help_url', value),
    onSuccess: () => {
      setHelpUrlMsg('Saved — the widget\'s help button now points there.');
      saved();
    },
    onError: (e) => setHelpUrlMsg(e instanceof Error ? e.message : 'failed'),
  });

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
  const agentDomain = (agent.config as { help_domain?: string | null } | undefined)?.help_domain ?? null;
  const agentHelpUrl = (agent.config as { help_url?: string | null } | undefined)?.help_url ?? null;
  const helpDomain = agentDomain ?? ws?.workspace.help_domain ?? null;
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
              The chat widget shows a "Browse help articles" link once at least
              one article is published. You can hide that link per widget under
              Channels → appearance, or point it at an external help centre
              below — neither changes what the agent knows.
              {helpDomain
                ? ` Serving at https://${helpDomain} — CNAME it at ${window.location.host}.${agentDomain ? ' (agent override)' : ' (workspace domain)'}`
                : ` Set a custom domain under Settings → Workspace, or override it just for this agent below. Point the domain's CNAME at ${window.location.host} first, then set it here.`}
            </p>
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <input
                className="input"
                style={{ maxWidth: 280 }}
                placeholder="help.yourdomain.com — optional"
                value={domainDraft ?? agentDomain ?? ''}
                onChange={(e) => setDomainDraft(e.target.value)}
              />
              <button
                className="btn sm"
                disabled={saveDomain.isPending || (domainDraft === null || (domainDraft.trim().toLowerCase() || null) === agentDomain)}
                onClick={() => {
                  const v = (domainDraft ?? '').trim().toLowerCase() || null;
                  saveDomain.mutate(v);
                  setDomainDraft(null);
                }}
              >
                {saveDomain.isPending ? 'Saving…' : 'Save domain'}
              </button>
              {domainMsg && <span className="muted" style={{ fontSize: 12 }}>{domainMsg}</span>}
            </div>
            {(agentDomain || ws?.workspace.help_domain) && (
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
                {agentDomain
                  ? ws?.workspace.help_domain
                    ? `Overrides the workspace domain (${ws.workspace.help_domain}) for this agent. Clear to inherit it.`
                    : 'Overrides the workspace default for this agent. Clear to inherit.'
                  : `Workspace domain applies (${ws?.workspace.help_domain}) — set one here to override it for this agent.`}
              </p>
            )}
            <p className="muted" style={{ margin: '10px 0 0', fontSize: 12 }}>
              <strong>External help link</strong> — already run a help centre
              elsewhere (Zendesk, Intercom, your own docs)? Set it here and the
              widget's help button goes there instead of this centre, even with
              no published articles. Clear it to use this centre again.
            </p>
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <input
                className="input"
                style={{ maxWidth: 280 }}
                placeholder="https://help.yourcompany.com — optional"
                value={helpUrlDraft ?? agentHelpUrl ?? ''}
                onChange={(e) => setHelpUrlDraft(e.target.value)}
              />
              <button
                className="btn sm"
                disabled={saveHelpUrl.isPending || (helpUrlDraft === null || (helpUrlDraft.trim() || null) === agentHelpUrl)}
                onClick={() => {
                  const v = (helpUrlDraft ?? '').trim() || null;
                  saveHelpUrl.mutate(v);
                  setHelpUrlDraft(null);
                }}
              >
                {saveHelpUrl.isPending ? 'Saving…' : 'Save link'}
              </button>
              {helpUrlMsg && <span className="muted" style={{ fontSize: 12 }}>{helpUrlMsg}</span>}
            </div>
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

      <Insights agentId={agent.id} />

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

interface Insight {
  top_viewed: { id: string; title: string; slug: string | null; viewCount: number; helpful: number; notHelpful: number }[];
  zero_result_searches: { query: string; n: number; last_seen: string }[];
  satisfaction: { id: string; title: string; slug: string | null; helpful: number; notHelpful: number }[];
}

/** Reader signal: most-viewed articles with their helpfulness ratio, the
 *  articles readers are downvoting, and the searches that found nothing —
 *  together they're the content roadmap. */
function Insights({ agentId }: { agentId: string }) {
  const { data: ins } = useQuery({
    queryKey: ['article-insights', agentId],
    queryFn: () => api<Insight>(`/api/articles/insights?agent_id=${agentId}`),
  });
  const rows = ins?.top_viewed ?? [];
  const missed = ins?.zero_result_searches ?? [];
  const disliked = (ins?.satisfaction ?? []).filter((a) => a.notHelpful > 0);
  if (!ins || (rows.length === 0 && missed.length === 0)) return null;
  return (
    <div className="card">
      <strong>Insights</strong>
      {rows.length > 0 && (
        <table style={{ width: '100%', fontSize: 13, marginTop: 8 }}>
          <tbody>
            {rows.map((a) => {
              const votes = a.helpful + a.notHelpful;
              const pct = votes ? Math.round((a.helpful / votes) * 100) : null;
              return (
                <tr key={a.id}>
                  <td style={{ padding: '3px 0' }}>{a.title}</td>
                  <td className="muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {a.viewCount} views
                    {pct !== null && ` · ${pct}% helpful (${votes})`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {disliked.length > 0 && (
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
          Needs revision: {disliked.map((a) => `${a.title} (${a.notHelpful} down)`).join(', ')}
        </p>
      )}
      {missed.length > 0 && (
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
          Searched, found nothing: {missed.slice(0, 8).map((m) => `${m.query} (${m.n}×)`).join(', ')}
          {' '}— these are the articles to write next.
        </p>
      )}
    </div>
  );
}
