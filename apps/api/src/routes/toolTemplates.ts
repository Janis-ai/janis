import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { sessionAuth } from '../middleware/sessionAuth.js';
import { TOOL_TEMPLATES, templateInfo } from '../lib/toolTemplates.js';

// Built-in tools (builtinCatalog) are intentionally not exposed yet — the
// platform-keyed web_search stays dormant until pricing/plan-gating lands.

/** Public catalog of predefined tool connections (Tools & model tab). */
export function toolTemplateRoutes(db: Db) {
  const app = new Hono();
  app.use('/*', sessionAuth(db));
  app.get('/', (c) => c.json({ templates: TOOL_TEMPLATES.map(templateInfo) }));
  return app;
}
