/**
 * Port of wordhopapi api/messenger.js response formatting — the JSON the
 * Chatfuel JSON API card and the ManyChat external request expect back.
 *
 * Chatfuel:   {messages: [{text} | {attachment:{template,...}} | ...],
 *              set_attributes?, redirect_to_blocks?}
 * ManyChat:   {version:'v2', content:{messages:[{type:...}], actions:[],
 *              quick_replies:[{type:'node',caption,target}]}}
 *
 * DF fulfillment messages arrive in the v1 shape from dialogflow.ts
 * (type 0=text, 1=card, 2=quick replies, 3=image, 4=custom payload).
 */
import type { V1Message, V1Result } from './dialogflow.js';

const FB_TEXT_LIMIT = 640;

/** Slack-ish markup + emoji codes → plain text (wordhopapi removeFormatting). */
export function removeFormatting(text: string): string {
  const reserved = ['channel', 'group', 'everyone', 'here'];
  return text
    .replace(/<([@#!])?([^>|]+)(?:\|([^>]+))?>/g, (m, type: string, link: string, label?: string) => {
      switch (type) {
        case '@': return m;
        case '#': if (label) return label; break;
        case '!': if (reserved.includes(link)) return `@${link}`; break;
        default:
          link = link.replace(/^mailto:/, '');
          if (label && !link.includes(label)) return `${label} (${link})`;
          return link;
      }
      return m;
    })
    .replace(/:(skin-tone)(\S+):/g, '');
}

function splitResponse(str: string): string[] {
  if (str.length <= FB_TEXT_LIMIT) return [str];
  const out: string[] = [];
  let curr = FB_TEXT_LIMIT;
  let prev = 0;
  while (curr < str.length) {
    let cut = -1;
    for (let i = curr; i > prev; i--) {
      if (str[i] === ' ') { cut = i; break; }
    }
    if (cut === -1) cut = Math.min(curr, str.length);
    out.push(str.slice(prev, cut).trim());
    prev = cut;
    curr = cut + FB_TEXT_LIMIT;
  }
  out.push(str.slice(prev).trim());
  return out.filter(Boolean);
}

const isFb = (m: V1Message) => m.platform == null || m.platform.toLowerCase() === 'facebook';
const titleLimit = (t: string) => (t.length > 20 ? `${t.slice(0, 16)}...` : t);

/** v1 fulfillment.messages → Messenger-format message objects.
 *  chatfuel: card buttons become show_block (block_names) so taps route back
 *  into the customer's Chatfuel blocks; quick replies redirect to "Janis". */
export function toFbMessages(messages: V1Message[], flavor: 'chatfuel' | 'manychat' | 'fb'): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const txtIdx: number[] = [];
  let lastTxt = -1;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    switch (m.type) {
      case 0: {
        if (!m.speech) break;
        for (let s of splitResponse(m.speech)) {
          s = removeFormatting(s);
          if (m.platform == null && txtIdx.length === 0) {
            // platform-less text holds until a facebook variant appears
            txtIdx.push(out.length);
            out.push(flavor === 'manychat' ? { type: 'text', text: s } : { text: s });
            lastTxt = out.length - 1;
          } else if (m.platform?.toLowerCase() === 'facebook') {
            for (const idx of txtIdx) out.splice(idx, 1);
            txtIdx.length = 0;
            out.push(flavor === 'manychat' ? { type: 'text', text: s } : { text: s });
            lastTxt = out.length - 1;
          }
        }
        break;
      }
      case 1: {
        if (!isFb(m)) break;
        // consecutive cards collapse into one carousel
        const carousel = [m];
        while (i + 1 < messages.length && messages[i + 1].type === 1 && isFb(messages[i + 1])) {
          carousel.push(messages[++i]);
        }
        const elements = carousel.map((c) => {
          const card: Record<string, unknown> = {
            title: removeFormatting(c.title ?? ''),
            subtitle: removeFormatting(c.subtitle ?? ''),
          };
          if (c.imageUrl) card.image_url = c.imageUrl;
          const buttons = (c.buttons ?? [])
            .filter((b) => b.text)
            .map((b) => {
              const postback = removeFormatting(b.postback ?? '') || removeFormatting(b.text ?? '');
              if (postback.startsWith('http')) return { type: 'web_url', title: b.text, url: postback };
              if (flavor === 'chatfuel') {
                return {
                  type: 'show_block',
                  title: b.text,
                  block_names: b.postback ? [b.postback] : ['Janis'],
                  set_attributes: { 'user input': b.text },
                };
              }
              return { type: 'postback', title: b.text, payload: postback };
            });
          if (buttons.length) card.buttons = buttons;
          return card;
        });
        const att: Record<string, unknown> = { type: 'template', payload: { template_type: 'generic', elements } };
        if (m.payload?.image_aspect_ratio) (att.payload as Record<string, unknown>).image_aspect_ratio = m.payload.image_aspect_ratio;
        out.push({ attachment: att });
        break;
      }
      case 2: {
        if (!m.replies?.length || !isFb(m)) break;
        // no title → steal the preceding text message as the prompt
        let text = m.title ?? '';
        if (!text && lastTxt >= 0 && typeof out[lastTxt]?.text === 'string') {
          text = out[lastTxt].text as string;
          out.splice(lastTxt, 1);
        }
        const quick_replies = m.replies.map((r) => {
          if (flavor === 'chatfuel') {
            return { title: titleLimit(r), block_names: ['Janis'], set_attributes: { 'user input': titleLimit(r) } };
          }
          const match = /{(.*)}/.exec(r);
          if (match) return { content_type: match[1] };
          return { content_type: 'text', title: titleLimit(r), payload: titleLimit(r) };
        });
        out.push({ text, quick_replies });
        break;
      }
      case 3: {
        if (!m.imageUrl || !isFb(m)) break;
        out.push({ attachment: { type: 'image', payload: { url: m.imageUrl } } });
        break;
      }
      case 4: {
        const fb = m.payload?.facebook;
        if (fb && typeof fb === 'object' && isFb(m)) out.push(fb as Record<string, unknown>);
        break;
      }
    }
  }
  return out;
}

