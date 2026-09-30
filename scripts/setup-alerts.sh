#!/usr/bin/env bash
# Cloud Monitoring alerts for janis-api — run once per environment.
#
#   ALERT_SLACK_WEBHOOK=https://hooks.slack.com/... ./scripts/setup-alerts.sh
#
# Creates: a Slack webhook notification channel, a log-based 5xx metric on the
# Cloud Run service, and two alert policies (5xx rate, request latency). Safe
# to re-run — existing resources are reused where gcloud permits; duplicate
# policy names will error visibly rather than silently stacking.

set -euo pipefail

PROJECT=${PROJECT:-janis-prod-mn}
REGION=${REGION:-us-east1}
SERVICE=${SERVICE:-janis-api}
WEBHOOK=${ALERT_SLACK_WEBHOOK:?ALERT_SLACK_WEBHOOK required — the Slack incoming-webhook URL}

echo "==> project $PROJECT / service $SERVICE"

# ── notification channel → Slack webhook ─────────────────────────────────
CHAN=$(gcloud beta monitoring channels list --project "$PROJECT" \
  --format='value(name)' --filter='displayName="janis-alerts-slack"' | head -1)
if [ -z "$CHAN" ]; then
  CHAN=$(gcloud beta monitoring channels create --project "$PROJECT" \
    --display-name="janis-alerts-slack" --type=webhook_tokenauth \
    --channel-labels="url=$WEBHOOK" --format='value(name)')
  echo "created channel $CHAN"
else
  echo "channel exists: $CHAN"
fi

# ── log-based metric: 5xx responses ──────────────────────────────────────
if ! gcloud logging metrics describe janis_api_5xx --project "$PROJECT" >/dev/null 2>&1; then
  gcloud logging metrics create janis_api_5xx --project "$PROJECT" \
    --description="janis-api 5xx responses" \
    --log-filter="resource.type=\"cloud_run_revision\" resource.labels.service_name=\"$SERVICE\" httpRequest.status>=500"
  echo "created metric janis_api_5xx"
fi

# ── alert: any 5xx spike ─────────────────────────────────────────────────
cat > /tmp/janis-5xx-policy.json <<EOF
{
  "displayName": "janis-api 5xx spike",
  "conditions": [{
    "displayName": "5xx > 5/min",
    "conditionThreshold": {
      "filter": "metric.type=\"logging.googleapis.com/user/janis_api_5xx\" resource.type=\"cloud_run_revision\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": 5,
      "duration": "60s",
      "aggregations": [{"alignmentPeriod": "60s", "perSeriesAligner": "ALIGN_SUM"}]
    }
  }],
  "notificationChannels": ["$CHAN"],
  "combiner": "OR"
}
EOF
gcloud alpha monitoring policies create --project "$PROJECT" \
  --policy-from-file=/tmp/janis-5xx-policy.json && echo "created 5xx alert"

# ── alert: p95 latency via Cloud Run request_latencies ────────────────────
cat > /tmp/janis-latency-policy.json <<EOF
{
  "displayName": "janis-api latency p95",
  "conditions": [{
    "displayName": "p95 > 3s for 5m",
    "conditionThreshold": {
      "filter": "metric.type=\"run.googleapis.com/request_latencies\" resource.type=\"cloud_run_revision\" resource.labels.service_name=\"$SERVICE\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": 3000,
      "duration": "300s",
      "aggregations": [{"alignmentPeriod": "60s", "perSeriesAligner": "ALIGN_PERCENTILE_95"}]
    }
  }],
  "notificationChannels": ["$CHAN"],
  "combiner": "OR"
}
EOF
gcloud alpha monitoring policies create --project "$PROJECT" \
  --policy-from-file=/tmp/janis-latency-policy.json && echo "created latency alert"

echo "done — verify under: console.cloud.google.com/monitoring/alerting (project $PROJECT)"
