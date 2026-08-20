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

  // Words that stop a prompt being clicked whatever its category is. They are
  // matched against the prompt's text, not the button's label, because the label
  // needs no list of its own: TARGET_LABELS is an exact match, so `Always allow`,
  // `Allow all future` and `Deny` are already excluded by it. What an exact label
  // match cannot see is what is being asked for, which is where the risk sits.
  // `always` and `forever` are deliberately not here: a prompt offering `Allow`
  // beside `Always allow` carries the second label in its own text, and blocking
  // on it would refuse the ordinary case.
  const BLOCKED_CONTEXT = ['delete', 'force', 'production'];

  // `risk` is the order the categories are matched in, highest first, and it is
  // not the order they are displayed in. A prompt matching more than one has to
  // be judged by the riskiest thing it matches, or `Deploy the build, view the
  // plan first` counts as read-only and goes through with the deploy category
  // switched off. `other` matches everything, so it sits at the bottom.
  const CATEGORIES = [
    { id: 'read',   label: 'Read-only actions',      enabled: true,  risk: 1, match: t => /read|view|preview|list/i.test(t) },
    { id: 'write',  label: 'Write / edit actions',    enabled: true,  risk: 2, match: t => /write|edit|update|create/i.test(t) },
    { id: 'deploy', label: 'Deploy / build actions',  enabled: false, risk: 3, match: t => /deploy|build|publish|run/i.test(t) },
    { id: 'other',  label: 'Unclassified',            enabled: true,  risk: 0, match: () => true },
  ];
  const BY_RISK = [...CATEGORIES].sort((a, b) => b.risk - a.risk);

  // innerText is what a person reads off the button, which is what TARGET_LABELS
  // is written against, so it comes first. It is empty for a subtree the page is
  // not rendering, and textContent needs no rendering at all, so it is the
  // fallback: a button in the document whose text is exactly one of the labels is
  // one to press whether or not the page is drawing it. This is not the fix for a
  // prompt in a hidden tab, where there is no button in the document to read.
  function labelFor(btn) {
    return (btn.innerText || btn.getAttribute('aria-label') || btn.textContent || '').trim();
  }

  function promptContextFor(btn) {
    const container = btn.closest('[role="dialog"], [role="alertdialog"], .dialog, .modal') || btn.parentElement;
    return (container?.innerText || '').slice(0, 400).toLowerCase();
  }
  function categoryFor(context) {
    return BY_RISK.find(c => c.match(context));
  }

  const clicked = new WeakSet();
  let active = true, count = 0;

  // Stop can be followed by another press of the toolbar button on the same
  // page, so anything registered outside the panel has to be undone rather than
  // left behind: listeners on window outlive the host element that is removed.
  const teardown = [];
  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    teardown.push(() => target.removeEventListener(type, handler, options));
  }

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
  let disarmGesture = () => {};

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
    reportKeepAlive('waiting for a click on the page');
    if (awaitingGesture) return;
    awaitingGesture = true;
    // The one setting whose failure the user has to fix, and it looks identical
    // to success in the panel: the box is ticked, the audio is suspended, and
    // Chrome is throttling the tab anyway. So it goes in the log with the action
    // that clears it, the same as a resume that could not be sent.
    appendLog(new Date().toLocaleTimeString(), 'click the page once to keep the tab awake');
    const onGesture = () => {
      disarmGesture();
      if (keepAliveOn) settleKeepAlive();
    };
    GESTURE_EVENTS.forEach(e => window.addEventListener(e, onGesture, true));
    disarmGesture = () => {
      GESTURE_EVENTS.forEach(e => window.removeEventListener(e, onGesture, true));
      awaitingGesture = false;
      disarmGesture = () => {};
    };
  }

  function stopKeepAlive() {
    disarmGesture();
    if (!keepAliveOn) return;
    audioCtx.__osc.stop();
    audioCtx.close();
    audioCtx = null;
    keepAliveOn = false;
    reportKeepAlive('Off');
  }

  // ---------- Telling the page the tab is visible ----------
  // Chrome produces no frames for a hidden tab, and a callback that is delivered
  // with the frame, ResizeObserver and IntersectionObserver among them, is not
  // delivered at all. The log shows what that costs: while the tab was in the
  // background the pending approval was never in the document to be pressed, six
  // attempts to reach it found nothing, and the first attempt after the tab was
  // looked at found it at once.
  //
  // Nothing here can make Chrome draw the tab. What it can do is stop the page
  // standing down on its own account, which applications do by reading
  // document.hidden and by acting on visibilitychange. Both are answered as
  // though the tab were in front: the properties report visible, and the event
  // saying otherwise is kept from the page. The event saying the tab is back is
  // let through, because that is the one the page needs in order to catch up on
  // whatever it deferred.
  //
  // How much of Foundry's standing down is its own choice rather than Chrome's is
  // not knowable from here, which is why this is a checkbox and not an
  // assumption.
  const realVisibility = (() => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    const read = descriptor && descriptor.get;
    // With no descriptor to read the truth from, reporting visible means the
    // suppression below never fires, which is the safe way to be wrong.
    return () => (read ? read.call(document) : 'visible');
  })();

  let visibilitySpoofed = false;

  function startVisibilitySpoof() {
    if (visibilitySpoofed) return;
    try {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    } catch (err) {
      console.warn('[Auto FDE] could not tell the page it is visible:', err.message);
      return;
    }
    visibilitySpoofed = true;
    console.log('[Auto FDE] tell the page the tab is visible: On');
  }

  function stopVisibilitySpoof() {
    if (!visibilitySpoofed) return;
    // Own properties, so deleting them uncovers the real getters on the
    // prototype rather than leaving the page with no answer at all.
    delete document.hidden;
    delete document.visibilityState;
    visibilitySpoofed = false;
    console.log('[Auto FDE] tell the page the tab is visible: Off');
  }

  // ---------- Network-error auto-resume ----------
  // Set from the checkbox, which carries the default so the two cannot drift.
  let autoResumeEnabled = false;
  let recovering = false;
  let resumeTimer = null;
  const handledBanners = new WeakSet();
  // What gets typed into the chat and sent once the connection is back. It is a
  // fresh instruction, not a replay: the agent knows what it was doing, so it
  // only needs telling to carry on.
  const RESUME_TEXT = 'Networking restored. Resume what you were doing.';

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

  // Reaches for the page's own descriptor to get past React's patched setter,
  // which is why this script runs in the MAIN world. A page that has replaced the
  // prototype property with a plain value leaves no setter to call, and throwing
  // here would surface as an unhandled rejection inside the recovery, so the
  // failure is reported instead.
  function setTextareaValue(el, text) {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (!descriptor || !descriptor.set) return false;
    descriptor.set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
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
      if (!setTextareaValue(textarea, RESUME_TEXT)) {
        console.warn('[Auto FDE] The chat textarea has no value setter to call.');
        return false;
      }
    } else {
      const rich = findRichInput();
      if (!rich) { console.warn('[Auto FDE] Could not locate any chat input.'); return false; }
      pasteIntoRichInput(rich, RESUME_TEXT);
    }
    // The editor needs a turn to take the text before the button will send it.
    // This is the one deferred action in the script, and it is not the prompt
    // click: a resume that lands late in a throttled tab still resumes, whereas
    // a prompt click that lands late is a session left sitting unanswered.
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (!sendBtn.isConnected) { reportResume('could not send the resume message', true); return; }
      sendBtn.click();
      recordResume();
    }, 300);
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
  async function handleErrorBanner(banner) {
    if (recovering || !autoResumeEnabled) return;
    // One recovery per banner. Foundry's callout does not always clear itself
    // once the connection is back, and without this the next mutation would find
    // the same banner still on screen and tell the agent to carry on again.
    handledBanners.add(banner);
    recovering = true;
    reportResume('recovering');
    const stable = await waitForStableConnection();
    if (!recovering) { reportResume(autoResumeEnabled ? 'watching' : 'off'); return; }
    if (stable) {
      const ok = sendResumeMessage();
      if (ok) reportResume('watching');
      else reportResume('could not send the resume message', true);
    }
    recovering = false;
  }

  // ---------- Traffic watch ----------
  // A diagnostic, off until it is asked for from the console as
  // window.__autoFde.watchTraffic(). It is not in the panel because it is not a
  // decision anyone makes while using this; it is one step in working out whether
  // an approval can be sent rather than clicked.
  //
  // Why it exists: the DOM route cannot reach a prompt in a tab Chrome is not
  // drawing, because the row is not in the document to be reached. Sending the
  // approval the way the page sends it would work in any tab, and the only thing
  // that knows what the page sends is the page. So this logs the request going
  // out when an approval is granted: method, URL, and a truncated body.
  //
  // Never a header. That is where the session token is, and this writes to a
  // console whose contents get copied into chat windows.
  //
  // A first pass at this printed the first 800 characters of every body matching
  // the word, which on a Foundry thread is 800 characters of tool configuration
  // and item ids with the interesting field somewhere past the cut. So the body
  // is not printed whole: it is parsed, walked, and only the paths whose key or
  // value carries the word are reported. That turns a wall of thread document
  // into the two or three fields an approval actually sets.
  const APPROVAL_TRAFFIC = /approv/i;
  const SESSION_API = '/ai-fde/api/';
  const BODY_LIMIT = 240;
  const FIELD_LIMIT = 12;
  const FIELD_VALUE_LIMIT = 200;
  // The session's own approval policy, which is the one field worth reading
  // whole. It is what decides whether a prompt appears at all, so a truncated
  // copy of it is the one truncation that costs something.
  const POLICY_FIELD = /approvalsettings|bulkapproval/i;
  const POLICY_VALUE_LIMIT = 2500;
  const WALK_DEPTH = 8;
  // How long after an Allow is pressed to treat everything as interesting. The
  // request that grants the approval is the one that follows the click, and
  // knowing which one that is beats guessing from its name.
  const CLICK_WINDOW_MS = 2000;
  let watching = false, capturingUntil = 0;

  function shorten(text, limit) {
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }

  // Every path whose key or string value carries the word, which is what an
  // approval sets and what a body this size buries.
  function approvalFields(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    const found = [];
    // A field named for approval whose value is also the word reports itself
    // twice, once for each, and two identical lines read as two findings.
    const add = entry => {
      if (!found.includes(entry)) found.push(entry);
    };
    const walk = (value, path, depth) => {
      if (found.length >= FIELD_LIMIT || depth > WALK_DEPTH) return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
        return;
      }
      if (value && typeof value === 'object') {
        Object.keys(value).forEach(key => {
          const here = path ? `${path}.${key}` : key;
          if (APPROVAL_TRAFFIC.test(key)) {
            const limit = POLICY_FIELD.test(key) ? POLICY_VALUE_LIMIT : FIELD_VALUE_LIMIT;
            add(`${here} = ${shorten(JSON.stringify(value[key]), limit)}`);
          }
          walk(value[key], here, depth + 1);
        });
        return;
      }
      if (typeof value === 'string' && APPROVAL_TRAFFIC.test(value)) {
        add(`${path} = ${JSON.stringify(shorten(value, FIELD_VALUE_LIMIT))}`);
      }
    };
    walk(parsed, '', 0);
    return found;
  }

  // The grant carries no field named after approval, so there is nothing to
  // search for and the body has to be read. Read whole it is unreadable: the
  // thread document leads with hundreds of item ids. So every top-level key is
  // reported, an array of nothing but strings as a count and a sample, and
  // everything else in full up to a generous limit. Whatever an approval sets
  // lives in one of the keys that is not the item order.
  const SHAPE_VALUE_LIMIT = 1200;
  const SHAPE_SAMPLE = 2;

  function describeBody(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [`body: ${shorten(text, BODY_LIMIT)}`];
    }
    if (!parsed || typeof parsed !== 'object') {
      return [`body: ${shorten(text, BODY_LIMIT)}`];
    }
    return Object.keys(parsed).map(key => {
      const value = parsed[key];
      if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        return `${key}: ${value.length} strings, first `
          + `${JSON.stringify(value.slice(0, SHAPE_SAMPLE))}`;
      }
      return `${key}: ${shorten(JSON.stringify(value), SHAPE_VALUE_LIMIT)}`;
    });
  }

  // Called when a prompt is clicked, so the log says what followed it. The window
  // opens whether or not the traffic watch is on, because the store watch reads
  // from the same window and has its own reason to exist. Only the line about
  // traffic belongs to the traffic watch.
  function markApprovalClick() {
    capturingUntil = Date.now() + CLICK_WINDOW_MS;
    if (watching) {
      console.log('[Auto FDE] traffic: --- Allow clicked, what follows is the grant ---');
    }
  }

  function watchTraffic(options) {
    const everything = !!(options && options.all);
    if (watching) {
      console.log('[Auto FDE] traffic watch is already on');
      return 'already on';
    }
    watching = true;

    // The same thread metadata goes out over and over with a new version each
    // time. Repeats of a request that says nothing new are dropped, or the one
    // line that matters scrolls away.
    const seen = new Set();

    const report = (how, url, body) => {
      const text = typeof body === 'string' ? body : (body == null ? '' : String(body));
      const following = Date.now() < capturingUntil;
      const onApi = url.includes(SESSION_API);
      const named = APPROVAL_TRAFFIC.test(url) || APPROVAL_TRAFFIC.test(text);
      // The session's own API either way. The word is only asked for outside the
      // window, because the grant turned out not to carry it, and without the
      // first half a repository query called QuickApprovalProjectQuery is the
      // loudest thing in the log and a dataset query is the second.
      if (!everything && !(onApi && (following || named))) return;

      const fields = approvalFields(text);
      const signature = `${how} ${url} ${fields.join(';')}`;
      if (!following) {
        if (seen.has(signature)) return;
        if (seen.size > 50) seen.clear();
        seen.add(signature);
      }

      // In the window the shape is printed instead of the body: the grant is a
      // thread document, and every key of it except the item order is worth
      // reading, while the item order is hundreds of ids and never the point.
      const detail = following
        ? describeBody(text).map(line => `  ${line}`)
        : [`  body: ${shorten(text, BODY_LIMIT)}`];

      // The colon is load-bearing: it is what the line the user is asked to copy
      // has and the banner below does not.
      console.log([
        `[Auto FDE] traffic: ${how} ${url}`,
        fields.length ? `  fields: ${fields.join('\n          ')}` : '  fields: none',
        ...(text ? detail : []),
      ].filter(Boolean).join('\n'));
    };

    const realFetch = window.fetch;
    const realOpen = XMLHttpRequest.prototype.open;
    const realSend = XMLHttpRequest.prototype.send;
    const realWsSend = WebSocket.prototype.send;

    // A Request object carries its body in a stream that reading would consume,
    // so only the URL is taken from one. The page's own approval call is the one
    // that matters and applications send those with an init body.
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      report('fetch', url, init && init.body);
      return realFetch.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__autoFdeUrl = url;
      return realOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      report('xhr', this.__autoFdeUrl || '', body);
      return realSend.apply(this, arguments);
    };
    WebSocket.prototype.send = function (data) {
      report('ws', this.url || '', typeof data === 'string' ? data : '[binary]');
      return realWsSend.apply(this, arguments);
    };

    // Stop has to undo everything, and a wrapped fetch left on a page whose
    // panel has been removed is exactly the kind of thing that rule is for.
    teardown.push(() => {
      window.fetch = realFetch;
      XMLHttpRequest.prototype.open = realOpen;
      XMLHttpRequest.prototype.send = realSend;
      WebSocket.prototype.send = realWsSend;
      watching = false;
    });

    console.log(`[Auto FDE] traffic watch is on${everything ? ', logging everything' : ''}.`
      + ' Let it approve one prompt, then copy every line starting "[Auto FDE] traffic:".');
    return 'on';
  }

  // ---------- State probe ----------
  // Reached from the console as window.__autoFde.probeApproval(), and the second
  // capture step. The first one established that an approval is a state
  // transition inside the page rather than a request to a server: the client
  // holds the thread, writes `toolResponse.state: "pending_approval"` into it,
  // and carries on when the button is pressed. There is nothing on the far end to
  // tell.
  //
  // That is what makes a third route possible. This script runs in the page's own
  // world, so the state the button changes is reachable from here whether or not
  // the button is. And the state is mounted even in a hidden tab, because the
  // pending pill renders from it, which is how the pill can be found at all.
  //
  // So the target is the function the button calls, and the object holding the
  // pending call. This walks React's fiber tree up from whichever anchor exists,
  // preferring an Allow button while there is one and falling back to the pill,
  // and reports each component's name, its function props by name, and its other
  // props by shape. Names and shapes only: props on a thread component hold the
  // conversation, and this output gets pasted into chat windows.
  //
  // It runs itself twice rather than waiting to be asked, because the interesting
  // half is the hidden tab and a console command cannot be timed against one: to
  // type it you focus DevTools, and the answer wanted is what the page looks like
  // when nobody is. So the probe fires once from the first Allow this panel
  // presses, which is the mounted case, and again from the pill when a stall is
  // reported, which is the case that matters. Once each, since the point is a map
  // and not a running commentary.
  const REACT_FIBER = /^__reactFiber\$|^__reactInternalInstance\$/;
  const PROBE_INTERESTING = /approv|pending|tool|item|thread|decision|allow|state/i;
  const PROBE_LEVELS = 40;
  const PROBE_KEYS = 12;
  const PROBE_STRING_LIMIT = 120;
  let probedAClick = false;

  function fiberFor(el) {
    const key = Object.keys(el).find(name => REACT_FIBER.test(name));
    return key ? el[key] : null;
  }

  function fiberName(fiber) {
    const type = fiber.type || fiber.elementType;
    if (!type) return '(host)';
    if (typeof type === 'string') return type;
    return type.displayName || type.name || '(anonymous)';
  }

  // Shapes, not contents. A prop on one of these components is as likely to be
  // the whole conversation as it is to be a flag, and JSON.stringify on a fiber
  // prop finds a cycle sooner or later anyway.
  function describeValue(value) {
    if (typeof value === 'function') return 'fn';
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array[${value.length}]`;
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      return `{${keys.slice(0, PROBE_KEYS).join(', ')}${keys.length > PROBE_KEYS ? ', …' : ''}}`;
    }
    if (typeof value === 'string') return JSON.stringify(shorten(value, PROBE_STRING_LIMIT));
    return String(value);
  }

  // An anchor with no fiber on it is no use, so one that has a fiber wins over
  // one that merely comes first in the document. Falling back to an anchor
  // without one is still better than saying nothing was pending, because then
  // the report says which of the two things went wrong.
  function probeAnchor() {
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter(b => TARGET_LABELS.includes(labelFor(b).toLowerCase()));
    const wired = buttons.find(fiberFor);
    if (wired) return { what: 'an Allow button', el: wired };
    const marker = findPendingMarker();
    if (marker && fiberFor(marker)) return { what: 'the pending pill', el: marker };
    if (buttons.length) return { what: 'an Allow button', el: buttons[0] };
    if (marker) return { what: 'the pending pill', el: marker };
    return null;
  }

  function probeApproval() {
    const anchor = probeAnchor();
    if (!anchor) {
      console.warn('[Auto FDE] probe: nothing to start from. Run it while a prompt is pending.');
      return 'nothing pending';
    }
    return probeFrom(anchor.el, anchor.what);
  }

  // Props are only what a component was handed. The first walk against a real
  // session showed the state is all there in a hidden tab, contextMap,
  // contextOrder, sessionState, startAgentLoop, and no way to change any of it,
  // because the functions that do live in a context value or a hook rather than
  // in props. This reports those two.
  //
  // Only shapes whose keys look like they could answer a prompt are printed. A
  // provider value or a hook's state is otherwise most of the application, and
  // this output goes in a chat window.
  const PROBE_ACTIONS = /approv|allow|accept|deny|decision|respond|resolve|submit|continue|resume|dispatch/i;
  const PROBE_HOOKS = 30;
  const PROBE_SHAPES = 8;

  function stateShapes(fiber) {
    const out = [];
    const props = fiber.memoizedProps;
    // A context provider carries everything it offers in one prop, so the shape
    // of that prop is the shape of what its subtree can reach.
    const value = props && typeof props === 'object' ? props.value : null;
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      out.push(`value: ${describeValue(value)}`);
    }
    // A function component's memoizedState is a linked list of hooks. A store or
    // a reducer's dispatch sits in one of them.
    let hook = fiber.memoizedState;
    for (let i = 0; hook && i < PROBE_HOOKS && out.length < PROBE_SHAPES; i++, hook = hook.next) {
      const state = hook.memoizedState;
      // nodeType rules out a hook holding a DOM node, which describes itself as
      // the entire element otherwise.
      if (!state || typeof state !== 'object' || state.nodeType) continue;
      const keys = Object.keys(state);
      if (!keys.some(key => PROBE_ACTIONS.test(key) || PROBE_INTERESTING.test(key))) continue;
      out.push(`hook ${i}: ${describeValue(state)}`);
    }
    return out;
  }

  // ---------- Store probe ----------
  // The walk from the pill found the store: a context value of
  // {__enqueueEffect, __setState, agent, dispatch, getSnapshot, subscribe},
  // mounted with no row in the document, over state of {agentStatus, contextMap,
  // contextOrder, requestStatus, sessionState, …}. The walk from a mounted button
  // found what the click does: handleAllow on the button pair, over
  // handleUpdateContextItem and startAgentLoop on the row, against a toolUseId.
  //
  // What is left to establish is how to say it. This reads the store and reports
  // the pending item and the names the store answers to. Read-only, on purpose:
  // dispatching a guessed action into somebody's live session is the one thing
  // worth being slow about.
  const PENDING_STATE = /pending/i;
  const ITEM_SEARCH_DEPTH = 4;
  const EVENT_NAMES_LIMIT = 1200;
  // Up here rather than beside the grant reader, because describeArg() prints a
  // toolResponse too and is declared above it.
  const GRANT_LIMIT = 400;

  function looksLikeStore(value) {
    return !!value && typeof value === 'object'
      && typeof value.getSnapshot === 'function'
      && (typeof value.dispatch === 'function' || typeof value.__setState === 'function');
  }

  // The store hides in the same two places the setters do, so the search is the
  // one stateShapes() reports from, narrowed to what answers like a store.
  //
  // STORE_LEVELS is not PROBE_LEVELS and the difference cost a whole run. Forty
  // levels is a readable amount to print and it reaches the store from the pill,
  // which sits near the root. From a transcript row the store is far further up,
  // past the row, the sortable list and the rest, so a search capped at forty
  // found nothing and reported that no store existed. A search goes to the root;
  // only the printing is capped.
  const STORE_LEVELS = 200;
  let knownStore = null, storeSearchWarned = false;

  // Cached, because it is the same store every time and the walk is not free.
  function getStore(el) {
    if (knownStore) return knownStore;
    const found = findStore(el);
    if (found) {
      knownStore = found;
      return found;
    }
    if (!storeSearchWarned) {
      storeSearchWarned = true;
      console.warn('[Auto FDE] store: none reachable from the prompt.');
    }
    return null;
  }

  function findStore(el) {
    let fiber = fiberFor(el);
    for (let level = 0; fiber && level < STORE_LEVELS; level++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object' && looksLikeStore(props.value)) {
        return { store: props.value, where: `${level} ${fiberName(fiber)} value` };
      }
      let hook = fiber.memoizedState;
      for (let i = 0; hook && i < PROBE_HOOKS; i++, hook = hook.next) {
        if (looksLikeStore(hook.memoizedState)) {
          return { store: hook.memoizedState, where: `${level} ${fiberName(fiber)} hook ${i}` };
        }
      }
    }
    return null;
  }

  // The traffic capture gave the shape to look for: a tool-usage item whose
  // toolResponse carries a state of pending_approval. It sits under content in
  // what goes over the wire, so a few levels are searched rather than one.
  function findPendingItem(value, path, depth) {
    if (!value || typeof value !== 'object' || depth > ITEM_SEARCH_DEPTH) return null;
    const response = value.toolResponse;
    if (response && typeof response.state === 'string' && PENDING_STATE.test(response.state)) {
      return { path, item: value };
    }
    const keys = Array.isArray(value) ? value.keys() : Object.keys(value);
    for (const key of keys) {
      const found = findPendingItem(value[key], `${path}.${key}`, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function probeStore() {
    const anchor = probeAnchor();
    if (!anchor) {
      console.warn('[Auto FDE] store: nothing pending to start from.');
      return 'nothing pending';
    }
    const found = getStore(anchor.el);
    if (!found) return 'no store';

    const lines = [`[Auto FDE] store: found at ${found.where}, from ${anchor.what}`];
    lines.push(`  store: ${describeValue(found.store)}`);
    const agent = found.store.agent;
    lines.push(`  agent: ${describeValue(agent)}`);
    // agent came back as {contextItems, effectHandlers, events, onEvent}, so it
    // takes events rather than offering methods. If the event names are in there,
    // they are the vocabulary, and one of them answers a prompt.
    if (agent && typeof agent === 'object') {
      ['events', 'effectHandlers', 'contextItems'].forEach(key => {
        if (agent[key] != null) lines.push(`  agent.${key}: ${describeValue(agent[key])}`);
      });
      // agent.events came back as array[35]. If those are the events the agent
      // has seen rather than the ones it accepts, one of them is an approval
      // already granted in this session, and the vocabulary needs no click to
      // learn. The tail, because the recent ones are the relevant ones.
      // Each entry came back as {make, schema}, so these are definitions rather
      // than a log: the vocabulary itself. The factory's name is the event's
      // name, which is the whole list in one line.
      if (Array.isArray(agent.events)) {
        const names = agent.events
          .map(event => (event && typeof event.make === 'function' && event.make.name) || '?')
          .join(', ');
        lines.push(`  agent.events names: ${shorten(names, EVENT_NAMES_LIMIT)}`);
      }
    }

    let snapshot = null;
    try {
      snapshot = found.store.getSnapshot();
    } catch (err) {
      lines.push(`  getSnapshot threw: ${err.message}`);
    }
    if (snapshot && typeof snapshot === 'object') {
      lines.push(`  snapshot: ${describeValue(snapshot)}`);
      // Neither of these printed on the first run, because both were being
      // reported only when they were strings and neither is one. Their shape is
      // what says whether the loop is waiting on the user or on something else.
      ['agentStatus', 'requestStatus'].forEach(key => {
        if (snapshot[key] != null) lines.push(`  ${key}: ${describeValue(snapshot[key])}`);
      });
      if (Array.isArray(snapshot.contextOrder)) {
        lines.push(`  contextOrder: ${snapshot.contextOrder.length} ids`);
      }
      const pending = findPendingItem(snapshot.contextMap, 'contextMap', 0);
      if (!pending) {
        lines.push('  pending item: none found in contextMap');
      } else {
        lines.push(`  pending item: at ${pending.path}`);
        lines.push(`    item: ${describeValue(pending.item)}`);
        lines.push(`    toolName: ${JSON.stringify(pending.item.toolName)}`);
        lines.push(`    toolResponse: ${JSON.stringify(pending.item.toolResponse)}`);
      }
    }
    console.log(lines.join('\n'));
    return 'probed';
  }

  // ---------- Store watch ----------
  // The store takes events and the event that answers a prompt is not guessable,
  // so the same trick as the traffic watch: let the page send it and read what it
  // sent. dispatch and agent.onEvent are wrapped, they pass everything through
  // untouched, and they only log inside the window a click opens, which is what
  // separates the grant from everything else the session is doing.
  //
  // Installed from the button about to be pressed, so the click that follows is
  // the one that gets read. Stop puts both back.
  let storeWatched = false;

  function describeArg(value) {
    if (!value || typeof value !== 'object') return describeValue(value);
    const type = value.type;
    const head = typeof type === 'string' ? `type=${JSON.stringify(type)} ` : '';
    // upsertChildContextItem is the event that answers a prompt, and the answer
    // is the toolResponse it carries. Everything else about the item is the
    // conversation, so only that one field is printed.
    const item = value.contextItem;
    const holder = item ? findToolResponse(item, 0) : null;
    const tail = holder ? ` toolResponse=${shorten(JSON.stringify(holder.toolResponse), GRANT_LIMIT)}` : '';
    return `${head}${describeValue(value)}${tail}`;
  }

  function installStoreWatch(el) {
    if (storeWatched) return;
    const found = getStore(el);
    // Not latched on failure. Latching before the search is what turned one bad
    // search into a run with no watch at all and no second attempt at getting
    // one.
    if (!found) return;
    storeWatched = true;

    const wrap = (owner, name, label) => {
      const real = owner[name];
      if (typeof real !== 'function') return;
      try {
        owner[name] = function (...args) {
          if (Date.now() < capturingUntil) {
            console.log(`[Auto FDE] store ${label}: ${args.map(describeArg).join(' , ')}`);
          }
          return real.apply(this, args);
        };
      } catch (err) {
        console.warn(`[Auto FDE] store watch: could not wrap ${label}: ${err.message}`);
        return;
      }
      teardown.push(() => { owner[name] = real; });
    };

    wrap(found.store, 'dispatch', 'dispatch');
    if (found.store.agent) wrap(found.store.agent, 'onEvent', 'agent.onEvent');
    console.log(`[Auto FDE] store watch on at ${found.where}.`
      + ' The next Allow will show what it sends.');
  }

  // ---------- Reading the grant out of the store ----------
  // The shortest route to what an approval actually sets, and it needs no
  // vocabulary: read the pending item's toolResponse from the store immediately
  // before a click, then read the same item again once the page has answered.
  // The difference is the target state, stated by the application rather than
  // guessed at. `pending_approval` is known; what replaces it is not.
  let awaitingGrant = null, grantRead = false;

  function safeSnapshot(store) {
    try {
      return store.getSnapshot();
    } catch (err) {
      console.warn(`[Auto FDE] store: getSnapshot threw: ${err.message}`);
      return null;
    }
  }

  // The item sits under content in what goes over the wire and at the top level
  // in the store, so neither depth is assumed.
  function findToolResponse(value, depth) {
    if (!value || typeof value !== 'object' || depth > ITEM_SEARCH_DEPTH) return null;
    if (value.toolResponse) return value;
    for (const key of Object.keys(value)) {
      const found = findToolResponse(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  // The id of the item this button belongs to, read off its own fibers. Taking
  // the first pending item in the map instead is what made this silent: with
  // several prompts queued it watched one the click was never going to answer,
  // and the guard against noting twice meant it never tried again.
  const ITEM_ID_PROPS = ['toolUseId', 'contextItemId', 'maybePendingUserActionContextItemId', 'itemId'];

  function itemIdFor(el) {
    let fiber = fiberFor(el);
    for (let level = 0; fiber && level < STORE_LEVELS; level++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      for (const key of ITEM_ID_PROPS) {
        if (typeof props[key] === 'string' && props[key]) return props[key];
      }
    }
    return null;
  }

  function noteGrantBefore(el) {
    if (grantRead || awaitingGrant) return;
    const found = getStore(el);
    if (!found) return;
    const snapshot = safeSnapshot(found.store);
    const map = snapshot && snapshot.contextMap;
    if (!map) return;

    const id = itemIdFor(el);
    const holder = id ? findToolResponse(map[id], 0) : null;
    if (holder) {
      awaitingGrant = { id, before: shorten(JSON.stringify(holder.toolResponse), GRANT_LIMIT) };
      return;
    }
    // No id on the fibers, so fall back to whatever is pending. Better than
    // nothing, and the log says which id it settled on either way.
    const pending = findPendingItem(map, 'contextMap', 0);
    if (!pending || !pending.item.id) return;
    awaitingGrant = {
      id: pending.item.id,
      before: shorten(JSON.stringify(pending.item.toolResponse), GRANT_LIMIT),
    };
  }

  function readGrantAfter() {
    if (!awaitingGrant || !knownStore) return;
    const snapshot = safeSnapshot(knownStore.store);
    const map = snapshot && snapshot.contextMap;
    const holder = map ? findToolResponse(map[awaitingGrant.id], 0) : null;
    if (!holder) return;
    const after = shorten(JSON.stringify(holder.toolResponse), GRANT_LIMIT);
    if (after === awaitingGrant.before) return;
    console.log(`[Auto FDE] store grant: item ${awaitingGrant.id}`
      + `\n  toolResponse before: ${awaitingGrant.before}`
      + `\n  toolResponse after:  ${after}`);
    awaitingGrant = null;
    grantRead = true;
  }

  function probeFrom(el, what) {
    let fiber = fiberFor(el);
    if (!fiber) {
      console.warn('[Auto FDE] probe: no React fiber on ' + what
        + '. The page may not be React, or the key has changed.');
      return 'no fiber';
    }

    const lines = [`[Auto FDE] probe: walking up from ${what}`];
    for (let level = 0; fiber && level < PROBE_LEVELS; level++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') {
        lines.push(`  ${level} ${fiberName(fiber)}`);
        continue;
      }
      const keys = Object.keys(props);
      const handlers = keys.filter(key => typeof props[key] === 'function');
      const interesting = keys.filter(key =>
        typeof props[key] !== 'function' && PROBE_INTERESTING.test(key));
      lines.push(`  ${level} ${fiberName(fiber)}`
        + (handlers.length ? `\n      fns: ${handlers.join(', ')}` : '')
        + (interesting.length
          ? `\n      props: ${interesting.map(k => `${k}=${describeValue(props[k])}`).join(', ')}`
          : '')
        + stateShapes(fiber).map(shape => `\n      ${shape}`).join(''));
    }
    console.log(lines.join('\n'));
    return 'probed';
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
        background: rgba(23, 27, 33, .25);
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
          <div class="hint">Inaudible audio stops Chrome throttling this tab.</div>
          <label class="row" style="margin-top:5px">
            <input type="checkbox" id="af-resume-toggle" checked>
            <span>Automatically resume after a network error</span>
          </label>
          <div class="hint">Tells the agent to carry on once the connection is back.</div>
          <label class="row" style="margin-top:5px">
            <input type="checkbox" id="af-visible" checked>
            <span>Tell the page the tab is visible</span>
          </label>
          <div class="hint">Stops Foundry standing down while you work elsewhere.</div>
        </div>

        <div class="sec">
          <div class="cap">Recent clicks</div>
          <div class="log" id="af-log"></div>
        </div>

      </div>
    </div>`;

  const panel = shadow.querySelector('#af-panel');
  const header = shadow.querySelector('#af-header');
  const catsEl = shadow.querySelector('#af-cats');
  const countEl = shadow.querySelector('#af-count');
  const logEl = shadow.querySelector('#af-log');
  const toggleBtn = shadow.querySelector('#af-toggle');
  const stopBtn = shadow.querySelector('#af-stop');
  const collapseBtn = shadow.querySelector('#af-collapse');

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

  // Neither of the settings carries a status field any more: the panel assumes
  // they work, which they do. The state still goes to the console, because
  // "ticked but suspended" is a real thing to be able to check.
  function reportKeepAlive(text) { console.log(`[Auto FDE] keep the tab awake: ${text}`); }

  const keepAliveBox = shadow.querySelector('#af-keepalive');
  keepAliveBox.onchange = e => {
    e.target.checked ? startKeepAlive() : stopKeepAlive();
  };
  if (keepAliveBox.checked) startKeepAlive();

  // A failure is the one thing that cannot be assumed away, so it goes in the
  // activity log, where the user is already looking, rather than nowhere.
  function reportResume(text, failed = false) {
    console.log(`[Auto FDE] auto-resume: ${text}`);
    if (failed) appendLog(new Date().toLocaleTimeString(), text);
  }

  // Ticked by default, for the same reason the keep-alive is: the tab is in the
  // background and nobody is watching it. A dropped connection is what actually
  // ends a long session, and an agent sitting behind an error banner until
  // somebody looks at the tab is the failure this is here to prevent. It writes
  // one line into the chat to do it, which is why the log records every send.
  const resumeBox = shadow.querySelector('#af-resume-toggle');
  resumeBox.onchange = e => {
    autoResumeEnabled = e.target.checked;
    reportResume(autoResumeEnabled ? 'watching' : 'off');
    if (!autoResumeEnabled) recovering = false;
  };
  autoResumeEnabled = resumeBox.checked;
  if (autoResumeEnabled) reportResume('watching');

  // Ticked by default, because working in another tab is the reason this exists
  // and it costs nothing when the tab is in front.
  const visibleBox = shadow.querySelector('#af-visible');
  visibleBox.onchange = e => {
    e.target.checked ? startVisibilitySpoof() : stopVisibilitySpoof();
  };
  if (visibleBox.checked) startVisibilitySpoof();

  // The panel remembers where it was put and whether it was collapsed. Both go
  // through these, because localStorage throws outright rather than returning
  // null when the page's storage is blocked, and losing the panel's position is
  // not worth an exception in somebody else's application.
  function remember(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }
  function recall(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  // ---------- Collapse ----------
  // Collapsed keeps the header, which carries the count and the active state, so
  // the panel is still worth glancing at when it is out of the way.
  function setCollapsed(collapsed) {
    if (collapsed) panel.setAttribute('data-collapsed', '');
    else panel.removeAttribute('data-collapsed');
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
    collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    remember('__autoFdeCollapsed', collapsed ? '1' : '0');
  }
  collapseBtn.onclick = () => setCollapsed(!panel.hasAttribute('data-collapsed'));
  setCollapsed(recall('__autoFdeCollapsed') === '1');

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
    appendLog(t, 'sent the resume message');
    console.log(`[Auto FDE] ${t} — auto-sent resume message`);
  }

  // ---------- Reaching a prompt that is not on the page ----------
  // The transcript is a windowed list: rows outside the range it has rendered
  // are not in the document at all. An approval that arrives while the user is
  // scrolled up therefore has no button for the scan to find and produces no
  // mutation for the observer to react to, and no amount of waiting changes
  // that. That is the whole of the bug this exists to fix: the count would sit
  // still for minutes and then move the moment somebody scrolled the tab, which
  // is exactly what an unattended session cannot rely on happening.
  //
  // The page does leave one thing behind that is always rendered: the pill it
  // floats over the transcript to say an approval is pending. Pressing that is
  // the page's own way back to the row. Putting the transcript at the bottom as
  // well is the way that still works in a tab Chrome has stopped painting,
  // because assigning scrollTop needs no frame whereas a smooth scroll does.
  const PENDING_PROMPT = /waiting for (tool )?approval/i;
  // Long enough for the list to render the row it was sent to, short enough that
  // a prompt is not left sitting. It is the distance between two Date.now()
  // readings taken inside the observer callback, not a timer, so throttling in a
  // hidden tab cannot stretch it.
  const JUMP_INTERVAL_MS = 1500;
  // Attempts this close together stop after MAX_JUMPS and carry on at
  // JUMP_BACKOFF_MS. Stopping outright was worse than the thing it guarded
  // against: a prompt the page would not render while the tab was hidden was
  // then left alone for as long as the tab stayed hidden, which is the whole
  // failure this file exists to prevent. The cap only decides how often to try,
  // not whether to keep trying.
  const MAX_JUMPS = 5;
  const JUMP_BACKOFF_MS = 30000;
  let lastJumpAt = 0, jumpAttempts = 0, reportedStall = false;
  let lastMarkerText = '', scroller = null;

  function resetJumps() { jumpAttempts = 0; reportedStall = false; }

  // The pill is found by its text rather than a class, because the class is
  // Foundry's and the sentence is the product's. A TreeWalker does not cross a
  // shadow boundary, so the panel's own log cannot match itself.
  function findPendingMarker() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!PENDING_PROMPT.test(node.nodeValue || '')) continue;
      const el = node.parentElement;
      if (!el) continue;
      return el.closest('button, [role="button"], a') || el;
    }
    return null;
  }

  // The transcript is the tallest thing on the page with a scrollbar of its own.
  // The result is cached because finding it costs a computed style per
  // candidate, and it is only looked for again if the page swaps it out. The
  // floor on clientHeight is what keeps a small scrolling widget with a lot of
  // content in it from winning on scroll room alone.
  function findScroller() {
    if (scroller && scroller.isConnected && scroller.scrollHeight > scroller.clientHeight) {
      return scroller;
    }
    scroller = null;
    let most = 0;
    document.querySelectorAll('div, main, section, ul, ol').forEach(el => {
      const room = el.scrollHeight - el.clientHeight;
      if (room <= most || el.clientHeight < 200) return;
      const overflow = getComputedStyle(el).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll') return;
      most = room;
      scroller = el;
    });
    return scroller;
  }

  // What to send when a stall has to be explained. Whether the button is in the
  // document at all is the one thing that separates a list that has not rendered
  // the row from a row that is there and not being matched, and it cannot be
  // read off the panel. Flat text rather than an object, because an object
  // arrives in the console collapsed and gets reported as "Object". The
  // visibility comes from the real reader, so the spoof cannot lie in a
  // diagnostic.
  // allowByText is counted separately and from textContent, which needs no
  // rendering of any kind. A button reported by it and not by the labels beside
  // it is a button that is in the document and is not being matched, which is a
  // bug here. Neither of them finding anything is the page not having put the
  // row in the document, which is not.
  function stallReport() {
    const buttons = Array.from(document.querySelectorAll('button'));
    const labels = buttons.map(labelFor).filter(t => /allow/i.test(t));
    const byText = buttons.filter(b => /allow/i.test(b.textContent || '')).length;
    return `visibility=${realVisibility()} buttons=${buttons.length}`
      + ` allow=[${labels.join(' | ') || 'none'}] allowByText=${byText}`;
  }

  function reachPendingPrompt() {
    const now = Date.now();
    const wait = jumpAttempts < MAX_JUMPS ? JUMP_INTERVAL_MS : JUMP_BACKOFF_MS;
    if (now - lastJumpAt < wait) return;
    lastJumpAt = now;

    const marker = findPendingMarker();
    if (!marker) { resetJumps(); return; }

    // The pill names the row it is waiting on, so a pill that reads differently
    // is a different prompt and gets the fast attempts again rather than
    // inheriting the backoff from the one before it.
    const label = (marker.textContent || '').trim().slice(0, 120);
    if (label !== lastMarkerText) {
      lastMarkerText = label;
      resetJumps();
    }

    jumpAttempts++;
    marker.click();
    const box = findScroller();
    if (box) box.scrollTop = box.scrollHeight;

    // Said once per prompt, at the point the fast attempts run out. It stays in
    // the log while the slow ones carry on, because scrolling to the prompt is
    // something the user can do and nothing here can make the page render a row
    // it will not render.
    if (jumpAttempts >= MAX_JUMPS && !reportedStall) {
      reportedStall = true;
      appendLog(new Date().toLocaleTimeString(), 'off-screen prompt still out of reach');
      console.warn(`[Auto FDE] off-screen prompt still out of reach; slowing down. ${stallReport()}`);
      // The state as it stands with the row missing. That is the only moment
      // worth mapping, and the one moment nobody can be at the console for.
      probeFrom(marker, 'the pending pill, with no row in the document');
      probeStore();
      return;
    }
    console.log(`[Auto FDE] a prompt is pending off screen; went to it (attempt ${jumpAttempts})`);
  }

  function scan() {
    // Cheap, and only does anything at all in the window between a click and the
    // page having answered it.
    readGrantAfter();
    if (active) {
      // Whether there is a prompt on the page at all, which is what decides
      // between waiting and going to fetch one. A prompt this script will not
      // press still counts as one it can see: reachPendingPrompt() moves the
      // transcript, and doing that every couple of seconds for as long as a
      // deliberately refused prompt is up would fight the user for the scrollbar.
      let sawPrompt = false;
      document.querySelectorAll('button').forEach(btn => {
        const label = labelFor(btn);
        if (!label || !TARGET_LABELS.includes(label.toLowerCase())) return;
        sawPrompt = true;
        if (clicked.has(btn) || btn.disabled) return;
        const context = promptContextFor(btn);
        if (BLOCKED_CONTEXT.some(word => context.includes(word))) return;
        const cat = categoryFor(context);
        if (!cat.enabled) return;

        // The click is not deferred, and must not be. Chrome throttles timers in
        // a hidden tab to once a second, and to once a minute once the tab has
        // been hidden for five, so putting the click behind a setTimeout meant
        // approvals sat there untouched while the tab was in the background and
        // then all fired at once the moment it was looked at. MutationObserver
        // callbacks are not throttled, so clicking from inside this one works
        // whether or not anyone is watching.
        clicked.add(btn);
        btn.style.outline = '2px solid #4ade80';
        // Before the click, not after. The page's own handler sends the grant
        // synchronously, so a window opened after the click has already missed
        // the request it was opened to catch. The probe is before it for the same
        // reason: the row unmounts once the prompt is answered.
        markApprovalClick();
        if (!probedAClick) {
          probedAClick = true;
          probeFrom(btn, 'the Allow button being pressed');
        }
        installStoreWatch(btn);
        noteGrantBefore(btn);
        btn.click();
        record(label, cat.id);
        resetJumps();
      });
      if (!sawPrompt) reachPendingPrompt();
    }
    if (autoResumeEnabled && !recovering) {
      const banner = findErrorBanner();
      if (banner && !handledBanners.has(banner)) handleErrorBanner(banner);
    }
  }

  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });
  scan();

  // Registered in the capture phase on window, which is upstream of anything the
  // page has on document, so an event suppressed here never reaches it.
  on(window, 'visibilitychange', event => {
    if (realVisibility() !== 'visible') {
      if (visibilitySpoofed) event.stopImmediatePropagation();
      return;
    }
    // Being looked at is the one event that changes whether a jump can work,
    // because Chrome starts producing frames again. It has to be acted on rather
    // than waited on: a session sitting on an approval changes nothing, so the
    // observer never fires, and the only thing left is the 2000ms backstop, which
    // Chrome has throttled to once a minute by then.
    resetJumps();
    lastJumpAt = 0;
    scan();
  }, true);

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
    clearTimeout(resumeTimer);
    stopKeepAlive();
    // The page has to be handed the truth back, or it keeps reading its own
    // visibility off a panel that is no longer there.
    stopVisibilitySpoof();
    recovering = false;
    teardown.forEach(undo => undo());
    teardown.length = 0;
    host.remove();
    delete window.__autoFde;
    console.log('[Auto FDE] Stopped. Press the toolbar button to start again.');
  };

  // ---------- Draggable panel ----------
  // The host element is what carries the position, so that is what moves.
  function placeAt(left, top) {
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    // A position saved on a wide screen is off the edge of a narrow one, and a
    // panel nobody can reach cannot be stopped, so every placement is clamped
    // rather than only the ones made by dragging.
    host.style.left = Math.max(0, Math.min(left, window.innerWidth - host.offsetWidth)) + 'px';
    host.style.top = Math.max(0, Math.min(top, window.innerHeight - host.offsetHeight)) + 'px';
  }

  try {
    const saved = JSON.parse(recall('__autoFdePos') || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      placeAt(saved.left, saved.top);
    }
  } catch {}

  let dragging = false, dragOffsetX = 0, dragOffsetY = 0;
  on(header, 'mousedown', e => {
    // The header is the drag handle and the transport controls sit inside it, so
    // a press on one of those is a press, not the start of a drag.
    if (e.button !== 0 || e.target.closest('.ctl')) return;
    dragging = true;
    const rect = host.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    placeAt(rect.left, rect.top);
    e.preventDefault();
  });
  on(window, 'mousemove', e => {
    if (!dragging) return;
    placeAt(e.clientX - dragOffsetX, e.clientY - dragOffsetY);
  });
  on(window, 'mouseup', () => {
    if (!dragging) return;
    dragging = false;
    remember('__autoFdePos', JSON.stringify({
      left: parseFloat(host.style.left),
      top: parseFloat(host.style.top),
    }));
  });

  window.__autoFde = {
    show: () => { host.style.display = 'block'; },
    stop: () => stopBtn.click(),
    watchTraffic,
    probeApproval,
    probeStore,
  };
  console.log('[Auto FDE] Running on', location.href);
})();