/** Pick a response payload: webhookPayload.facebook or a fulfillment message
 *  payload carrying the caller's keys; a random pick when several match. */
function pickPayload(result: V1Result, flavor: 'chatfuel' | 'manychat'): Record<string, unknown> | null {
  const payloads: Record<string, unknown>[] = [];
  const wp = result.fulfillment.webhookPayload?.facebook;
  if (wp && typeof wp === 'object') {
    if (flavor === 'manychat' && (wp as { version?: string }).version === 'v2' && (wp as { content?: unknown }).content) {
      payloads.push((wp as { content: Record<string, unknown> }).content);
    } else {
      payloads.push(wp as Record<string, unknown>);
    }
  }
  for (const m of result.fulfillment.messages ?? []) {
    const p = m.payload;
    if (!p) continue;
    if (
      (flavor === 'chatfuel' && (p.messages || p.redirect_to_blocks || p.set_attributes)) ||
      (flavor === 'manychat' && (p.actions || p.messages || p.quick_replies))
    ) {
      payloads.push(p);
    } else if (flavor === 'manychat' && p.version === 'v2' && p.content && typeof p.content === 'object') {
      payloads.push(p.content as Record<string, unknown>);
    }
  }
  return payloads.length ? payloads[Math.floor(Math.random() * payloads.length)] : null;
}

/** Chatfuel JSON API response: {messages:[...], set_attributes?, ...} */
export function buildChatfuelPayload(result: V1Result): Record<string, unknown> {
  const payload = pickPayload(result, 'chatfuel') ?? {};
  const fbMessages = toFbMessages(result.fulfillment.messages ?? [], 'chatfuel');
  const existing = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : [];
  return { ...payload, messages: [...fbMessages, ...existing] };
}

interface ManychatMessage {
  type: string;
  text?: string;
  url?: string;
  elements?: unknown[];
  image_aspect_ratio?: string;
}

/** ManyChat external-request response: {version:'v2',content:{messages,actions,quick_replies}} */
export function buildManychatPayload(result: V1Result): Record<string, unknown> {
  const payload = pickPayload(result, 'manychat') ?? {};
  const fbMessages = toFbMessages(result.fulfillment.messages ?? [], 'manychat');
  const raw = [...fbMessages, ...(Array.isArray(payload.messages) ? (payload.messages as Record<string, unknown>[]) : [])];

  const messages: ManychatMessage[] = [];
  const quick_replies: { type: string; caption?: string; target?: string }[] = [];
  for (const m of raw) {
    if (m.type === 'text' || m.type === 'audio' || m.type === 'video' || m.type === 'image' || m.type === 'file') {
      messages.push(m as unknown as ManychatMessage);
    } else if (Array.isArray(m.quick_replies)) {
      if (m.text) messages.push({ type: 'text', text: m.text as string });
      for (const qr of m.quick_replies as { title?: string }[]) {
        quick_replies.push({ type: 'node', caption: qr.title, target: qr.title });
      }
    } else if (m.attachment) {
      const att = m.attachment as { type?: string; payload?: { url?: string; elements?: { buttons?: Record<string, unknown>[] }[]; image_aspect_ratio?: string } };
      if (att.type === 'image') {
        messages.push({ type: 'image', url: att.payload?.url });
      } else if (att.type === 'template' && att.payload?.elements) {
        for (const el of att.payload.elements) {
          for (const b of el.buttons ?? []) {
            if (b.url) b.type = 'url';
            else if (
              typeof b.title === 'string' &&
              /content|seqmessage|widget|default|^welcome|system_/.test(b.title)
            ) b.type = 'flow';
            else if (b.type === 'postback') b.type = 'flow';
            if (b.title) { b.caption = b.title; delete b.title; }
            if (b.payload) { b.target = b.payload; delete b.payload; }
          }
        }
        const card: ManychatMessage = { type: 'cards', elements: att.payload.elements };
        if (att.payload.image_aspect_ratio) card.image_aspect_ratio = att.payload.image_aspect_ratio;
        messages.push(card);
      }
    }
  }
  if (Array.isArray(payload.quick_replies)) quick_replies.push(...(payload.quick_replies as typeof quick_replies));

  const content: Record<string, unknown> = { messages, actions: [], quick_replies: [] };
  if (Array.isArray(payload.actions)) content.actions = payload.actions;
  if (messages.length) content.messages = messages;
  if (quick_replies.length) content.quick_replies = quick_replies;
  return { ...payload, version: 'v2', content };
}
