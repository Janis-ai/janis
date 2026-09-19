import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { uploads } from '../db/schema.js';
import type { AttachmentRef } from './channels.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Strip path separators + odd chars from a user-supplied filename. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()[\]]+/g, '_');
  return base.slice(0, 120) || 'file';
}

/**
 * Persist file bytes and return the public ref. Storage is the DB, not the
 * container filesystem — Cloud Run recycles local disk on every deploy.
 */
export async function storeUpload(
  db: Db,
  file: { name: string; type: string; data: Buffer },
): Promise<AttachmentRef> {
  const name = sanitizeFilename(file.name);
  const filename = `${randomUUID()}-${name}`;
  await db.insert(uploads).values({
    filename,
    name,
    type: file.type || 'application/octet-stream',
    size: file.data.length,
    data: file.data,
  });
  return { name, url: `/uploads/${filename}`, type: file.type || 'application/octet-stream', size: file.data.length };
}

/** Fetch an upload row by its public filename. */
export async function getUpload(db: Db, filename: string) {
  const [row] = await db.select().from(uploads).where(eq(uploads.filename, filename)).limit(1);
  return row;
}

/** Download a remote file (size-capped), returning null on any failure. */
async function fetchBytes(url: string, bearer?: string): Promise<{ data: Buffer; type: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        'User-Agent': 'janis/1.0',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_UPLOAD_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_UPLOAD_BYTES || buf.length === 0) return null;
    return { data: buf, type: res.headers.get('content-type')?.split(';')[0] ?? '' };
  } catch {
    return null;
  }
}

const GRAPH = 'https://graph.facebook.com/v21.0';
const WA_MEDIA_PREFIX = 'wa-media:';

/**
 * Rehost remote attachment URLs into durable /uploads/* refs. Meta's CDN URLs
 * are signed and expire; WhatsApp media only exists behind the Graph API.
 * `wa-media:<id>` refs are resolved via the channel's access token.
 * Failures keep the original ref — a temporary URL beats no URL.
 */
export async function rehostAttachments(
  db: Db,
  refs: AttachmentRef[] | undefined,
  metaToken?: string,
): Promise<AttachmentRef[] | undefined> {
  if (!refs?.length) return refs;
  const out: AttachmentRef[] = [];
  for (const ref of refs) {
    let url = ref.url;
    let bearer: string | undefined;
    if (url.startsWith(WA_MEDIA_PREFIX)) {
      if (!metaToken) { out.push(ref); continue; }
      try {
        const res = await fetch(`${GRAPH}/${url.slice(WA_MEDIA_PREFIX.length)}`, {
          headers: { Authorization: `Bearer ${metaToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) { out.push({ ...ref, url: '' }); continue; }
        const d = (await res.json()) as { url?: string };
        if (!d.url) { out.push({ ...ref, url: '' }); continue; }
        url = d.url;
        bearer = metaToken;
      } catch {
        out.push({ ...ref, url: '' });
        continue;
      }
    }
    if (!/^https?:\/\//.test(url)) { out.push(ref); continue; }
    const got = await fetchBytes(url, bearer);
    if (!got) { out.push(ref); continue; }
    const stored = await storeUpload(db, {
      name: ref.name,
      type: ref.type || got.type || 'application/octet-stream',
      data: got.data,
    }).catch(() => null);
    out.push(stored ?? ref);
  }
  return out;
}
