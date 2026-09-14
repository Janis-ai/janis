import { Hono } from 'hono';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? 'uploads';
const MAX_BYTES = 10 * 1024 * 1024;

/** Multipart file upload → served back at /uploads/*. Attachment refs ride in message payloads. */
export function uploadRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.post('/', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);
    if (file.size > MAX_BYTES) return c.json({ error: 'file too large (max 10MB)' }, 413);

    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${randomUUID()}-${safe}`;
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, filename), Buffer.from(await file.arrayBuffer()));

    return c.json(
      {
        name: file.name,
        url: `/uploads/${filename}`,
        type: file.type || 'application/octet-stream',
        size: file.size,
      },
      201,
    );
  });

  return app;
}
