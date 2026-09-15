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
  metaAppSecret: process.env.META_APP_SECRET ?? '', // X-Hub-Signature-256 verification
};
