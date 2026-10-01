export const env = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgliteDir: process.env.PGLITE_DIR ?? '.pglite',
  // Explicit pool ceiling — postgres-js defaults to 10/instance, which is
  // fine at 3 Cloud Run instances but an accident at 10. Sized against the
  // Neon pooler, not the per-instance default.
  dbPoolMax: Number(process.env.DB_POOL_MAX) || 8,
  // Deploys run migrations as a pre-deploy step (deploy-gcp.sh); instances
  // boot against an already-current schema instead of racing the migrator.
  // Local/PGlite mode still migrates at boot.
  skipDbMigrate: process.env.SKIP_DB_MIGRATE === '1',
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
  // email channel: inbound domain each channel address is minted under +
  // svix webhook secret verifying Resend's email.received posts
  emailInboundDomain: process.env.EMAIL_INBOUND_DOMAIN ?? 'inbound.janis.ai',
  resendInboundSecret: process.env.RESEND_INBOUND_SECRET ?? '',
  // outbound event webhook (bounces/complaints) — separate Resend webhook
  // registration, so a distinct secret; falls back to the inbound secret.
  resendEventsSecret: process.env.RESEND_EVENTS_SECRET ?? '',
  // ops alerting — Slack incoming webhook for janis.alert incidents, plus
  // the token that authenticates Cloud Monitoring's webhook posts to
  // /ops/alert. Empty webhook = Slack posts skipped.
  alertSlackWebhook: process.env.ALERT_SLACK_WEBHOOK ?? '',
  opsAlertToken: process.env.OPS_ALERT_TOKEN ?? '',
  // Hosted voice — master Twilio account that provisions per-channel
  // subaccounts + numbers. Empty = BYO-creds voice only.
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
  twilioVoiceCountry: process.env.TWILIO_VOICE_COUNTRY ?? 'US',
  // Hosted voice abuse controls — cap live numbers per workspace and daily
  // provisioning attempts (each attempt can create a Twilio subaccount).
  voiceHostedMax: Number(process.env.VOICE_HOSTED_MAX ?? 3),
  voiceProvisionDaily: Number(process.env.VOICE_PROVISION_DAILY ?? 10),
  // What a hosted voice minute costs Janis (Twilio inbound ~$0.014/min) —
  // billed to the customer at cost × (1 + BILLING_MARGIN), same as LLM.
  voiceCostMicrosPerMin: Number(process.env.VOICE_COST_MICROS_PER_MIN ?? 14_000),
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@janis.local',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'janis-admin',
  // Email+password sign-in — OAuth is the product login; password auth stays
  // on outside production so the seed admin and tests can log in.
  // ALLOW_PASSWORD_LOGIN=1 force-enables it anywhere.
  passwordLogin:
    process.env.NODE_ENV !== 'production' || process.env.ALLOW_PASSWORD_LOGIN === '1',
  // Janis-side suggestion generation (OpenAI-compatible chat completions)
  llmApiKey: process.env.JANIS_LLM_API_KEY ?? '',
  // Webchat channel id for the "Ask Janis" console rail — the concierge agent
  // that answers product questions inside the app. Empty hides the rail.
  supportChannelId: process.env.JANIS_SUPPORT_CHANNEL_ID ?? '',
  // The Janis operator workspace — gates the account_status builtin tool so
  // only our own concierge agent can look up a signed-in user's plan.
  operatorWorkspaceId: process.env.JANIS_OPERATOR_WORKSPACE_ID ?? '',
  llmBaseUrl: process.env.JANIS_LLM_BASE_URL ?? 'https://api.openai.com/v1',
  llmModel: process.env.JANIS_LLM_MODEL ?? 'gpt-4o-mini',
  // Second model tried when the primary keeps failing on 429/5xx/timeouts
  // (e.g. Gemini flash-lite demand spikes). Empty = no fallback.
  llmFallbackModel: process.env.JANIS_LLM_FALLBACK_MODEL ?? '',
  // Extra Janis-metered provider accounts — JSON keyed by catalog vendor:
  // JANIS_LLM_PROVIDERS='{"anthropic":{"api_key":"sk-ant-…"},"openai":{"api_key":"sk-…"}}'
  // base_url optional (defaults to the vendor endpoint). The legacy
  // JANIS_LLM_API_KEY/JANIS_LLM_BASE_URL pair is always the default account.
  janisLlmProviders: (() => {
    try {
      return process.env.JANIS_LLM_PROVIDERS
        ? (JSON.parse(process.env.JANIS_LLM_PROVIDERS) as Record<
            string,
            { api_key?: string; base_url?: string }
          >)
        : {};
    } catch {
      return {};
    }
  })(),
  // Per-vendor metered keys: <VENDOR>_LLM_API_KEY (+ optional
  // <VENDOR>_LLM_BASE_URL override). OPENROUTER_LLM_API_KEY makes one
  // account serve every catalog model via vendor/id routing.
  // Org-scoped Anthropic keys require this header on every request — the
  // workspace UUID from console.anthropic.com → Settings → Workspaces.
  anthropicWorkspace: process.env.ANTHROPIC_LLM_WORKSPACE ?? '',
  llmVendorKeys: (() => {
    const out: Record<string, { api_key: string; base_url?: string }> = {};
    for (const v of [
      'openai', 'anthropic', 'google', 'xai', 'deepseek', 'moonshot',
      'zai', 'nvidia', 'mistral', 'meta', 'openrouter',
    ]) {
      const key = process.env[`${v.toUpperCase()}_LLM_API_KEY`];
      if (key) out[v] = { api_key: key, base_url: process.env[`${v.toUpperCase()}_LLM_BASE_URL`] };
    }
    return out;
  })(),
  // Janis-side Brave Search key powering the built-in web_search tool — lets
  // hosted agents search without the customer configuring a connection.
  // Empty = the tool is hidden from the catalog and never offered to the LLM.
  searchApiKey: process.env.JANIS_SEARCH_API_KEY ?? '',
  slackClientId: process.env.SLACK_CLIENT_ID ?? '',
  slackClientSecret: process.env.SLACK_CLIENT_SECRET ?? '',
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? '',
  // Second accepted signing secret — the test app's during the cutover, so
  // requests signed by EITHER app verify while both are live.
  slackSigningSecretAlt: process.env.SLACK_SIGNING_SECRET_ALT ?? '',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  // gmail channel OAuth: separate redirect from sign-in — must be registered
  // in the same Google OAuth client's authorized URIs.
  gmailPubsubTopic: process.env.GMAIL_PUBSUB_TOPIC ?? '',
  gmailPushToken: process.env.GMAIL_PUSH_TOKEN ?? '',
  gmailRedirectUri:
    process.env.GMAIL_REDIRECT_URI ??
    `${process.env.API_ORIGIN ?? 'http://localhost:8787'}/gmail/callback`,
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ?? `${process.env.API_ORIGIN ?? 'http://localhost:8787'}/auth/google/callback`,
  slackRedirectUri:
    process.env.SLACK_REDIRECT_URI ?? `${process.env.API_ORIGIN ?? 'http://localhost:8787'}/auth/slack/callback`,
  // WorkOS AuthKit enterprise SSO — /auth/sso?connection|organization|domain.
  // Empty disables (route 404s to login with an error).
  workosClientId: process.env.WORKOS_CLIENT_ID ?? '',
  workosApiKey: process.env.WORKOS_API_KEY ?? '',
  workosRedirectUri:
    process.env.WORKOS_REDIRECT_URI ?? `${process.env.API_ORIGIN ?? 'http://localhost:8787'}/auth/sso/callback`,
  // WorkOS Directory Sync (SCIM provisioning) — webhook signing secret for
  // POST /workos/directory-events. Empty disables the endpoint.
  workosDirectorySecret: process.env.WORKOS_DIRECTORY_WEBHOOK_SECRET ?? '',
  // Outlook/365 channel OAuth + Graph — separate Azure app registration.
  msClientId: process.env.MS_CLIENT_ID ?? '',
  msClientSecret: process.env.MS_CLIENT_SECRET ?? '',
  msTenant: process.env.MS_TENANT ?? 'common',
  msRedirectUri:
    process.env.MS_REDIRECT_URI ?? `${process.env.API_ORIGIN ?? 'http://localhost:8787'}/outlook/callback`,
  msPushToken: process.env.MS_PUSH_TOKEN ?? '', // shared secret on the push URL
  metaAppId: process.env.META_APP_ID ?? '', // FB app id for OAuth connect flow
  metaAppSecret: process.env.META_APP_SECRET ?? '', // OAuth exchange + X-Hub-Signature-256
  // Cloudflare OAuth client — auto-configures sending-domain DNS records on
  // the client's zone (zone.read + dns.write scopes).
  cfOauthClientId: process.env.CLOUDFLARE_OAUTH_CLIENT_ID ?? '',
  cfOauthClientSecret: process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET ?? '',
  // Domain Connect signing key (PEM) — enables the zero-auth DNS path once
  // the janis.ai template is in the public registry. Pubkey lives at
  // _dc.janis.ai as `p=<base64>`.
  dcPrivateKey: (process.env.DC_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
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
  // Legacy wordhopapi base URL — legacy-SDK traffic is mirrored here so the
  // old dashboard (Mongo transcripts) and wordhop-slack takeovers keep
  // working during the migration. Empty disables forwarding (dev/tests).
  legacyApiUrl: process.env.WORDHOP_API_URL ?? '',
  // Legacy wordhop-slack interactivity endpoint — Slack apps have a single
  // Interactivity URL, so once the real Janis app points at this service we
  // fan out payloads we don't recognize (legacy dialogs, training buttons,
  // followup menus) to wordhop-slack verbatim. Empty disables.
  legacySlackInteractionsUrl: process.env.LEGACY_SLACK_INTERACTIONS_URL ?? '',
  // billing — custom rate card JSON {"model":{"input":n,"output":n}} ($/1M tokens)
  llmPrices: (() => {
    try {
      return process.env.LLM_PRICES ? JSON.parse(process.env.LLM_PRICES) : undefined;
    } catch {
      return undefined;
    }
  })(),
  // USD cents — per connected channel per month

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
  // Annual billing — yearly prices per tier (interval:'year' on the Stripe
  // price). Empty disables the annual option for that plan.
  stripeYearlyPrices: {
    starter: process.env.STRIPE_PRICE_STARTER_YEARLY ?? '',
    pro: process.env.STRIPE_PRICE_PRO_YEARLY ?? '',
    scale: process.env.STRIPE_PRICE_SCALE_YEARLY ?? '',
  } as Record<string, string>,
  // Free trial on first paid checkout — days of paid-tier access before the
  // card charges. 0 disables. Stripe sends trial_will_end 3 days out.
  trialDays: Number(process.env.TRIAL_DAYS ?? 0),
  // metered overage prices (graduated: included msgs free, then per-msg) + shared LLM meter
  stripeMeterPrices: {
    starter: process.env.STRIPE_METER_PRICE_STARTER ?? '',
    pro: process.env.STRIPE_METER_PRICE_PRO ?? '',
    scale: process.env.STRIPE_METER_PRICE_SCALE ?? '',
    llm: process.env.STRIPE_METER_PRICE_LLM ?? '',
    voice: process.env.STRIPE_METER_PRICE_VOICE ?? '',
    stt: process.env.STRIPE_METER_PRICE_STT ?? '',
  } as Record<string, string>,
  // GA4 measurement id (G-…) — when set, the served SPA gets the gtag snippet
  // injected into <head>. Empty disables (dev/tests embed nothing).
  gaMeasurementId: process.env.GA_MEASUREMENT_ID ?? '',
  // DB-backed hourly caps per webchat channel token — bound worst-case spend
  // when a widget endpoint is flooded from many IPs. Generous defaults; lower
  // them if a specific channel is abused.
  chatTokenHourlyMax: Number(process.env.CHAT_TOKEN_HOURLY_MAX ?? 600),
  chatTokenUploadHourlyMax: Number(process.env.CHAT_TOKEN_UPLOAD_HOURLY_MAX ?? 60),
  // Rolling-24h micro-USD ceiling on Janis-keyed LLM spend per workspace —
  // hitting it pauses AI replies and escalates to humans. 0 disables.
  llmDailyCapMicros: Number(process.env.LLM_DAILY_CAP_MICROS ?? 25_000_000),
};
