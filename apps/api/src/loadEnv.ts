// Load ./.env before any module reads process.env. Import first in index.ts.
try {
  process.loadEnvFile?.();
} catch {
  // no .env file — fine, env may come from the shell
}
