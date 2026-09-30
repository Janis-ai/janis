import { env } from '../env.js';

/** Fire-and-forget post to the ops Slack channel via incoming webhook.
 *  Pairs with the `janis.alert` ERROR log markers — the log line feeds a
 *  Cloud Logging alert, this pings Slack immediately without GCP plumbing.
 *  No-ops when ALERT_SLACK_WEBHOOK is unset. Never throws. */
export function opsAlert(text: string): void {
  if (!env.alertSlackWebhook) return;
  void fetch(env.alertSlackWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
