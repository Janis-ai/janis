// Verbatim port of the button_definitions.js sets used on the ported paths —
// pause/resume/pauseTranscribe/resumeWithSourceChannel/takeOver,
// messengerLog, reconnectMessenger, billingLog, compare, freePlan, log,
// filterAlerts. Attachment format (not Block Kit) — parity with what Slack
// renders for these teams today.

export interface SlackAction {
  name?: string;
  text: string;
  type: string;
  value?: string;
  url?: string;
  style?: string;
}

export interface SlackAttachment {
  text?: string;
  callback_id?: string;
  attachment_type?: string;
  actions?: SlackAction[];
  mrkdwn_in?: string[];
  color?: string;
  fields?: { short: boolean; value: string }[];
  title?: string;
  fallback?: string;
  image_url?: string;
  thumb_url?: string;
}

export function resumeButtons(): SlackAttachment {
  return {
    text: '',
    callback_id: 'resume_buttons',
    attachment_type: 'default',
    actions: [
      { name: 'Resume', text: 'Resume', type: 'button', value: 'Resume', style: 'primary' },
      { name: 'Push Content', text: 'Push Content', type: 'button', value: 'Push Content' },
      { name: 'About User', text: 'About User', type: 'button', value: 'About User' },
      { name: 'Help', text: 'Help', type: 'button', value: 'Help' },
    ],
  };
}

export function pauseButtons(): SlackAttachment {
  return {
    text: '',
    callback_id: 'pause_buttons',
    attachment_type: 'default',
    actions: [
      { name: 'Pause', text: 'Pause', type: 'button', value: 'Pause', style: 'danger' },
      { name: 'Push Content', text: 'Push Content', type: 'button', value: 'Push Content' },
      { name: 'About User', text: 'About User', type: 'button', value: 'About User' },
      { name: 'Help', text: 'Help', type: 'button', value: 'Help' },
      { name: 'Leave Channel', text: 'Leave', type: 'button', value: 'Leave Channel' },
    ],
  };
}

export function pauseTranscribeButtons(): SlackAttachment {
  return {
    text: '',
    callback_id: 'pause_buttons',
    attachment_type: 'default',
    actions: [
      { name: 'Pause', text: 'Pause', type: 'button', value: 'Pause', style: 'danger' },
      { name: 'Transcribe', text: 'Transcribe', type: 'button', value: 'Transcribe' },
      { name: 'About User', text: 'About User', type: 'button', value: 'About User' },
      { name: 'Help', text: 'Help', type: 'button', value: 'Help' },
      { name: 'Leave Channel', text: 'Leave', type: 'button', value: 'Leave Channel' },
    ],
  };
}

// pauseResumeButtons — chooses based on the SOURCE channel's pause state.
export function pauseResumeButtons(sourceChannel: {
  paused?: boolean;
  should_process_transcript?: boolean;
}): SlackAttachment {
  if (sourceChannel.paused) return resumeButtons();
  if (sourceChannel.should_process_transcript) return pauseButtons();
  return pauseTranscribeButtons();
}

export function takeOverButtons(sourceChannel: string): SlackAttachment {
  return {
    text: '',
    callback_id: 'log_buttons',
    actions: [
      {
        name: 'Take Over',
        text: 'Take Over',
        type: 'button',
        value: `Take Over:${sourceChannel}`,
        style: 'danger',
      },
    ],
  };
}

export function resumeButtonsWithSourceChannel(sourceChannel: string): SlackAttachment {
  return {
    text: '',
    callback_id: 'resume_buttons_with_source_channel',
    attachment_type: 'default',
    actions: [
      {
        name: 'Resume',
        text: 'Resume',
        type: 'button',
        value: `Resume Bot:${sourceChannel}`,
        style: 'primary',
      },
    ],
  };
}

export function freePlanButtons(): SlackAttachment {
  return {
    text: '',
    callback_id: 'log_buttons',
    actions: [
      {
        name: 'Upgrade',
        text: 'Upgrade',
        type: 'button',
        url: 'https://www.janis.ai/account/settings/billing',
      },
    ],
  };
}

export function compareButtons(): SlackAttachment {
  return {
    text: '',
    callback_id: 'log_buttons',
    actions: [{ name: 'Compare plans', text: 'Compare plans', type: 'button', value: 'Compare plans' }],
  };
}

export function billingLogButtons(): SlackAttachment {
  return {
    text: '',
    callback_id: 'log_buttons',
    actions: [
      {
        type: 'button',
        text: 'Billing',
        url: 'https://www.janis.ai/account/settings/billing',
      },
    ],
  };
}

export function messengerLogButtons(url: string): SlackAttachment {
  return {
    text:
      ':key: Complete the setup. Connect me to your Facebook page: \n' +
      ":rocket: I'll monitor your bot \n" +
      ':rocket: You\'ll get all `alerts` \n' +
      ':rocket: You can take over live from this workspace \n' +
      ':rocket: You can train your bot from your chat transcripts',
    callback_id: 'log_buttons',
    actions: [
      { type: 'button', text: 'Connect to Facebook', url, style: 'primary' },
    ],
  };
}

export function reconnectMessengerButtons(url: string): SlackAttachment {
  return {
    text: ' ',
    callback_id: 'log_buttons',
    actions: [
      { type: 'button', text: 'Reconnect to Facebook', url, style: 'primary' },
    ],
  };
}

export function logButtons(): SlackAttachment {
  return {
    text: '',
    callback_id: 'log_buttons',
    actions: [
      { name: 'Filter Alerts', text: 'Filter Alerts', type: 'button', value: 'Filter Alerts' },
      { name: 'Train', text: 'Train', type: 'button', value: 'Train' },
    ],
  };
}

export function filterAlertsButtons(): SlackAttachment {
  return {
    text: '',
    callback_id: 'log_buttons',
    actions: [
      { name: 'Filter Alerts', text: 'Filter Alerts', type: 'button', value: 'Filter Alerts' },
    ],
  };
}
