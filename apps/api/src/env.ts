export const env = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgliteDir: process.env.PGLITE_DIR ?? '.pglite',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-insecure-secret',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  apiOrigin: process.env.API_ORIGIN ?? 'http://localhost:8787',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:ops@janis.ai',
  // AES-256-GCM key for agent secrets — 32 bytes, hex or base64.
  // Falls back to a key derived from SESSION_SECRET (fine for dev; set a
  // dedicated key in prod so rotating sessions doesn't strand secrets).
  secretsKey: process.env.JANIS_SECRETS_KEY ?? '',
  // transactional email alerts (Resend) — inactive until both are set
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  emailFrom: process.env.JANIS_EMAIL_FROM ?? 'Janis <alerts@janis.ai>',
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@janis.local',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'janis-admin',
  // Janis-side suggestion generation (OpenAI-compatible chat completions)
  llmApiKey: process.env.JANIS_LLM_API_KEY ?? '',
  llmBaseUrl: process.env.JANIS_LLM_BASE_URL ?? 'https://api.openai.com/v1',
  llmModel: process.env.JANIS_LLM_MODEL ?? 'gpt-4o-mini',
  slackClientId: process.env.SLACK_CLIENT_ID ?? '',
  slackClientSecret: process.env.SLACK_CLIENT_SECRET ?? '',
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? '',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ?? `${process.env.API_ORIGIN ?? 'http://localhost:8787'}/auth/google/callback`,
  slackRedirectUri:
    process.env.SLACK_REDIRECT_URI ?? `${process.env.API_ORIGIN ?? 'http://localhost:8787'}/auth/slack/callback`,
  metaAppId: process.env.META_APP_ID ?? '', // FB app id for OAuth connect flow
  metaAppSecret: process.env.META_APP_SECRET ?? '', // OAuth exchange + X-Hub-Signature-256
  metaVerifyToken: process.env.META_VERIFY_TOKEN ?? '',
  // Shared secret for the legacy broadcast-api relay — it forwards Facebook
  // page events for which no legacy client exists. Verified via
  // x-janis-relay-signature (HMAC-SHA256). Required in prod — the endpoint
  // refuses to run without it.
  janisRelaySecret: process.env.JANIS_RELAY_SECRET ?? '',
  // Legacy Janis webhook receiver — while both systems share the Meta app,
  // events for pages we don't own are forwarded here verbatim.
  metaLegacyWebhookUrl: process.env.META_LEGACY_WEBHOOK_URL ?? '',
  // wordhop-socket-server relay (POST /send) — pushes chat-response and
  // channel-update events to self-hosted SDK bots that registered a socket.
  legacySocketUrl:
    process.env.JANIS_SOCKET_SERVER_URL ?? 'https://wordhop-socket-server.herokuapp.com',
  // billing — custom rate card JSON {"model":{"input":n,"output":n}} ($/1M tokens)
  llmPrices: (() => {
    try {
      return process.env.LLM_PRICES ? JSON.parse(process.env.LLM_PRICES) : undefined;
    } catch {
      return undefined;
    }
  })(),
  // USD cents — per connected channel per month
  billingChannelCents: Number(process.env.BILLING_CHANNEL_CENTS ?? 1000), // $10/channel
  billingMargin: Number(process.env.BILLING_MARGIN ?? 0.2),
  // plan assigned to new workspaces — 'free'|'starter'|'pro'|'scale'
  defaultPlan: process.env.DEFAULT_PLAN ?? 'free',
  // Stripe — plan selection happens in-app, payment collection on Stripe-hosted pages
  stripeSecret: process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  stripePrices: {
    starter: process.env.STRIPE_PRICE_STARTER ?? '',
    pro: process.env.STRIPE_PRICE_PRO ?? '',
    scale: process.env.STRIPE_PRICE_SCALE ?? '',
  } as Record<string, string>,
  // metered overage prices (graduated: included msgs free, then per-msg) + shared LLM meter
  stripeMeterPrices: {
    starter: process.env.STRIPE_METER_PRICE_STARTER ?? '',
    pro: process.env.STRIPE_METER_PRICE_PRO ?? '',
    scale: process.env.STRIPE_METER_PRICE_SCALE ?? '',
    llm: process.env.STRIPE_METER_PRICE_LLM ?? '',
  } as Record<string, string>,
};
