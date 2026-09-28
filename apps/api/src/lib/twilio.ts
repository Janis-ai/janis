import { env } from '../env.js';

/**
 * Minimal Twilio REST client — Basic auth, form-encoded bodies, JSON in/out.
 * Used for hosted voice: subaccounts, number search, purchase, release.
 * Caller-facing calls (TwiML webhooks) live in routes/voice.ts.
 */
const API = 'https://api.twilio.com/2010-04-01';

export interface TwilioError {
  code?: number;
  message?: string;
  status?: number;
}

export async function twilioApi(
  sid: string,
  token: string,
  path: string,
  opts: { method?: string; params?: Record<string, string> } = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      ...(opts.params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(opts.params ? { body: new URLSearchParams(opts.params).toString() } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & TwilioError;
  if (!res.ok) {
    const err = new Error(data.message ?? `twilio ${res.status}`) as Error & TwilioError;
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export function hostedVoiceCreds(): { sid: string; token: string } | null {
  return env.twilioAccountSid && env.twilioAuthToken
    ? { sid: env.twilioAccountSid, token: env.twilioAuthToken }
    : null;
}

export interface AvailableNumber {
  phone_number: string;
  friendly_name: string;
  locality?: string;
  region?: string;
}

/** Search buyable voice-capable numbers on the master account. */
export async function searchVoiceNumbers(
  country: string,
  opts: { areaCode?: string; contains?: string } = {},
): Promise<AvailableNumber[]> {
  const master = hostedVoiceCreds();
  if (!master) throw new Error('hosted voice is not configured');
  const qs = new URLSearchParams({ VoiceEnabled: 'true', PageSize: '20' });
  if (opts.areaCode) qs.set('AreaCode', opts.areaCode);
  if (opts.contains) qs.set('Contains', opts.contains);
  const data = await twilioApi(
    master.sid,
    master.token,
    `/Accounts/${master.sid}/AvailablePhoneNumbers/${country}/Local.json?${qs}`,
  );
  return ((data.available_phone_numbers as AvailableNumber[] | undefined) ?? []).map((n) => ({
    phone_number: n.phone_number,
    friendly_name: n.friendly_name,
    locality: n.locality,
    region: n.region,
  }));
}

/**
 * Provision a hosted number: dedicated subaccount (isolated billing/abuse
 * boundary per channel), then buy the number INTO the subaccount with the
 * voice webhooks prewired. Returns the creds the channel row stores — the
 * webhook signature validator uses the subaccount's own auth token.
 */
export async function provisionVoiceNumber(
  channelId: string,
  phoneNumber: string,
  label: string,
): Promise<{ subSid: string; subToken: string; number: string; numberSid: string }> {
  const master = hostedVoiceCreds();
  if (!master) throw new Error('hosted voice is not configured');

  // One subaccount per voice channel — its auth token signs the webhooks,
  // and closing it on disconnect releases billing cleanly.
  const sub = await twilioApi(master.sid, master.token, '/Accounts.json', {
    method: 'POST',
    params: { FriendlyName: `janis-voice-${label}` },
  });
  const subSid = sub.sid as string;
  const subToken = sub.auth_token as string;
  if (!subSid || !subToken) throw new Error('twilio: subaccount creation returned no creds');

  try {
    const bought = await twilioApi(subSid, subToken, `/Accounts/${subSid}/IncomingPhoneNumbers.json`, {
      method: 'POST',
      params: {
        PhoneNumber: phoneNumber,
        VoiceUrl: `${env.apiOrigin}/voice/${channelId}/incoming`,
        VoiceMethod: 'POST',
        StatusCallback: `${env.apiOrigin}/voice/${channelId}/status`,
        StatusCallbackMethod: 'POST',
      },
    });
    return { subSid, subToken, number: phoneNumber, numberSid: bought.sid as string };
  } catch (err) {
    // Purchase failed (regulatory bundle required, number gone) — don't leak
    // a billed subaccount; close it and let the caller surface the error.
    await twilioApi(master.sid, master.token, `/Accounts/${subSid}.json`, {
      method: 'POST',
      params: { Status: 'closed' },
    }).catch(() => {});
    throw err;
  }
}

/** Release a hosted channel's number and close its subaccount. */
export async function deprovisionVoiceNumber(subSid: string, numberSid?: string): Promise<void> {
  const master = hostedVoiceCreds();
  if (!master) return;
  if (numberSid) {
    // Master creds can manage subaccount resources directly — release the
    // number before closing the account so nothing keeps billing.
    await twilioApi(
      master.sid,
      master.token,
      `/Accounts/${subSid}/IncomingPhoneNumbers/${numberSid}.json`,
      { method: 'DELETE' },
    ).catch(() => {});
  }
  await twilioApi(master.sid, master.token, `/Accounts/${subSid}.json`, {
    method: 'POST',
    params: { Status: 'closed' },
  }).catch(() => {});
}
