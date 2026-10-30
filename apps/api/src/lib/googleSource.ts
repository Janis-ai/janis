import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentConnections, agents } from '../db/schema.js';
import { connectionToken } from './connections.js';
import { extractKnowledgeText, UnsupportedFileError, type KnowledgeLlm } from './knowledge.js';
import { llmFor } from './llm.js';

const API_TIMEOUT_MS = 15_000;
const MAX_CHARS = 80_000;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_SHEET_TABS = 20;

export interface GoogleTarget {
  kind: 'document' | 'spreadsheet' | 'presentation' | 'file' | 'folder';
  id: string;
}

/** Parse a pasted Google link into an API target — accepts the /edit,
 *  /export (the normalized form stored on source_url), /file/d and open?id=
 *  shapes. 'file' targets resolve their native type by probing APIs, since
 *  drive.file can't read metadata of unpicked files. */
export function googleSourceTarget(raw: string): GoogleTarget | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hostname === 'docs.google.com') {
    const m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) return null;
    const kind = { document: 'document', spreadsheets: 'spreadsheet', presentation: 'presentation' }[
      m[1]
    ] as GoogleTarget['kind'];
    return { kind, id: m[2] };
  }
  if (u.hostname === 'drive.google.com') {
    const m = u.pathname.match(/^\/(?:drive\/u\/\d+\/)?file\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return { kind: 'file', id: m[1] };
    if (u.pathname === '/open' && u.searchParams.get('id'))
      return { kind: 'file', id: u.searchParams.get('id')! };
    if (/^\/drive\/(?:u\/\d+\/)?folders\/[a-zA-Z0-9_-]+/.test(u.pathname))
      return { kind: 'folder', id: '' };
  }
  return null;
}

interface ApiResult {
  status: number;
  json: Record<string, unknown> | null;
}

async function apiGet(token: string, url: string): Promise<ApiResult> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

/** Depth-first walk collecting every textRun — covers Doc body/table cells
 *  and Slides shapes/notes/tables with one flattener. */
function collectTextRuns(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTextRuns(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  const run = rec.textRun as { content?: unknown } | undefined;
  if (typeof run?.content === 'string') out.push(run.content);
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') collectTextRuns(v, out);
  }
}

function textRunsToText(json: Record<string, unknown>): string {
  const parts: string[] = [];
  collectTextRuns(json, parts);
  return parts
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS);
}

const NATIVE_MIME: Record<string, 'document' | 'spreadsheet' | 'presentation'> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'spreadsheet',
  'application/vnd.google-apps.presentation': 'presentation',
};

async function docText(token: string, id: string): Promise<{ status: number; text?: string }> {
  const { status, json } = await apiGet(
    token,
    `https://docs.googleapis.com/v1/documents/${id}?fields=body`,
  );
  return { status, text: json ? textRunsToText(json) : undefined };
}

async function deckText(token: string, id: string): Promise<{ status: number; text?: string }> {
  const { status, json } = await apiGet(
    token,
    `https://slides.googleapis.com/v1/presentations/${id}?fields=slides`,
  );
  return { status, text: json ? textRunsToText(json) : undefined };
}

async function sheetText(token: string, id: string): Promise<{ status: number; text?: string }> {
  const meta = await apiGet(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`,
  );
  if (meta.status !== 200 || !meta.json) return { status: meta.status };
  const titles = ((meta.json.sheets as { properties?: { title?: string } }[]) ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t))
    .slice(0, MAX_SHEET_TABS);
  if (!titles.length) return { status: 200, text: '' };
  const q = titles.map((t) => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "\\'")}'!A1:Z2000`)}`);
  const vals = await apiGet(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?majorDimension=ROWS&${q.join('&')}`,
  );
  if (vals.status !== 200 || !vals.json) return { status: vals.status };
  const blocks = ((vals.json.valueRanges as { range?: string; values?: string[][] }[]) ?? []).map(
    (vr, i) => {
      const rows = (vr.values ?? []).map((r) => r.join('\t')).join('\n');
      return rows ? `# ${titles[i] ?? vr.range ?? 'sheet'}\n${rows}` : '';
    },
  );
  return { status: 200, text: blocks.filter(Boolean).join('\n\n').slice(0, MAX_CHARS) };
}

