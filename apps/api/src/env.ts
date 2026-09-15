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
};
