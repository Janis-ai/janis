// Verbatim port of wordhop-slack src/string_definitions.js — the copy
// customers see on every alert card. Do not "improve" wording; parity is the
// product requirement here.

export function severityLevelText(level: number): string {
  if (level === 0) return ':mute:';
  if (level === 1) return ':speak_no_evil:';
  if (level === 2) return ':speak_no_evil::speak_no_evil:';
  if (level === 3) return ':speak_no_evil::speak_no_evil::speak_no_evil:';
  return '';
}

export function sentimentLevelText(level: number): string {
  if (level === 0) return ':mute:';
  if (level === 1) return ':scream:';
  if (level === 2) return ':scream::scream:';
  if (level === 3) return ':scream::scream::scream:';
  return '';
}

export function helpNeededLevelText(level: number): string {
  if (level === 0) return ':mute:';
  if (level === 1) return ':information_desk_person::skin-tone-2:';
  return '';
}

export function customAlertLevelText(level: number): string {
  if (level === 0) return ':mute:';
  if (level === 1) return ':bell:';
  return '';
}

export function logDescription(botName: string, _level: number): string {
  return `*${botName}*: No response`;
}

export function sentimentDescription(botName: string, _level: number): string {
  return `*${botName}*: Negative sentiment`;
}

export function helpNeededDescription(botName: string): string {
  return `*${botName}*: Help requested`;
}

export function logHeader(
  botName: string,
  level: number,
  sentimentScore: number,
  isFailure: boolean,
): string {
  let emoji = '';
  let txt = '';
  if (sentimentScore < -0.5 && sentimentScore > -0.66) {
    emoji = sentimentLevelText(1);
    txt = sentimentDescription(botName, 1);
  } else if (sentimentScore <= -0.66 && sentimentScore > -0.9) {
    emoji = sentimentLevelText(2);
    txt = sentimentDescription(botName, 2);
  } else if (sentimentScore <= -0.9) {
    emoji = sentimentLevelText(3);
    txt = sentimentDescription(botName, 3);
  }
  let header = `${emoji} ${txt}`;
  if (isFailure) {
    if (txt.length > 0) header += '\n';
    header = `${severityLevelText(level)} ${logDescription(botName, level)}`;
  }
  return header;
}

export function assistanceHeader(botName: string): string {
  return `${helpNeededLevelText(1)} ${helpNeededDescription(botName)}`;
}

export function errorHeader(botName: string): string {
  return `:warning: *${botName}*`;
}

export const slashCommandWarning =
  '_`/pause` and `/resume` only work in user transcript channels._';

// custom_messages.js — verbatim invite strings.
export function invitedMessage(name: string): { text: string; attachments: any[] } {
  return {
    text:
      'Thanks for the invite, ' +
      name +
      '. I monitor bots and when I sense problems I will alert you here.' +
      ' To learn more about my capabilities say `Help`.',
    attachments: [],
  };
}

export function invitedToTranscriptMessage(
  name: string,
  sourceChannel: string,
): { text: string; attachments: any[] } {
  return {
    text:
      '_Thanks for the adding me to this channel, ' +
      name +
      '. Type freely, without using slash commands, and your message will be sent through your bot to your user. ' +
      'A full transcript of this conversation can be viewed at_ https://www.janis.ai/messages/' +
      sourceChannel +
      '.',
    attachments: [],
  };
}
