# Security & Data Protection Policy

Internal policy for the Janis platform. Covers staff access, data handling,
incident response, and data-loss prevention for merchant and end-customer
personal data.

## Staff access

- Production data access is limited to the founding team and granted through
  Google Cloud IAM on the project; there is no shared production login.
- Staff console access uses the same hardened auth as customers: scrypt-hashed
  passwords (8–128 chars, HIBP k-anonymity screening, rate-limited) or SSO.
- Sensitive operations (agent/workspace changes, billing, destructive actions)
  are written to the `audit_log` table and visible in Settings → Audit log.
- Secrets live in GCP Secret Manager / env-injected variables — never in the
  repo, never in logs. Tool credentials are stored redacted and never echoed
  to console surfaces.

## Personal data handling

- Minimum-viable collection: we process customer name/email/phone/order data
  only to answer the shopper's own questions and perform shopper-requested
  actions (order lookup, draft orders, returns, record updates).
- Data is encrypted in transit (TLS) and at rest (managed Postgres / GCS
  default encryption). Backups (Neon PITR snapshots) are encrypted.
- Retention: customers/redact + shop/redact GDPR webhooks purge personal
  data on request; workspace deletion cascades personal data.
- Test and production data are fully separated: local dev runs on PGlite
  with synthetic data; production runs on managed Postgres. Test stores are
  Shopify development stores with generated data.

## Data-loss prevention

- Database credentials are single-purpose, access-gated, and rotatable;
  the API never exposes raw SQL surfaces.
- No personal data is exported to third parties for advertising or sale.
  LLM provider calls carry only the conversation context needed to answer.
- Outbound sends (email/SMS/social) are policy-gated and logged.

## Incident response

1. **Detect** — Cloud Monitoring alerts, error reporting, or user report.
2. **Contain** — revoke affected tokens/sessions, disable the compromised
   integration or route, roll back the deploy if code-caused.
3. **Assess** — scope via `audit_log`, request logs, and conversation/event
   tables; identify affected workspaces and data classes.
4. **Notify** — affected merchants are emailed within 72 hours where personal
   data was exposed; Shopify is notified for platform-scope incidents.
5. **Remediate** — root-cause fix, regression test, post-incident note in
   HANDOFF.md; credentials rotated regardless of confirmed exposure.
