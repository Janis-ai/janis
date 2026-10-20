# Legacy Slack surface — parity checklist (Option C "classic mode")

Source of truth: `wordhop-slack` (`src/slack_bot.js`, ~13k lines; `transcript_api.js`,
`wordhopapi.js`, `button_definitions.js`, `string_definitions.js`, `training.js`)
+ event emitters in `wordhopapi` (`api/v1/hop.js`, `api/messenger.js`,
`api/v1/common.js`, `api/send_chat_response.js`, `api/update_bot_messenger.js`,
`server/auth/{slack,google}/passport.js`).
Verified live 2026-10-20 via [ALERTTRACE] on whapi v3175 / whslack v1751.

Scope decision (Mike, 2026-10-20): **port EVERYTHING verbatim** — no feature
cuts, no format changes, same bot identity in Slack.

---

## 1. Inbound event types → handlers (`POST /wordhopapi/receive`)

Emitted by wordhopapi `sendMessage(type, msg)` → `JANIS_SLACKBOT_URL/wordhopapi/receive`,
`message-type` header dispatches. Gate order (slack_bot.js ~373-437):
client_key → `slack_integrations.bot_subscriptions` lookup → `migrated` stand-down
→ alert types get `isPro` check inline → other types gated by
`if (slack_integration && !isPro(slack_integration)) return;` (i.e. transcript
relay only runs for Pro teams; a NULL integration falls through — quirk to
preserve).

| `message-type` | Gate | Handler | Output |
|---|---|---|---|
| `chat message` | Pro | `chatMessageResponse` → `queueTranscriptChannel` → `sendChatMessageResponse` | Customer line in j-channel, posted with customer's name+avatar (`username`, `icon_url`, `as_user:false`, `transcript:true`). If bot has DF (`apiai_key`/`dialogflow`): `refreshGoogleToken` → `training_module.findApiAiResponseAndWriteAttachment` enriches the line with matched intent + interactive training attachment (`msg.menu` → `writeTrainThread` posts a threaded training menu). `display_text` overrides `text`. |
| `bot message` | Pro | `botMessageResponse` → `sendBotMessageResponse` | Bot reply line rendered via `makeFbMessage` (see §5), `username: msg.bot_name`, `icon_emoji: ':robot_face:'`. If `slack_user`/metadata.slack_user: text prefixed `_<@U…>_:  `. After posting, DELETES the operator's original j-channel message (`chat.delete` metadata.ts, user_token) — relay replaces what they typed. On post failure: `chat.update` original msg → `… _YOUR BOT FAILED TO SEND THIS MESSAGE. ERROR: <err>_`. |
| `dialogflow_message` | Pro | intent lookup (`mongoStorage.intents`) → `findApiAiResponseAndWriteAttachment` → `getTranscriptChannelAndProcessBulkMessages` → `dialogflowMessageResponse` | Line + intent details + training menu. Quirk: `dialogflowMessageResponse` polls `conversations.replies`/`history` up to 30×1s looking for a `createnew:<ts>` action — reposts the menu into that thread and deletes the intermediate reply. |
| `bulk messages` | Pro | `getBulkMessages` (per-channel serial queue `queueBulkMessages`) → `getTranscriptChannelAndProcessBulkMessages` → `processBulkMessages` | Fetch last 21 `messages` docs for channel (`data.message.channel`, `isWarning != true`, ts desc); mark ≤20 unprocessed `proccessedInTranscript:true`; >20 backlog adds synthetic "To see more than the last 20 messages, click here: {JANIS_WEBAPP_URL}/messages/{channel}" line (`is_from_janis`). **Empty backlog → reject "no messages"** (chain continues silently). Each msg dispatched: metadata(non-janis,non-broadcast)→botMessageResponse; is_from_janis→sendWarningToChannel('link to full transcript'); is_from_user→sendChatMessageResponse; dialogflow_message type→dialogflowMessageResponse; else→sendBotMessageResponse. When msg.apiai_key/dialogflow/is_oneclick: all user lines get `findApiAiResponseAndWriteAttachment` enrichment first. |
| `custom alert message` | **isPro required at dispatch** | `processMessageAndAlert` → `getChannelsAndShowAlert` → `showJanisAlert` | `:bell: *BotName*: {customAlertTitle \|\| reply.result.metadata.intentName \|\| "Alert"}` + red attachment + plan-dependent buttons → DM fan-out + threaded profile card. |
| `live chat request message` | **isPro required** | `processMessageAndAlert` (`showLiveChat`) | `assistanceHeader` = `:information_desk_person::skin-tone-2: *BotName*: Help requested` — same DM fan-out. |
| `failure log` | no Pro gate | `processMessageAndAlert` (`showLog`) | `logHeader(botName, logSeverity, sentimentScore, isFailure)` — emoji prefix by sentiment (<-0.5/:scream:, <-0.66/2x, <-0.9/3x) or severity (:speak_no_evil: ×level) + `*BotName*: No response` / `Negative sentiment` — same DM fan-out. |
| `channel update` | `msg.show_warning == true` only | `sendFullTranscriptWarning` → `queueTranscriptChannel` → `sendWarningToChannel` | Lifecycle post in j-channel + pause/resume buttons. |
| `stopped transcribing channels message`, `stopped processing channels message` | none | `sendWarningToChannel` per resolved j-channel (`getTranscriptChannelsBySourceIds`) | `{msg.text}{channel.sourceChannel}` + pause/resume buttons. Skips archived channels. |
| `inactive channels message`, `inactive processing channels message`, `resumed channels message` | none | same path | `{msg.text}\n _See my 1-reply to messages you receive and I will help you train your AI_` + buttons. |
| `link to full transcript` | none | `sendFullTranscriptWarning` | Transcript link post in j-channel. |
| `engage users` | Pro | `sendMessageToChannel` per channel | Plain text post; **skips `is_wordhop_channel`** (never posts into transcripts); uses channel's `sourceTeam` bot. |
| `chat response` | Pro | `botSay(bot, msg)` for `_bots[msg.team]` | Operator reply relay; on Slack error → `chat.update` transcript msg with failure text via sourceTeam agent bot. `user_typing` sub-type → no-op (return). |
| `user typing` | Pro | early return | No-op (code returns before botSay). |
| `fb bot updated` | none | startPrivateConversation + config refresh | DM conversation w/ triggering user; refreshes bot/dialogflow state (full onboarding-ish flow, ~150 lines at 440-590). |
| `google authenticated` / `slack authenticated` | none | post-auth flow | Completes workspace setup after OAuth. |
| `error` | none | none | `no handler matched` — logs only. |

