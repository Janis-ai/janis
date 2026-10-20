// Verbatim port of the alert gate chain — slack_bot.js isPro(),
// getBotAlertSettings(), and the severity/suppression block inside
// showJanisAlert (~8075-8180). These gates are the part that silently killed
// Shane's alerts; they must behave identically, including quirks.

export interface ClassicPrefsSettings {
  client_key?: string;
  logSeverityLevel?: number;
  helpNeededSeverityLevel?: number;
  userUpsetSeverityLevel?: number;
  errorWarningLevel?: number;
  customAlertSeverityLevel?: number;
  intents?: { id: string }[];
}

export type AlertType = 'showLog' | 'showLiveChat' | 'showCustomAlert' | 'error';

// isPro (slack_bot.js ~7899): trialing OR (non-basic plan && active);
// delinquent customer → not Pro.
export function isPro(integration: {
  stripe_customer?: { delinquent?: boolean } | null;
  subscription?: {
    status?: string;
    plan?: { id?: string };
    trial_end?: number;
  } | null;
} | null | undefined): boolean {
  if (integration?.stripe_customer && integration.stripe_customer.delinquent === true) {
    return false;
  }
  const subscription = integration?.subscription;
  return !!(
    subscription &&
    subscription.plan &&
    (subscription.status === 'trialing' ||
      (subscription.plan.id !== process.env.STRIPE_PLAN_BASIC &&
        subscription.status === 'active'))
  );
}

// getBotAlertSettings + the fall-through chain in showJanisAlert.
// `channelDoc` is the member's prefs/doc equivalent: {custom_alerts:[{client_key,…}],
// logSeverityLevel,…, bot_context:{client_key}}.
export function resolveAlertSettings(
  channelDoc: {
    custom_alerts?: ClassicPrefsSettings[];
    bot_context?: { client_key?: string } | null;
  } & ClassicPrefsSettings,
  clientKey: string,
): ClassicPrefsSettings {
  const alerts = channelDoc.custom_alerts ?? [];
  const found = alerts.find((o) => o.client_key === clientKey);
  const out: ClassicPrefsSettings = found ? { ...found } : { };

  const levels = [
    'logSeverityLevel',
    'helpNeededSeverityLevel',
    'userUpsetSeverityLevel',
    'errorWarningLevel',
    'customAlertSeverityLevel',
  ] as const;
  const contextMatch =
    channelDoc.bot_context?.client_key && channelDoc.bot_context.client_key === clientKey;
  for (const level of levels) {
    if (out[level] == null) {
      if (channelDoc[level] != null) out[level] = channelDoc[level];
      else if (contextMatch) out[level] = 1;
      else out[level] = 0;
    }
  }
  return out;
}

// The custom-alert intent re-check inside showJanisAlert — runs only when
// customAlertSeverityLevel > 0 AND json.reply exists.
export function applyCustomAlertIntentCheck(
  level: number,
  alertObj: ClassicPrefsSettings,
  replyRaw: unknown,
): number {
  if (level <= 0 || !replyRaw) return level;
  let replyRes: any = replyRaw;
  if (typeof replyRes === 'string') {
    try {
      replyRes = JSON.parse(replyRes);
    } catch {
      return level;
    }
  }
  if (
    replyRes?.result?.action !== 'alert.custom' &&
    replyRes?.result?.action !== 'custom_alert'
  ) {
    level = 0;
  }
  if (alertObj.intents) {
    const intentId = replyRes?.result?.metadata?.intentId;
    for (const intent of alertObj.intents) {
      if (intent.id === intentId) {
        level = 1;
        break;
      }
    }
  }
  return level;
}

// Severity computation (verbatim bounds).
export function logSeverityFor(count: number | undefined): number {
  if (count === 1) return 1;
  if ((count ?? 0) > 15) return 3;
  if ((count ?? 0) > 1) return 2;
  return 1;
}

export function sentimentSeverityFor(score: number): number {
  if (score <= -0.9) return 3;
  if (score <= -0.8) return 2;
  // original: (< -0.7 && > -0.8) → 1; and the -0.5..-0.66 band is only used by
  // logHeader's display emoji, not the gate — gate uses <-0.7 boundary:
  return 1;
}

// The suppression block — returns the reason the alert is dropped, or null.
export function suppressionReason(
  type: AlertType,
  alertObj: ClassicPrefsSettings,
  json: { isFailure?: boolean; count?: number; docSentiment?: { score?: number } },
): string | null {
  const logSeverity = logSeverityFor(json.count);
  const sentimentScore = json.docSentiment?.score ?? 0;
  const sentimentSeverity = sentimentSeverityFor(sentimentScore);

  if (
    json.isFailure &&
    (alertObj.logSeverityLevel === 0 || (alertObj.logSeverityLevel ?? 0) > logSeverity)
  ) {
    return 'logSeverity';
  }
  if (
    (alertObj.userUpsetSeverityLevel === 0 ||
      (alertObj.userUpsetSeverityLevel ?? 0) > sentimentSeverity) &&
    json.isFailure !== true &&
    type === 'showLog'
  ) {
    return 'userUpset';
  }
  if (alertObj.helpNeededSeverityLevel === 0 && type === 'showLiveChat') {
    return 'helpNeeded';
  }
  if (alertObj.customAlertSeverityLevel === 0 && type === 'showCustomAlert') {
    return 'customAlert';
  }
  if (alertObj.errorWarningLevel === 0 && type === 'error') {
    return 'errorWarning';
  }
  return null;
}
