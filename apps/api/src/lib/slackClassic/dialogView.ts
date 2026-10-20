// Legacy dialog.open → views.open fallback. Slack removed the Dialog API for
// apps created after Dec 2021 — migrated teams keep calling dialog.open on
// the OLD app's token (grandfathered), while fresh installs get the modal
// equivalent. The submission arrives as view_submission and is normalized
// back to dialog-submission shape by the interactions route, so the
// submission handlers stay verbatim.
import type { ClassicCtx } from './types.js';

export interface LegacyDialogElement {
  label: string;
  name: string;
  type: 'text' | 'textarea' | 'select' | string;
  value?: string | null;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
  min_length?: number;
  max_length?: number;
  subtype?: string;
  options?: { label: string; value: string | number }[];
  data_source?: string;
}

export interface LegacyDialog {
  callback_id: string;
  title: string;
  submit_label?: string;
  state?: string;
  notify_on_cancel?: boolean;
  elements: LegacyDialogElement[];
}

const plain = (s: string | undefined, max = 2000) => ({
  type: 'plain_text' as const,
  text: (s ?? ' ').slice(0, max),
});

export function legacyDialogToView(
  dialog: LegacyDialog,
  privateMetadata: string,
): Record<string, unknown> {
  const blocks = (dialog.elements ?? []).map((el) => {
    const block: Record<string, unknown> = {
      type: 'input',
      block_id: el.name,
      label: plain(el.label, 48),
      optional: el.optional === true,
    };
    if (el.hint) block.hint = plain(el.hint, 2000);
    if (el.type === 'select') {
      if (el.data_source === 'external') {
        block.element = {
          type: 'external_select',
          action_id: el.name,
          placeholder: plain(el.placeholder ?? el.label, 150),
          min_query_length: 0,
        };
      } else {
        const options = (el.options ?? []).map((o) => ({
          text: plain(o.label, 75),
          // Slack views require string option values (dialog.open tolerated
          // numbers — pause_modal's duration values are numeric).
          value: String(o.value),
        }));
        const element: Record<string, unknown> = {
          type: 'static_select',
          action_id: el.name,
          placeholder: plain(el.placeholder ?? el.label, 150),
          options,
        };
        const initial = options.find((o) => o.value === String(el.value) || o.text.text === el.value);
        if (initial) element.initial_option = initial;
        block.element = element;
      }
    } else {
      const element: Record<string, unknown> = {
        type: 'plain_text_input',
        action_id: el.name,
        placeholder: plain(el.placeholder, 150),
      };
      if (el.type === 'textarea') element.multiline = true;
      if (el.value != null) element.initial_value = el.value;
      if (el.min_length != null) element.min_length = el.min_length;
      if (el.max_length != null) element.max_length = el.max_length;
      block.element = element;
    }
    return block;
  });
  return {
    type: 'modal',
    callback_id: dialog.callback_id,
    title: plain(dialog.title, 24),
    submit: plain(dialog.submit_label ?? 'Submit', 24),
    close: plain('Cancel', 24),
    notify_on_close: dialog.notify_on_cancel === true,
    private_metadata: privateMetadata,
    blocks,
  };
}

// openClassicDialog — dialog.open first (verbatim for grandfathered tokens),
// views.open fallback when the app doesn't have the Dialog API.
export async function openClassicDialog(
  ctx: ClassicCtx,
  opts: {
    triggerId: string;
    dialog: LegacyDialog;
    channel: string;
    user?: string;
  },
): Promise<boolean> {
  const res = await ctx.api(ctx.install.botToken, 'dialog.open', {
    dialog: JSON.stringify(opts.dialog),
    trigger_id: opts.triggerId,
  });
  if (res.ok) return true;
  const err1 = res.error ?? 'dialog.open failed';
  // dialog.open removed for post-2021 apps → modal equivalent. Channel/user
  // round-trip through private_metadata (view_submission drops the channel).
  const view = legacyDialogToView(
    opts.dialog,
    JSON.stringify({ channel: opts.channel, user: opts.user ?? null }),
  );
  const res2 = await ctx.api(ctx.install.botToken, 'views.open', {
    trigger_id: opts.triggerId,
    view,
  });
  if (!res2.ok) {
    ctx.result.errors.push(`dialog ${opts.dialog.callback_id}: ${err1} / views.open ${res2.error ?? 'failed'}`);
  }
  return res2.ok === true;
}

// normalizeViewSubmission — view_submission payload → the dialog_submission
// inbound shape the verbatim handlers expect.
export function normalizeViewSubmission(payload: {
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { type?: string; value?: string; selected_option?: { value?: string; text?: { text?: string } } }>> };
  };
  user?: { id?: string };
  team?: { id?: string };
  trigger_id?: string;
}): {
  callbackId: string;
  channel: string;
  user: string | undefined;
  team: string | undefined;
  triggerId: string | undefined;
  submission: Record<string, string>;
} | null {
  const view = payload.view;
  if (!view?.callback_id) return null;
  let channel = '';
  let user = payload.user?.id;
  try {
    const meta = JSON.parse(view.private_metadata ?? '{}') as { channel?: string; user?: string };
    channel = meta.channel ?? '';
    if (!user && meta.user) user = meta.user;
  } catch {
    /* opaque metadata — still dispatch, handlers tolerate '' channel */
  }
  const submission: Record<string, string> = {};
  for (const [blockId, actions] of Object.entries(view.state?.values ?? {})) {
    for (const [actionId, v] of Object.entries(actions)) {
      const key = actionId || blockId;
      if (v.type === 'static_select' || v.type === 'external_select') {
        submission[key] = v.selected_option?.value ?? v.selected_option?.text?.text ?? '';
      } else {
        submission[key] = v.value ?? '';
      }
    }
  }
  return {
    callbackId: view.callback_id,
    channel,
    user,
    team: payload.team?.id,
    triggerId: payload.trigger_id,
    submission,
  };
}
