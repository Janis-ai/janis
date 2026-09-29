import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';

interface ArticleStub {
  id: string;
  title: string;
  excerpt: string;
}

interface Index {
  agent_name: string;
  categories: { name: string; articles: ArticleStub[] }[];
}

interface ArticleView {
  agent_name: string;
  article: { id: string; title: string; category: string; body: string; updated_at: string };
}

/**
 * Customer-facing help center — unauthenticated, plain-text body rendered
 * with preserved whitespace. Lives outside the console's auth gate so any
 * visitor can self-serve articles the agent also answers from.
 */
export function HelpCenter() {
  const { agentId } = useParams();
  const [index, setIndex] = useState<Index | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Index>(`/api/help/${agentId}`)
      .then(setIndex)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load'));
  }, [agentId]);

  if (error)
    return <div className="login-wrap"><div className="card">Help center not found.</div></div>;
  if (!index) return <div className="login-wrap muted">Loading…</div>;

  return (
    <div className="help-center">
      <div className="help-inner">
        <h1 className="page-title">{index.agent_name} Help Center</h1>
        {index.categories.length === 0 && (
          <p className="muted">No articles published yet.</p>
        )}
        {index.categories.map((cat) => (
          <section key={cat.name} className="help-category">
            <h2>{cat.name}</h2>
            <ul>
              {cat.articles.map((a) => (
                <li key={a.id}>
                  <Link to={`/help/${agentId}/${a.id}`}>{a.title}</Link>
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
