// k6 load test — staging-grade probe of the hot request paths.
//
//   BASE_URL=https://janis-api-….run.app SESSION_COOKIE=… k6 run scripts/load-test.js
//
// SESSION_COOKIE is the `janis_session` cookie value from a logged-in browser
// session (session-auth routes 401 without it — that's still a useful signal:
// cheap auth rejection shouldn't collapse under load either).
//
// What it measures: p95 latency on health + session-auth'd inbox reads +
// public widget config, with staged RPS. If p95 goes non-linear or 5xx
// appear, that's the scaling ceiling for the current pool/instances.
//
// Install: brew install k6. Writes are deliberately excluded — staging
// write traffic pollutes metrics + CRM write-back queues.

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8787';
const COOKIE = __ENV.SESSION_COOKIE || '';

export const options = {
  scenarios: {
    reads: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { duration: '30s', target: 10 },   // warm
        { duration: '1m',  target: 50 },   // normal-ish
        { duration: '1m',  target: 150 },  // stress
        { duration: '30s', target: 0 },    // cool-down
      ],
    },
  },
  thresholds: {
    http_req_failed:   ['rate<0.01'],          // <1% errors
    http_req_duration: ['p(95)<800'],          // p95 under 800ms end-to-end
  },
};

const headers = COOKIE ? { Cookie: `janis_session=${COOKIE}` } : {};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export default function () {
  const targets = [
    ['/health', true],
    ['/api/auth/me', !!COOKIE],
    ['/api/conversations?state=attention', !!COOKIE],
    ['/api/conversations?state=attention&unread=1', !!COOKIE],
    ['/api/agents', !!COOKIE],
    ['/api/saved-replies', !!COOKIE],
  ].filter(([, allowed]) => allowed);

  const [path] = pick(targets);
  const res = http.get(`${BASE}${path}`, { headers });
  check(res, {
    'no 5xx': (r) => r.status < 500,
    'no 429': (r) => r.status !== 429,
  });
  sleep(0.1 + Math.random() * 0.4); // think-time jitter — steady, not a DOS
}
