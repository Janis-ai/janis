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
  };

  // Public API — the embedding site identifies its logged-in user:
  //   Janis.identify({ id, name, email, sig })
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
    'height:480px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;overflow:hidden;' +
    'box-shadow:0 8px 32px rgba(0,0,0,.25);z-index:999999;display:none;flex-direction:column;' +
    'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2937;' +
    'transition:width .15s ease,height .15s ease}' +
    '#janis-panel.open{display:flex}' +
    '#janis-panel.expanded{width:min(680px,calc(100vw - 24px));height:min(760px,calc(100vh - 100px));right:12px;bottom:76px}' +
    '#janis-bubble.janis-left{left:20px;right:auto}' +
    '#janis-panel.janis-left{left:20px;right:auto}' +
    '#janis-panel.janis-left.expanded{left:12px;right:auto}' +
    '#janis-head{padding:12px 16px;color:#fff;font-weight:600;display:flex;align-items:center;gap:8px}' +
    '#janis-head img.janis-logo{width:30px;height:30px;border-radius:50%;object-fit:cover;background:#fff;flex:none}' +
    '#janis-bubble img{width:26px;height:26px;border-radius:50%;object-fit:cover;display:block}' +
    '#janis-head>div{flex:1;min-width:0}' +
    '#janis-head small{display:block;font-weight:400;opacity:.8}' +
    '#janis-expand{background:none;border:none;color:#fff;cursor:pointer;font-size:16px;padding:4px;opacity:.85;line-height:1}' +
    '#janis-expand:hover{opacity:1}' +
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
    '#janis-input{flex:1;border:none;padding:12px 6px;font-size:14px;outline:none;background:#fff;color:#1f2937;' +
    'resize:none;font-family:inherit;line-height:1.35;max-height:110px;overflow-y:auto}' +
    '#janis-send{border:none;align-self:stretch;padding:0 16px;cursor:pointer;color:#fff;font-weight:600;background:var(--janis-accent)}' +
    '#janis-file{display:none}' +
    '#janis-power{text-align:center;font-size:11px;color:#9ca3af;padding:4px;background:#fff}' +
    '.janis-loading{text-align:center;color:#9ca3af;font-size:12px;padding:18px 0}' +
    '#janis-form :disabled{opacity:.55;cursor:default}';
  document.head.appendChild(css);

  // ---- DOM ----------------------------------------------------------------
  var bubble = el('button', { background: accent }, { id: 'janis-bubble', 'aria-label': 'Chat with us' });
  bubble.id = 'janis-bubble';
  bubble.textContent = '💬';
  var panel = el('div', {}, { id: 'janis-panel' });
  panel.innerHTML =
    '<div id="janis-head"><div><span id="janis-title">Chat</span><small id="janis-sub"></small></div>' +
    '<button id="janis-expand" aria-label="Expand chat" title="Expand">⤢</button></div>' +
    '<div id="janis-msgs"></div>' +
    '<div id="janis-attach"></div>' +
    '<div id="janis-emoji"></div>' +
    '<form id="janis-form">' +
    '<button id="janis-clip" class="janis-ico" type="button" aria-label="Attach a file" title="Attach a file">📎</button>' +
    '<button id="janis-smile" class="janis-ico" type="button" aria-label="Emoji" title="Emoji">😊</button>' +
    '<textarea id="janis-input" placeholder="Type a message…" rows="1"></textarea>' +
    '<button id="janis-send" type="submit">Send</button></form>' +
    '<input id="janis-file" type="file" multiple />' +
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

  // ---- transcript loading gate ----------------------------------------------
  // The composer stays disabled until the first poll resolves (or fails) —
  // sending into an unloaded transcript could race the history render.
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
    sendBtn.disabled = false;
    clipBtn.disabled = false;
    smileBtn.disabled = false;
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
      msgs.scrollTop = msgs.scrollHeight;
      return;
    }
    var d = el('div', {}, { class: 'janis-msg out typing' });
    var dots = el('span', {}, { class: 'janis-dots' });
    dots.appendChild(el('span', {}, { class: 'janis-dot' }));
    dots.appendChild(el('span', {}, { class: 'janis-dot' }));
    dots.appendChild(el('span', {}, { class: 'janis-dot' }));
    d.appendChild(dots);
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
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
    if (state.convState === 'human' || state.convState === 'archived') return;
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
    if (m.created_at) d.setAttribute('data-real', '1'); // synthetic greeting stays unmarked
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
      d.appendChild(who);
    }
    if (m.text) {
      var span = document.createElement('span');
      linkify(span, m.text);
      d.appendChild(span);
    }
    (m.attachments || []).forEach(function (a) { addAttachmentNode(d, a); });
    return d;
  }

  function addMsg(m) {
    if (m.id) {
      if (state.seen[m.id]) return;
      state.seen[m.id] = 1;
    }
    if (m.direction !== 'in') hideTyping();
    // A visitor message means any pending prompt was answered — drop the chips.
    if (m.direction === 'in') clearChips();
    var d = buildMsgEl(m);
    msgs.appendChild(d);
    // Per-message tappable choices (e.g. "Yes, get a human" on an offer).
    if (m.direction !== 'in' && m.quick_replies && m.quick_replies.length) {
      renderChips(m.quick_replies);
    }
    if (state.qrsEl) msgs.appendChild(state.qrsEl); // keep chips under the newest bubble
    msgs.scrollTop = msgs.scrollHeight;
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
    }).catch(function () { markFailed(entry); });
  }

  // One 'Delivered' receipt, pinned under the newest confirmed visitor
  // bubble. Cleared the moment a new message starts sending.
  function hideDelivered() {
    if (state.deliveredEl) { state.deliveredEl.remove(); state.deliveredEl = null; }
  }

  function showDelivered(entry) {
    hideDelivered();
    var st = document.createElement('div');
    st.className = 'janis-status';
    st.textContent = 'Delivered';
    entry.el.after(st);
    entry.statusEl = st;
    state.deliveredEl = st;
  }

  // Quick-reply chips — tappable prompt buttons shown under the latest
  // message. Removed permanently once the visitor sends anything.
  function clearChips() {
    if (state.qrsEl) { state.qrsEl.remove(); state.qrsEl = null; }
  }

  function sendText(text) {
    var entry = addPending({ visitor_id: visitor, text: text, user: state.user || undefined, attachments: [] }, []);
    sendPayload(entry);
  }

  function renderChips(list) {
    clearChips();
    var row = el('div', {}, { class: 'janis-qrs' });
    list.forEach(function (q) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'janis-qr';
      b.textContent = q;
      b.onclick = function () { clearChips(); sendText(q); };
      row.appendChild(b);
    });
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
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
        if (!d) return;
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
        if (d.has_more !== undefined) state.hasMore = d.has_more;
        if (!state.greeted) {
          // first poll resolved — only kick off the greeting once we know the
          // transcript is actually empty, so history doesn't get a greeting header
          state.greeted = true;
          if (!d.messages.length && !state.outbox.length) {
            if (state.config && state.config.greeting) {
              addMsg({ direction: 'out', text: state.config.greeting, created_at: null });
            }
            if (state.config && state.config.quick_replies && state.config.quick_replies.length) {
              renderChips(state.config.quick_replies);
            }
          }
        }
        var gotReply = false;
        d.messages.forEach(function (m) {
          var i = m.direction === 'in' ? state.outbox.findIndex(function (o) {
            return o.text === m.text ||
              (o.payload.attachments.length > 0 && (m.attachments || []).length > 0);
          }) : -1;
          if (i >= 0) {
            var o = state.outbox.splice(i, 1)[0];
            o.el.classList.remove('pending'); // promoted: server echo confirms delivery
            if (o.statusEl) o.statusEl.remove();
            showDelivered(o); // receipt moves to the newest confirmed bubble
            if (m.id) state.seen[m.id] = 1;
            if (m.created_at && (!state.lastTs || m.created_at > state.lastTs)) state.lastTs = m.created_at;
            return;
          }
          if (m.direction !== 'in') gotReply = true;
          addMsg(m);
        });
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
    }).catch(function () { state.pollBusy = false; markLoaded(); });
    return state.pollPromise;
  }

  function setOpen(open) {
    state.open = open;
    panel.classList.toggle('open', open);
    localStorage.setItem(LS_OPEN, open ? '1' : '0');
    if (open) { poll(); if (!state.timer) state.timer = setInterval(poll, 3000); input.focus(); }
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
  input.addEventListener('input', function () { autoresize(); sendTyping(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

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
    state.pending = state.pending.filter(function (a) { return a.uploading; });
    renderPending();
    var atts = ready.map(function (a) { return { name: a.name, url: a.url, type: a.type, size: a.size }; });
    var entry = addPending({ visitor_id: visitor, text: text, user: state.user || undefined, attachments: atts }, atts);
    sendPayload(entry);
  };

  // ---- bootstrap ----------------------------------------------------------
  fetch(API + '/chat/' + TOKEN).then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
    if (!cfg) return;
    state.config = cfg;
    if (cfg.accent) {
      accent = cfg.accent;
      bubble.style.background = accent;
      document.documentElement.style.setProperty('--janis-accent', accent);
      panel.querySelector('#janis-head').style.background = accent;
    } else {
      document.documentElement.style.setProperty('--janis-accent', accent);
      panel.querySelector('#janis-head').style.background = accent;
    }
    panel.querySelector('#janis-title').textContent = cfg.title || cfg.name || 'Chat';
    panel.querySelector('#janis-sub').textContent =
      cfg.subtitle !== null && cfg.subtitle !== undefined
        ? cfg.subtitle
        : cfg.agent_name
          ? cfg.agent_name + ' · replies in seconds'
          : '';
    if (cfg.logo_url) {
      var logo = document.createElement('img');
      logo.className = 'janis-logo';
      logo.src = cfg.logo_url;
      logo.alt = '';
      panel.querySelector('#janis-head').insertBefore(logo, panel.querySelector('#janis-head').firstChild);
      var bub = document.createElement('img');
      bub.src = cfg.logo_url;
      bub.alt = '';
      bubble.textContent = '';
      bubble.appendChild(bub);
    }
    if (cfg.position === 'left') {
      bubble.classList.add('janis-left');
      panel.classList.add('janis-left');
    }
    if (state.open) setOpen(true);
  }).catch(function () {});
})();
