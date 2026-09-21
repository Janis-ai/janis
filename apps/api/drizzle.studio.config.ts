import { defineConfig } from 'drizzle-kit';

// Web UI for browsing a live database:
//   DATABASE_URL="$(gcloud secrets versions access latest \
//     --secret=janis-database-url --project=janis-prod-mn)" \
//     npm run db:studio -w apps/api
// Then open https://local.drizzle.studio
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