## 2. Alert gate chain — VERBATIM (`showJanisAlert` ~8000-8680)

1. `processMessageAndAlert`: `msg.paused` → **hard drop**.
2. `team_ids` → `_bots[team_id]` teambot (email-style ids have no teambot — skipped).
3. `getChannelsAndShowAlert` → `getBulkMessages(msg)` FIRST (flushes transcript backlog; reject tolerated) → `messageReceivedForBot` → `mongoStorage.channels.getChannelsWithJanis(bot_user_id, team)` = **every DM channel doc in the workspace** (53 docs for Air Tahiti).
4. Per candidate channel, `getBotAlertSettings(channel, client_key)` → `channel.custom_alerts` array filtered by client_key (first match; pushes `{client_key}` stub if absent — note: MUTATES the array but the doc is only saved elsewhere).
5. Severity resolution per level, in order — first non-null wins:
   `custom_alerts[ck].<level>` → `channelTmpObj.<level>` → (`bot_context.client_key == ck` → 1) → 0.
   Levels: `logSeverityLevel`, `helpNeededSeverityLevel`, `userUpsetSeverityLevel`,
   `errorWarningLevel`, `customAlertSeverityLevel`.
6. **Custom-alert intent re-check** (only when level>0 AND `json.reply` present):
   `reply.result.action` must be `"alert.custom"` or `"custom_alert"` else level→0;
   then if `alertObj.intents` non-empty, `reply.result.metadata.intentId` matching
   an intents[] entry sets level→1. (Reading: intents[] acts as a re-enable filter —
   a member with intents subscribed still posts on level>0 even for non-matched
   intents IF action is right; the real suppression happens at step 5 where
   unsubscribed members resolve to 0.)
7. Suppression (type-keyed):
   - `json.isFailure` && (logLevel==0 || logLevel>logSeverity) → drop. logSeverity: count==1→1, >1→2, >15→3.
   - non-failure `showLog` && (userUpsetLevel==0 || userUpsetLevel>sentimentSeverity) → drop. sentimentSeverity: <-0.7→1, <-0.8→2, <-0.9→3.
   - `showLiveChat` && helpNeededLevel==0 → drop.
   - `showCustomAlert` && customAlertLevel==0 → drop.
   - `error` && errorWarningLevel==0 → drop.
   - `channel.is_wordhop_channel || channel.is_training_channel` → skip (never alert INTO transcript channels).
8. Card attachments (all `color:'#ff0000'`):
   - `json.type == "out"` → `*Bot said to {name}*: {userSaid}`
   - `type == "error"` → `Error: {json.error|error.message stringified}` + `reconnectMessengerButtons(url)` when OAuth/code in {200-299,102,10,190,458,459,460,463,464,467,492}
   - else → `*{name} said*: {userSaid}`
9. Plan-dependent append (after header text):
   - Pro && messenger && `fb_app_id` empty → `messengerLogButtons` (Connect to Facebook url)
   - Pro && wordhop_channel → `:speech_balloon: _See conversation_: https://{team_domain}.slack.com/archives/{channel_id}/p{last_message_ts w/o dot}` field
   - Pro && trialing && <3 days left → `:clock3: Your Janis Pro free trial will end *{n}*…` + billing+compare buttons
   - delinquent non-basic → `:warning: Your payment could not be processed…` + billing buttons
   - basic plan → `:lock: Upgrade to process 1000+ messages with AI, more alerts, customer data, and human takeover.` + freePlan+compare+log buttons
   - no subscription → `:no_entry: Your Janis Pro free trial ended…` + billing+compare+log buttons
   - actionsAttachment `callback_id: "log_buttons"` only appended when actions non-empty.
