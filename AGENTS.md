# Janis reboot — agent notes

## Stack

npm workspaces monorepo: `apps/api` (Hono + Drizzle, PGlite dev / Postgres prod),
`apps/web` (React + Vite PWA), `packages/shared` (zod contracts), `packages/sdk`.

## Dev servers

- API: `npm run dev -w apps/api` → http://localhost:8787 (tsx watch)
- Web: `npm run dev -w apps/web` → http://localhost:5173 (vite, proxies /api + /auth)
- Login: `admin@janis.local` / `janis-admin` (env-overridable seed)
- Demo agent: `npm run demo-agent -w apps/api` (needs built packages/shared + sdk)

## Verify after every change

1. `npm run typecheck` (root — all workspaces)
2. `npm test -w apps/api`
3. `./scripts/smoke.sh` — checks web 200s, API health, login, all key endpoints,
   and that the SSE stream delivers a live event. Run this **before telling the
   user to reload the Devin preview** — it catches dead servers, CORS breaks,
   and endpoint regressions.

## Caveats

- SSE check needs an existing conversation to trigger a bus event.
- Slack features need SLACK_CLIENT_ID/SECRET/SIGNING_SECRET + a public API URL.
- Devin preview proxies :5173 — API CORS echoes localhost/127.0.0.1 origins.

## Gotchas
- Do NOT run the API with .pglite inside an iCloud/Dropbox-synced dir — file sync corrupts the live DB. This repo is under iCloud Drive, so apps/api/.env sets PGLITE_DIR=~/.janis/pglite.
- Only ONE tsx watch may run against a PGlite dir at a time; kill extras (pkill -f "tsx watch src/index.ts") before restarting.

## Billing / Stripe

- Plans live in apps/api/src/lib/plans.ts (base + included msgs + overage/1k; free hard-caps).
- Stripe test-mode price ids (in apps/api/.env): starter price_1UFvvnLuGzRk7fCQB5zSxMWZ, pro price_1UFvvoLuGzRk7fCQTsX4GeVn, scale price_1UFvvoLuGzRk7fCQnnhu8cRp.
- Stripe live-mode price ids (created, not yet wired): starter price_1UFwIBLuGzRk7fCQtDS4VRVM, pro price_1UFwIBLuGzRk7fCQVyL9qP6A, scale price_1UFwICLuGzRk7fCQtkVk4Tq7. For prod set STRIPE_SECRET_KEY=sk_live_… + these price ids.
- Webhook endpoint https://janis.ai/billing/stripe-webhook is registered on both test and live; local dev uses `stripe listen --api-key $STRIPE_SECRET_KEY --forward-to localhost:8787/billing/stripe-webhook` (the whsec it prints goes in STRIPE_WEBHOOK_SECRET).
- Customer Portal configured on both modes: card updates, invoice history, immediate cancel.
- Meters (both modes): janis.messages (1 per stored message) and janis.llm_micros (billed micro-USD incl. margin per LLM call). Metered prices: test starter/pro/scale = price_1UFwMP…gq7Q/…XxYp/…HBJcnK, llm = price_1UFwMQ…C8tOE; live starter/pro/scale = price_1UFwMR…HYZq/…Zjls/…TkO, llm = price_1UFwMT…ion8. Checkout adds the plan's metered price + LLM price as extra line items.
- .env edits do NOT trigger tsx watch reloads — restart the API after changing env.
