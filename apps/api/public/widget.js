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
    convState: 'agent',
    emojiOpen: false,
  };

  var EMOJIS = ('😀 😄 😁 🙂 😉 😊 😍 🤩 😘 😜 🤪 😎 🤔 😅 😂 🤣 😢 😭 😮 😴' +
    ' 👍 👎 🙏 👏 🙌 🤝 💪 ✌️ 🤞 👋 👀 💬 ❤️ 💚 💙 💜 🖤 🤍 💯 ✅ 🎉 🔥 ⭐ 💡 📎 ❓').split(' ');

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
    '.janis-msg{max-width:80%;padding:8px 12px;border-radius:12px;line-height:1.4;word-wrap:break-word;white-space:pre-wrap}' +
    '.janis-msg.in{align-self:flex-end;background:var(--janis-accent);color:#fff;border-bottom-right-radius:4px}' +
    '.janis-msg.out,.janis-msg.human{align-self:flex-start;background:#e5e7eb;color:#1f2937;border-bottom-left-radius:4px}' +
    '.janis-msg.human{background:#dbeafe}' +
    '.janis-msg.typing{display:inline-flex;gap:4px;align-items:center;padding:12px 14px}' +
    '.janis-dot{width:6px;height:6px;border-radius:50%;background:#9ca3af;animation:janis-blink 1.2s infinite ease-in-out}' +
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
    '#janis-power{text-align:center;font-size:11px;color:#9ca3af;padding:4px;background:#fff}';
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

  // Typing indicator — shown after the server receives a visitor message,
  // cleared when an agent/human reply lands (or a safety timeout fires).
  function hideTyping() {
    if (state.typingEl) { state.typingEl.remove(); state.typingEl = null; }
    if (state.typingTimer) { clearTimeout(state.typingTimer); state.typingTimer = null; }
  }

  function showTyping() {
    if (state.typingEl || state.convState === 'human' || state.convState === 'archived') return;
    var d = el('div', {}, { class: 'janis-msg out typing' });
    d.appendChild(el('span', {}, { class: 'janis-dot' }));
    d.appendChild(el('span', {}, { class: 'janis-dot' }));
    d.appendChild(el('span', {}, { class: 'janis-dot' }));
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    state.typingEl = d;
    state.typingTimer = setTimeout(hideTyping, 45000);
  }

  function addMsg(m) {
    if (m.id) {
      if (state.seen[m.id]) return;
      state.seen[m.id] = 1;
    }
    if (m.direction !== 'in') hideTyping();
    var d = el('div', {}, { class: 'janis-msg ' + m.direction });
    d.className = 'janis-msg ' + (m.direction === 'in' ? 'in' : m.direction === 'human' ? 'human' : 'out');
    if (m.text) {
      var span = document.createElement('span');
      span.textContent = m.text;
      d.appendChild(span);
    }
    (m.attachments || []).forEach(function (a) { addAttachmentNode(d, a); });
    msgs.appendChild(d);
    if (state.qrsEl) msgs.appendChild(state.qrsEl); // keep chips under the newest bubble
    msgs.scrollTop = msgs.scrollHeight;
    if (m.created_at && (!state.lastTs || m.created_at > state.lastTs)) state.lastTs = m.created_at;
    return d;
  }

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
    var entry = addPending({ visitor_id: visitor, text: text, attachments: [] }, []);
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
    var url = API + '/chat/' + TOKEN + '/messages?visitor_id=' + encodeURIComponent(visitor);
    if (state.lastTs) url += '&after=' + encodeURIComponent(state.lastTs);
    state.pollPromise = fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      state.pollBusy = false;
      if (!d) return;
      state.convState = d.state;
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
        addMsg(m);
      });
    }).catch(function () { state.pollBusy = false; });
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
  input.addEventListener('input', autoresize);
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
    var text = input.value.trim();
    var ready = state.pending.filter(function (a) { return !a.uploading; });
    if (!text && ready.length === 0) return;
    clearChips();
    input.value = '';
    autoresize();
    state.pending = state.pending.filter(function (a) { return a.uploading; });
    renderPending();
    var atts = ready.map(function (a) { return { name: a.name, url: a.url, type: a.type, size: a.size }; });
    var entry = addPending({ visitor_id: visitor, text: text, attachments: atts }, atts);
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
    if (cfg.greeting) addMsg({ direction: 'out', text: cfg.greeting, created_at: null });
    if (cfg.quick_replies && cfg.quick_replies.length) renderChips(cfg.quick_replies);
    if (state.open) setOpen(true);
  }).catch(function () {});
})();
