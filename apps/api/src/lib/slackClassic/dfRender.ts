// makeMessageFromApiAi + makeMessageFromApiAiIntent (slack_bot.js
// 11972-12505) — the DF v1 fulfillment → Slack {text, attachments} renderer,
// verbatim. Used by the meta-bot shell, the training-channel renderer, and
// every dialogflow_message transcript line.

export interface DfSlackObject {
  text: string;
  attachments: any[];
}

export function makeMessageFromApiAi(
  response: any,
  isTraining = false,
  isWordhopChannel = false,
  matchingBot?: { platform?: string },
): DfSlackObject {
  let text = '';
  if (response?.status?.errorDetails) {
    return { text: response.status.errorDetails, attachments: [] };
  }
  if (response?.result?.fulfillment?.speech) {
    text = response.result.fulfillment.speech;
  }
  const messages = response?.result?.fulfillment?.messages;
  if (messages != null) {
    let hasPlatform = false;
    for (const m of messages) {
      if (m.platform && m.platform !== 'PLATFORM_UNSPECIFIED') {
        hasPlatform = true;
        break;
      }
    }
    return makeMessageFromApiAiIntent(messages, isTraining, hasPlatform, text, response, matchingBot, isWordhopChannel);
  }
  // Legacy drops speech-only fulfillments entirely (returns '') — callers
  // that want the speech read it off result.fulfillment themselves.
  return { text: '', attachments: [] };
}