async function mediaText(
  token: string,
  meta: { id?: string; name?: string; mimeType?: string; size?: string },
  llm: () => Promise<KnowledgeLlm>,
): Promise<string> {
  const mime = meta.mimeType ?? '';
  const name = meta.name ?? 'drive-file';
  if (Number(meta.size ?? 0) > MAX_MEDIA_BYTES)
    throw new UnsupportedFileError('file too large (max 10MB)');
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${meta.id}?alt=media`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`drive download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const needsVision = mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name);
  return extractKnowledgeText(buf, mime, name, needsVision ? await llm() : { apiKey: '', baseUrl: '', model: '' });
}

/**
 * Fetch a Google-file knowledge source through the agent's own Google
 * connection — the OAuth grant (documents/spreadsheets/presentations.readonly/
 * drive.file) covers private files without public sharing. Returns null when
 * the URL isn't Google-shaped or the agent has no usable connection — the
 * caller then falls back to the anonymous export crawl.
 */
export async function fetchGoogleSourceText(
  db: Db,
  workspaceId: string,
  agentId: string,
  url: string,
  llm: () => Promise<KnowledgeLlm>,
): Promise<{ text: string; sizeBytes: number } | null> {
  const target = googleSourceTarget(url);
  if (!target) return null;
  if (target.kind === 'folder')
    throw new Error("that's a Drive folder — link the files inside it, or pick them in the Google integration");
  const [conn] = await db
    .select()
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.agentId, agentId),
        eq(agentConnections.workspaceId, workspaceId),
        eq(agentConnections.provider, 'google'),
      ),
    )
    .limit(1);
  if (!conn) return null;
  let token: string;
  try {
    token = await connectionToken(db, conn);
  } catch {
    return null; // dead grant — anonymous export may still reach a link-shared file
  }

  const cantOpen = () =>
    new Error(
      `the connected Google account can't open this file — share it with ${conn.label ?? 'that account'} or pick it in the Google integration`,
    );

  // Opaque drive/file links: metadata only resolves for files the token can
  // already see (picked/app-created). Unpicked files 404 on files.get, so
  // probe each native API — the broad scopes answer per-type.
  if (target.kind === 'file') {
    const meta = await apiGet(
      token,
      `https://www.googleapis.com/drive/v3/files/${target.id}?fields=id,name,mimeType,size`,
    );
    const file = (meta.json ?? {}) as { id?: string; name?: string; mimeType?: string; size?: string };
    if (meta.status === 200 && file.mimeType) {
      if (file.mimeType === 'application/vnd.google-apps.folder')
        throw new Error("that's a Drive folder — link the files inside it, or pick them in the Google integration");
      const kind = NATIVE_MIME[file.mimeType];
      const text = kind
        ? (await { document: docText, spreadsheet: sheetText, presentation: deckText }[kind](
            token,
            target.id,
          )).text
        : await mediaText(token, file, llm);
      if (!text) throw new Error('file had no readable text');
      return { text, sizeBytes: Buffer.byteLength(text) };
    }
    for (const probe of [docText, sheetText, deckText]) {
      const r = await probe(token, target.id);
      if (r.status === 200 && r.text !== undefined) {
        if (!r.text) throw new Error('file had no readable text');
        return { text: r.text, sizeBytes: Buffer.byteLength(r.text) };
      }
    }
    throw cantOpen();
  }

  const fetcher = { document: docText, spreadsheet: sheetText, presentation: deckText }[
    target.kind as 'document' | 'spreadsheet' | 'presentation'
  ];
  const r = await fetcher(token, target.id);
  if (r.status === 401)
    throw new Error('the Google connection needs re-authorizing — reconnect it in the agent’s integrations');
  if (r.status !== 200 || r.text === undefined) throw cantOpen();
  if (!r.text) throw new Error('file had no readable text');
  return { text: r.text, sizeBytes: Buffer.byteLength(r.text) };
}

/** Lazy-LLM factory for a file row — only resolved when a Drive download
 *  turns out to be an image (vision extraction needs the agent's model). */
export function llmForAgent(db: Db, agentId: string, workspaceId: string) {
  return async (): Promise<KnowledgeLlm> => {
    const [agent] = await db
      .select({ config: agents.config, workspaceId: agents.workspaceId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
      .limit(1);
    if (!agent) throw new Error('agent not found');
    return llmFor(db, agent);
  };
}
