import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { MAX_UPLOAD_BYTES, storeUpload } from '../lib/uploads.js';

/** Multipart file upload → stored in Postgres, served at /uploads/*. Attachment refs ride in message payloads. */
export function uploadRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.post('/', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (max 10MB)' }, 413);

    const ref = await storeUpload(db, {
      name: file.name,
      type: file.type,
      data: Buffer.from(await file.arrayBuffer()),
    });
    return c.json(ref, 201);
  });

  return app;
}