10. `botSay(bot, {channel: dmChannelId, text, attachments})` — empty text+empty attachments → skip post entirely.
11. `doProcessPro` (Pro only) → `bot.replyInThread(res.message, profileMessage)`:
    profile card fields `*Name*: {name}`, `:speech_balloon: *See conversation*: {link}`,
    then user_profile.data fields — whitelist `profile_fields` (timezone, gender,
    locale, language, status, page_id, id) shown as `*Field*: v`; hidden:
    live_chat_url/name/first_name/last_name/last_input_text/'last name'/'first name';
    `tags` → USER TAGS: (color #7CD197); `custom_fields` → CUSTOM FIELDS: (#FFA500);
    everything else → ATTRIBUTES: (#7CD197) JSON.stringify'd; `incomingContexts`
    parsed specially. `user_profile.image` → image_url attachment first.

## 3. j-channel lifecycle (`transcript_api.getTranscriptChannel` — VERBATIM)

- Serialized per (sourceChannel, team) via `channelQueue`.
- `queueTranscriptChannel` pre-gate (`getParamsForTranscriptChannel`): reject
  "not on pro plan" when slack_integration && !isPro; reject "no facebook
  connection" when messenger bot has empty fb_app_id; reject when stored
  sourceChannel missing or already is_wordhop/is_training channel.
- Lookup `getBySourceChannelId(sourceChannel, team)` → mergeAndSave (refresh
  conversations.info, **unarchive** if archived, ensure bot_user_id member
  via invite+leave dance with user_token) else create.
- Name: `j-{username}` where username = real_name_normalized → real_name →
  first_name[-last_name] → name → last_name → sourceChannel fallback;
  sanitized: spaces→`-`, `[.,/!$%^&*;:{}=-_`~()]`→`-`, lowercase. For Slack-sourced
  channels (D/C/G prefix + externalBot): team.info + users.info enrich the name.
- `conversations.create` with **user_token** (channel owned by installing user),
  invite bot_user_id, leave, save doc: `{is_wordhop_channel:true,
  sourceChannel, client_key, apiai_key, sourceUser, sourceTeam, team, members,
  lang (from reply.result.lang), last_agent_ts (chatMessage/takeOver types),
  trainingEnabled?, address?}`.
- `name_taken` → `duplicateNameHandler`: if existing name matches same
  sourceChannel → merge; else suffix `-{index}` (name truncated so
  name+suffix ≤21 chars; index += random 1-99); missing obj → 1s delay retry once.
- `channel_not_found` on merge → delete doc, recreate.
- All Slack channel docs (conversations.list, im.list, groups.list, mpim.list,
  conversations.info on events) are mirrored into Mongo `channels` — the WHOLE
  workspace channel directory lives in Mongo.

## 4. Two-way relay (operator → customer)

- `channelResponse(bot, message, channel)` (j-channel): sets
  `sourceChannel/client_key/team/sourceTeam/address` from channel doc;
  `command:true` when callback_id/command present; strips Slack formatting
  (`<@>`/`<#>`/`<!>`/`mailto:` handling — `removeFormatting`); **isPro gate** →
  not Pro → `sendIntentForTranscriptBot` event `{name:"NeedPro"}` + reject;
  sourceChannel doc must exist; direct_mention text → reject;
  → `wordhopapi.sendChatResponse` POST `/send_chat_response` (WORDHOP_API_URL,
  apikey=WORDHOP_MASTER_KEY, team_id header). Error → botSay error details;
  error code 290 → reconnectMessengerButtons.
- training channel variant: bot.say back into the channel (no customer relay).
- `sendMessageAsBot` (slash `/bot`, ambient msgs, thread_broadcast, files):
  empty text+attachments → skip; `channelResponse` → `bot.replyAcknowledge`;
  when response+contexts+training_module passed → `detectEventAndQueryForIntent`
  → recurses with the DF event's response (events can chain).
- `files_uploaded`/`file_shared`/`thread_broadcast`: files get
  `files.sharedPublicURL` → relayed as `{type:"image", payload:{url:private+pub_secret}}`
  attachment with bot_name/:robot_face: identity.
- `youSaid` (button clicks on transcripts): `wordhopapi.getProfile` → posts the
  clicked value AS THE CUSTOMER (username+icon) → `incoming` for the DF response.
- `botReplyInteractive`: posts updated card + `_User clicked: {value}_` + hopOut.

## 5. Rich-media transcript rendering (`makeFbMessage`/`makeFbAttachment`)

- `fulfillmentMessages` (DFv2) → `dialogflow_conversion.convertV2toV1Query` →
  `makeMessageFromApiAi`.
- Attachment normalization (shared by chat + df message renderers):
  `contentType` image → `{text:name, image_url:contentUrl, thumb_url}`;
  `type:"image"` → `{image_url:payload.url}`; `file|audio|video` → `{text:url}`
  (+ `files.upload` side-effect into j-channel, filename audio.mp4/video.mp4);
  `type:"template"` → `template_type:"button"` → `fbButton` (Slack actions,
  callback_id `fb_buttons`); `generic|list|receipt` → per-element
  image attachment + `{title, text:subtitle, mrkdwn_in}` + `fbButton`;
  passthrough otherwise.
- `quick_replies` → fb_buttons attachment with title/value actions.
- Final msg: `{text, attachments, transcript:true, username:msg.bot_name,
  icon_emoji:':robot_face:'}`.

## 6. Slash commands (verbatim, `slash_command` 1867-1978)

Aliases: `/pause_s`,`/pause_qa`→`/pause`; `/resume_s`,`/resume_qa`→`/resume`;
`/broadcast_s`→`/broadcast`; `/bot_s`,`/blast`,`/say`,`/say_s`→`/bot`.

- `/pause [text]` — channel must have `sourceChannel` else ephemeral
  `_`/pause` and `/resume` only work in user transcript channels._`. minutes =
  parseInt(text) default 10; `unlimited|forever|infinity` → -1;
  customDuration = text non-empty. → `wordhopapi.pauseLogging` → POST
  `/api/v1/update_channel` `{channel_id:sourceChannel, client_key, userId,
  team, paused:true, minutes, is_archived:false, transcript_channel:channel.id,
  transcribe:true, show_warning:true, customDuration}` → `replyAcknowledge`.
- `/resume` — same gate; `resumeLogging` (uses `last_source_channel` if set) →
  update_channel `{paused:false, minutes:0, transcribe:true, customDuration:false}`.
- `/bot <text>` → `sendMessageAsBot` (relays to customer).
- `/wordhop` — verifies `SLACK_SLASH_COMMAND_VERIFICATION_TOKEN`, → `incoming`.
- default → ephemeral `"I'm afraid I don't know how to <cmd> yet."`

## 7. Interactive callbacks (`interactive_message_callback` 2849+, ~2500 lines)

Dispatch order:
1. `archive_channel` → `conversations.archive` (user_token)
2. Channel doc lookup; then:
   `manychat.add.token`(value "add token") → `addManyChatToken`;
   `generic_callback`/"edit" → `editBotModal`;
   non-threaded `set_bot` (not Add/Help) → `buttonClicked` → `youSaid`+`incoming`;
   `original_message.thread_ts && is_wordhop_channel` OR `is_training_channel`
   → `training_interactive_message` (the big training editor, 4212-5400):
   `responses_page`, `detect_intent`, `userssay_page`, `add_followup`,
   `quick_reply_menu_callback`, `user_says_type`, `reply_type`,
   `intent_response`, `send_to_user`, `intent_user_says`,
   `manage_intent_list`, `followup_list`/`followup_nav`, `intent_selection`,
   `intent_selection_alerts`, `quick_reply_callback` (non-j-channel),
   `createnew:{ts}` handling — full intent CRUD against Dialogflow;
   threaded non-log_buttons: `set_bot`, `filter_alert` (per-intent subscribe
   UI — writes `custom_alerts[ck].intents` on the DM channel doc),
   `intent_selection_alerts`, `suggested_response` (Send → relays);
   `filter_sentiment_mute`/`filter_assistance_mute`/`filter_custom_alert`/
   `filter_failure_mute`/`filter_assistance`/`filter_sentiment`/`filter_failure`/
   `filter_buttons` → severity setters on channel doc (writes
   logSeverityLevel/helpNeededSeverityLevel/userUpsetSeverityLevel/
   customAlertSeverityLevel);
   `toggle_agent`, `resume_buttons_with_source_channel` ("Resume Bot:{ch}"),
   `log_buttons`, `generic_callback`, `bot.name.save`, `summary_page`,
   `prior_messages_buttons`, `fb_buttons`, `get_agents`,
   `send_to_user` → sendMessageAsBot with DF response.
3. `dialog_submission`: `subscribe_to_plan`, `agent_name` (AgentNamed event),
   `bot_name`, `send_intent` (Push Bot Content → intent select → DF),
   `pause_modal`.

## 8. Meta-bot conversational shell (`incoming`/`incomingContinued`)

- Every DM/direct_mention to the bot + text typed in training channels goes
  through `incoming` → `incomingContinued`.
- Non-transcript channels: auto-creates channel doc `{logSeverityLevel:1, team}`.
- j-channel: `get_agents` → ListDialogflowAgents event; "Push Content" → dialog
  with external intent select (needs DF creds + chatfuel/manychat tokens else
  `IntentPushFail`); else text → `sendIntentForTranscriptBot` against the
  **JANIS_TRANSCRIPT_BOT_CLIENT_KEY** meta-agent with contexts
  `transcript_channel`, `paused|resumed`, `transcribing`, `is_chatfuel|is_manychat`;
  events: `help_simple` (empty text), `NeedPro`, `IntentPushFail`, `AgentNamed`,
  `ListDialogflowAgents`. Response → `sendMessage`/botSay back into channel.
- NLP severity setters parse natural language on channel docs:
  `setCustomAlertSeverity` ("mute|shut up|shut the fuck up|quiet|stop"→0),
  `filter_failure`/`filter_sentiment`/`filter_assistance`/`filter_custom_alert`
  variants (9924-9960).

## 9. Slack-event sync handlers (must port — keep directory consistent)

- `bot_channel_join` → ensure channel doc; `member_joined_channel` →
  members[] update (and j-channel member add flow); `member_left_channel`,
  `channel_marked`, `channel_rename`, `channel_history_changed` →
  `updateChannel` (conversations.info + members → save).
- `channel_archive` → doc update + kick bot if it's someone else's j-channel;
  `channel_unarchive` → re-save; `channel_deleted` → `channels.delete`.
- `team_join` → new member onboarding/DM doc.
- `message_deleted` — noop-ish. `app_uninstalled` — team teardown.
- `presence_change`, `tick`, `rtm_*` — operational, skip.

## 10. wordhopapi emitters + payload fields

| Type | Site | Notable fields |
|---|---|---|
| `custom alert message` | hop.js:255 | channel, client_key, bot_name, team_ids, paused, custom_alert, reply (JSON string DF result w/ result.action + result.metadata.intentId/intentName), user_profile, type=`in|out`, text, apiai_key, dialogflow, ts, sourceTeam, address? |
| `live chat request message` | hop.js:236 | same shape, `help_requested` |
| `bulk messages` | hop.js:1010 | channel, client_key, bot_name, team_ids, apiai_key, dialogflow, is_oneclick, address?, trainingEnabled?, user_profile, ts |
| `chat message` | hop.js:1206 (emitSocketMessage, gated by `isDirectedAtBot && (should_process_transcript \|\| paused)`) | message doc fields + text, user, ts |
| `bot message` | hop.js:1208 (`type=='out'` same gate) | + metadata (slack_user/team/ts/quick_replies) |
| `failure log` | hop.js:1250 | j: {channel, client_key, bot_name, count, message, docSentiment{score}, isFailure, user_profile, paused, team, sourceTeam, ts, ts_estimated, apiai_key, dialogflow} |
| `channel update` | common.js:991-1019 (also socket.emit + writes isWarning Message doc "Janis") | channel, paused, show_warning, team_ids/team, minutes, client_key, user_profile |
| `dialogflow_message` | messenger.js:2005 | data.message (doc w/ intent id), team_ids, client_key, apiai_key |
| `chat response` | send_chat_response.js:342 + slack_webhook:169 | channel, text, team, ts, transcriptChannel, sourceTeam |
| `fb bot updated` | update_bot_messenger.js:263 | team, user, channel? |
| `slack authenticated`/`google authenticated` | passport.js | team_id, user_id |
| `engage users` | (legacy sweep/dashboard) | channels[], message |
| lifecycle channel msgs | sweeper worker (outside this repo — emitted to slackbot + stored as Message docs type='stopped transcribing channels message' etc.) | channels[] (source ids), text |

`sendMessage` transport: POST JSON, header `message-type`, fire-and-forget rp.
`update_channel` ALSO mirrors takeover state → `NEW_JANIS_API_URL/api/v1/mirror`
(post-Sept migration; keep — new API already consumes it).

## 11. Data contracts → Postgres mapping

- `slack_integrations`: `bot_subscriptions[{client_key}]`,
  `slack_params.team_id`, `stripe_customer{delinquent}`,
  subscription/plan (`isPro`: trialing || (plan.id != STRIPE_PLAN_BASIC &&
  status=='active')), `migrated`, `bot_subscriptions`.
- `channels` (Mongo): workspace-wide docs — DM docs `D…`
  (`custom_alerts[{client_key,intents,…}]`, severity levels, `bot_context`),
  session docs `Y7s…`, j-channel docs (`is_wordhop_channel`, `sourceChannel`,
  `client_key`, `apiai_key`, `sourceUser`, `sourceTeam`, `team`, `members`,
  `lang`, `last_agent_ts`, `last_message_ts`, `trainingEnabled`, `address`,
  `bot_context`), training docs (`is_training_channel`).
- `messages`: `{data.message{channel,ts,user,user_profile,text,attachments,
  reply,metadata,…}, type:'in|out|channel update|…', isWarning,
  proccessedInTranscript}` — **note the legacy typo `proccessedInTranscript`
  is the real field name**.
- `message_queues`: `{ts, channel}` flush markers (dead-ish — code paths
  commented out).
- `bots`: `client_key`, `name`, `dialogflow{credentials,agent,agent_object}`,
  `apiai_key`, `locale`, `is_chatfuel`/`chatfuel_token`/`chatfuel_botid`,
  `is_manychat`/`manychat_token`, `is_oneclick`, `fb_app_id`, `platform`,
  `code_lang`, `access_token`, `webhook`.
- `intents`: `{_id, intent}` JSON string — resolved for dialogflow_message.
- `users`: `{id, profile…}` — customer profile cache for transcript names.

## 12. Where "same" still needs a concrete definition (mechanics)

1. **Slack app identity**: posts must come from the same "Janis" bot identity —
   reuse the legacy app's credentials/manifest so customers see the same bot
   name/avatar, not a new app.
2. **Alert card buttons**: verify real action sets from a captured live card
   (ALERTTRACE payloads) before locking renderers.
3. **Subscription state through migration**: verbatim = member subscribed in old
   Slack stays subscribed — `custom_alerts` + severities must be carried into
   Postgres prefs, not recreated empty.
4. **`JANIS_TRANSCRIPT_BOT_CLIENT_KEY` meta-agent**: the conversational shell
   depends on a Dialogflow agent that lives in Mike's DF console — port keeps
   calling it (credentials on the janisbot doc) until a native replacement is
   decided.
5. **isPro on new stack**: map to workspace plan (paid≠free/trial) + imported
   `legacy_stripe` linkage — keep trialing semantics.
6. **Team domain permalinks**: `{domain}.slack.com/archives/…` — need team
   domain stored at install (team.info at OAuth).

## 13. Build status (2026-10-20)

**Done — intake + render half** (`apps/api/src/lib/slackClassic/`):
- `index.ts` — `handleLegacyEvent` (client_key → install resolution),
  `dispatchClassicEvent` (verbatim gate order: classic/migrated stand-down →
  alert family → lifecycle → Pro gate → transcript/handlers), `makeClassicCtx`
  with `dry` mode simulating every Slack API call deterministically.
- `store.ts` — Postgres adapters: j-channel registry, member DM docs
  (`__dm__` sentinel row for doc-level + shell state), prefs fall-through
  merge, backlog fetch + `processed_in_transcript` dedup (payload flag —
  the legacy `proccessedInTranscript` field maps here).
- `transcript.ts` — getBulkMessages (≤21 cap + "see more" warning),
  per-message dispatch precedence, user/bot/DF line renderers, warnings.
- `alerts.ts` — processMessageAndAlert (paused hard drop + transcript
  prelude), showJanisAlert per-member gate loop, profile-card thread.
- `channels.ts` — j-channel provisioning verbatim (naming, dedupe,
  unarchive, bot invite/leave), mergeAndSave re-contact.
- `gates.ts`/`strings.ts`/`profiles.ts`/`buttons.ts`/`attachments.ts` —
  verbatim severity math, headers, names, buttons, FB→Slack conversion.
- `routes/slackClassic.ts` — `POST /slack/classic/receive`,
  `x-classic-key` authed, `?dry=1` for shadow replay.

**Done — DF-free inbound half** (`relay.ts` + `routes/slack.ts` hooks):
- `classicIncoming`/`classicIncomingContinued` — identity/slackbot guards,
  channel resolution, j-channel → meta-bot shell gate.
- `channelResponse` — pause-on-send (takeover + pauseMinutes=10 +
  transcribe latch), removeFormatting, Pro gate, direct_mention reject,
  humanReply delivery, error→botSay + reconnect-Messenger button.
- `sendMessageAsBot`, `handleClassicSlash` (`/pause` `/resume` `/bot`
  `/wordhop` + all aliases verbatim), `processIncomingClassic`
  (broadcast + filter-reply severity setters, DF-shell stub),
  `handleClassicCallback` (fb_buttons, quick_reply_callback,
  resume_buttons_with_source_channel, archive_channel; DF-bound ids →
  suppressed reasons).
- `routes/slack.ts` — `/events`, `/commands`, `/interactions` dispatch to
  classic handlers when `slack_installations.mode='classic'`; new-mode
  behavior untouched.

**Phase C — DF-bound, partially ported**:
- `training.ts` — the training-menu renderer verbatim (training.js):
  `writeTrainAttachments` (intent_selection/create_new/detect_intent/
  followup_list/send_to_user/reply_type attachments, categorized vs matched
  vs suggested vs fallback menu states, editMode delete/Done-Editing,
  paging), `makeApiAiUserSaysAttachment` (5/page userssay_page),
  `makeApiAiResponseAttachment` (text/quickreplies/payloads/chatfuelblock/
  manychatflow type select + paged response list), `getActionsMenu`
  (reply-method select, chatfuel/manychat option inserts, raw:ts link,
  per-actionType hint attachments), `findApiAiResponseAndWriteAttachment`
  glue, and the message scanners (getIntentIdFromMessage/getTsFromMessage/
  response+userssay counters). Wired into `processBulkMessages`: every
  'in' line on a DF-enabled bot (resolved via resolveAgentDf — client_key →
  agent → dialogflow.project + DIALOGFLOW_SA_JSON) gets its menu posted in
  the line's thread via the existing msg.menu hook.
- `dialogflow.ts getIntentV1` — v2 intent GET → v1 doc shape (name,
  userSays from trainingPhrases, events, inputContextNames→contexts,
  fallbackIntent, responses[0].messages in v1 types 0/2/4, optional
  followUpIntentsArr + parentId via list call).
- `sendToUser` (relay.ts) — send_to_user/suggested_response mainline:
  getIntentIdFromMessage(reply_type select name) → conversations.replies →
  thread first-message txt (intent_user_says fallback override) →
  findIntent → dfEvent/userSays/'unknown' → detectIntentV1 on the
  customer agent → fulfillment text → deliverToChannel.
- `dfRender.ts` — `makeMessageFromApiAi`/`makeMessageFromApiAiIntent`
  verbatim (~500 lines): status errors, fulfillment speech/messages,
  platform gate (incl. the non-slack-platform quirk), slack/botcopy payload
  unwrap, payload text/attachments/quick_replies, training-mode custom
  payloads + Chatfuel `redirect_to_blocks` + ManyChat `flow` renders,
  simpleResponses/suggestions/linkOutSuggestion/replies, basicCard/
  listSelect/carouselSelect/buttons/imageUrl, `\\n`/`\\t` unescape.
  Legacy `var`-hoisting bugs preserved (carouselSelect leaks undefined
  callback_id; speech-only fulfillment renders `''`).
- `transcriptChannelShell` (relay.ts) — j-channel text → meta-bot DF query
  with verbatim contexts (transcript_channel, paused|resumed, transcribing,
  is_chatfuel/has_chatfuel_token/has_chatfuel_botid, is_manychat/
  has_manychat_token, dialogflow_integration). Meta-bot SA resolves via
  `classicConfig.transcriptBotSa` OR `JANIS_TRANSCRIPT_BOT_CLIENT_KEY` →
  agent's `DIALOGFLOW_SA_JSON` secret.
- `classicApiAiResponse` (relay.ts, exported) — the apiaiResponse
  dispatch (slack_bot.js 10889-11927), ported verbatim:
  - **Session-state prelude**: `state` = clone(stateDefault) + doc-key
    overlay + filterSettings keys, then params merge (bot_name→saveBotContext,
    framework, date-range, date_range_in_log, source_channel→
    last_source_channel, filtertype→lowercase, channel_id, code_language,
    platform) + `reset_bot` context → state reset. Tail: doc save +
    `detectEventAndSend` (params.event + `eventparam_*` → meta-bot
    re-detect → recurse apiaiResponse).
  - **Ported actions**: log_unknown_intent/input.unknown, add_apiai_key
    (→ agent metadata.apiai_key), subscriptions.news.send (broadcasting
    state latch), intents.manage/intents.manage.help.bot (manageIntents →
    ai-<bot> channel create/unarchive/recreate + welcome post + member
    invite + `training_channel_link` placeholder substitution or
    `<#id>` append), help.no_response.no_bot, bot.add.init +
    bot.context.set (verbatim state reset; custom_alerts never lives on
    state), dashbot.key.save, bot.name.confirm (ConfirmBotname event
    re-detect), bot.name.change (dialog.open), bot.name.save (agent
    create + generated client_key + all-1s severity defaults +
    bot_context), code.language.set (+platform='messenger' for
    df/chatfuel/manychat), code.platform.set, bot.getAll +
    training_channel.requested.no_bot (suggestBot select),
    bot.settings + filter (botSettingsMessage threaded + doSave + the
    verbatim "1 reply" hint), bot.automation.toggle.* (agent
    metadata.automation_enabled), resume_bot, developer.added +
    member.added (verbatim inviteMemberToIm: mention-parse /
    users.list substring match → conversations.open → invite text +
    bot list → invited notice or "No user was found…"),
    context.clear (reset + `user` context prime), waitlist.join
    (users.info → profile.email → user_email context → re-detect
    recurse), transcript_help, skip_fb (metadata.skip_fb),
    starter_kit (zip-url fetch → DF agent:restore →
    dialogflow_template+settings_shown; verbatim Install/Cancel error
    card), settings.show* (!= .messenger → settings_shown),
    create_dialogflow_agent (agent_name dialog.open),
    block_push/set_attributes/flow_push (→redirectToCustomer).
  - **suppressed (external deps not migrated)**: dialogflow.agents.get +
    agent.name.save + the agent_value branch of bot.name.save (member
    Google OAuth link), plans.subscribe (billing console), email.add
    (Untorch retired).
  - Helpers in `adminActions.ts`: botObjsForWorkspace (workspace agents
    with metadata.legacy_client_key), getBotAlertSettings,
    saveBotContext, suggestBotMessage, botSettingsMessage (verbatim
    441-line renderer: bot select, 5 severity filters, custom-alerts
    manage/intent list w/ paging), inviteMemberToIm, manageIntents,
    sendIntentForTranscriptBot.
  - store.ts: setMemberDocSettings (verbatim doc save);
    getMemberShellState reads top-level doc fields AND shell.* (legacy
    state keys are top-level doc fields).

**Training callback tree — PORTED** (`trainingCallbacks.ts`,
`dfIntents.ts`, `followups.ts`, slack_bot.js 4249-5473 + training.js
1353-1683):
- `getTrainingOptions` verbatim — pagination labels, editMode from the Done
  Editing action, user_says_type/reply_type reconstruction from the
  original message's attachments (never the click payload), the "userSays
  survives only for truthy non-menu titles" quirk.
- `dfIntents.ts` — v1-doc mutation layer over the v2 REST API:
  addUserSays/removeUserSays/removeResponse/removeQuickReply/modifyIntent
  (chatfuel block merge, manychat flow, payload JSON, quickreply ≤5,
  text push) + trainApiAi (409/400 → findIntentAndModify) +
  addFollowUpIntent (affectedContexts `{name}-followup` lifespan 2 →
  createFollowUp from the 10 verbatim `followups/*.json` templates,
  conflict → index suffix retry) + findApiAiResponse (janis context
  pinned, `${channel}suggest` session for detect_intent).
- `v1DocToV2`/`v2IntentToV1Doc` round-trip (dialogflow.ts) — PATCH sends
  the full v1 doc translated to v2; the response converts back so
  re-renders never need a second GET.
- Handlers: `responses_page`, `userssay_page`, `detect_intent`
  (contexts from latest stored 'in' reply), `add_followup` ("No
  follow-up" → in-place attachment selection mutation),
  `quick_reply_menu_callback` (edit-mode DF delete vs in-place select),
  `user_says_type`, `reply_type` (edit/done/createnew*/manage_intents/
  `raw:`ts/suggested_response + the getActionsMenu select splice),
  `intent_response` (delete → removeResponseToIntent; suggested →
  rendered stored reply as bot), `intent_user_says` delete,
  `followup_list`/`followup_nav`, `intent_selection`
  (approve → addUserSays; find_other_intent; delete → deleteIntent +
  re-detect; reject → removeUserSays + re-detect), `createnew*`,
  `quick_reply_callback` non-j-channel ("You clicked:" + menu +
  rendered response).
- `channelTrain` ambient path — thread replies in j-/training channels:
  lastTrainingBlock scan → trainingType from the last menu's selected
  option → modifyIntent/addUserSays/trainApiAi → updateTrainingUI
  (chat.update + best-effort chat.delete of the typed reply).
- `trainingChannelIncoming` — the is_training_channel incoming() branch:
  detectIntent on the CUSTOMER agent → bot-named render → threaded menu.
- **Ambient order correction**: verbatim j-channel free text goes to
  sendMessageAsBot→channelResponse (relay), NOT the meta-bot; the
  meta-bot only sees callback_id events / @mentions / DMs on the
  j-channel surface. Fixed in classicIncomingContinued; slack.ts
  /events now routes classic installs' app_mention + DM + thread
  replies to classicIncoming (concierge no longer eats them) with
  `direct` marking mention/DM → incoming().

**Interactive dispatcher — PORTED verbatim** (`handleClassicCallback`,
slack_bot.js 2849-3390 ordering):
- `archive_channel` BEFORE channel lookup (installer token; the stored
  channel doc is NOT deleted — verbatim).
- Channel lookup → `channel == null` return; Botkit `message.text`
  normalization (select option/button label).
- manychat.add.token+"add token" → `addManyChatTokenDialog`;
  generic_callback+"edit" → `editBotModalDialog` (both
  `callback_id: "modify_bot:<ck>"` — submission shared with edit-modal).
- Non-threaded `set_bot` (excl. "Add a bot"/"Help") → callback_event +
  `buttonClicked`.
- `(thread_ts && is_wordhop) || is_training` → `training_interactive_message`
  tree (`handleTrainingCallback`, incl. `send_to_user` 'suggested' →
  sendToUser + the conversations.replies thread-head read).
- Threaded non-wordhop, non-log_buttons → settings surface:
  `set_bot` (bot_name + saveBotContext → `botSettingsMessage` chat.update),
  `filter_alert` (severity writes — per-bot or "All bots" sweep →
  re-render), `intent_selection_alerts` (manage_intent_alert add via
  customer-agent findIntent / 'delete' X / alert_intent_page_label paging).
- `is_wordhop_channel` (non-threaded): `suggested_response`+"Send" →
  `channelResponse` w/ `replyts` threading; everything else →
  `transcriptFunctions` (10254-10633): Leave/Leave Channel
  (conversations.kick → cant_kick_self → leave), Transcribe
  (pop+clicked-note replyInteractive + shouldProcessTranscript +
  ":robot_face: I've resumed transcribing…" + pauseResumeButtons),
  Help (pop+clicked+replyInteractive → incomingContinued 'help'),
  Pause (pause_modal dialog.open), Resume (resumeLogging + pop+clicked+
  replyInteractive), About User (profile card: profile-fields/tags/
  custom_fields/attributes attachments → "See the `1 reply` below" +
  replyInThread; source = conversations.userProfile + contacts.metadata),
  else → incoming → transcriptChannelShell (meta-bot turn w/ verbatim
  contexts: transcript_channel + paused|resumed + transcribing +
  is_chatfuel/has_chatfuel_token/has_chatfuel_botid|is_manychat/
  has_manychat_token|dialogflow_integration; `fb_buttons` early-return;
  `Push Content` → send_intent dialog.open or IntentPushFail meta-bot
  event when the bot can't take intent pushes).
- Non-wordhop tail: `filter_*` ids → buttonClicked; `toggle_agent`
  ('Create New Agent' → incoming; else option-label youSaid +
  addBotFromAgent suppressed — user Google OAuth not migrated);
  `resume_buttons_with_source_channel` (resumeLogging + pop +
  botReplyInteractive); `log_buttons` ('Take Over' shifts the action off
  the last attachment → replyInteractive; else buttonClicked);
  `generic_callback` → buttonClicked; catch-all → buttonClicked →
  `botReplyAsUser` → `youSaid` (post AS the member w/ their
  users.info name+avatar) + incoming. Legacy's add_apiai_key/integrate_help
  exclusion + bot.name.save/summary_page/prior_messages_buttons
  removeButtonsClicked branch are dead code — the trailing else catches all.
- **Dialog submissions** (1541-1810): `subscribe_to_plan` → incoming
  text; `agent_name` → AgentNamed event + createDialogFlowAgents
  suppressed (member Google OAuth absent); `bot_name` → SaveCustomBotName
  event; `modify_bot:<ck>` → agents.metadata update (name, code_lang map
  manychat/chatfuel/dialogflow/npm/botcopy, tokens, fb_app_id,
  access_token, fb_user_access_token) + bot_context save + 'Settings'
  incoming; df_agents select → suppressed (getDialogFlowAgent needs the
  member Google link); `send_intent` → sendToUser(txt=null,
  submission.intent_id); `pause_modal` → custom_duration||duration →
  takeover + pauseMinutes + paused latch.
- `botReplyInteractive` → response_url replace_original POST (recorded
  `replyInteractive` in dry mode); `addToAttachments` verbatim (strips
  attachment/action ids, empty-text normalize).

**Workspace-event sync — PORTED** (`handleClassicWorkspaceEvent`,
slack_bot.js 1275-1458 + updateChannel 7588):
- `channel_deleted` → registry row delete; `channel_rename`/`archive`/
  `marked`/`history_changed`/`member_left_channel`/`channel_created` →
  `updateChannel` (conversations.info → name sync; member lists resolved
  on demand instead of stored verbatim).
- `member_joined_channel` when the bot is invited: wordhop channel →
  `invitedToTranscriptMessage` + pauseResumeButtons; `callback_id`-carrying
  channel → `invitedMessage` (both verbatim strings).
- `channel_unarchive` on a wordhop channel → conversations.invite(bot) +
  conversations.leave (the self-ping that reactivates the channel).
- `team_join` — verbatim stores the user doc; our port resolves profiles
  via users.info on demand (no-op).
- `bot_channel_join` — commented out upstream; nothing to port.
- `/events` route now resolves the install for all sync event types and
  dispatches classic installs through `handleClassicWorkspaceEvent`.
- `file_shared`/`files_uploaded` — `files_uploaded` ported earlier;
  `file_shared` is commented out upstream (nothing to port).

**Dialog API deprecation** (`dialogView.ts`): `dialog.open` was removed for
apps created after Dec 2021. `openClassicDialog` calls dialog.open first —
migrated teams keep the old app's grandfathered token so it works verbatim —
then falls back to `views.open` with `legacyDialogToView` (text/textarea/
select/external_select → input blocks; numeric option values stringified).
Channel/user round-trip through `view.private_metadata`; the interactions
route normalizes `view_submission` back to the dialog_submission shape so the
submission handlers (pause_modal, modify_bot:<ck>, bot_name, agent_name,
send_intent, subscribe_to_plan) stay verbatim. `slack-manifest-sync.ts`
declares the classic extras: im:read/files:read/team:read scopes +
member_joined/left, channel_* lifecycle, team_join bot events.

**Legacy state import** (`scripts/import-classic-channels.ts`, run after
`migrate-slack-teams.ts` has imported the team's slack_installations row):
- Export: `MONGODB_URI=…(wordhop-slack) node scripts/slack-migration.js
  export-channels > channels.jsonl` — streams the botkit `channels`
  collection.
- Transcript channel docs (`is_wordhop_channel`/`sourceChannel`) →
  `slack_classic_channels` verbatim: `paused`, `should_process_transcript`,
  `client_key`, `source_user`, `source_team`, `lang`, `last_message_ts`,
  `last_agent_ts`.
- Training docs (`is_training_channel`) → same table with a
  `training:<slackId>` sentinel sourceChannel (legacy docs lack one;
  `is_wordhop_channel` stays false so the training gate applies).
- Member DM docs (`D…` ids / `client_key==WORDHOP_CLIENT_KEY`) →
  `slack_classic_prefs`: `*` wildcard row carries `dmChannelId`; `__dm__`
  row gets every persistent doc field verbatim (custom_alerts, severities,
  broadcasting, filtertype, bot_context…) minus volatile session keys.
  `--resolve-dm` recovers the member's slack user id via
  `conversations.info` when the doc doesn't carry `source_user`.
- Ordinary channel docs are skipped — shell state is member-scoped in the
  port and recreates lazily. Dry-run by default; `--apply` upserts,
  idempotent. `--team T…` scopes to specific teams for staged cutovers.

**Phase C — still not ported**:
- engage-users broadcast target resolution (member subscription list →
  channel fan-out), `/broadcast` fan-out to subscriptions,
  file_shared→customer download/re-host half.
- Google-OAuth-bound onboarding (dialogflow.agents.get, agent.name.save,
  addDialogflowAgent inside bot.name.save's agent_value branch,
  modify_bot df_agents, toggle_agent addBotFromAgent) — the member's
  slack_integration.google token doesn't exist in the new stack;
  agents attach DF via DIALOGFLOW_SA_JSON secrets instead.
- plans.subscribe (Stripe checkout on the console supersedes the legacy
  plan ids) and email.add (Untorch retired) — suppressed-records.
- The send_intent dialog's `data_source:"external"` select has NO
  legacy options-load handler (Slack suggestion endpoint unimplemented
  upstream) — verbatim no-op, nothing to port.

**Test surface**: 110 tests in `slackClassic.test.ts` — gate matrix,
strings/profiles/attachments verbatim, dry dispatch (paused, intent
subscription, Pro, backlog dedup, engage skip), relay (slash commands,
fb_buttons, archive, guards, ambient relay-vs-meta-bot ordering),
dfRender (platform gate, replies, basicCard,
payload unwrap, escape normalization), meta-bot action dispatch
(ack/resume/help/broadcast-latch/context-clear/unported-suppression,
send_to_user suppression honesty), training menu (categorize/matched/
suggested/fallback states, response-type select, edit-mode delete+Done,
paging, chatfuel option splice), callback tree (getTrainingOptions
reconstruction, v1DocToV2 round-trip, all major dispatch ids incl.
suppression honesty without DF creds), store dedup.

**Verification gate before any migration**: shadow-post a real workspace's
event feed into `/slack/classic/receive?dry=1` (or a test workspace),
diff `posted`/`suppressed` against whslack's real behavior per event —
every `suppressed` reason is a deliberate parity record.
