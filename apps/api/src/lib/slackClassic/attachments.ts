// Verbatim port of makeFbMessage / makeFbAttachment / fbButton
// (slack_bot.js ~7428-7600) — converts Messenger/DF message payloads into the
// Slack attachment format transcript lines render as, plus the shared
// normalization used by sendChatMessageResponse/dialogflowMessageResponse.

import type { SlackAttachment } from './buttons';

function fbButton(payload: any): SlackAttachment | Record<string, never> {
  const facebookButtons = payload?.buttons;
  if (facebookButtons == null) return {};
  let text = '';
  if (payload.template_type === 'button') {
    text = payload.text || payload.title || payload.subtitle || '';
  }
  const slackButtons: SlackAttachment = {
    text,
    callback_id: 'fb_buttons',
    attachment_type: 'default',
    actions: [],
    fallback: 'Facebook attachment',
  };
  for (const btn of facebookButtons) {
    slackButtons.actions!.push({
      name: btn.title,
      text: btn.title,
      type: 'button',
      value: btn.title,
    });
  }
  return slackButtons;
}

export function makeFbAttachment(attachment: any, attachments: any[]): void {
  if (attachment.text == null) attachment.text = '';
  if (attachment.contentType === 'image/png' || attachment.contentType === 'image') {
    attachment.image_url = attachment.contentUrl;
    attachment.thumb_url = attachment.thumbnailUrl;
    attachments.push(attachment);
  } else if (attachment.type === 'image') {
    attachment.image_url = attachment.payload?.url;
    attachments.push(attachment);
  } else if (
    attachment.type === 'file' ||
    attachment.type === 'audio' ||
    attachment.type === 'video'
  ) {
    if (attachment.payload?.url) {
      attachments.push({ text: attachment.payload.url });
    } else {
      attachments.push({ text: `resusable ${attachment.type}` });
    }
  } else if (attachment.type === 'template' && attachment.payload) {
    const pl = attachment.payload;
    if (pl.template_type === 'button') {
      attachments.push(fbButton(pl));
    } else if (
      pl.template_type === 'generic' ||
      pl.template_type === 'list' ||
      pl.template_type === 'receipt'
    ) {
      for (const element of pl.elements ?? []) {
        if (element.image_url) {
          attachments.push({ text: '', image_url: element.image_url });
        }
        attachments.push({
          mrkdwn_in: ['text', 'pretext'],
          title: element.title ?? '',
          text: element.subtitle ?? '',
        });
        attachments.push(fbButton(element));
      }
    }
  } else {
    attachments.push(attachment);
  }
}

// The outbound-transcript normalization shared by sendChatMessageResponse and
// dialogflowMessageResponse — mutates copy, returns normalized attachments.
export function normalizeTranscriptAttachments(attachments: any[] | undefined): {
  out: any[];
  fileUploads: { url: string; filename: string }[];
} {
  const out: any[] = [];
  const fileUploads: { url: string; filename: string }[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.contentType === 'image/png' || attachment.contentType === 'image') {
      out.push({
        text: attachment.name,
        image_url: attachment.contentUrl,
        thumb_url: attachment.thumbnailUrl,
      });
    } else if (attachment.type === 'image') {
      out.push({ text: '', image_url: attachment.payload?.url });
    } else if (
      attachment.type === 'file' ||
      attachment.type === 'audio' ||
      attachment.type === 'video'
    ) {
      if (attachment.payload?.url) {
        out.push({ text: attachment.payload.url });
      } else {
        out.push({ text: `resusable ${attachment.type}` });
      }
      let filename = attachment.type;
      if (attachment.type === 'audio' || attachment.type === 'video') {
        filename = `${filename}.mp4`;
      }
      if (attachment.payload?.url) {
        fileUploads.push({ url: attachment.payload.url, filename });
      }
    } else {
      out.push(attachment);
    }
  }
  return { out, fileUploads };
}

// makeFbMessage — the bot-side transcript line (verbatim shape).
export function makeFbMessage(msg: any): {
  text: string;
  attachments: any[];
  transcript: boolean;
  username: string | undefined;
  icon_emoji: string;
} {
  // DFv2 fulfillmentMessages conversion is handled upstream in the new stack
  // (the agent's own reply payload is already canonical).
  if (msg.message) msg = msg.message;
  const attachments: any[] = [];
  if (msg.attachments) {
    for (const attachment of msg.attachments) makeFbAttachment(attachment, attachments);
  } else if (msg.attachment) {
    makeFbAttachment(msg.attachment, attachments);
  } else if (msg.payload) {
    makeFbAttachment(msg.payload, attachments);
  }
  if (msg.quick_replies) {
    const slackButtons: SlackAttachment = {
      text: '',
      callback_id: 'fb_buttons',
      attachment_type: 'default',
      actions: [],
    };
    for (const btn of msg.quick_replies) {
      slackButtons.actions!.push({
        name: btn.title,
        text: btn.title,
        type: 'button',
        value: btn.title,
      });
    }
    attachments.push(slackButtons);
  }
  let text = '';
  if (msg.text) text = msg.text;
  else if (typeof msg === 'string') text = msg;
  return {
    text,
    attachments,
    transcript: true,
    username: msg.bot_name,
    icon_emoji: ':robot_face:',
  };
}
