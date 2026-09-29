import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';

interface ArticleStub {
  id: string;
  slug: string | null;
  title: string;
  excerpt: string;
}

interface Index {
  agent_name: string;
  categories: { name: string; articles: ArticleStub[] }[];
}

interface ArticleView {
  agent_name: string;
  article: {
    id: string;
    slug: string | null;
    title: string;
    category: string;
    seo_title: string | null;
    seo_description: string | null;
    body: string;
    updated_at: string;
  };
}

/** Keep <title> + meta description honest for share previews and crawlers
 * that execute JS (the API also injects them server-side for /help paths). */
function setMeta(title: string, description?: string) {
  document.title = title;
  if (description !== undefined) {
    let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!tag) {
      tag = document.createElement('meta');
      tag.name = 'description';
      document.head.appendChild(tag);
    }
    tag.content = description;
  }
}

/**
 * Customer-facing help center — unauthenticated, plain-text body rendered
 * with preserved whitespace. Lives outside the console's auth gate so any
 * visitor can self-serve articles the agent also answers from.
 */
export function HelpCenter() {
  const { agentId } = useParams();
  const [params, setParams] = useSearchParams();
  const [index, setIndex] = useState<Index | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = params.get('q') ?? '';
  const [query, setQuery] = useState(q);

  useEffect(() => setQuery(q), [q]);

  useEffect(() => {
    api<Index>(`/api/help/${agentId}${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .then(setIndex)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load'));
  }, [agentId, q]);

  useEffect(() => {
    if (index) setMeta(`${index.agent_name} Help Center`, `Help articles and answers from ${index.agent_name}.`);
  }, [index]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setParams(query.trim() ? { q: query.trim() } : {});
  };

  if (error)
    return <div className="login-wrap"><div className="card">Help center not found.</div></div>;
  if (!index) return <div className="login-wrap muted">Loading…</div>;

  return (
    <div className="help-center">
      <div className="help-inner">
        <h1 className="page-title">{index.agent_name} Help Center</h1>
        <form onSubmit={onSearch} className="row" style={{ marginBottom: 18 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search articles…"
            style={{ flex: 1, padding: '10px 14px' }}
          />
          <button className="btn primary" type="submit">Search</button>
        </form>
        {q && (
          <p className="muted">
            Results for “{q}” — <Link to={`/help/${agentId}`}>clear</Link>
          </p>
        )}
        {index.categories.length === 0 && (
          <p className="muted">{q ? 'No articles match.' : 'No articles published yet.'}</p>
        )}
        {index.categories.map((cat) => (
          <section key={cat.name} className="help-category">
            <h2>{cat.name}</h2>
            <ul>
              {cat.articles.map((a) => (
                <li key={a.id}>
                  <Link to={`/help/${agentId}/${a.slug ?? a.id}`}>{a.title}</Link>
                  {a.excerpt && <p className="muted">{a.excerpt}…</p>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export function HelpArticle() {
  const { agentId, articleId } = useParams();
  const [data, setData] = useState<ArticleView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ArticleView>(`/api/help/${agentId}/${articleId}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load'));
  }, [agentId, articleId]);

  useEffect(() => {
    if (data) {
      const a = data.article;
      setMeta(
        a.seo_title ?? `${a.title} — ${data.agent_name}`,
        a.seo_description ?? a.body.slice(0, 200).replace(/\s+/g, ' ').trim(),
      );
    }
  }, [data]);

  if (error)
    return <div className="login-wrap"><div className="card">Article not found.</div></div>;
  if (!data) return <div className="login-wrap muted">Loading…</div>;

  return (
    <div className="help-center">
      <div className="help-inner">
        <p className="muted">
          <Link to={`/help/${agentId}`}>← {data.agent_name} Help Center</Link>
          {' · '}{data.article.category}
        </p>
        <h1 className="page-title">{data.article.title}</h1>
        <p className="muted" style={{ fontSize: 12 }}>
          Updated {new Date(data.article.updated_at).toLocaleDateString()}
        </p>
        <div className="help-body">{data.article.body}</div>
      </div>
    </div>
  );
}

/**
 * Custom help domain landing — a workspace that CNAME'd help.acme.com at us
 * gets its published agents listed here. /api/help-domain resolves by Host.
 */
export function HelpDomain() {
  const [data, setData] = useState<{ workspace_name: string; agents: { id: string; name: string }[] } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api<{ workspace_name: string; agents: { id: string; name: string }[] }>(
      `/api/help/domain?host=${encodeURIComponent(window.location.hostname)}`,
    )
      .then(setData)
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    if (data) setMeta(`${data.workspace_name} Help`, `Help and support from ${data.workspace_name}.`);
  }, [data]);

  if (error) return <div className="login-wrap"><div className="card">Help center not found.</div></div>;
  if (!data) return <div className="login-wrap muted">Loading…</div>;

  return (
    <div className="help-center">
      <div className="help-inner">
        <h1 className="page-title">{data.workspace_name} Help</h1>
        <p className="muted">Pick a help center:</p>
        <ul>
          {data.agents.map((a) => (
            <li key={a.id}>
              <Link to={`/help/${a.id}`}>{a.name}</Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
