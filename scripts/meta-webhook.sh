#!/usr/bin/env bash
# Flip the shared Meta app's webhook subscription between the legacy Janis
# receiver and a target base URL (ngrok tunnel or deployed new Janis).
#
#   ./scripts/meta-webhook.sh legacy                      -> webhook.janis.ai
#   ./scripts/meta-webhook.sh https://xxxx.ngrok-free.app -> <base>/channels/meta/webhook
#
# While pointed at new Janis, pages it doesn't own are forwarded to legacy
# automatically (META_LEGACY_WEBHOOK_URL). Reads creds from apps/api/.env.

set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source apps/api/.env; set +a

case "${1:-}" in
  legacy) BASE="https://webhook.janis.ai/messenger/webhook" ;;
  https://*) BASE="${1%/}/channels/meta/webhook" ;;
  *) echo "usage: $0 legacy | https://<public-base-url>"; exit 1 ;;
esac

echo "Meta webhook -> $BASE"
PAGE_FIELDS="messages,messaging_postbacks,messaging_referrals,message_echoes,standby,messaging_handovers,feed"
IG_FIELDS="messages,messaging_postbacks,messaging_seen,messaging_handover,message_reactions,standby,comments,live_comments,mentions,story_insights"

for spec in "page:$PAGE_FIELDS" "instagram:$IG_FIELDS"; do
  obj="${spec%%:*}"; fields="${spec#*:}"
  curl -s -X POST "https://graph.facebook.com/v21.0/${META_APP_ID}/subscriptions" \
    -d "object=${obj}" \
    -d "callback_url=${BASE}" \
    -d "verify_token=${META_VERIFY_TOKEN}" \
    -d "fields=${fields}" \
    -d "access_token=${META_APP_ID}|${META_APP_SECRET}"
  echo " <- ${obj}"
done
