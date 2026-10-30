/**
 * Chatfuel/ManyChat bot-platform reply contract — one deterministic mapping
 * from the hosted pipeline's rich reply (text + quick replies + widgets +
 * attachments + {{…}} directive effects) into each platform's JSON.
 *
 * Chatfuel's JSON API card expects:
 *   {messages: [{text} | {attachment:…} | {text, quick_replies}],
 *    set_attributes?, redirect_to_blocks?}
 * ManyChat's External Request expects (and sendContent accepts):
 *   {version:'v2', content:{messages:[{type:…}], actions:[…], quick_replies?}}
 * A `goto` effect doesn't ride sendContent's actions — the push path peels it
 * off and calls the dedicated sendFlow endpoint, same as the legacy relay.
 *
 * Directive grammar (closed — an unrecognized {{…}} stays literal text):
 *   {{set field=value}}    → subscriber attribute / custom field
 *   {{tag name}}           → add tag (ManyChat only — Chatfuel has no primitive)
 *   {{untag name}}         → remove tag (ManyChat only)
 *   {{goto "Flow Name"}}   → Chatfuel redirect_to_blocks / ManyChat send_flow
 * Whitespace inside the braces is tolerated; quotes on a name/value are
 * optional. The ingest path strips directives from the stored text and
 * records them on the message payload, so transcripts stay clean while the
 * effect still reaches the platform.
 */
import type { QuickReply } from '@janis/shared';
import { qrTitle, splitResponse } from './legacyFormat.js';
import type { AttachmentRef } from './channels.js';
import type { WidgetComponent } from './widgets.js';

export type BotFlavor = 'chatfuel' | 'manychat';

/** A platform side-effect parsed out of the reply text. */
export type BotEffect =
  | { kind: 'set'; name: string; value: string }
  | { kind: 'tag' | 'untag'; name: string }
  | { kind: 'goto'; name: string };

export interface BotReplyInput {
  text: string;
  quickReplies?: QuickReply[];
  widgets?: WidgetComponent[];
  attachments?: AttachmentRef[];
  effects?: BotEffect[];
}

const DIRECTIVE = /\{\{\s*(set|tag|untag|goto)\s+([\s\S]*?)\s*\}\}/gi;

const unquote = (s: string): string => {
  const t = s.trim();
  return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    ? t.slice(1, -1).trim()
    : t;
};

/** Pull the invisible {{…}} directives out of a reply. Returns the text the
 *  customer should actually see (directives removed, leftover whitespace
 *  tidied) plus the effects to execute. Unknown {{…}} markup is left in the
 *  text untouched — a literal the model or the customer meant to send. */