export function makeMessageFromApiAiIntent(
  messages: any[],
  isTraining: boolean,
  hasPlatform: boolean,
  speech: string,
  response: any,
  matchingBot?: { platform?: string },
  isWordhopChannel = false,
): DfSlackObject {
  let text = '';
  const attachments: any[] = [];
  let hasChatfuelBlockRedirect = false;
  let hasPayloadBeenAdded = false;

  for (const m of messages) {
    const bot = matchingBot ? { ...matchingBot } : null;
    if (bot && bot.platform === 'messenger') bot.platform = 'facebook';
    if (bot && bot.platform === 'other') hasPlatform = false;

    // Verbatim legacy gate (slack_bot.js 11994-12001): ANY non-UNSPECIFIED
    // platform passes while hasPlatform, slack-platform passes when not in
    // training, everything passes when nothing declares a platform.
    if (
      (hasPlatform && m.platform && String(m.platform).toLowerCase() !== 'platform_unspecified') ||
      (m.platform && String(m.platform).toLowerCase() === 'slack' && !isTraining) ||
      !hasPlatform
    ) {
      if (m.payload) {
        let payload = m.payload;
        if (payload.slack) payload = payload.slack;
        if (payload.botcopy) payload = payload.botcopy;
        if (Array.isArray(payload)) payload = payload[0];
        const keys = Object.keys(payload);

        if (!hasPayloadBeenAdded) {
          if (payload.attachments) {
            for (const att of payload.attachments) {
              if (att.fallback == null) att.fallback = 'attachment';
              attachments.push(att);
            }
          }
          if (payload.text && typeof payload.text === 'string') {
            text = text + '\n' + payload.text;
          } else if (payload.text && Array.isArray(payload.text)) {
            if (payload.text[0] && payload.text[0].displayText) {
              text = text + '\n' + payload.text[0].displayText;
            }
          } else if (payload.text && payload.text.displayText) {
            text = text + '\n' + payload.text.displayText;
          } else if (payload.messages) {
            for (const msg of payload.messages) {
              if (msg.text) {
                text = text + '\n' + msg.text;
              } else if (msg.attachment) {
                attachments.push(msg.attachment);
              } else if (msg.quick_replies) {
                const actions = [];
                let callback_id = 'generic_callback';
                for (const reply of msg.quick_replies) {
                  if (response?.result?.action) {
                    callback_id = response.result.action;
                  } else if (response?.responses?.length > 0) {
                    callback_id = response.responses[0].action;
                  }
                  actions.push({ name: reply, text: reply, type: 'button', value: reply });
                }
                const title = msg.title ?? '';
                attachments.push({
                  mrkdwn_in: ['fields', 'text', 'pretext'],
                  text: title,
                  callback_id,
                  attachment_type: 'default',
                  fallback: title,
                  color: '#3AA3E3',
                  actions,
                });
              }
            }
          }
          if (keys.length > 0 && keys[0] !== 'redirect_to_blocks') {
            hasPayloadBeenAdded = true;
          }
          if (isTraining) {
            if (keys.length === 1 && keys[0] === 'redirect_to_blocks') {
              text = text + '\n\n' + 'Redirects to Chatfuel block(s): ```' + JSON.stringify(payload.redirect_to_blocks, null, 2) + '```\n';
              hasChatfuelBlockRedirect = true;
            } else if (keys.length === 1 && keys[0] === 'flow') {
              text = text + '\n\n' + 'Redirects to Manychat flow: ```' + JSON.stringify(payload.flow, null, 2) + '```\n';
              hasChatfuelBlockRedirect = true;
            } else {
              text = text + '\n\n' + 'Custom payload: ```' + JSON.stringify(payload, null, 2) + '```\n';
            }
          }
        }
      }

      if (m.speech) {
        if (typeof m.speech === 'string') {
          text = text + '\n' + m.speech;
        } else if (m.speech.length > 0) {
          text = text + '\n' + m.speech[Math.floor(Math.random() * m.speech.length)];
        }
      } else if (m.simpleResponses) {
        const srs = m.simpleResponses.simpleResponses;
        if (srs && srs.length > 0) {
          text = text + '\n' + srs[Math.floor(Math.random() * srs.length)].textToSpeech;
        }
      } else if (m.suggestions) {
        const actions = [];
        if (m.suggestions.suggestions && m.suggestions.suggestions.length > 0) {
          for (const suggestion of m.suggestions.suggestions) {
            const quickReply = suggestion.title;
            actions.push({ name: quickReply, text: quickReply, type: 'button', value: quickReply });
          }
        }
        attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          text: '',
          callback_id: 'generic_callback',
          attachment_type: 'default',
          fallback: 'fallback',
          color: '#3AA3E3',
          actions,
        });
      } else if (m.linkOutSuggestion) {
        const quickReply = m.linkOutSuggestion.destinationName;
        const actions = [{ name: quickReply, text: quickReply, type: 'button', value: quickReply }];
        attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          text: '',
          callback_id: 'generic_callback',
          attachment_type: 'default',
          fallback: 'fallback',
          color: '#3AA3E3',
          actions,
        });
      } else if (m.replies != null) {
        const actions = [];
        let callback_id = 'generic_callback';
        for (const reply of m.replies) {
          if (response?.result?.action) {
            callback_id = response.result.action;
          } else if (response?.responses?.length > 0) {
            callback_id = response.responses[0].action;
          }
          actions.push({ name: reply, text: reply, type: 'button', value: reply });
        }
        const title = m.title ?? '';
        attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          text: title,
          callback_id,
          attachment_type: 'default',
          fallback: title,
          color: '#3AA3E3',
          actions,
        });
      } else if (m.basicCard) {
        const card = m.basicCard;
        let callback_id = 'generic_callback';
        if (response.result.action) callback_id = response.result.action;

        if (card.image && card.image.imageUri) {
          const fallback = card.image.accessibilityText ? card.image.accessibilityText : 'fallback';
          attachments.push({ text: '', image_url: card.image.imageUri, fallback });
        }
        const actions = [];
        for (const button of card.buttons ?? []) {
          let postback = button.title;
          if (button.postback) postback = button.postback;
          if (button.title) {
            actions.push({ name: button.title, text: button.title, type: 'button', value: postback });
          }
        }
        const title = card.title ?? '';
        const subtitle = card.subtitle ?? '';
        if (card.formattedText == null) card.formattedText = '';
        attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          text: subtitle,
          title,
          callback_id,
          attachment_type: 'default',
          fallback: title,
          color: '#3AA3E3',
          actions: [],
        });
        attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          text: card.formattedText,
          callback_id,
          attachment_type: 'default',
          color: '#3AA3E3',
          fallback: card.formattedText,
          actions,
        });
      } else if (m.listSelect) {
        const card = m.listSelect;
        let callback_id = 'generic_callback';
        if (response.result.action) callback_id = response.result.action;
        const title = card.title ?? '';
        attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          text: '',
          title,
          callback_id,
          attachment_type: 'default',
          fallback: title,
          color: '#3AA3E3',
          actions: [],
        });
        for (const button of card.items ?? []) {
          if (button.image && button.image.imageUri) {
            const fallback = button.image.accessibilityText ? button.image.accessibilityText : 'fallback';
            attachments.push({
              mrkdwn_in: ['fields', 'text', 'pretext'],
              title: button.title ?? '',
              text: button.description ?? '',
              callback_id,
              attachment_type: 'default',
              color: '#3AA3E3',
              image_url: button.image.imageUri,
              fallback,
              actions: [],
            });
          }
        }
      } else if (m.carouselSelect) {
        const card = m.carouselSelect;
        // Legacy leaks callback_id (var-hoisted, often undefined here) —
        // actions arrays are empty anyway, so it's cosmetic. Verbatim: omit.
        let callback_id: string | undefined;
        for (const button of card.items ?? []) {
          if (button.image && button.image.imageUri) {
            const fallback = button.image.accessibilityText ? button.image.accessibilityText : 'fallback';
            attachments.push({
              mrkdwn_in: ['fields', 'text', 'pretext'],
              title: button.title ?? '',
              text: button.description ?? '',
              callback_id,
              attachment_type: 'default',
              color: '#3AA3E3',
              image_url: button.image.imageUri,
              fallback,
              actions: [],
            });
          }
        }
      } else if (m.buttons != null) {
        if (m.imageUrl) {
          attachments.push({ text: '', image_url: m.imageUrl, fallback: 'image' });
        }
        const actions = [];
        let callback_id = 'generic_callback';
        for (const button of m.buttons) {
          if (response.result.action) callback_id = response.result.action;
          let postback = button.text;
          if (button.postback) postback = button.postback;
          if (button.text) {
            actions.push({ name: button.text, text: button.text, type: 'button', value: postback });
          }
        }
        const title = m.title ?? '';
        const subtitle = m.subtitle ?? '';
        attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          text: subtitle,
          title,
          callback_id,
          attachment_type: 'default',
          color: '#3AA3E3',
          fallback: title,
          actions,
        });
      } else if (m.imageUrl != null) {
        attachments.push({
          fallback: 'image',
          title: '',
          text: '',
          color: '#3AA3E3',
          image_url: m.imageUrl,
        });
      }
    }
  }

  if (speech != null && speech !== '' && text === '') {
    text = speech;
  }
  text = text.replace(/\\n/g, '\n');
  text = text.replace(/\\t/g, '\t');
  if (text === ' ' || text == null) {
    text = '';
  }
  return { text, attachments };
}
