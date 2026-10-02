/* Janis web-chat widget.
   Embed: <script src="https://<api>/widget.js" data-janis-token="<channel id>" async></script>
   Optional: data-janis-api="https://<api>" to override the API origin. */
(function () {
  var script = document.currentScript ||
    document.querySelector('script[data-janis-token]');
  if (!script) return;
  var TOKEN = script.getAttribute('data-janis-token');
  if (!TOKEN) return;
  var API = (script.getAttribute('data-janis-api') || script.src.replace(/\/widget\.js.*$/, '')).replace(/\/$/, '');

  var LS_VISITOR = 'janis_visitor_' + TOKEN;
  var LS_OPEN = 'janis_open_' + TOKEN;
  var LS_EXPANDED = 'janis_expanded_' + TOKEN;
  var LS_SEEN = 'janis_seen_' + TOKEN;   // read watermark for the unread badge
  var SS_TEASER = 'janis_teaser_' + TOKEN; // teaser dismissed this session
  var visitor = localStorage.getItem(LS_VISITOR);
  if (!visitor) {
    visitor = (crypto.randomUUID ? crypto.randomUUID() :
      'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 18)).replace(/-/g, '');
    localStorage.setItem(LS_VISITOR, visitor);
  }

  var state = {
    open: localStorage.getItem(LS_OPEN) === '1',
    expanded: localStorage.getItem(LS_EXPANDED) === '1',
    lastTs: null,
    config: null,
    timer: null,
    seen: {},
    pollBusy: false,
    pending: [],   // attachments uploaded, not yet sent
    outbox: [],    // optimistic bubbles awaiting server echo
    deliveredEl: null, // 'Delivered' receipt under the newest confirmed bubble
    qrsEl: null,     // quick-reply chip row (suggested prompts)
    typingEl: null,
    typingTimer: null,
    agentWorking: false, // visitor sent, awaiting the agent's reply
    opTyping: null,    // {name|null} — operator composing in the console
    agentTyping: false, // server-side "message.user dispatched, no reply yet"
    convState: 'agent',
    emojiOpen: false,
    user: null,      // host-asserted identity via Janis.identify()
    participant: null, // server-resolved thread owner — switches on sign-in
    lastTypingPing: 0,
    loaded: false, // composer stays disabled until the first transcript fetch
    greeted: false, // greeting waits for the first poll to confirm an empty thread
    loadStart: 0, // first-poll start — keeps the loading row perceptible
    lastAuthor: null, // consecutive same-operator bubbles share one label
    hasMore: false, // older transcript pages exist (scroll up to back-fill)
    oldestTs: null, // created_at of the oldest rendered message — before cursor
    loadingMore: false,
    lastSeen: localStorage.getItem(LS_SEEN), // newest ts the visitor has seen
    seenInit: false, // first poll sets the baseline — history never counts unread
    unread: 0,
    fails: 0,        // consecutive poll failures — drives the reconnect strip
    pinBottom: true, // visitor is scrolled to the latest — keep following new msgs
    jumpEl: null,    // "new messages" pill shown when not pinned and replies land
    audioCtx: null,
    closedTimer: null, // closed-state poll — feeds the unread badge
  };

  // Public API — the embedding site identifies its logged-in user:
  //   Janis.identify({ id, name, email, sig, traits })
  // `sig` is HMAC-SHA256 of "id|email|name" with the channel's identity
  // secret — compute it server-side so identity can't be forged client-side.
  // Call with no args to clear identity (e.g. on logout).
  window.Janis = window.Janis || {};
  window.Janis.identify = function (u) {
    state.user = u && (u.id || u.email || u.name) ? u : null;
    fetch(API + '/chat/' + TOKEN + '/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitor, user: state.user || {} }),
    }).catch(function () {});
  };

  var EMOJIS = ('😀 😄 😁 🙂 😉 😊 😍 🤩 😘 😜 🤪 😎 🤔 😅 😂 🤣 😢 😭 😮 😴' +
    ' 👍 👎 🙏 👏 🙌 🤝 💪 ✌️ 🤞 👋 👀 💬 ❤️ 💚 💙 💜 🖤 🤍 💯 ✅ 🎉 🔥 ⭐ 💡 📎 ❓').split(' ');

  // Render [label](url) markdown links and bare https:// URLs as anchors.
  // DOM nodes only — never innerHTML — so message text can't inject markup.
  function linkify(span, text) {
    var re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m.index > last) span.appendChild(document.createTextNode(text.slice(last, m.index)));
      var parts = splitTrail(m[2] || m[3]);
      if (!parts[0]) {
        // nothing left after trimming — emit the raw match as text
        span.appendChild(document.createTextNode(m[0]));
      } else {
        var a = document.createElement('a');
        a.href = parts[0];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = m[1] || parts[0];
        span.appendChild(a);
        if (parts[1]) span.appendChild(document.createTextNode(parts[1]));
      }
      last = re.lastIndex;
    }
    if (last < text.length) span.appendChild(document.createTextNode(text.slice(last)));
  }

  // Canonical agent text is markdown-ish — the widget renders **bold**,
  // *italic*, ~~strike~~ and `code` natively (push channels get them
  // translated server-side). Content inside a tag still linkifies.
  var EM_RE = /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*|\*([^\s*](?:[^*]*[^\s*])?)\*|~~([^\s~](?:[^~]*[^\s~])?)~~|`([^`\n]+)`/g;
  function appendRich(span, text) {
    EM_RE.lastIndex = 0;
    var last = 0;
    var m;
    while ((m = EM_RE.exec(text))) {
      if (m.index > last) linkify(span, text.slice(last, m.index));
      var el = document.createElement(
        m[1] != null ? 'b' : m[2] != null ? 'i' : m[3] != null ? 's' : 'code',
      );
      linkify(el, m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]);
      span.appendChild(el);
      last = EM_RE.lastIndex;
    }
    if (last < text.length) linkify(span, text.slice(last));
  }

  // Models emit bullets two ways — one per line ("* item") or an inline run
  // on a single line ("options: * **A** … * **B** …"). Split blocks so lists
  // render as lists. The inline marker requires `* ` followed by ** so
  // "5 * 3 = 15" and emphasis never split.
  var BULLET_LEAD = /^(?:[-*•])\s+/;
  var NUM_LEAD = /^\d+[.)]\s+/;
  var INLINE_BULLET = / \* (?=\*\*)/g;
  function appendBlocks(bubble, text) {
    var list = null;
    var ordered = false;
    function flush() {
      list = null;
      ordered = false;
    }
    text.split('\n').forEach(function (raw) {
      var t = raw.trim();
      if (!t) { flush(); return; }
      if (BULLET_LEAD.test(t) || NUM_LEAD.test(t)) {
        var isOrdered = NUM_LEAD.test(t);
        if (!list || isOrdered !== ordered) {
          ordered = isOrdered;
          list = el(isOrdered ? 'ol' : 'ul', {}, { class: 'janis-wlist' });
          bubble.appendChild(list);
        }
        t.replace(BULLET_LEAD, '').replace(NUM_LEAD, '').split(INLINE_BULLET).forEach(function (item) {
          var li = el('li');
          appendRich(li, item);
          list.appendChild(li);
        });
        return;
      }
      var inline = (t.match(INLINE_BULLET) || []).length;
      if (inline >= 2) {
        var parts = t.split(INLINE_BULLET);
        var lead = parts[0].trim();
        if (lead) {
          var p = el('span');
          appendRich(p, lead);
          bubble.appendChild(p);
        }
        list = el('ul', {}, { class: 'janis-wlist' });
        bubble.appendChild(list);
        parts.slice(1).forEach(function (item) {
          var li = el('li');
          appendRich(li, item);
          list.appendChild(li);
        });
        return;
      }
      flush();
      var span = el('span');
      appendRich(span, t);
      bubble.appendChild(span);
    });
  }

  // Sentence punctuation glued to a URL — "see https://x.com/a." should link
  // the URL, not the period. Closers are only stripped when unbalanced, so
  // https://x.com/f_(b) keeps its parens while "(see https://x.com)" doesn't
  // eat the bracket. Returns [cleanUrl, trailingText].
  function splitTrail(u) {
    var trail = '';
    var pairs = { ')': '(', ']': '[', '}': '{' };
    while (u.length) {
      var c = u.charAt(u.length - 1);
      if ('.,;:!?\'"'.indexOf(c) >= 0) {
        trail = c + trail;
        u = u.slice(0, -1);
        continue;
      }
      var open = pairs[c];
      if (open && u.split(c).length - 1 > u.split(open).length - 1) {
        trail = c + trail;
        u = u.slice(0, -1);
        continue;
      }
      break;
    }
    return [u, trail];
  }

  function el(tag, styles, attrs) {
    var e = document.createElement(tag);
    for (var k in styles) e.style[k] = styles[k];
    for (var a in attrs || {}) e.setAttribute(a, attrs[a]);
    return e;
  }

  // ---- styles -------------------------------------------------------------
  var accent = '#5b21b6';
  var css = document.createElement('style');
  css.id = 'janis-style';
  css.textContent =
    '#janis-bubble{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;' +
    'border:none;cursor:pointer;z-index:999998;display:flex;align-items:center;justify-content:center;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.3);font-size:24px;color:#fff}' +
    '#janis-panel{position:fixed;right:20px;bottom:88px;width:340px;max-width:calc(100vw - 40px);' +
    'height:480px;max-height:calc(100vh - 120px);background:#fff;border-radius:var(--janis-radius,14px);overflow:hidden;' +
    'box-shadow:0 8px 32px rgba(0,0,0,.25);z-index:999999;display:none;flex-direction:column;' +
    'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2937;' +
    'transition:width .15s ease,height .15s ease}' +
    '#janis-panel.open{display:flex}' +
    '#janis-panel.expanded{width:min(680px,calc(100vw - 24px));height:min(760px,calc(100vh - 100px));right:12px;bottom:76px}' +
    '#janis-bubble.janis-left{left:20px;right:auto}' +
    '#janis-panel.janis-left{left:20px;right:auto}' +
    '#janis-panel.janis-left.expanded{left:12px;right:auto}' +
    '#janis-head{padding:12px 16px;color:#fff;font-weight:600;display:flex;align-items:center;gap:8px}' +
    '#janis-head img.janis-logo{width:30px;height:30px;border-radius:8px;object-fit:contain;background:#fff;padding:2px;flex:none}' +
    '#janis-bubble img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}' +
    '#janis-head>div{flex:1;min-width:0}' +
    '#janis-head small{display:block;font-weight:400;opacity:.8}' +
    '#janis-expand{background:none;border:none;color:#fff;cursor:pointer;font-size:16px;padding:4px;opacity:.85;line-height:1}' +
    '#janis-expand:hover{opacity:1}' +
    '#janis-menu-btn{background:none;border:none;color:#fff;cursor:pointer;font-size:18px;padding:2px 4px;opacity:.85;line-height:1}' +
    '#janis-menu-btn:hover{opacity:1}' +
    '#janis-menu{display:none;position:absolute;top:44px;right:10px;background:#fff;border:1px solid #e5e7eb;' +
    'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:10;min-width:150px;overflow:hidden}' +
    '#janis-menu.open{display:block}' +
    '#janis-menu button{display:block;width:100%;text-align:left;background:none;border:none;' +
    'padding:10px 14px;font-size:13px;color:#1f2937;cursor:pointer;font-family:inherit}' +
    '#janis-menu button:hover{background:#f3f4f6}' +
    '.janis-ended{align-self:center;text-align:center;font-size:11.5px;color:#9ca3af;padding:8px 4px;width:100%}' +
    '#janis-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f9fafb}' +
    '#janis-panel *{scrollbar-width:thin;scrollbar-color:#d1d5db transparent}' +
    '#janis-panel *::-webkit-scrollbar{width:6px;height:6px}' +
    '#janis-panel *::-webkit-scrollbar-track{background:transparent}' +
    '#janis-panel *::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:3px}' +
    '#janis-panel *::-webkit-scrollbar-thumb:hover{background:#9ca3af}' +
    '.janis-msg{max-width:80%;padding:8px 12px;border-radius:12px;line-height:1.4;word-wrap:break-word;white-space:pre-wrap}' +
    '.janis-msg.in{align-self:flex-end;background:var(--janis-accent);color:#fff;border-bottom-right-radius:4px}' +
    '.janis-msg.out,.janis-msg.human{align-self:flex-start;background:#e5e7eb;color:#1f2937;border-bottom-left-radius:4px}' +
    '.janis-msg a{color:inherit;text-decoration:underline;word-break:break-all}' +
    '.janis-msg code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:rgba(0,0,0,.08);padding:0 3px;border-radius:4px}' +
    '.janis-msg.in code{background:rgba(255,255,255,.18)}' +
    '.janis-msg.human{background:#dbeafe}' +
    '.janis-author{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:#1e40af;margin-bottom:2px}' +
    '.janis-author-img{width:16px;height:16px;border-radius:50%;margin:0!important;max-width:16px!important;max-height:16px!important}' +
    '.janis-msg.typing{display:inline-flex;flex-direction:column;align-items:flex-start;gap:3px;padding:8px 14px}' +
    '.janis-dots{display:inline-flex;gap:4px;align-items:center;padding:3px 0}' +
    '.janis-dot{width:6px;height:6px;border-radius:50%;background:#6b7280;animation:janis-blink 1.2s infinite ease-in-out}' +
    '.janis-dot:nth-child(2){animation-delay:.15s}' +
    '.janis-dot:nth-child(3){animation-delay:.3s}' +
    '@keyframes janis-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}' +
    '.janis-msg.failed{outline:1.5px solid #ef4444;opacity:1;cursor:pointer}' +
    '.janis-status{align-self:flex-end;font-size:10px;color:#9ca3af;margin-top:-5px;padding-right:2px;cursor:default}' +
    '.janis-qrs{display:flex;flex-wrap:wrap;gap:6px;padding:2px 4px 8px}' +
    '.janis-qr{border:1px solid var(--janis-accent,#5b21b6);color:var(--janis-accent,#5b21b6);background:#fff;' +
    'border-radius:16px;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit;line-height:1.3;text-align:left}' +
    '.janis-qr:active{opacity:.7}' +
    '.janis-qr-ask{display:flex;gap:6px;align-items:center;flex:1 1 100%}' +
    '.janis-qr-ask input{flex:1;min-width:0;border:1px solid #d1d5db;border-radius:16px;' +
    'padding:7px 12px;font-size:13px;font-family:inherit;outline:none}' +
    '.janis-qr-ask input:focus{border-color:var(--janis-accent,#5b21b6)}' +
    '.janis-msg img{display:block;max-width:180px;max-height:180px;border-radius:8px;margin-top:4px}' +
    '.janis-file{display:inline-flex;align-items:center;gap:4px;margin-top:4px;padding:4px 8px;border-radius:8px;' +
    'background:rgba(0,0,0,.08);color:inherit;text-decoration:none;font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#janis-attach{display:none;flex-wrap:wrap;gap:6px;padding:8px 12px 0;background:#fff}' +
    '#janis-attach.show{display:flex}' +
    '.janis-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;' +
    'background:#f3f4f6;font-size:12px;color:#374151;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.janis-chip button{background:none;border:none;cursor:pointer;color:#6b7280;font-size:13px;padding:0;line-height:1}' +
    '#janis-emoji{display:none;grid-template-columns:repeat(10,1fr);gap:2px;padding:8px 12px;background:#fff;border-top:1px solid #f3f4f6;max-height:120px;overflow-y:auto}' +
    '#janis-emoji.open{display:grid}' +
    '#janis-emoji button{background:none;border:none;cursor:pointer;font-size:18px;padding:3px;border-radius:6px;line-height:1}' +
    '#janis-emoji button:hover{background:#f3f4f6}' +
    '#janis-form{display:flex;align-items:flex-end;border-top:1px solid #e5e7eb;background:#fff}' +
    '#janis-form .janis-ico{background:none;border:none;cursor:pointer;font-size:16px;padding:10px 4px 10px 10px;color:#6b7280;line-height:1}' +
    '#janis-form .janis-ico:hover{color:#374151}' +
    '#janis-form .janis-ico.on{color:var(--janis-accent);animation:janis-micpulse 1.2s ease-in-out infinite}' +
    '#janis-mic{display:flex;align-items:center;justify-content:center}' +
    '#janis-mic.err{color:#ef4444}' +
    '@keyframes janis-micpulse{0%,100%{opacity:1}50%{opacity:.45}}' +
    '#janis-input{flex:1;border:none;padding:12px 6px;font-size:14px;outline:none;background:#fff;color:#1f2937;' +
    'resize:none;font-family:inherit;line-height:1.35;max-height:110px;overflow-y:auto}' +
    '#janis-send{border:none;align-self:stretch;padding:0 16px;cursor:pointer;color:#fff;font-weight:600;background:var(--janis-accent)}' +
    '#janis-file{display:none}' +
    '#janis-power{text-align:center;font-size:11px;color:#9ca3af;padding:4px;background:#fff}' +
    '#janis-help{display:block;text-align:center;font-size:12px;color:#2563eb;padding:4px;text-decoration:none;background:#fff;border-top:1px solid #f3f4f6}' +
    '#janis-help:hover{text-decoration:underline}' +
    '.janis-loading{text-align:center;color:#9ca3af;font-size:12px;padding:18px 0}' +
    '#janis-form :disabled{opacity:.55;cursor:default}' +
    // in-conversation widgets — agent-emitted interactive components
    '.janis-w{margin-top:6px;font-size:13px}' +
    '.janis-msg.janis-hasw{max-width:95%;min-width:180px}' +
    '.janis-wcards-wrap{position:relative}' +
    '.janis-wcards{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}' +
    '.janis-wcards::-webkit-scrollbar{display:none}' +
    '.janis-wscroll{position:absolute;top:50%;transform:translateY(-50%);width:26px;height:26px;border-radius:50%;' +
    'border:1px solid #e5e7eb;background:#fff;color:#374151;box-shadow:0 2px 6px rgba(0,0,0,.18);' +
    'cursor:pointer;font-size:16px;line-height:0;display:flex;align-items:center;justify-content:center;padding:0 1px 2px 0;z-index:2;transition:opacity .15s}' +
    '.janis-wscroll.janis-wprev{left:2px;padding-right:2px}.janis-wscroll.janis-wnext{right:2px;padding-left:2px}' +
    '.janis-wscroll[disabled]{opacity:0;pointer-events:none}' +
    '.janis-wcard{flex:0 0 150px;max-width:150px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;color:#1f2937;overflow:hidden}' +
    '.janis-wcard img{width:100%;height:90px;object-fit:cover;display:block;margin:0!important;max-width:none!important;max-height:90px!important;border-radius:0}' +
    '.janis-wcard-body{padding:8px}' +
    '.janis-wcard-t{font-weight:600;font-size:13px;line-height:1.3}' +
    '.janis-wcard-s{color:#6b7280;font-size:12px;margin-top:2px;line-height:1.3}' +
    '.janis-wcard-p{font-weight:600;font-size:13px;margin-top:4px}' +
    '.janis-wcard-btns{display:flex;gap:4px;padding:0 8px 8px;flex-wrap:wrap}' +
    '.janis-wbtn{display:inline-block;border:1px solid var(--janis-accent);color:var(--janis-accent);background:#fff;' +
    'border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;text-decoration:none;font-family:inherit}' +
    '.janis-wbtn.janis-wbtn-primary{background:var(--janis-accent);color:#fff}' +
    '.janis-wtitle{font-weight:600;margin-bottom:6px;color:#374151}' +
    '.janis-wlist{margin:4px 0;padding-left:18px;display:block}' +
    '.janis-wlist li{margin:2px 0}' +
    '.janis-wopts{display:flex;flex-direction:column;gap:5px}' +
    '.janis-wopt{display:block;text-align:left;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#1f2937;' +
    'padding:7px 10px;font-size:13px;cursor:pointer;font-family:inherit}' +
    '.janis-wopt:hover:not(:disabled){border-color:var(--janis-accent);color:var(--janis-accent)}' +
    '.janis-wopt small{display:block;color:#6b7280;font-size:11.5px;margin-top:1px}' +
    '.janis-wopt.janis-wsel{border-color:var(--janis-accent);background:var(--janis-accent);color:#fff}' +
    '.janis-wopt.janis-wsel small{color:rgba(255,255,255,.8)}' +
    '.janis-wopts.janis-wdone .janis-wopt:not(.janis-wsel){opacity:.5;pointer-events:none}' +
    '.janis-wform{display:flex;flex-direction:column;gap:6px;min-width:200px}' +
    '.janis-wform input,.janis-wform textarea,.janis-wform select{border:1px solid #d1d5db;border-radius:8px;' +
    'padding:7px 10px;font-size:13px;font-family:inherit;background:#fff;color:#1f2937;outline:none;width:100%;box-sizing:border-box}' +
    '.janis-wform input:focus,.janis-wform textarea:focus,.janis-wform select:focus{border-color:var(--janis-accent)}' +
    '.janis-wform textarea{min-height:56px;resize:vertical}' +
    '.janis-wform label{font-size:12px;color:#6b7280;display:block;margin-bottom:2px}' +
    '.janis-wsent{color:#059669;font-size:12.5px;font-weight:600;padding:4px 0}' +
    '.janis-wsteps{display:flex;flex-direction:column;gap:7px}' +
    '.janis-wstep{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#1f2937}' +
    '.janis-wdot{flex:0 0 10px;width:10px;height:10px;border-radius:50%;margin-top:4px;background:#d1d5db}' +
    '.janis-wstep.done .janis-wdot{background:#059669}' +
    '.janis-wstep.current .janis-wdot{background:var(--janis-accent);box-shadow:0 0 0 3px rgba(91,33,182,.2)}' +
    '.janis-wstep.todo{color:#9ca3af}' +
    '.janis-wstep small{display:block;color:#6b7280;font-size:11.5px}' +
    '.janis-wreceipt{border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#fff;color:#1f2937}' +
    '.janis-wrow{display:flex;justify-content:space-between;gap:12px;padding:3px 0;font-size:13px}' +
    '.janis-wrow .janis-wv{text-align:right;font-weight:500;white-space:pre-line}' +
    '.janis-wrow.janis-wtotal{border-top:1px solid #e5e7eb;margin-top:6px;padding-top:7px;font-weight:700}' +
    '#janis-badge{position:absolute;top:-5px;left:-5px;min-width:22px;height:22px;border-radius:11px;' +
    'background:#ef4444;color:#fff;font-size:12px;font-weight:700;line-height:22px;text-align:center;' +
    'padding:0 6px;box-sizing:border-box;display:none;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none}' +
    '@keyframes janis-pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}' +
    '#janis-teaser{position:fixed;bottom:88px;right:20px;z-index:999998;max-width:250px;background:#fff;' +
    'border-radius:var(--janis-radius,14px);padding:11px 32px 11px 14px;box-shadow:0 6px 24px rgba(0,0,0,.2);font-size:13.5px;' +
    'line-height:1.45;color:#1f2937;cursor:pointer;animation:janis-pop .25s ease;' +
    'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}' +
    '#janis-teaser.janis-left{left:20px;right:auto}' +
    '#janis-teaser .janis-x{position:absolute;top:5px;right:7px;border:none;background:none;color:#9ca3af;' +
    'font-size:15px;cursor:pointer;padding:2px 5px;line-height:1}' +
    '#janis-conn{flex-shrink:0;background:#fef3c7;color:#92400e;font-size:12px;padding:5px 14px;text-align:center}' +
    '#janis-jump{position:absolute;bottom:66px;left:50%;transform:translateX(-50%);z-index:2;' +
    'border:none;border-radius:14px;padding:7px 14px;background:#1f2937;color:#fff;font-size:12px;' +
    'cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);white-space:nowrap;animation:janis-pop .2s ease;' +
    'font-family:inherit}' +
    '#janis-jump:hover{background:#374151}' +
    '.janis-when{opacity:.55;font-weight:400;margin-left:4px}' +
    // Dark scheme — applied via .janis-dark on the panel when branding.theme
    // is 'dark', or 'auto' + the visitor's OS prefers dark. Only neutrals
    // flip; the accent and its white text stay.
    '#janis-panel.janis-dark{background:#1f2937;color:#f3f4f6}' +
    '#janis-panel.janis-dark #janis-msgs{background:#111827}' +
    '#janis-panel.janis-dark .janis-msg.out{background:#374151;color:#f3f4f6}' +
    '#janis-panel.janis-dark .janis-msg.human{background:#1e3a8a;color:#dbeafe}' +
    '#janis-panel.janis-dark .janis-author{color:#93c5fd}' +
    '#janis-panel.janis-dark .janis-qr{background:transparent}' +
    '#janis-panel.janis-dark .janis-qr-ask input{background:#111827;border-color:#4b5563;color:#f3f4f6}' +
    '#janis-panel.janis-dark #janis-form{background:#1f2937;border-top-color:#374151}' +
    '#janis-panel.janis-dark #janis-input{background:#1f2937;color:#f3f4f6}' +
    '#janis-panel.janis-dark #janis-input::placeholder{color:#6b7280}' +
    '#janis-panel.janis-dark .janis-ico{color:#9ca3af!important}' +
    '#janis-panel.janis-dark #janis-attach,#janis-panel.janis-dark #janis-emoji{background:#1f2937;border-top-color:#374151}' +
    '#janis-panel.janis-dark .janis-chip{background:#374151;color:#e5e7eb}' +
    '#janis-panel.janis-dark #janis-help{background:#1f2937;border-top-color:#374151;color:#60a5fa}' +
    '#janis-panel.janis-dark #janis-power{background:#1f2937;color:#6b7280}' +
    '#janis-panel.janis-dark .janis-status{color:#6b7280}' +
    '#janis-panel.janis-dark .janis-file{background:rgba(255,255,255,.12)}' +
    '#janis-panel.janis-dark .janis-loading{color:#6b7280}' +
    '#janis-teaser.janis-dark{background:#1f2937;color:#f3f4f6}' +
    // iOS Safari zooms the whole page when a focused field is under 16px —
    // keep the input at 16px on touch devices so opening the widget doesn't
    // blow up the host site's layout.
    '@media (pointer:coarse){#janis-input{font-size:16px}}';
  document.head.appendChild(css);

  // ---- DOM ----------------------------------------------------------------
  var bubble = el('button', { background: accent }, { id: 'janis-bubble', 'aria-label': 'Chat with us' });
  bubble.id = 'janis-bubble';
  bubble.textContent = '💬';
  var badgeEl = el('span', {}, { id: 'janis-badge' });
  bubble.appendChild(badgeEl);
  var panel = el('div', {}, { id: 'janis-panel' });
  panel.innerHTML =
    '<div id="janis-head"><div><span id="janis-title">Chat</span><small id="janis-sub"></small></div>' +
    '<button id="janis-menu-btn" aria-label="Chat options" title="Options">⋯</button>' +
    '<button id="janis-expand" aria-label="Expand chat" title="Expand">⤢</button></div>' +
    '<div id="janis-menu">' +
    '<button type="button" id="janis-menu-end">End chat</button>' +
    '<button type="button" id="janis-menu-new" style="display:none">Start a new chat</button>' +
    '</div>' +
    '<div id="janis-msgs"></div>' +
    '<div id="janis-attach"></div>' +
    '<div id="janis-emoji"></div>' +
    '<form id="janis-form">' +
    '<button id="janis-clip" class="janis-ico" type="button" aria-label="Attach a file" title="Attach a file">📎</button>' +
    '<button id="janis-smile" class="janis-ico" type="button" aria-label="Emoji" title="Emoji">😊</button>' +
    '<textarea id="janis-input" placeholder="Type a message…" rows="1"></textarea>' +
    '<button id="janis-mic" class="janis-ico" type="button" aria-label="Dictate a message" title="Dictate"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg></button>' +
    '<button id="janis-send" type="submit">Send</button></form>' +
    '<input id="janis-file" type="file" multiple />' +
    '<a id="janis-help" target="_blank" rel="noopener" style="display:none">Browse help articles</a>' +
    '<div id="janis-power">Powered by Janis</div>';
  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  var msgs = panel.querySelector('#janis-msgs');
  var form = panel.querySelector('#janis-form');
  var input = panel.querySelector('#janis-input');
  var attachRow = panel.querySelector('#janis-attach');
  var emojiGrid = panel.querySelector('#janis-emoji');
  var fileInput = panel.querySelector('#janis-file');
  var expandBtn = panel.querySelector('#janis-expand');
  var sendBtn = panel.querySelector('#janis-send');
  var clipBtn = panel.querySelector('#janis-clip');
  var smileBtn = panel.querySelector('#janis-smile');
  var menuBtn = panel.querySelector('#janis-menu-btn');
  var menu = panel.querySelector('#janis-menu');
  var menuEnd = panel.querySelector('#janis-menu-end');
  var menuNew = panel.querySelector('#janis-menu-new');

  // Chat options (⋯) — Zendesk-style: end the chat, or start a fresh thread
  // once it's ended. The server archives on end (CSAT prompt follows), and
  // /new re-points this visitor's binding at a fresh empty conversation.
  function syncMenu() {
    var ended = state.convState === 'archived';
    menuEnd.style.display = ended ? 'none' : 'block';
    menuNew.style.display = ended ? 'block' : 'none';
  }
  function markEnded() {
    syncMenu();
    if (msgs.querySelector('.janis-ended')) return;
    var note = el('div', {}, { class: 'janis-ended' });
    note.textContent = 'This chat has ended — use ⋯ → Start a new chat to begin a fresh thread.';
    msgs.appendChild(note);
    scrollBottom();
  }
  menuBtn.onclick = function (e) {
    e.stopPropagation();
    syncMenu();
    menu.classList.toggle('open');
  };
  document.addEventListener('click', function (e) {
    if (menu.classList.contains('open') && !menu.contains(e.target)) menu.classList.remove('open');
  });
  menuEnd.onclick = function () {
    menu.classList.remove('open');
    fetch(API + '/chat/' + TOKEN + '/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitor }),
    }).then(function () {
      state.convState = 'archived';
      markEnded();
      return poll();
    }).catch(function () {});
  };
  menuNew.onclick = function () {
    menu.classList.remove('open');
    fetch(API + '/chat/' + TOKEN + '/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitor }),
    }).then(function (r) { return r && r.ok ? r.json() : null; }).then(function (d) {
      if (!d || d.state !== 'new') return;
      // Fresh conversation — wipe the rendered thread and re-poll so the
      // greeting lands on the empty transcript.
      state.seen = {};
      state.lastTs = null;
      state.oldestTs = null;
      state.hasMore = false;
      state.greeted = false;
      state.convState = 'agent';
      state.lastAuthor = null;
      msgs.innerHTML = '';
      var ended = msgs.querySelector('.janis-ended');
      if (ended) ended.remove();
      return poll();
    }).catch(function () {});
  };

  // ---- transcript loading gate ----------------------------------------------
  // The composer stays disabled until the first poll resolves (or fails) —
  // sending into an unloaded transcript could race the history render.
  // ---- presence helpers -----------------------------------------------------
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  // Short two-note chime on a new reply while the panel is closed or the tab
  // is hidden — WebAudio, no asset; suspended contexts (no prior user
  // gesture on the page) fail silently.
  function ping() {
    if (state.config && state.config.sound === false) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!state.audioCtx) state.audioCtx = new AC();
      var ctx = state.audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      var t = ctx.currentTime;
      [880, 660].forEach(function (f, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.07, t + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.2);
        o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.22);
      });
    } catch (e) {}
  }
  function saveSeen() { try { if (state.lastSeen) localStorage.setItem(LS_SEEN, state.lastSeen); } catch (e) {} }
  // Tab-title flash — "(2) Site name". Strip our own prefix rather than
  // restoring a saved title so host-side title changes (SPAs) survive.
  // Plus a red dot painted over the favicon — what actually catches the eye
  // on a crowded tab bar (Intercom does the same).
  var favOrig = null, favData = null, favApplied = false;
  function faviconBadge(on) {
    try {
      var link = document.querySelector('link[rel~="icon"],link[rel="shortcut icon"]');
      if (!link) return;
      if (favOrig === null) favOrig = link.getAttribute('href') || '';
      if (!on) {
        if (favApplied) { link.setAttribute('href', favOrig); favApplied = false; }
        return;
      }
      if (favData) { link.setAttribute('href', favData); favApplied = true; return; }
      var img = new Image();
      img.onload = function () {
        var s = img.width || 32;
        var c = document.createElement('canvas');
        c.width = c.height = s;
        var x = c.getContext('2d');
        x.drawImage(img, 0, 0, s, s);
        var r = s * 0.3;
        x.beginPath();
        x.arc(s - r * 0.7, r * 0.7, r, 0, Math.PI * 2);
        x.fillStyle = '#ef4444';
        x.fill();
        x.lineWidth = s * 0.1;
        x.strokeStyle = '#fff';
        x.stroke();
        try { favData = c.toDataURL('image/png'); } catch (e) { return; } // tainted canvas (cross-origin icon) — title prefix still carries it
        link.setAttribute('href', favData);
        favApplied = true;
      };
      img.src = favOrig;
    } catch (e) {}
  }
  function updateBadge() {
    // Bubble badge only while closed (the panel covers it); title + favicon
    // badge whenever unseen — they're what a backgrounded tab can show.
    var n = state.unread;
    badgeEl.style.display = n > 0 && !state.open ? 'block' : 'none';
    badgeEl.textContent = n > 9 ? '9+' : String(n);
    var bare = document.title.replace(/^\(\d+\+?\)\s+/, '');
    document.title = n > 0 ? '(' + n + ') ' + bare : bare;
    faviconBadge(n > 0);
  }
  // Returned to a visible tab with the panel open — the transcript is in
  // view, so the backlog is seen by definition.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.open && state.unread) {
      state.unread = 0;
      if (state.lastTs && (!state.lastSeen || state.lastTs > state.lastSeen)) {
        state.lastSeen = state.lastTs;
        saveSeen();
      }
      updateBadge();
    }
  });
  // Proactive teaser — a card above the launcher for brand-new visitors (no
  // thread, no unread). Session dismissal; superseded by the unread badge.
  var teaserEl = null;
  function hideTeaser() { if (teaserEl) { teaserEl.remove(); teaserEl = null; } }
  function maybeTeaser() {
    if (teaserEl || state.open || state.lastTs || state.unread > 0 || !state.config ||
        state.config.proactive === false) return;
    try { if (sessionStorage.getItem(SS_TEASER)) return; } catch (e) {}
    var txt = state.config.teaser_text || state.config.greeting || 'Questions? Chat with us.';
    teaserEl = el('div', {}, { id: 'janis-teaser', role: 'button' });
    if (state.config.position === 'left') teaserEl.classList.add('janis-left');
    if (panel.classList.contains('janis-dark')) teaserEl.classList.add('janis-dark');
    var tx = el('span', {}, {});
    tx.textContent = txt;
    teaserEl.appendChild(tx);
    var x = el('button', {}, { class: 'janis-x', 'aria-label': 'Dismiss' });
    x.textContent = '×';
    x.onclick = function (e) {
      e.stopPropagation();
      hideTeaser();
      try { sessionStorage.setItem(SS_TEASER, '1'); } catch (e2) {}
    };
    teaserEl.appendChild(x);
    teaserEl.onclick = function () { setOpen(true); };
    document.body.appendChild(teaserEl);
  }
  // Connectivity strip — consecutive poll failures mean the host is likely
  // offline or the API unreachable; show it only while the panel is open.
  // Follow-bottom scrolling — the standard pattern (Intercom/iMessage):
  // new messages yank the view only while the visitor is pinned near the
  // bottom; if they've scrolled up to read, a "new messages" pill offers
  // the jump instead of ripping them out of their place.
  function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }
  function nearBottom() { return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60; }
  function showJump() {
    if (state.jumpEl || !state.open) return;
    var b = el('button', {}, { id: 'janis-jump', type: 'button' });
    b.textContent = '↓ New messages';
    b.onclick = function () { state.pinBottom = true; scrollBottom(); hideJump(); };
    panel.appendChild(b);
    state.jumpEl = b;
  }
  function hideJump() { if (state.jumpEl) { state.jumpEl.remove(); state.jumpEl = null; } }

  var connEl = null;
  function setConn(lost) {
    if (lost && state.open && !connEl) {
      connEl = el('div', {}, { id: 'janis-conn' });
      connEl.textContent = 'Connection lost — reconnecting…';
      panel.insertBefore(connEl, msgs);
    } else if (!lost && connEl) {
      connEl.remove(); connEl = null;
    }
  }

  var loadingEl = el('div', {}, { class: 'janis-loading' });
  loadingEl.textContent = 'Loading conversation…';
  msgs.appendChild(loadingEl);
  input.disabled = true;
  sendBtn.disabled = true;
  clipBtn.disabled = true;
  smileBtn.disabled = true;
  function markLoaded() {
    if (state.loaded) return;
    state.loaded = true;
    loadingEl.remove();
    input.disabled = false;
    clipBtn.disabled = false;
    smileBtn.disabled = false;
    syncSend();
  }

  // ---- rendering ----------------------------------------------------------
  function addAttachmentNode(parent, a) {
    var url = /^https?:\/\//.test(a.url) ? a.url : API + a.url;
    if ((a.type || '').indexOf('image/') === 0) {
      var link = el('a', {}, { href: url, target: '_blank', rel: 'noopener' });
      link.appendChild(el('img', {}, { src: url, alt: a.name || 'image' }));
      parent.appendChild(link);
    } else {
      var chip = el('a', {}, { class: 'janis-file', href: url, target: '_blank', rel: 'noopener' });
      chip.textContent = '📎 ' + (a.name || 'file');
      parent.appendChild(chip);
    }
  }

  // Typing indicator — two drivers share one dots bubble: the agent working
  // after a visitor send (agentWorking, suppressed once a human owns the
  // thread) and an operator composing in the console (opTyping, polled).
  // Always bare dots — the sender's name/avatar belongs on the reply itself,
  // not on the indicator. Cleared when a reply lands or the timeout fires.
  function renderTyping() {
    var want = state.agentWorking || state.agentTyping || !!state.opTyping;
    if (!want) {
      if (state.typingEl) { state.typingEl.remove(); state.typingEl = null; }
      return;
    }
    if (state.typingEl) {
      if (state.pinBottom) scrollBottom();
      return;
    }
    var d = el('div', {}, { class: 'janis-msg out typing' });
    var dots = el('span', {}, { class: 'janis-dots' });
    dots.appendChild(el('span', {}, { class: 'janis-dot' }));
    dots.appendChild(el('span', {}, { class: 'janis-dot' }));
    dots.appendChild(el('span', {}, { class: 'janis-dot' }));
    d.appendChild(dots);
    msgs.appendChild(d);
    if (state.pinBottom) scrollBottom(); // transient — no jump pill for dots
    state.typingEl = d;
  }

  function hideTyping() {
    state.agentWorking = false;
    state.agentTyping = false;
    state.opTyping = null;
    if (state.typingTimer) { clearTimeout(state.typingTimer); state.typingTimer = null; }
    renderTyping();
  }

  function showTyping() {
    if (state.convState === 'human') return;
    state.agentWorking = true;
    renderTyping();
    if (state.typingTimer) clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(function () {
      state.agentWorking = false;
      renderTyping();
    }, 45000);
  }

  // The server resolves which participant a poll belongs to; a switch (anon
  // → signed-in, or logout) means the rendered bubbles, dedupe set and
  // after-cursor all belong to the old thread — reset and fetch it fresh.
  function resetTranscript() {
    msgs.innerHTML = '';
    state.seen = {};
    state.lastTs = null;
    state.lastAuthor = null;
    state.hasMore = false;
    state.oldestTs = null;
    state.loadingMore = false;
    state.outbox = [];
    state.deliveredEl = null;
    hideTyping();
    if (state.qrsEl) { state.qrsEl.remove(); state.qrsEl = null; }
    state.greeted = false; // let the fresh poll decide whether the greeting belongs
  }

  // Bubble construction shared by append (new messages) and prepend
  // (scroll-up history back-fill). Stamps data-author so a prepended page
  // can dedupe the author label at the seam with existing messages.
  function buildMsgEl(m) {
    var d = el('div', {}, { class: 'janis-msg ' + m.direction });
    d.className = 'janis-msg ' + (m.direction === 'in' ? 'in' : m.direction === 'human' ? 'human' : 'out');
    // Operator identity on human replies — the label shows once per run of
    // consecutive same-author bubbles, not on every message.
    var authorKey = m.direction === 'human' ? 'h:' + ((m.author && m.author.name) || '') : m.direction;
    var sameAuthor = state.lastAuthor === authorKey;
    state.lastAuthor = authorKey;
    d.setAttribute('data-author', authorKey);
    if (m.created_at) {
      d.setAttribute('data-real', '1'); // synthetic greeting stays unmarked
      var dt = new Date(m.created_at);
      if (!isNaN(dt)) d.title = dt.toLocaleString(); // full stamp on hover
    }
    // Sender label opens each run — an operator's name/avatar on human
    // replies, the agent's name/logo on its own messages. One label per
    // consecutive run, not every bubble.
    var label = null;
    var avatar = null;
    if (m.direction === 'human' && m.author && m.author.name) {
      label = m.author.name;
      avatar = m.author.avatar;
    } else if (m.direction === 'out' && state.config && state.config.agent_name) {
      label = state.config.agent_name;
      avatar = state.config.logo_url;
    }
    if (label && !sameAuthor) {
      var who = el('div', {}, { class: 'janis-author' });
      if (avatar) {
        // relative paths (e.g. /uploads/…) live on the API origin,
        // not the host page's — resolve them the same way attachments do
        var avSrc = /^https?:\/\//.test(avatar) ? avatar : API + avatar;
        var av = el('img', {}, { class: 'janis-author-img', src: avSrc, alt: '' });
        who.appendChild(av);
      }
      who.appendChild(document.createTextNode(label));
      var when = fmtTime(m.created_at);
      if (when) {
        var w = el('span', {}, { class: 'janis-when' });
        w.textContent = '· ' + when;
        who.appendChild(w);
      }
      d.appendChild(who);
    }
    if (m.text) {
      appendBlocks(d, m.text);
    }
    (m.attachments || []).forEach(function (a) { addAttachmentNode(d, a); });
    if (m.direction === 'out' && m.widgets && m.widgets.length) renderWidgets(d, m.widgets);
    return d;
  }

  // ---- in-conversation widgets -------------------------------------------
  // Agent-emitted interactive components (payload.widgets). DOM nodes only —
  // content is model output and must never become markup. Interactions send
  // back through sendText() as ordinary customer messages.

  function wtext(parent, str) {
    parent.appendChild(document.createTextNode(String(str)));
  }

  function wTitle(parent, title) {
    if (!title) return;
    var t = el('div', {}, { class: 'janis-wtitle' });
    wtext(t, title);
    parent.appendChild(t);
  }

  function renderCards(box, w) {
    var wrap = el('div', {}, { class: 'janis-wcards-wrap' });
    var row = el('div', {}, { class: 'janis-wcards' });
    (w.items || []).forEach(function (item) {
      var card = el('div', {}, { class: 'janis-wcard' });
      if (item.image) {
        card.appendChild(el('img', {}, { src: item.image, alt: '', loading: 'lazy' }));
      }
      var body = el('div', {}, { class: 'janis-wcard-body' });
      var t = el('div', {}, { class: 'janis-wcard-t' });
      wtext(t, item.title);
      body.appendChild(t);
      if (item.subtitle) {
        var sEl = el('div', {}, { class: 'janis-wcard-s' });
        wtext(sEl, item.subtitle);
        body.appendChild(sEl);
      }
      if (item.price) {
        var p = el('div', {}, { class: 'janis-wcard-p' });
        wtext(p, item.price);
        body.appendChild(p);
      }
      card.appendChild(body);
      if (item.link || item.select_label) {
        var btns = el('div', {}, { class: 'janis-wcard-btns' });
        if (item.link) {
          var a = el('a', {}, { class: 'janis-wbtn', href: item.link, target: '_blank', rel: 'noopener noreferrer' });
          wtext(a, item.link_label || 'View');
          btns.appendChild(a);
        }
        if (item.select_label) {
          var b = el('button', {}, { class: 'janis-wbtn janis-wbtn-primary', type: 'button' });
          wtext(b, item.select_label);
          b.onclick = function () { sendText(item.select_label, { of: item.title }); };
          btns.appendChild(b);
        }
        card.appendChild(btns);
      }
      row.appendChild(card);
    });
    wrap.appendChild(row);
    // Overflow arrows — the row scrolls natively but nothing signals that on
    // desktop. ‹ › step one card at a time and fade out at the edges.
    function arrow(cls, dir, label) {
      var b = el('button', {}, { class: 'janis-wscroll ' + cls, type: 'button', 'aria-label': label });
      wtext(b, dir < 0 ? '‹' : '›');
      b.onclick = function () { row.scrollBy({ left: dir * 168, behavior: 'smooth' }); };
      return b;
    }
    var prev = arrow('janis-wprev', -1, 'Scroll left');
    var next = arrow('janis-wnext', 1, 'Scroll right');
    function syncArrows() {
      var over = row.scrollWidth > row.clientWidth + 4;
      prev.style.display = over ? 'flex' : 'none';
      next.style.display = over ? 'flex' : 'none';
      prev.disabled = !over || row.scrollLeft <= 0;
      next.disabled = !over || row.scrollLeft + row.clientWidth >= row.scrollWidth - 2;
    }
    row.addEventListener('scroll', syncArrows, { passive: true });
    wrap.appendChild(prev);
    wrap.appendChild(next);
    box.appendChild(wrap);
    // The panel may be closed (scrollWidth 0) when the cards render, and the
    // window can resize — observe so arrows track real overflow.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(syncArrows).observe(row);
    }
    requestAnimationFrame(syncArrows);
    setTimeout(syncArrows, 300);
  }

  function renderOptions(box, w) {
    wTitle(box, w.title);
    var list = el('div', {}, { class: 'janis-wopts' });
    (w.items || []).forEach(function (item) {
      var b = el('button', {}, { class: 'janis-wopt', type: 'button' });
      wtext(b, item.label);
      if (item.description) {
        var sEl = document.createElement('small');
        wtext(sEl, item.description);
        b.appendChild(sEl);
      }
      b.onclick = function () {
        list.classList.add('janis-wdone');
        b.classList.add('janis-wsel');
        sendText(item.label, { of: w.title });
      };
      list.appendChild(b);
    });
    box.appendChild(list);
  }

  function renderForm(box, w) {
    wTitle(box, w.title);
    var form = el('div', {}, { class: 'janis-wform' });
    var fields = [];
    (w.fields || []).forEach(function (f) {
      var lab = document.createElement('label');
      wtext(lab, f.label + (f.required ? ' *' : ''));
      var input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
      } else if (f.type === 'select' && f.options && f.options.length) {
        input = document.createElement('select');
        f.options.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o;
          wtext(opt, o);
          input.appendChild(opt);
        });
      } else {
        input = document.createElement('input');
        input.type = f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text';
      }
      form.appendChild(lab);
      form.appendChild(input);
      fields.push({ f: f, input: input });
    });
    var submit = el('button', {}, { class: 'janis-wbtn janis-wbtn-primary', type: 'button' });
    wtext(submit, w.submit_label || 'Submit');
    submit.onclick = function () {
      var pairs = [];
      for (var i = 0; i < fields.length; i++) {
        var v = fields[i].input.value.trim();
        if (fields[i].f.required && !v) { fields[i].input.focus(); return; }
        if (fields[i].f.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          fields[i].input.focus();
          return;
        }
        if (v) pairs.push(fields[i].f.label + ': ' + v);
      }
      if (!pairs.length) return;
      // The submission lands as a normal customer message — the agent reads
      // it like any other turn, no special wire needed.
      var text = (w.title ? 'Form "' + w.title + '"' : 'Form') + ' — ' + pairs.join(' · ');
      box.innerHTML = '';
      var done = el('div', {}, { class: 'janis-wsent' });
      wtext(done, 'Sent ✓');
      box.appendChild(done);
      sendText(text, { of: w.title || 'form' });
    };
    form.appendChild(submit);
    box.appendChild(form);
  }

  function renderStatus(box, w) {
    wTitle(box, w.title);
    var list = el('div', {}, { class: 'janis-wsteps' });
    (w.steps || []).forEach(function (st) {
      var row = el('div', {}, { class: 'janis-wstep ' + (st.state || 'todo') });
      row.appendChild(el('div', {}, { class: 'janis-wdot' }));
      var txt = el('div', {});
      wtext(txt, st.label);
      if (st.note) {
        var n = document.createElement('small');
        wtext(n, st.note);
        txt.appendChild(n);
      }
      row.appendChild(txt);
      list.appendChild(row);
    });
    box.appendChild(list);
  }

  function renderReceipt(box, w) {
    var card = el('div', {}, { class: 'janis-wreceipt' });
    wTitle(card, w.title);
    (w.rows || []).forEach(function (r) {
      var row = el('div', {}, { class: 'janis-wrow' });
      var l = el('span', {});
      wtext(l, r.label);
      var v = el('span', {}, { class: 'janis-wv' });
      wtext(v, r.value);
      row.appendChild(l);
      row.appendChild(v);
      card.appendChild(row);
    });
    if (w.total) {
      var tr = el('div', {}, { class: 'janis-wrow janis-wtotal' });
      var tl = el('span', {});
      wtext(tl, w.total.label);
      var tv = el('span', {}, { class: 'janis-wv' });
      wtext(tv, w.total.value);
      tr.appendChild(tl);
      tr.appendChild(tv);
      card.appendChild(tr);
    }
    box.appendChild(card);
  }

  function renderWidgets(msgEl, widgets) {
    widgets.forEach(function (w) {
      if (!w || typeof w !== 'object' || typeof w.type !== 'string') return;
      try {
        var box = el('div', {}, { class: 'janis-w janis-w-' + w.type });
        if (w.type === 'cards') renderCards(box, w);
        else if (w.type === 'options') renderOptions(box, w);
        else if (w.type === 'form') renderForm(box, w);
        else if (w.type === 'status') renderStatus(box, w);
        else if (w.type === 'receipt') renderReceipt(box, w);
        else return;
        msgEl.classList.add('janis-hasw');
        msgEl.appendChild(box);
      } catch (e) {
        // a malformed component must never break the transcript
      }
    });
  }

  function addMsg(m) {
    if (m.id) {
      if (state.seen[m.id]) return;
      state.seen[m.id] = 1;
    }
    if (m.direction !== 'in') hideTyping();
    var d = buildMsgEl(m);
    msgs.appendChild(d);
    // Chips belong to the message that offered them — a visitor send or any
    // newer message without its own quick replies retires the offer.
    if (m.direction !== 'in' && m.quick_replies && m.quick_replies.length) {
      renderChips(m.quick_replies);
    } else {
      clearChips();
    }
    if (state.qrsEl) msgs.appendChild(state.qrsEl); // keep chips under the newest bubble
    // Own sends always snap to bottom (the visitor is right there typing);
    // replies only follow when pinned — otherwise offer the jump pill.
    if (state.pinBottom || !state.open || m.direction === 'in') scrollBottom();
    else showJump();
    if (m.created_at && (!state.lastTs || m.created_at > state.lastTs)) state.lastTs = m.created_at;
    if (m.created_at && (!state.oldestTs || m.created_at < state.oldestTs)) state.oldestTs = m.created_at;
    return d;
  }

  // Older history back-fill — the initial poll returns only the latest page;
  // scrolling to the top pulls the previous page and prepends it while
  // holding the scroll position steady.
  function loadOlder() {
    if (!state.hasMore || state.loadingMore || !state.oldestTs) return;
    state.loadingMore = true;
    var spinner = el('div', {}, { class: 'janis-loading' });
    spinner.textContent = 'Loading earlier messages…';
    msgs.insertBefore(spinner, msgs.firstChild);
    fetch(API + '/chat/' + TOKEN + '/messages?visitor_id=' + encodeURIComponent(visitor) +
        '&before=' + encodeURIComponent(state.oldestTs))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        spinner.remove();
        if (!d || !d.messages.length) { state.hasMore = !!(d && d.has_more); return; }
        var prevHeight = msgs.scrollHeight;
        var prevTop = msgs.scrollTop;
        var firstEl = msgs.querySelector('[data-real]');
        var seamKey = firstEl ? firstEl.getAttribute('data-author') : null;
        var savedAuthor = state.lastAuthor;
        state.lastAuthor = null; // fresh runs within the prepended page
        var lastKey = null;
        d.messages.forEach(function (m) {
          if (m.id) {
            if (state.seen[m.id]) return;
            state.seen[m.id] = 1;
          }
          var b = buildMsgEl(m);
          msgs.insertBefore(b, firstEl);
          lastKey = b.getAttribute('data-author');
        });
        state.lastAuthor = savedAuthor;
        // Seam dedupe — if the page's last author matches the bubble that was
        // already first, that bubble's label is now mid-run; drop it.
        if (firstEl && seamKey && seamKey === lastKey) {
          var lbl = firstEl.querySelector('.janis-author');
          if (lbl) lbl.remove();
        }
        state.hasMore = !!d.has_more;
        state.oldestTs = d.messages[0].created_at;
        msgs.scrollTop = prevTop + (msgs.scrollHeight - prevHeight);
      })
      .catch(function () { spinner.remove(); })
      .finally(function () { state.loadingMore = false; });
  }
  msgs.addEventListener('scroll', function () {
    if (msgs.scrollTop < 40 && state.loaded) loadOlder();
    state.pinBottom = nearBottom();
    if (state.pinBottom) hideJump(); // scrolled to latest by hand
  });

  // Optimistic send: bubble renders instantly, swaps for the server echo when it arrives.
  function sendPayload(entry) {
    fetch(API + '/chat/' + TOKEN + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry.payload),
    }).then(function (r) {
      if (!r || !r.ok) return Promise.reject(new Error('send failed'));
      showTyping(); // server has the message — agent is working
      return poll();
    }).then(function () {
      if (state.outbox.indexOf(entry) < 0) return; // echo already reconciled
      // The awaited poll may have been issued before the store landed — verify once more.
      setTimeout(function () {
        poll().then(function () {
          if (state.outbox.indexOf(entry) >= 0) markFailed(entry); // never stored (e.g. plan cap)
        });
      }, 1500);
    }).catch(function () {
      // The write may have landed even though the response was lost — poll
      // once so a stored echo reconciles the entry before marking it failed.
      return poll().then(function () {
        if (state.outbox.indexOf(entry) >= 0) markFailed(entry);
      });
    });
  }

  // One 'Delivered' receipt, pinned under the newest confirmed visitor
  // bubble. Cleared the moment a new message starts sending.
  function hideDelivered() {
    if (state.deliveredEl) { state.deliveredEl.remove(); state.deliveredEl = null; }
  }

  function showDelivered(entry, ts) {
    hideDelivered();
    var st = document.createElement('div');
    st.className = 'janis-status';
    var when = fmtTime(ts);
    st.textContent = when ? 'Delivered · ' + when : 'Delivered';
    entry.el.after(st);
    entry.statusEl = st;
    state.deliveredEl = st;
  }

  // Quick-reply chips — tappable prompt buttons shown under the latest
  // message. Removed permanently once the visitor sends anything.
  function clearChips() {
    if (state.qrsEl) { state.qrsEl.remove(); state.qrsEl = null; }
  }

  // `tap` marks component-originated sends (card button, option pick, chip,
  // form submit) — the agent sees them as picks with context, not typed
  // commands. `tap.of` names the card/widget it came from.
  function sendText(text, tap) {
    var body = { visitor_id: visitor, text: text, user: state.user || undefined, attachments: [] };
    if (tap) {
      body.tap = true;
      if (tap.of) body.tap_of = tap.of;
    }
    var entry = addPending(body, []);
    sendPayload(entry);
  }

  function renderChips(list) {
    clearChips();
    var row = el('div', {}, { class: 'janis-qrs' });
    list.forEach(function (q) {
      // {type:'email'|'phone'} — contact-field ask; webchat has no native
      // share affordance, so render an inline field that sends the value.
      if (q && typeof q === 'object' && (q.type === 'email' || q.type === 'phone')) {
        var form = el('div', {}, { class: 'janis-qr-ask' });
        var input = document.createElement('input');
        input.type = q.type === 'email' ? 'email' : 'tel';
        input.placeholder = q.type === 'email' ? 'you@example.com' : 'Your phone number';
        input.autocomplete = q.type === 'email' ? 'email' : 'tel';
        var send = document.createElement('button');
        send.type = 'button';
        send.className = 'janis-qr';
        send.textContent = 'Send';
        var submit = function () {
          var v = input.value.trim();
          if (!v) { input.focus(); return; }
          if (q.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
            input.focus();
            return;
          }
          clearChips();
          sendText(v);
        };
        send.onclick = submit;
        input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
        form.appendChild(input);
        form.appendChild(send);
        row.appendChild(form);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'janis-qr';
      b.textContent = q;
      b.onclick = function () { clearChips(); sendText(q, {}); };
      row.appendChild(b);
    });
    msgs.appendChild(row);
    if (state.pinBottom) scrollBottom();
    state.qrsEl = row;
  }

  function markFailed(entry) {
    hideTyping();
    hideDelivered();
    entry.el.classList.remove('pending');
    entry.el.classList.add('failed');
    if (!entry.statusEl || !entry.statusEl.isConnected) {
      var st = document.createElement('div');
      st.className = 'janis-status';
      st.style.cursor = 'pointer';
      entry.el.after(st); // right under its own bubble, wherever it sits
      entry.statusEl = st;
    }
    entry.statusEl.textContent = 'Not delivered — tap to retry';
    var retry = function () {
      entry.el.onclick = null;
      if (entry.statusEl) entry.statusEl.onclick = null;
      entry.el.classList.remove('failed');
      entry.el.classList.add('pending');
      if (entry.statusEl) entry.statusEl.remove();
      entry.statusEl = null;
      sendPayload(entry);
    };
    entry.el.onclick = retry;
    entry.statusEl.onclick = retry;
  }

  function addPending(payload, attachments) {
    hideDelivered(); // a new send clears the previous receipt
    // Idempotency key — a retried POST (timeout, lost response) dedupes
    // server-side instead of double-storing the visitor's message.
    payload.client_id = 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    var d = addMsg({ direction: 'in', text: payload.text, attachments: attachments });
    d.classList.add('pending');
    var entry = { el: d, statusEl: null, text: payload.text, payload: payload };
    state.outbox.push(entry);
    return entry;
  }

  function poll() {
    if (state.pollBusy) return state.pollPromise || Promise.resolve();
    state.pollBusy = true;
    if (!state.loadStart) state.loadStart = Date.now();
    var url = API + '/chat/' + TOKEN + '/messages?visitor_id=' + encodeURIComponent(visitor);
    if (state.lastTs) url += '&after=' + encodeURIComponent(state.lastTs);
    // the signed claim rides the poll — for a real Janis user the transcript
    // is keyed on the user, not the visitor id, so identity must travel too
    if (state.user) {
      url += '&u_id=' + encodeURIComponent(state.user.id || '') +
        '&u_name=' + encodeURIComponent(state.user.name || '') +
        '&u_email=' + encodeURIComponent(state.user.email || '') +
        '&u_sig=' + encodeURIComponent(state.user.sig || '');
    }
    state.pollPromise = fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      // The first fetch usually lands in <100ms — without a floor the
      // loading row never paints and history reads as popping in raw.
      var delay = Math.max(0, 500 - (Date.now() - state.loadStart));
      return new Promise(function (res) { setTimeout(res, delay); }).then(function () {
        state.pollBusy = false;
        markLoaded();
        if (!d) {
          // r.ok false (5xx, rate-limited) — soft failure, still counts
          state.fails++;
          if (state.fails >= 2) setConn(true);
          return;
        }
        state.fails = 0;
        setConn(false);
        if (d.participant && state.participant !== d.participant) {
          // identity switched threads — discard this response (fetched with the
          // old thread's cursor) and re-poll the new thread from scratch. The
          // first poll just records the participant (state starts null) — no
          // reset, or we'd wipe the greeting.
          var changed = state.participant !== null;
          state.participant = d.participant;
          if (changed) {
            resetTranscript();
            return poll();
          }
        }
        state.convState = d.state;
        if (d.state === 'archived') markEnded();
        if (d.has_more !== undefined) state.hasMore = d.has_more;
        if (!state.greeted) {
          // first poll resolved — only kick off the greeting once we know the
          // transcript is actually empty, so history doesn't get a greeting header
          state.greeted = true;
          if (!d.messages.length && !state.outbox.length) {
            if (state.config && state.config.greeting) {
              addMsg({
                direction: 'out',
                text: state.config.greeting,
                created_at: null,
                // Components pinned "show when the chat opens" in the composer
                widgets: state.config.greeting_widgets || undefined,
              });
            }
            if (state.config && state.config.quick_replies && state.config.quick_replies.length) {
              renderChips(state.config.quick_replies);
            }
          }
        }
        var gotReply = false;
        var wantPing = false;
        d.messages.forEach(function (m) {
          // Exact idempotency-key match first — text matching misfires when
          // the same message is sent twice.
          var i = m.direction === 'in' ? state.outbox.findIndex(function (o) {
            return (m.client_id && o.payload.client_id === m.client_id) ||
              o.text === m.text ||
              (o.payload.attachments.length > 0 && (m.attachments || []).length > 0);
          }) : -1;
          if (i >= 0) {
            var o = state.outbox.splice(i, 1)[0];
            o.el.classList.remove('pending'); // promoted: server echo confirms delivery
            if (o.statusEl) o.statusEl.remove();
            showDelivered(o, m.created_at); // receipt moves to the newest confirmed bubble
            clearChips(); // the visitor's own send answers any pending offer
            if (m.id) state.seen[m.id] = 1;
            if (m.created_at && (!state.lastTs || m.created_at > state.lastTs)) state.lastTs = m.created_at;
            if (m.created_at && state.open &&
                (!state.lastSeen || m.created_at > state.lastSeen)) {
              state.lastSeen = m.created_at; saveSeen();
            }
            return;
          }
          // Dedup BEFORE the unread check — the poll boundary can re-return
          // a rendered message; it must advance the cursor, not re-count.
          if (m.id && state.seen[m.id]) {
            if (m.created_at && (!state.lastTs || m.created_at > state.lastTs)) {
              state.lastTs = m.created_at;
            }
            return;
          }
          // Unread watermark: non-visitor messages newer than lastSeen count
          // while the panel is closed; while open they just advance it.
          if (m.direction !== 'in' && m.created_at && state.lastSeen &&
              m.created_at > state.lastSeen) {
            // "Unseen" = closed panel OR backgrounded tab — an open panel on
            // a hidden tab still needs the tab-strip signals (title/favicon).
            // Gate is lastSeen (persisted), not seenInit — a refresh re-counts
            // genuinely-unread backlog; only first-ever visits baseline it away.
            if (!state.open || document.hidden) { wantPing = true; state.unread++; }
            else { state.lastSeen = m.created_at; saveSeen(); }
          }
          if (m.direction !== 'in') gotReply = true;
          addMsg(m);
        });
        // First poll seeds the read watermark ONLY for brand-new visitors —
        // a stored lastSeen means messages newer than it are real backlog
        // and were counted above (badge survives refresh; the chime doesn't
        // re-fire for backlog on load).
        var firstPoll = !state.seenInit;
        if (firstPoll) {
          state.seenInit = true;
          if (!state.lastSeen && state.lastTs) { state.lastSeen = state.lastTs; saveSeen(); }
        }
        if (wantPing && !firstPoll) ping();
        if (state.unread > 0) hideTeaser(); // the badge supersedes the teaser
        updateBadge();
        // A pending offer is moot once a human owns the conversation.
        if (state.convState === 'human') clearChips();
        // A fresh reply means whoever was typing stopped — clear both flags
        // outright rather than re-asserting stale ones; a still-typing
        // operator re-marks on their next ping and a working agent re-flags
        // on the next poll.
        if (gotReply) {
          state.opTyping = null;
          state.agentTyping = false;
        } else {
          state.opTyping = d.operator_typing || null;
          state.agentTyping = !!d.agent_typing;
        }
        renderTyping();
      });
    }).catch(function () {
      state.pollBusy = false;
      markLoaded();
      state.fails++;
      if (state.fails >= 2) setConn(true);
    });
    return state.pollPromise;
  }

  function setOpen(open) {
    state.open = open;
    panel.classList.toggle('open', open);
    localStorage.setItem(LS_OPEN, open ? '1' : '0');
    if (open) {
      hideTeaser();
      state.unread = 0;
      if (state.lastTs && (!state.lastSeen || state.lastTs > state.lastSeen)) {
        state.lastSeen = state.lastTs;
        saveSeen();
      }
      updateBadge();
      // The transcript pre-loads while closed — but display:none has no
      // layout, so those scroll calls were no-ops and the panel would open
      // at the oldest message. Snap to the latest once a frame paints.
      state.pinBottom = true;
      hideJump();
      requestAnimationFrame(function () { scrollBottom(); });
      poll();
      if (!state.timer) state.timer = setInterval(poll, 3000);
      // Auto-focus pops the on-screen keyboard on mobile — let them tap in.
      if (typeof matchMedia !== 'function' || !matchMedia('(pointer:coarse)').matches) input.focus();
    }
    else if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }
  bubble.onclick = function () { setOpen(!state.open); };

  // ---- expand -------------------------------------------------------------
  function setExpanded(on) {
    state.expanded = on;
    panel.classList.toggle('expanded', on);
    expandBtn.textContent = on ? '⤡' : '⤢';
    expandBtn.title = on ? 'Shrink' : 'Expand';
    localStorage.setItem(LS_EXPANDED, on ? '1' : '0');
    msgs.scrollTop = msgs.scrollHeight;
  }
  expandBtn.onclick = function () { setExpanded(!state.expanded); };
  if (state.expanded) setExpanded(true);

  // ---- textarea -----------------------------------------------------------
  function autoresize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  }
  // Typing pings — throttled; the console shows "visitor is typing" dots.
  function sendTyping() {
    var now = Date.now();
    if (now - state.lastTypingPing < 2500) return;
    state.lastTypingPing = now;
    fetch(API + '/chat/' + TOKEN + '/typing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitor }),
    }).catch(function () {});
  }
  // Send stays dead until there's text or a finished attachment — an
  // enabled-but-empty button just swallows clicks.
  function syncSend() {
    var ready = 0;
    for (var i = 0; i < state.pending.length; i++) if (!state.pending[i].uploading) ready++;
    sendBtn.disabled = !state.loaded || (!input.value.trim() && ready === 0);
  }
  input.addEventListener('input', function () { autoresize(); sendTyping(); syncSend(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  // ---- dictation ------------------------------------------------------------
  // Two engines, chosen by the channel's dictation_engine setting:
  //   'llm' (default) — MediaRecorder → POST /chat/:token/transcribe
  //     (server-side Gemini→OpenAI). Metered, works in every browser.
  //   'browser' — free client-side Web Speech API. Chrome/Edge only;
  //     the mic stays hidden where SpeechRecognition doesn't exist.
  var micBtn = panel.querySelector('#janis-mic');
  // Hidden until bootstrap confirms the channel opted into dictation (it's a
  // metered Janis charge); canDictate adds the browser-capability check.
  micBtn.style.display = 'none';
  // Gemini's audio input accepts webm/ogg/wav/mp3/aiff/flac — NOT mp4/m4a/aac.
  // Safari's MediaRecorder only emits mp4, so those recordings are decoded
  // through Web Audio and re-uploaded as 16kHz mono WAV (toWav below).
  var dictMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
    .find(function (t) {
      try { return window.MediaRecorder && MediaRecorder.isTypeSupported(t); } catch (e) { return false; }
    });
  var recMime = dictMime || (function () {
    try { return window.MediaRecorder && MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : null; }
    catch (e) { return null; }
  })();
  var canDictate = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
    window.MediaRecorder && window.FormData && recMime);
  // Engine comes from the channel's dictation_engine setting — 'browser'
  // means free client-side Web Speech (Chrome/Edge; the mic hides where
  // unsupported), anything else means metered server transcription that
  // works everywhere. data-janis-stt / ?janis_stt= remain as a debug
  // override (gemini|openai|webspeech).
  var sttOverride = (script.getAttribute('data-janis-stt') ||
    new URLSearchParams(location.search).get('janis_stt') || '').toLowerCase();
  var hasSpeechRec = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  function dictEngine() {
    if (sttOverride === 'gemini' || sttOverride === 'openai' || sttOverride === 'webspeech')
      return sttOverride;
    var e = state.config && state.config.dictation_engine;
    return e === 'browser' ? 'webspeech' : 'auto';
  }
  var speechRec = null;
  function webspeechToggle() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { micNote('Web Speech unavailable in this browser'); return; }
    if (speechRec) { try { speechRec.stop(); } catch (e) {} return; }
    var rec = new SR();
    speechRec = rec;
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = function (e) {
      var said = '';
      for (var i = 0; i < e.results.length; i++) said += e.results[i][0].transcript;
      said = said.trim();
      if (said) {
        input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + said;
        autoresize();
        syncSend();
      } else {
        micNote('Did not catch that — try again');
      }
    };
    rec.onerror = function (e) {
      if (e.error && e.error !== 'aborted')
        micNote(e.error === 'not-allowed' ? 'Microphone access denied' : 'Web Speech failed — try again');
    };
    rec.onend = function () {
      speechRec = null;
      micBtn.classList.remove('on');
      micBtn.setAttribute('aria-label', 'Dictate a message');
    };
    try {
      rec.start();
      micBtn.classList.add('on');
      micBtn.setAttribute('aria-label', 'Stop dictating');
    } catch (e) {
      speechRec = null;
      micNote('Web Speech failed — try again');
    }
  }
  // mp4/aac → 16kHz mono PCM WAV — Gemini reads wav natively.
  function toWav(blob) {
    var AC = window.AudioContext || window.webkitAudioContext;
    var actx = new AC();
    return blob.arrayBuffer()
      .then(function (ab) { return actx.decodeAudioData(ab); })
      .then(function (decoded) {
        var rate = 16000;
        var off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
        var src = off.createBufferSource();
        src.buffer = decoded;
        src.connect(off.destination);
        src.start();
        return off.startRendering();
      })
      .then(function (rendered) {
        actx.close();
        var pcm = rendered.getChannelData(0);
        var out = new Int16Array(pcm.length);
        for (var i = 0; i < pcm.length; i++) {
          var s = Math.max(-1, Math.min(1, pcm[i]));
          out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        var hdr = new DataView(new ArrayBuffer(44));
        var ws = function (o, s) { for (var j = 0; j < s.length; j++) hdr.setUint8(o + j, s.charCodeAt(j)); };
        ws(0, 'RIFF'); hdr.setUint32(4, 36 + out.length * 2, true); ws(8, 'WAVE');
        ws(12, 'fmt '); hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true);
        hdr.setUint16(22, 1, true); hdr.setUint32(24, 16000, true);
        hdr.setUint32(28, 32000, true); hdr.setUint16(32, 2, true); hdr.setUint16(34, 16, true);
        ws(36, 'data'); hdr.setUint32(40, out.length * 2, true);
        return new Blob([hdr.buffer, out.buffer], { type: 'audio/wav' });
      })
      .catch(function (e) { actx.close(); throw e; });
  }
  // Peak RMS while recording — distinguishes "transcribed silence" (dead mic
  // input) from "heard but couldn't parse", which previously looked identical.
  function meterStream(stream) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var actx = new AC();
      var src = actx.createMediaStreamSource(stream);
      var an = actx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      var buf = new Uint8Array(an.fftSize);
      var peak = 0;
      var raf = 0;
      var tick = function () {
        an.getByteTimeDomainData(buf);
        var s = 0;
        for (var i = 0; i < buf.length; i++) { var d = (buf[i] - 128) / 128; s += d * d; }
        var rms = Math.sqrt(s / buf.length);
        if (rms > peak) peak = rms;
        raf = requestAnimationFrame(tick);
      };
      tick();
      return {
        peak: function () { return peak; },
        stop: function () { cancelAnimationFrame(raf); src.disconnect(); void actx.close(); },
      };
    } catch (e) {
      return { peak: function () { return 1; }, stop: function () {} };
    }
  }
  var mediaRec = null;
  var micStream = null;
  var micTimer = null;
  var transcribing = false;
  var basePlaceholder = input.placeholder;
  function micNote(msg) {
    micBtn.classList.add('err');
    micBtn.title = msg;
    setTimeout(function () {
      micBtn.classList.remove('err');
      micBtn.title = 'Dictate';
    }, 3000);
    input.placeholder = msg;
    setTimeout(function () {
      if (input.placeholder === msg) input.placeholder = basePlaceholder;
    }, 4000);
  }
  function stopDictation() {
    if (mediaRec && mediaRec.state !== 'inactive') mediaRec.stop();
  }
  if (canDictate || hasSpeechRec) {
    micBtn.addEventListener('click', function () {
      if (transcribing) return;
      if (dictEngine() === 'webspeech') { webspeechToggle(); return; }
      if (mediaRec) { stopDictation(); return; }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        micStream = stream;
        var chunks = [];
        var meter = meterStream(stream);
        var rec;
        try {
          rec = new MediaRecorder(stream, { mimeType: recMime });
        } catch (e) {
          meter.stop();
          stream.getTracks().forEach(function (t) { t.stop(); });
          micStream = null;
          return;
        }
        mediaRec = rec;
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          mediaRec = null;
          if (micTimer) { clearTimeout(micTimer); micTimer = null; }
          micBtn.classList.remove('on');
          micBtn.setAttribute('aria-label', 'Dictate a message');
          if (micStream) {
            micStream.getTracks().forEach(function (t) { t.stop(); });
            micStream = null;
          }
          var level = meter.peak();
          meter.stop();
          if (!chunks.length) return;
          var blob = new Blob(chunks, { type: chunks[0].type || rec.mimeType || 'audio/webm' });
          if (window.console && console.debug)
            console.debug('[janis] dictation blob', blob.type, blob.size + 'B', 'peak', level.toFixed(3));
          if (level < 0.005) {
            micNote('No sound captured — check your mic input');
            return;
          }
          var up = /mp4|m4a|aac/.test(blob.type)
            ? toWav(blob).then(
                function (w) { return { blob: w, ext: 'wav' }; },
                function () { return { blob: blob, ext: 'm4a' }; },
              )
            : Promise.resolve({ blob: blob, ext: /ogg/.test(blob.type) ? 'ogg' : 'webm' });
          transcribing = true;
          input.placeholder = 'Transcribing…';
          up.then(function (u) {
            var fd = new FormData();
            fd.append('audio', u.blob, 'dictation.' + u.ext);
            var de = dictEngine();
            var engineQ = de === 'gemini' || de === 'openai' ? '?engine=' + de : '';
            return fetch(API + '/chat/' + TOKEN + '/transcribe' + engineQ, { method: 'POST', body: fd });
          })
            .then(function (r) {
              if (!r.ok) return Promise.reject(r.status);
              return r.json();
            })
            .then(function (d) {
              var said = ((d && d.text) || '').trim();
              if (said) {
                input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + said;
                autoresize();
                syncSend();
              } else {
                micNote('Did not catch that — try again');
              }
            })
            .catch(function () { micNote('Transcription failed — try again'); })
            .finally(function () {
              transcribing = false;
              if (input.placeholder === 'Transcribing…') input.placeholder = basePlaceholder;
            });
        };
        rec.start();
        micBtn.classList.add('on');
        micBtn.setAttribute('aria-label', 'Stop dictating');
        // hard cap — keeps a forgotten mic from recording for hours
        micTimer = setTimeout(stopDictation, 90 * 1000);
        input.focus();
      }).catch(function (err) {
        micNote(err && err.name === 'NotAllowedError' ? 'Microphone access denied' : 'No microphone found');
      });
    });
  }

  // ---- emoji --------------------------------------------------------------
  EMOJIS.forEach(function (em) {
    var b = el('button', {}, { type: 'button' });
    b.textContent = em;
    b.onclick = function () {
      var s = input.selectionStart || input.value.length;
      var e2 = input.selectionEnd || s;
      input.setRangeText(em, s, e2, 'end');
      input.focus();
      autoresize();
    };
    emojiGrid.appendChild(b);
  });
  panel.querySelector('#janis-smile').onclick = function () {
    state.emojiOpen = !state.emojiOpen;
    emojiGrid.classList.toggle('open', state.emojiOpen);
  };

  // ---- attachments --------------------------------------------------------
  function renderPending() {
    attachRow.innerHTML = '';
    attachRow.classList.toggle('show', state.pending.length > 0);
    state.pending.forEach(function (a, i) {
      var chip = el('span', {}, { class: 'janis-chip' });
      chip.textContent = (a.uploading ? '⏳ ' : '📎 ') + a.name;
      var x = el('button', {}, { type: 'button', 'aria-label': 'Remove' });
      x.textContent = '×';
      x.onclick = function () { state.pending.splice(i, 1); renderPending(); };
      chip.appendChild(x);
      attachRow.appendChild(chip);
    });
    syncSend();
  }

  panel.querySelector('#janis-clip').onclick = function () { fileInput.click(); };
  fileInput.addEventListener('change', function () {
    var files = Array.prototype.slice.call(fileInput.files || []);
    fileInput.value = '';
    files.forEach(function (f) {
      if (state.pending.length >= 5) return;
      var slot = { name: f.name, uploading: true };
      state.pending.push(slot);
      renderPending();
      var fd = new FormData();
      fd.append('visitor_id', visitor);
      fd.append('file', f);
      fetch(API + '/chat/' + TOKEN + '/uploads', { method: 'POST', body: fd })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (a) {
          if (!a) { state.pending.splice(state.pending.indexOf(slot), 1); renderPending(); return; }
          slot.name = a.name; slot.url = a.url; slot.type = a.type; slot.size = a.size; slot.uploading = false;
          renderPending();
        })
        .catch(function () { state.pending.splice(state.pending.indexOf(slot), 1); renderPending(); });
    });
  });

  // ---- send ---------------------------------------------------------------
  form.onsubmit = function (e) {
    e.preventDefault();
    if (!state.loaded) return;
    var text = input.value.trim();
    var ready = state.pending.filter(function (a) { return !a.uploading; });
    if (!text && ready.length === 0) return;
    clearChips();
    input.value = '';
    autoresize();
    syncSend();
    state.pending = state.pending.filter(function (a) { return a.uploading; });
    renderPending();
    var atts = ready.map(function (a) { return { name: a.name, url: a.url, type: a.type, size: a.size }; });
    var entry = addPending({ visitor_id: visitor, text: text, user: state.user || undefined, attachments: atts }, atts);
    sendPayload(entry);
  };

  // ---- bootstrap ----------------------------------------------------------
  // no-store: branding edits apply on the next page load, not whenever a
  // heuristic cache decides to expire.
  fetch(API + '/chat/' + TOKEN, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
    if (!cfg) return;
    state.config = cfg;
    // Dictation is opt-in per channel (it's metered on Janis's keys) — the
    // mic shows only when bootstrap says the channel enabled it.
    // Browser-engine dictation needs Web Speech (absent on Firefox, patchy
    // on Safari); server dictation needs MediaRecorder capture.
    if (micBtn && cfg.dictation === true && (dictEngine() === 'webspeech' ? hasSpeechRec : canDictate))
      micBtn.style.display = '';
    if (cfg.accent) {
      accent = cfg.accent;
      bubble.style.background = accent;
      document.documentElement.style.setProperty('--janis-accent', accent);
      panel.querySelector('#janis-head').style.background = accent;
    } else {
      document.documentElement.style.setProperty('--janis-accent', accent);
      panel.querySelector('#janis-head').style.background = accent;
    }
    // Corner radius — panel + teaser share the --janis-radius var.
    if (cfg.radius != null)
      document.documentElement.style.setProperty('--janis-radius', cfg.radius + 'px');
    panel.querySelector('#janis-title').textContent = cfg.title || cfg.name || 'Chat';
    panel.querySelector('#janis-sub').textContent =
      cfg.subtitle !== null && cfg.subtitle !== undefined
        ? cfg.subtitle
        : cfg.agent_name
          ? cfg.agent_name + ' · replies in seconds'
          : '';
    if (cfg.logo_url) {
      // Uploaded logos are /uploads/… paths on the API origin, not the host page's.
      var logoSrc = /^https?:\/\//.test(cfg.logo_url) ? cfg.logo_url : API + cfg.logo_url;
      // Logo tile: padding/corner-radius/outline are branding-configurable.
      var logoPad = cfg.logo_padding != null ? cfg.logo_padding : 2;
      var logo = document.createElement('img');
      logo.className = 'janis-logo';
      logo.src = logoSrc;
      logo.alt = '';
      if (cfg.logo_radius != null) logo.style.borderRadius = cfg.logo_radius + 'px';
      logo.style.padding = logoPad + 'px';
      // With an inset the logo floats on the header colour — a white matte
      // would turn the padding into a visible tile. Keep the matte only for
      // edge-to-edge logos (it backs object-fit:contain letterboxing).
      logo.style.background = logoPad > 0 ? 'transparent' : '#fff';
      if (cfg.logo_border_width) {
        logo.style.border = cfg.logo_border_width + 'px solid ' + (cfg.logo_border_color || 'rgba(0,0,0,.2)');
      }
      panel.querySelector('#janis-head').insertBefore(logo, panel.querySelector('#janis-head').firstChild);
      var bub = document.createElement('img');
      bub.src = logoSrc;
      bub.alt = '';
      if (logoPad > 0) {
        // inset the logo inside the accent circle — the accent ring is the pad
        bub.style.width = bub.style.height = 'calc(100% - ' + logoPad * 2 + 'px)';
      }
      bubble.textContent = '';
      bubble.appendChild(bub);
      bubble.appendChild(badgeEl); // textContent='' wiped it — re-attach
    }
    if (cfg.help_url) {
      var helpLink = panel.querySelector('#janis-help');
      helpLink.href = cfg.help_url;
      helpLink.style.display = '';
    }
    // Branding the API chose to send: theme applies to panel + teaser;
    // hide_powered_by only reaches here for paid workspaces.
    var darkQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var applyTheme = function () {
      var dark = cfg.theme === 'dark' || (cfg.theme === 'auto' && darkQ && darkQ.matches);
      panel.classList.toggle('janis-dark', dark);
      var t = document.getElementById('janis-teaser');
      if (t) t.classList.toggle('janis-dark', dark);
    };
    applyTheme();
    if (cfg.theme === 'auto' && darkQ && darkQ.addEventListener) {
      darkQ.addEventListener('change', applyTheme);
    }
    if (cfg.hide_powered_by) {
      var pw = panel.querySelector('#janis-power');
      if (pw) pw.style.display = 'none';
    }
    if (cfg.position === 'left') {
      bubble.classList.add('janis-left');
      panel.classList.add('janis-left');
    }
    // Closed-state poll keeps the unread badge live and pre-warms the
    // transcript so opening renders instantly. 20s is cheap for the host
    // page (one GET per minute-of-three) and well under the API's read cap.
    poll();
    if (!state.closedTimer) {
      state.closedTimer = setInterval(function () { if (!state.open) poll(); }, 20000);
    }
    // Proactive teaser — a card over the launcher nudging first-time
    // visitors; skipped when a thread or unread already exists.
    if (cfg.proactive !== false) {
      setTimeout(maybeTeaser, Math.max(0, cfg.proactive_delay == null ? 20 : cfg.proactive_delay) * 1000);
    }
    if (state.open) setOpen(true);
  }).catch(function () {});
})();
