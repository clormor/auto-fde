(() => {
  if (window.__autoFde) { window.__autoFde.show(); return; }

  // background.js writes this onto the page immediately before injecting this
  // file. A MAIN-world script cannot read chrome.storage itself, so the origins
  // the user configured have to arrive this way. Checking them again here is
  // defence in depth: background.js has already gated on the same values, and
  // this catches the script being run by hand against the wrong page.
  const config = window.__autoFdeConfig;
  if (!config || !Array.isArray(config.origins) || !config.pathMarker) {
    console.warn('[Auto FDE] No configuration on the page \u2014 aborting.');
    return;
  }
  if (!config.origins.includes(location.origin)) {
    console.warn('[Auto FDE] ' + location.origin + ' is not a configured base URL \u2014 aborting.');
    return;
  }
  if (!location.pathname.includes(config.pathMarker)) {
    console.warn('[Auto FDE] Not an AI FDE session page \u2014 aborting.');
    return;
  }

  const TARGET_LABELS = ['allow', 'allow once'];
  const BLOCK_SUBSTRINGS = ['always', 'all future', 'forever', 'delete', 'force', 'production', 'deny'];

  const CATEGORIES = [
    { id: 'read',   label: 'Read-only actions',      enabled: true,  match: t => /read|view|preview|list/i.test(t) },
    { id: 'write',  label: 'Write / edit actions',    enabled: true,  match: t => /write|edit|update|create/i.test(t) },
    { id: 'deploy', label: 'Deploy / build actions',  enabled: false, match: t => /deploy|build|publish|run/i.test(t) },
    { id: 'other',  label: 'Unclassified',            enabled: true,  match: () => true },
  ];
  function categoryFor(btn) {
    const container = btn.closest('[role="dialog"], [role="alertdialog"], .dialog, .modal') || btn.parentElement;
    const context = (container?.innerText || '').slice(0, 400);
    return CATEGORIES.find(c => c.match(context)) || CATEGORIES[CATEGORIES.length - 1];
  }

  const clicked = new WeakSet();
  let active = true, count = 0;

  // The panel sits over somebody's work, so it is capped rather than allowed to
  // grow with the click count: the log holds the most recent LOG_LIMIT entries
  // and nothing older. The running total lives in the counter, which does not
  // change size.
  const LOG_LIMIT = 10;
  const log = [];

  // ---------- Keep-alive ----------
  // On by default, because a tab left in the background is the whole point and
  // Chrome's intensive throttling is what defeats it.
  //
  // The catch: an AudioContext created without a user gesture starts suspended,
  // and this script is injected by a toolbar press, which does not give the page
  // one. So the box starts ticked and the audio starts for real on the first
  // click or keypress anywhere on the page. The panel says which of those two
  // states it is in, because a ticked box that is quietly doing nothing is worse
  // than an unticked one.
  const GESTURE_EVENTS = ['pointerdown', 'keydown'];
  let audioCtx = null, keepAliveOn = false, awaitingGesture = false;

  function startKeepAlive() {
    if (keepAliveOn) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.001;
    osc.frequency.value = 20000;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    audioCtx.__osc = osc;
    keepAliveOn = true;
    settleKeepAlive();
  }

  function settleKeepAlive() {
    if (!audioCtx) return;
    audioCtx.resume()
      .then(() => {
        if (keepAliveOn && audioCtx && audioCtx.state === 'running') reportKeepAlive('On');
        else armGesture();
      })
      .catch(armGesture);
  }

  function armGesture() {
    if (!keepAliveOn) return;
    reportKeepAlive('starts on your next click');
    if (awaitingGesture) return;
    awaitingGesture = true;
    const onGesture = () => {
      GESTURE_EVENTS.forEach(e => window.removeEventListener(e, onGesture, true));
      awaitingGesture = false;
      if (keepAliveOn) settleKeepAlive();
    };
    GESTURE_EVENTS.forEach(e => window.addEventListener(e, onGesture, true));
  }

  function stopKeepAlive() {
    if (!keepAliveOn) return;
    audioCtx.__osc.stop();
    audioCtx.close();
    audioCtx = null;
    keepAliveOn = false;
    reportKeepAlive('Off');
  }

  // ---------- Network-error auto-resume ----------
  let autoResumeEnabled = false;
  let recovering = false;
  const RESUME_TEXT = 'resume after network error';

  const NETWORK_PATTERNS = [
    /network error/i,
    /"type"\s*:\s*"NETWORK"/,
    /ConjureError/i,
  ];
  function findErrorBanner() {
    return Array.from(document.querySelectorAll('.bp6-callout-intent-danger'))
      .find(el => NETWORK_PATTERNS.some(re => re.test(el.textContent || '')));
  }

  function findSendButton() { return document.querySelector('button[aria-label="Send message"]'); }
  function findFallbackTextarea() {
    return Array.from(document.querySelectorAll('textarea'))
      .find(t => /rich prompt editor is unavailable/i.test(t.placeholder || ''));
  }
  function findRichInput() {
    return document.querySelector('[role="combobox"][contenteditable="true"]');
  }

  function setTextareaValue(el, text) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function pasteIntoRichInput(el, text) {
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    el.dispatchEvent(pasteEvent);
  }

  function sendResumeMessage() {
    const sendBtn = findSendButton();
    if (!sendBtn) { console.warn('[Auto FDE] Could not locate send button.'); return false; }

    const textarea = findFallbackTextarea();
    if (textarea) {
      setTextareaValue(textarea, RESUME_TEXT);
    } else {
      const rich = findRichInput();
      if (!rich) { console.warn('[Auto FDE] Could not locate any chat input.'); return false; }
      pasteIntoRichInput(rich, RESUME_TEXT);
    }
    setTimeout(() => { sendBtn.click(); recordResume(); }, 300);
    return true;
  }

  async function probeOnce() {
    try {
      const res = await fetch(location.origin + '/favicon.ico', { method: 'HEAD', cache: 'no-store' });
      return res.ok || res.status < 500;
    } catch { return false; }
  }
  async function waitForStableConnection({ startDelay = 1000, maxDelay = 30000, requiredSuccesses = 2 } = {}) {
    let delay = startDelay, successes = 0;
    while (recovering) {
      await new Promise(r => setTimeout(r, delay));
      if (!recovering) return false;
      const ok = await probeOnce();
      if (ok) { successes++; if (successes >= requiredSuccesses) return true; }
      else { successes = 0; delay = Math.min(delay * 2, maxDelay); }
    }
    return false;
  }
  async function handleErrorBanner() {
    if (recovering || !autoResumeEnabled) return;
    recovering = true;
    updateResumeStatus('Recovering…', '#facc15');
    const stable = await waitForStableConnection();
    if (!recovering) { updateResumeStatus(autoResumeEnabled ? 'Watching' : 'OFF', autoResumeEnabled ? '#4ade80' : '#888'); return; }
    if (stable) {
      const ok = sendResumeMessage();
      updateResumeStatus(ok ? 'Watching' : 'Failed to send', ok ? '#4ade80' : '#f87171');
    }
    recovering = false;
  }

  // ---------- UI panel ----------
  // The panel lives in a shadow root. It is injected into somebody else's
  // application, so isolation cuts both ways: Foundry ships Blueprint, which
  // styles bare button and input elements, and nothing here should leak back out
  // into their stylesheet either.
  const host = document.createElement('div');
  host.id = 'af-host';
  host.style.cssText = 'all:initial;display:block;position:fixed;bottom:16px;right:16px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  // The mark. A bare AI FDE diamond was too close to AI FDE's own icon, which
  // made the panel look like part of the product rather than something clicking
  // through it. The diamond shrinks to a reference and the loop around it, which
  // is the thing this tool actually does, carries the identity.
  const DIAMOND = `
    <svg class="mark" viewBox="0 0 16 16" aria-hidden="true">
      <defs>
        <linearGradient id="af-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#f2a3d6"/>
          <stop offset=".5" stop-color="#a98ce8"/>
          <stop offset="1" stop-color="#5cc6f2"/>
        </linearGradient>
      </defs>
      <path d="M12.11 3.10 A 6.4 6.4 0 1 1 6.34 1.82" fill="none" stroke="url(#af-grad)"
        stroke-width="1.7" stroke-linecap="round"/>
      <path d="M8.85 1.15 6.73 3.27 5.95 0.37Z" fill="url(#af-grad)"/>
      <path d="M8 4 12 8 8 12 4 8Z" fill="url(#af-grad)"/>
      <path d="M8 4 12 8 8 8Z" fill="#fff" opacity=".30"/>
    </svg>`;

  const CHEVRON = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"
    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
    stroke-linejoin="round"/></svg>`;

  // Standard transport glyphs, so nobody has to read a label to know what they do.
  const PAUSE = `<svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="4" y="3" width="3" height="10" rx="1.1"/><rect x="9" y="3" width="3" height="10" rx="1.1"/></svg>`;
  const PLAY = `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5 3.3 12.6 8 5 12.7Z"/></svg>`;
  const STOP = `<svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.7"/></svg>`;

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .panel {
        width: 296px;
        max-height: calc(100vh - 32px);
        overflow: auto;
        /* Translucent, so the page underneath stays partly readable. The blur is
           what keeps the text on top legible over whatever it happens to cover. */
        background: rgba(23, 27, 33, .38);
        -webkit-backdrop-filter: blur(12px) saturate(1.4);
        backdrop-filter: blur(12px) saturate(1.4);
        color: #f2f4f8;
        font: 400 12.5px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
              "Helvetica Neue", system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
        /* At this level of transparency the panel picks up whatever is behind it,
           so the secondary text needs the shadow to survive a light background.
           On Foundry's own dark chrome it is invisible. */
        text-shadow: 0 1px 2px rgba(0, 0, 0, .55);
        border: 1px solid rgba(255,255,255,.10);
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,.5);
      }

      .hd {
        display: flex; align-items: center; gap: 8px;
        padding: 9px 8px 9px 11px;
        cursor: move; user-select: none;
      }
      .mark { width: 15px; height: 15px; flex: 0 0 auto; display: block; }
      .name { font-weight: 600; letter-spacing: .005em; }
      .count {
        font-variant-numeric: tabular-nums;
        font-size: 11px; font-weight: 600;
        padding: 1px 6px; border-radius: 999px;
        background: rgba(255,255,255,.10); color: #ccd2dc;
      }
      /* The controls sit in the header so they still work when collapsed. */
      .ctl { margin-left: auto; display: flex; align-items: center; gap: 2px; }
      .icon {
        flex: 0 0 auto; display: grid; place-items: center;
        width: 23px; height: 23px; padding: 0;
        background: none; border: 0; border-radius: 6px;
        cursor: pointer; color: #8b93a1;
      }
      .icon:hover { background: rgba(255,255,255,.14); }
      .icon svg { width: 13px; height: 13px; display: block; fill: currentColor;
        filter: drop-shadow(0 1px 1px rgba(0,0,0,.5)); }

      /* The glyph says what pressing it does; the colour says what it is doing
         now. Green pausing, amber waiting to be started again. */
      #af-toggle[data-state="active"] { color: #4ade80; }
      #af-toggle[data-state="paused"] { color: #fbbf24; background: rgba(251,191,36,.12); }
      #af-stop { color: #f0908f; }
      #af-stop:hover { background: rgba(248,113,113,.16); }

      .chev { color: #9aa3b1; transition: transform .15s ease; }
      .chev svg { width: 12px; height: 12px; fill: none; }

      .sec { padding: 8px 11px; border-top: 1px solid rgba(255,255,255,.07); }
      .cap {
        display: flex; align-items: baseline; gap: 7px;
        font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
        color: #9aa3b1; margin-bottom: 6px;
      }
      .cap .hint { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 11px; }

      label.row { display: flex; align-items: center; gap: 8px; padding: 2.5px 0; cursor: pointer; }
      label.row:hover { color: #fff; }
      input[type=checkbox] {
        width: 13px; height: 13px; margin: 0; flex: 0 0 auto;
        accent-color: #4ade80; cursor: pointer;
      }
      .hint { color: #99a2b0; font-size: 11px; }
      .hint b { color: #dbe0e8; font-weight: 600; }

      .log { max-height: 112px; overflow: auto; }
      .log .line {
        display: flex; gap: 8px; align-items: baseline;
        padding: 1.5px 0; color: #bcc3ce;
      }
      .log .t { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: #949cab; font-size: 11px; }
      .log .w { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .log .none { color: #949cab; font-style: italic; }

      .panel[data-collapsed] .body { display: none; }
      .panel[data-collapsed] .chev { transform: rotate(-90deg); }
    </style>

    <div class="panel" id="af-panel">
      <div class="hd" id="af-header">
        ${DIAMOND}
        <span class="name">Auto FDE</span>
        <span class="count" id="af-count" title="Prompts allowed">0</span>
        <span class="ctl">
          <button class="icon" id="af-toggle" type="button" data-state="active"
                  aria-label="Pause" title="Pause">${PAUSE}</button>
          <button class="icon" id="af-stop" type="button"
                  aria-label="Stop" title="Stop">${STOP}</button>
          <button class="icon chev" id="af-collapse" type="button"
                  aria-label="Collapse" title="Collapse">${CHEVRON}</button>
        </span>
      </div>

      <div class="body" id="af-body">
        <div class="sec">
          <div class="cap">Prompts to allow</div>
          <div id="af-cats"></div>
        </div>

        <div class="sec">
          <div class="cap">Settings</div>
          <label class="row">
            <input type="checkbox" id="af-keepalive" checked>
            <span>Keep the tab awake</span>
          </label>
          <div class="hint">Inaudible audio stops Chrome throttling this tab.
            <b id="af-keepalive-status">Off</b></div>
          <label class="row" style="margin-top:5px">
            <input type="checkbox" id="af-resume-toggle">
            <span>Automatically resume after a network error</span>
          </label>
          <div class="hint">Resends the last message once the connection is back.
            <b id="af-resume-status">Off</b></div>
        </div>

        <div class="sec">
          <div class="cap">Recent <span class="hint">last <span id="af-log-limit"></span></span></div>
          <div class="log" id="af-log"></div>
        </div>

      </div>
    </div>`;

  const panel = shadow.querySelector('#af-panel');
  const header = shadow.querySelector('#af-header');
  const catsEl = shadow.querySelector('#af-cats');
  const countEl = shadow.querySelector('#af-count');
  const logEl = shadow.querySelector('#af-log');
  const resumeStatusEl = shadow.querySelector('#af-resume-status');
  const toggleBtn = shadow.querySelector('#af-toggle');
  const stopBtn = shadow.querySelector('#af-stop');
  const collapseBtn = shadow.querySelector('#af-collapse');


  shadow.querySelector('#af-log-limit').textContent = LOG_LIMIT;

  CATEGORIES.forEach(c => {
    const row = document.createElement('label');
    row.className = 'row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = c.enabled;
    box.dataset.cat = c.id;
    box.onchange = e => { c.enabled = e.target.checked; };
    const text = document.createElement('span');
    text.textContent = c.label;
    row.append(box, text);
    catsEl.appendChild(row);
  });

  const keepAliveStatusEl = shadow.querySelector('#af-keepalive-status');
  function reportKeepAlive(text) { keepAliveStatusEl.textContent = text; }

  const keepAliveBox = shadow.querySelector('#af-keepalive');
  keepAliveBox.onchange = e => {
    e.target.checked ? startKeepAlive() : stopKeepAlive();
  };
  if (keepAliveBox.checked) startKeepAlive();

  function updateResumeStatus(text, color) {
    resumeStatusEl.textContent = text;
    resumeStatusEl.style.color = color;
  }

  shadow.querySelector('#af-resume-toggle').onchange = e => {
    autoResumeEnabled = e.target.checked;
    updateResumeStatus(autoResumeEnabled ? 'Watching' : 'Off', autoResumeEnabled ? '#4ade80' : '#7d8593');
    if (!autoResumeEnabled) recovering = false;
  };

  // ---------- Collapse ----------
  // Collapsed keeps the header, which carries the count and the active state, so
  // the panel is still worth glancing at when it is out of the way.
  function setCollapsed(collapsed) {
    if (collapsed) panel.setAttribute('data-collapsed', '');
    else panel.removeAttribute('data-collapsed');
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
    collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    try {
      localStorage.setItem('__autoFdeCollapsed', collapsed ? '1' : '0');
    } catch {}
  }
  collapseBtn.onclick = () => setCollapsed(!panel.hasAttribute('data-collapsed'));
  // Dragging is on the header, and the chevron sits inside it.
  collapseBtn.addEventListener('mousedown', e => e.stopPropagation());
  try {
    setCollapsed(localStorage.getItem('__autoFdeCollapsed') === '1');
  } catch {}

  // Log lines quote text taken off the page's own buttons, so they are written as
  // text nodes rather than innerHTML. A button labelled with angle brackets would
  // otherwise inject markup into this panel.
  function appendLog(time, what) {
    log.unshift({ time, what });
    log.length = Math.min(log.length, LOG_LIMIT);
    logEl.replaceChildren(...log.map(entry => {
      const row = document.createElement('div');
      row.className = 'line';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = entry.time;
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = entry.what;
      row.append(t, w);
      return row;
    }));
  }
  function renderEmptyLog() {
    const row = document.createElement('div');
    row.className = 'none';
    row.textContent = 'Nothing yet.';
    logEl.replaceChildren(row);
  }
  renderEmptyLog();

  function record(text, cat) {
    count++; countEl.textContent = count;
    const t = new Date().toLocaleTimeString();
    appendLog(t, `${text} · ${cat}`);
    console.log(`[Auto FDE] ${t} — [${cat}] clicked "${text}"`);
  }
  function recordResume() {
    const t = new Date().toLocaleTimeString();
    appendLog(t, `sent "${RESUME_TEXT}"`);
    console.log(`[Auto FDE] ${t} — auto-sent resume message`);
  }

  function scan() {
    if (active) {
      document.querySelectorAll('button').forEach(btn => {
        if (clicked.has(btn) || btn.disabled) return;
        const text = (btn.innerText || btn.getAttribute('aria-label') || '').trim().toLowerCase();
        if (!text || !TARGET_LABELS.includes(text)) return;
        if (BLOCK_SUBSTRINGS.some(b => text.includes(b))) return;
        const cat = categoryFor(btn);
        if (!cat.enabled) return;

        // The click is not deferred, and must not be. Chrome throttles timers in
        // a hidden tab to once a second, and to once a minute once the tab has
        // been hidden for five, so putting the click behind a setTimeout meant
        // approvals sat there untouched while the tab was in the background and
        // then all fired at once the moment it was looked at. MutationObserver
        // callbacks are not throttled, so clicking from inside this one works
        // whether or not anyone is watching.
        clicked.add(btn);
        const label = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
        btn.style.outline = '2px solid #4ade80';
        btn.click();
        record(label, cat.id);
      });
    }
    if (autoResumeEnabled && !recovering && findErrorBanner()) handleErrorBanner();
  }

  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });
  scan();

  // Backstop for a prompt that somehow arrives without a mutation this observer
  // sees. This one is a timer, so it is throttled in a hidden tab, which is
  // exactly why it is only the backstop and not the mechanism.
  const backstop = setInterval(scan, 2000);

  toggleBtn.onclick = () => {
    active = !active;
    toggleBtn.dataset.state = active ? 'active' : 'paused';
    toggleBtn.innerHTML = active ? PAUSE : PLAY;
    toggleBtn.setAttribute('aria-label', active ? 'Pause' : 'Resume');
    toggleBtn.title = active ? 'Pause' : 'Resume';
    if (active) scan();
  };

  stopBtn.onclick = () => {
    observer.disconnect();
    clearInterval(backstop);
    stopKeepAlive();
    recovering = false;
    host.remove();
    delete window.__autoFde;
    console.log('[Auto FDE] Stopped. Press the toolbar button to start again.');
  };

  // ---------- Draggable panel ----------
  // The host element is what carries the position, so that is what moves.
  try {
    const saved = JSON.parse(localStorage.getItem('__autoFdePos') || 'null');
    if (saved) {
      host.style.left = saved.left + 'px';
      host.style.top = saved.top + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    }
  } catch {}

  let dragging = false, dragOffsetX = 0, dragOffsetY = 0;
  header.addEventListener('mousedown', e => {
    dragging = true;
    const rect = host.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.left = rect.left + 'px';
    host.style.top = rect.top + 'px';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    let left = e.clientX - dragOffsetX;
    let top = e.clientY - dragOffsetY;
    left = Math.max(0, Math.min(left, window.innerWidth - host.offsetWidth));
    top = Math.max(0, Math.min(top, window.innerHeight - host.offsetHeight));
    host.style.left = left + 'px';
    host.style.top = top + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    localStorage.setItem('__autoFdePos', JSON.stringify({
      left: parseFloat(host.style.left),
      top: parseFloat(host.style.top),
    }));
  });

  window.__autoFde = { show: () => { host.style.display = 'block'; }, stop: () => stopBtn.click() };
  console.log('[Auto FDE] Running on', location.href);
})();
