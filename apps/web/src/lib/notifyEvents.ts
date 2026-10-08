/** Alert classes a member can toggle — keys match users.notify_prefs.events
 *  and agent_members.notify_prefs.events. Shared by the workspace baseline
 *  editor (Settings → Team) and the per-agent override editor. */
export const NOTIFY_EVENT_LABELS: [string, string][] = [
  ['handoff', 'Needs human'],
  ['failure', 'Agent failures'],
  ['ops', 'Agent errors'],
  ['inactivity', 'Unanswered customers'],
  ['sentiment', 'Negative sentiment'],
  ['offer', 'Handoff offers'],
  ['sla', 'SLA breaches'],
  ['assigned', 'Assigned to me'],
  ['keyword', 'Keyword matches'],
  ['intent', 'Topic matches'],
  ['csat', 'Low CSAT scores'],
  ['custom', 'Custom alerts'],
  ['approval', 'Approvals'],
  ['mention', 'Mentions'],
  ['digest', 'Digests'],
  ['eval', 'Eval regressions'],
];
