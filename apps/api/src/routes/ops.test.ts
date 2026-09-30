import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

// env.ts reads process.env at import time — set before the route import.
process.env.OPS_ALERT_TOKEN = 'test-ops-token';

const { opsRoutes } = await import('./ops.js');

let app: Hono;

beforeAll(() => {
  app = new Hono().route('/ops', opsRoutes());
});

describe('POST /ops/alert', () => {
  const post = (token: string, body: unknown) =>
    app.fetch(
      new Request(`http://t/ops/alert?token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('rejects bad and missing tokens', async () => {
    expect((await post('wrong', { incident: {} })).status).toBe(401);
    expect((await post('', { incident: {} })).status).toBe(401);
  });

  it('accepts a valid incident and forwards to Slack (no-op without webhook)', async () => {
    const res = await post('test-ops-token', {
      incident: { summary: '5xx spike on janis-api', state: 'open' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('also accepts the token via Authorization: Bearer (GCP webhook_tokenauth)', async () => {
    const res = await app.fetch(
      new Request('http://t/ops/alert', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-ops-token',
        },
        body: JSON.stringify({ incident: { summary: 'x', state: 'open' } }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
