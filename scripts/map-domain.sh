#!/usr/bin/env bash
# Map a customer domain onto the janis-api Cloud Run service so a claimed
# Bubble domain (channels.credentials.widget_domain) serves the hosted chat
# page + widget.js with a Google-managed cert.
#
# Usage: ./scripts/map-domain.sh chat.acme.com
#
# Requirements — Google's rules, not ours:
#   - The domain must be verified for THIS GCP project's owner account in
#     Search Console (a base-domain verification covers all subdomains).
#     If it isn't, gcloud fails with instructions and a verification link —
#     for customer-owned domains the customer adds a TXT record we hand them
#     from the console, OR they skip verification entirely by orange-clouding
#     the CNAME through their own Cloudflare zone (TLS terminates on CF's
#     edge and traffic arrives with the right Host — no mapping needed).
#   - DNS: the customer CNAMEs the domain at app.janis.ai (mapping docs say
#     ghs.googlehosted.com — our UI instructs app.janis.ai, which resolves
#     to the same frontend).
set -euo pipefail

DOMAIN="${1:?usage: $0 <domain>}"
PROJECT="janis-prod-mn"
SERVICE="janis-api"
REGION="us-east1"

gcloud run domain-mappings create \
  --service "$SERVICE" \
  --domain "$DOMAIN" \
  --region "$REGION" \
  --project "$PROJECT"

echo "Mapped $DOMAIN → $SERVICE. Verify: curl -s https://$DOMAIN/health"
