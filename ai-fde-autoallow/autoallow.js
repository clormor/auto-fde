(() => {
  if (window.__aiFdeAutoAllow) { window.__aiFdeAutoAllow.show(); return; }
  if (!location.hostname.includes('palantirfoundry.com') || !location.pathname.includes('/ai-fde/')) {
    console.warn('[AutoAllow] Not an AI FDE session page — aborting.');
    return;
  }

  const TARGET_LABELS = ['allow', 'allow once'];
  const BLOCK_SUBSTRINGS = ['always', 'all future', 'forever', 'delete', 'force', 'production', 'deny'];

  const CATEGORIES = [
    { id: 'read',   label: 'Read-only actions',      enabled: true,  match: t => /read|view|preview|list/i.test(t) },
    { id: 'write',  label: 'Write / edit actions',    enabled: true,  match: t => /write|edit|update|create/i.test(t) },
    { id: 'deploy', label: 'Deploy / build actions',  enabled: false, match: t => /deploy|build|publish|run/i.test(t) },
    { id: 'other',  label: 'Uncategorized',           enabled: true,  match: () => true },
  ];
  function categoryFor(btn) {
    const container = btn.closest('[role="dialog"], [role="alertdialog"], .dialog, .modal') || btn.parentElement;
    const context = (container?.innerText || '').slice(0, 400);
    return CATEGORIES.find(c => c.match(context)) || CATEGORIES[CATEGORIES.length - 1];
  }

  const clicked = new WeakSet();
  let active = true, count = 0;
  const log = [];

  // ---------- Keep-alive ----------
  let audioCtx = null, keepAliveOn = false;
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
  }
  function stopKeepAlive() {
    if (!keepAliveOn) return;
    audioCtx.__osc.stop();
    audioCtx.close();
    keepAliveOn = false;
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
    if (!sendBtn) { console.warn('[AutoAllow] Could not locate send button.'); return false; }

    const textarea = findFallbackTextarea();
    if (textarea) {
      setTextareaValue(textarea, RESUME_TEXT);
    } else {
      const rich = findRichInput();
      if (!rich) { console.warn('[AutoAllow] Could not locate any chat input.'); return false; }
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
  const panel = document.createElement('div');
  panel.style.cssText = `position:fixed;bottom:16px;right:16px;z-index:999999;
    background:#111;color:#fff;font:12px/1.4 monospace;padding:10px 12px;
    border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.4);width:280px;`;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <b>AutoAllow</b><span id="aa-status" style="color:#4ade80;">ACTIVE</span>
    </div>
    <div>Clicked: <span id="aa-count">0</span></div>
    <div id="aa-cats" style="margin:6px 0;border-top:1px solid #333;padding-top:6px;"></div>
    <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
      <input type="checkbox" id="aa-keepalive"> Keep tab alive (silent audio)
    </label>
    <div style="border-top:1px solid #333;margin:6px 0;padding-top:6px;">
      <label style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" id="aa-resume-toggle"> Auto-resume after network error
      </label>
      <div style="opacity:.8;">Resume status: <span id="aa-resume-status">OFF</span></div>
    </div>
    <div id="aa-log" style="max-height:80px;overflow:auto;margin:6px 0;opacity:.8;"></div>
    <button id="aa-toggle" style="width:100%;margin-bottom:4px;">Pause</button>
    <button id="aa-stop" style="width:100%;">Stop &amp; Remove</button>
  `;
  document.body.appendChild(panel);

  const catsEl = panel.querySelector('#aa-cats');
  CATEGORIES.forEach(c => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';
    row.innerHTML = `<input type="checkbox" ${c.enabled ? 'checked' : ''} data-cat="${c.id}"> ${c.label}`;
    row.querySelector('input').onchange = e => { c.enabled = e.target.checked; };
    catsEl.appendChild(row);
  });

  panel.querySelector('#aa-keepalive').onchange = e => { e.target.checked ? startKeepAlive() : stopKeepAlive(); };

  const statusEl = panel.querySelector('#aa-status');
  const countEl = panel.querySelector('#aa-count');
  const logEl = panel.querySelector('#aa-log');
  const resumeStatusEl = panel.querySelector('#aa-resume-status');
  function updateResumeStatus(text, color) { resumeStatusEl.textContent = text; resumeStatusEl.style.color = color; }

  panel.querySelector('#aa-resume-toggle').onchange = e => {
    autoResumeEnabled = e.target.checked;
    updateResumeStatus(autoResumeEnabled ? 'Watching' : 'OFF', autoResumeEnabled ? '#4ade80' : '#888');
    if (!autoResumeEnabled) recovering = false;
  };

  function record(text, cat) {
    count++; countEl.textContent = count;
    const t = new Date().toLocaleTimeString();
    log.unshift(`${t} — [${cat}] "${text}"`);
    logEl.innerHTML = log.slice(0, 5).map(l => `<div>${l}</div>`).join('');
    console.log(`[AutoAllow] ${t} — [${cat}] clicked "${text}"`);
  }
  function recordResume() {
    const t = new Date().toLocaleTimeString();
    log.unshift(`${t} — sent "${RESUME_TEXT}"`);
    logEl.innerHTML = log.slice(0, 5).map(l => `<div>${l}</div>`).join('');
    console.log(`[AutoAllow] ${t} — auto-sent resume message`);
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
        clicked.add(btn);
        btn.style.outline = '2px solid #4ade80';
        setTimeout(() => { if (active) { btn.click(); record(btn.innerText.trim(), cat.id); } }, 300);
      });
    }
    if (autoResumeEnabled && !recovering && findErrorBanner()) handleErrorBanner();
  }

  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });
  scan();

  panel.querySelector('#aa-toggle').onclick = () => {
    active = !active;
    statusEl.textContent = active ? 'ACTIVE' : 'PAUSED';
    statusEl.style.color = active ? '#4ade80' : '#facc15';
    panel.querySelector('#aa-toggle').textContent = active ? 'Pause' : 'Resume';
  };

  panel.querySelector('#aa-stop').onclick = () => {
    observer.disconnect();
    stopKeepAlive();
    recovering = false;
    panel.remove();
    delete window.__aiFdeAutoAllow;
    console.log('[AutoAllow] Stopped and removed.');
  };

  // ---------- Draggable panel ----------
  const header = panel.querySelector('div'); // title row: "AutoAllow" + status
  header.style.cursor = 'move';
  header.style.userSelect = 'none';

  try {
    const saved = JSON.parse(localStorage.getItem('__aiFdeAutoAllowPos') || 'null');
    if (saved) {
      panel.style.left = saved.left + 'px';
      panel.style.top = saved.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  } catch {}

  let dragging = false, dragOffsetX = 0, dragOffsetY = 0;
  header.addEventListener('mousedown', e => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    let left = e.clientX - dragOffsetX;
    let top = e.clientY - dragOffsetY;
    left = Math.max(0, Math.min(left, window.innerWidth - panel.offsetWidth));
    top = Math.max(0, Math.min(top, window.innerHeight - panel.offsetHeight));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    localStorage.setItem('__aiFdeAutoAllowPos', JSON.stringify({
      left: parseFloat(panel.style.left),
      top: parseFloat(panel.style.top),
    }));
  });

  window.__aiFdeAutoAllow = { show: () => panel.style.display = 'block', stop: () => panel.querySelector('#aa-stop').click() };
  console.log('[AutoAllow] Running on', location.href);
})();