export function parseDirectives(text: string): { clean: string; effects: BotEffect[] } {
  const effects: BotEffect[] = [];
  const stripped = text.replace(DIRECTIVE, (m, verb: string, arg: string) => {
    const v = verb.toLowerCase();
    if (v === 'set') {
      const eq = arg.indexOf('=');
      if (eq < 0) return m; // {{set name}} — not the grammar, keep literal
      const name = arg.slice(0, eq).trim();
      const value = unquote(arg.slice(eq + 1));
      if (!name) return m;
      effects.push({ kind: 'set', name, value });
      return '';
    }
    // tag / untag / goto all take a bare or quoted name
    const name = unquote(arg);
    if (!name) return m;
    effects.push(v === 'goto' ? { kind: 'goto', name } : { kind: v as 'tag' | 'untag', name });
    return '';
  });
  // Removing an inline directive can leave a doubled space or an emptied
  // line — tidy only what removal produced, never reflow the reply itself.
  const clean = stripped
    .replace(/ {2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { clean, effects };
}

/** Human-readable one-liner per effect — stored on payload.channel_effects
 *  so the transcript/console shows what the platform was asked to do. */
export function effectLabel(e: BotEffect): string {
  switch (e.kind) {
    case 'set':
      return `set ${e.name}`;
    case 'tag':
      return `tag ${e.name}`;
    case 'untag':
      return `untag ${e.name}`;
    case 'goto':
      return `flow: ${e.name}`;
  }
}

/** Effects → each platform's response fields. Chatfuel carries them at the
 *  top level of the response object; ManyChat as content.actions entries
 *  (the external-request/sendContent action names verbatim). */
export function effectsToPlatform(
  flavor: BotFlavor,
  effects: BotEffect[],
): Record<string, unknown> | Record<string, unknown>[] {
  if (flavor === 'chatfuel') {
    const out: { set_attributes?: Record<string, string>; redirect_to_blocks?: string[] } = {};
    for (const e of effects) {
      if (e.kind === 'set') (out.set_attributes ??= {})[e.name] = e.value;
      else if (e.kind === 'goto') (out.redirect_to_blocks ??= []).push(e.name);
      // tag/untag have no Chatfuel JSON-API primitive — dropped by design.
    }
    return out;
  }
  return effects.map((e): Record<string, unknown> => {
    switch (e.kind) {
      case 'set':
        return { action: 'set_field_value', field_name: e.name, value: e.value };
      case 'tag':
        return { action: 'add_tag', tag_name: e.name };
      case 'untag':
        return { action: 'remove_tag', tag_name: e.name };
      case 'goto':
        return { action: 'send_flow', flow_ns: e.name };
    }
  });
}

/** Suggested replies → the platform's quick-reply shape. A Chatfuel tap
 *  sets `user input` and redirects to the Janis block (the documented name
 *  for the block holding the JSON API card) so the card re-fires with the
 *  label as the user's message; a ManyChat node target is named after the
 *  label so a same-named flow/node picks the tap up. Non-string replies
 *  (email/phone collectors) have no bot-platform primitive — dropped. */
const qrFor = (flavor: BotFlavor, qrs: QuickReply[]) =>
  qrs
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter(Boolean)
    .slice(0, 11)
    .map((label) =>
      flavor === 'chatfuel'
        ? { title: qrTitle(label), block_names: ['Janis'], set_attributes: { 'user input': label } }
        : { type: 'node', caption: qrTitle(label), target: label },
    );

/** Attachment mime → the Messenger attachment type both platforms speak. */
const attachmentKind = (mime: string): 'image' | 'video' | 'audio' | 'file' =>
  mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : 'file';

/** A cards widget → generic-template elements (same shape the Meta push
 *  path builds). select_label rides back as a user-input attribute on
 *  Chatfuel (the tap re-fires the Janis block with the label as the
 *  message); on ManyChat the legacy convention names the target flow/node
 *  after it. */
function cardElements(w: Extract<WidgetComponent, { type: 'cards' }>, flavor: BotFlavor) {
  return w.items.slice(0, 10).map((it) => {
    const buttons: Record<string, unknown>[] = [];
    if (it.link && /^https?:\/\//.test(it.link)) {
      buttons.push(
        flavor === 'chatfuel'
          ? { type: 'web_url', title: qrTitle(it.link_label || 'View'), url: it.link }
          : { type: 'url', caption: qrTitle(it.link_label || 'View'), url: it.link },
      );
    }
    if (it.select_label) {
      const caption = qrTitle(it.select_button || it.select_label);
      buttons.push(
        flavor === 'chatfuel'
          ? {
              type: 'show_block',
              title: caption,
              block_names: ['Janis'],
              set_attributes: { 'user input': it.select_label },
            }
          : { type: 'flow', caption, target: it.select_label },
      );
    }
    return {
      title: it.title.slice(0, 80),
      ...(it.subtitle || it.price
        ? { subtitle: [it.subtitle, it.price].filter(Boolean).join(' · ').slice(0, 80) }
        : {}),
      ...(it.image && /^https?:\/\//.test(it.image) ? { image_url: it.image } : {}),
      // tap-anywhere on the card body opens the link, not just the button
      ...(flavor === 'chatfuel' && it.link && /^https?:\/\//.test(it.link)
        ? { default_action: { type: 'web_url', url: it.link } }
        : {}),
      ...(buttons.length ? { buttons } : {}),
    };
  });
}

/** Build the platform response for one reply. `text` is expected already
 *  channel-formatted (callers run formatForChannel — kept out of here so
 *  this module stays a leaf off the channels graph). Returns the exact
 *  shapes the empty/text-only contract has always produced:
 *    chatfuel → {messages:[…], set_attributes?, redirect_to_blocks?}
 *    manychat → {version:'v2', content:{messages:[…], actions:[…], quick_replies?}} */
export function buildBotResponse(
  flavor: BotFlavor,
  reply: BotReplyInput,
): Record<string, unknown> {
  const chunks = splitResponse(reply.text).filter(Boolean);
  const effects = reply.effects ?? [];

  if (flavor === 'manychat') {
    const messages: Record<string, unknown>[] = chunks.map((t) => ({ type: 'text', text: t }));
    for (const a of reply.attachments ?? []) {
      messages.push({ type: attachmentKind(a.type), url: a.url });
    }
    const quick_replies = qrFor('manychat', reply.quickReplies ?? []) as Record<string, unknown>[];
    for (const w of reply.widgets ?? []) {
      if (w.type === 'cards') {
        const elements = cardElements(w, 'manychat');
        if (elements.length) messages.push({ type: 'cards', elements });
      } else if (w.type === 'options') {
        messages.push({ type: 'text', text: w.title ?? 'Choose an option:' });
        for (const it of w.items.slice(0, 11)) {
          quick_replies.push({ type: 'node', caption: qrTitle(it.label), target: it.send ?? it.label });
        }
      }
      // form/status/receipt/pricing/cart have no ManyChat primitive — the
      // accompanying text carries them (same rule as the Meta channels).
    }
    const content: Record<string, unknown> = {
      messages,
      actions: effectsToPlatform('manychat', effects),
    };
    if (quick_replies.length) content.quick_replies = quick_replies;
    return { version: 'v2', content };
  }

  const msgs = chunks.map((t) => ({ text: t }) as Record<string, unknown>);
  // quick replies ride the last text message, the only spot Chatfuel
  // renders them
  const qrs = qrFor('chatfuel', reply.quickReplies ?? []);
  if (qrs.length && msgs.length) msgs[msgs.length - 1].quick_replies = qrs;
  for (const a of reply.attachments ?? []) {
    msgs.push({ attachment: { type: attachmentKind(a.type), payload: { url: a.url } } });
  }
  for (const w of reply.widgets ?? []) {
    if (w.type === 'cards') {
      const elements = cardElements(w, 'chatfuel');
      if (elements.length) {
        msgs.push({
          attachment: { type: 'template', payload: { template_type: 'generic', elements } },
        });
      }
    } else if (w.type === 'options') {
      msgs.push({
        text: w.title ?? 'Choose an option:',
        quick_replies: w.items.slice(0, 11).map((it) => ({
          title: qrTitle(it.label),
          block_names: ['Janis'],
          set_attributes: { 'user input': it.send ?? it.label },
        })),
      });
    }
  }
  const out: Record<string, unknown> = { messages: msgs };
  Object.assign(out, effectsToPlatform('chatfuel', effects));
  return out;
}
