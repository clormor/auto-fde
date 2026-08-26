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
    { id: 'deploy', label: 'Deploy / build actions',  enabled: true,  risk: 3, match: t => /deploy|build|publish|run/i.test(t) },
    { id: 'other',  label: 'Unclassified',            enabled: true,  risk: 0, match: () => true },
  ];
  const BY_RISK = [...CATEGORIES].sort((a, b) => b.risk - a.risk);

  // Runs of whitespace, which textContent keeps and innerText does not. A button
  // written across three lines of JSX has newlines between its words, and
  // TARGET_LABELS is an exact match, so the fallback below is unusable without
  // this.
  function collapse(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  // innerText is what a person reads off the button, which is what TARGET_LABELS
  // is written against, so it comes first. It is empty for a subtree the page is
  // not laying out, and textContent needs none, so textContent is the fallback: a
  // button in the document whose text is exactly one of the labels is one to
  // press whether or not the page is drawing it.
  //
  // aria-label goes last, and the order is the whole point. Foundry's approval
  // buttons carry one, and it describes the action rather than naming the
  // control: `Allow this tool use once` is not in TARGET_LABELS. Ahead of
  // textContent it answered for every button the page had not laid out, so a row
  // sitting in the document went unmatched and was reported as out of reach.
  // Behind it, it only answers for a button with no text of its own, which is
  // what it is for.
  function labelFor(btn) {
    return collapse(btn.innerText) || collapse(btn.textContent)
      || collapse(btn.getAttribute('aria-label'));
  }

  // What is being asked for, which is what the block list and the categories are
  // matched against. How far up to look for it, and how much of a container has
  // to be words before it counts as the prompt rather than the row of controls
  // the button sits in.
  const PROMPT_LEVELS = 5;
  const PROMPT_LIMIT = 400;
  const PROMPT_MIN_CHARS = 12;

  // The words in a container that are not on its buttons. `Allow` and `Deny` are
  // controls, so a container holding nothing else is the action row and not the
  // prompt, and this is what says so. textContent throughout, because a windowed
  // transcript keeps its off-screen rows in the document and does not lay them
  // out, and innerText is empty for every one of them.
  function promptTextOf(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts = [];
    let size = 0;
    for (let node = walker.nextNode(); node && size < PROMPT_LIMIT; node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest('button, [role="button"]')) continue;
      parts.push(node.nodeValue);
      size += (node.nodeValue || '').length;
    }
    return collapse(parts.join(' ')).slice(0, PROMPT_LIMIT).toLowerCase();
  }

  // An approval on this page is a transcript row, not a dialog, so the dialog
  // selector matches nothing and the fallback used to be the button's own parent,
  // which is the action row and whose text is `Allow Deny`. Every prompt
  // therefore classified as Unclassified and the block list never saw a word of
  // what was being asked for. So the search climbs to the first ancestor that carries
  // words of its own, which is the innermost thing holding the sentence. Bounded,
  // because the container above the row is the transcript, and matching the block
  // list against a whole session would refuse on a word somebody typed an hour
  // ago.
  function promptContextFor(btn) {
    const dialog = btn.closest('[role="dialog"], [role="alertdialog"], .dialog, .modal');
    if (dialog) return promptTextOf(dialog);
    let el = btn.parentElement;
    for (let level = 0; el && level < PROMPT_LEVELS; level++, el = el.parentElement) {
      const text = promptTextOf(el);
      if (text.length >= PROMPT_MIN_CHARS) return text;
    }
    return '';
  }
  function categoryFor(context) {
    return BY_RISK.find(c => c.match(context));
  }

  const clicked = new WeakSet();
  // Prompts the block list has held back, so each is said once rather than on
  // every mutation for as long as the row is up.
  const refused = new WeakSet();
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

  // Nothing is created until the page has been activated. An AudioContext built
  // without a gesture cannot start, and Chrome writes its own warning into the
  // page's console saying so, which is somebody else's console to be littering.
  // userActivation.hasBeenActive says whether the page has already been used, so
  // a panel opened on a session somebody has been working in starts the audio at
  // once and everything else waits for the first click.
  function startKeepAlive() {
    if (keepAliveOn) return;
    keepAliveOn = true;
    if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
      openAudio();
      return;
    }
    armGesture();
  }

  function openAudio() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.001;
    osc.frequency.value = 20000;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    audioCtx.__osc = osc;
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
      if (!keepAliveOn) return;
      if (audioCtx) settleKeepAlive();
      else openAudio();
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
    // There may be no context at all: the box can be ticked on a page nobody has
    // touched yet, in which case this is still waiting for the first click.
    if (audioCtx) {
      audioCtx.__osc.stop();
      audioCtx.close();
      audioCtx = null;
    }
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
  }

  function stopVisibilitySpoof() {
    if (!visibilitySpoofed) return;
    // Own properties, so deleting them uncovers the real getters on the
    // prototype rather than leaving the page with no answer at all.
    delete document.hidden;
    delete document.visibilityState;
    visibilitySpoofed = false;
  }

  // ---------- Network-error auto-resume ----------
  // Set from the checkbox, which carries the default so the two cannot drift.
  let autoResumeEnabled = false;
  let bridgeEnabled = false;
  let recovering = false;
  // Stop has to reach a send that is between its two waits, so the waits check
  // this rather than a timer handle being cleared.
  let stopped = false;
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

  // The send control. One exact aria-label was the whole of this, which is the
  // same brittleness that stopped Allow buttons being matched: a label is
  // Foundry's to rename and this had no second way to find it. aria-label across
  // every button first, since that is what the control actually carries, then the
  // visible text, which catches one whose label has been renamed but still reads
  // Send.
  const SEND_LABEL = /send message|^send$|submit/i;
  function findSendButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    return buttons.find(btn => SEND_LABEL.test(collapse(btn.getAttribute('aria-label'))))
      || buttons.find(btn => SEND_LABEL.test(collapse(btn.innerText) || collapse(btn.textContent)))
      || null;
  }
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

  // The rich input is a Slate editor and keeps its own model, which no DOM
  // technique updates: a synthetic paste, an InputEvent('beforeinput') and
  // document.execCommand('insertText') all leave the model empty, and the last
  // two paint the text on screen regardless, so the composer looks filled while
  // the send button sends nothing. The text goes through the editor object
  // instead, reached from the editable element's React fiber.
  const EDITOR_LEVELS = 60;

  function looksLikeEditor(value) {
    return !!value && typeof value === 'object' && Array.isArray(value.children)
      && typeof value.insertText === 'function' && typeof value.apply === 'function';
  }

  function slateEditorFrom(el) {
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!key) return null;
    let fiber = el[key];
    for (let i = 0; i < EDITOR_LEVELS && fiber; i++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && looksLikeEditor(props.editor)) return props.editor;
      if (looksLikeEditor(fiber.memoizedState && fiber.memoizedState.editor)) {
        return fiber.memoizedState.editor;
      }
    }
    return null;
  }

  // Slate refuses an edit with no selection, and an editor nobody has clicked in
  // has none. The end of the document is where typing would have gone.
  function endPointOf(editor) {
    const path = [];
    let node = editor;
    while (node && Array.isArray(node.children) && node.children.length) {
      const last = node.children.length - 1;
      path.push(last);
      node = node.children[last];
    }
    return { path, offset: typeof node?.text === 'string' ? node.text.length : 0 };
  }

  function insertThroughEditor(el, text) {
    const editor = slateEditorFrom(el);
    if (!editor) return false;
    try {
      if (!editor.selection) {
        const point = endPointOf(editor);
        editor.apply({
          type: 'set_selection',
          properties: null,
          newProperties: { anchor: point, focus: point }
        });
      }
      editor.insertText(text);
      return true;
    } catch (err) {
      console.warn('[Auto FDE] The editor refused the text:', err);
      return false;
    }
  }

  // What the send button will read, rather than what the DOM happens to show:
  // Slate renders the model into these, and renders its placeholder instead when
  // the model is empty.
  function richInputHolds(el, text) {
    const rendered = Array.from(el.querySelectorAll('[data-slate-string="true"]'))
      .map(n => n.textContent).join('');
    return rendered.includes(text.slice(0, 40));
  }

  // Puts text in the chat and sends it, for both the network-error resume and
  // the requests handled below. requireText decides what happens when the text
  // will not go in: a request needs its words, so it fails; the resume only needs
  // the session moving, which an empty send does, so it reports which it did.
  async function composeAndSend(text, { requireText }) {
    const textarea = findFallbackTextarea();
    let carriedText = false;

    if (textarea) {
      if (!setTextareaValue(textarea, text)) {
        return { ok: false, error: 'the chat textarea has no value setter to call' };
      }
      carriedText = true;
    } else {
      const rich = findRichInput();
      if (!rich) return { ok: false, error: 'no chat input on this page' };
      // The editor route first: it is the only one that changes Slate's model.
      // The paste stays behind it because it costs one event, and an editor that
      // accepts it needs no code change here.
      if (!insertThroughEditor(rich, text)) pasteIntoRichInput(rich, text);
      await new Promise(r => setTimeout(r, 300));
      if (stopped) return { ok: false, error: 'stopped' };
      carriedText = richInputHolds(rich, text);
      if (!carriedText && requireText) {
        return { ok: false, error: 'the editor would not take the text' };
      }
    }

    // The editor needs a turn to take the text before the button will send it.
    // This is the one deferred action in the script, and it is not the prompt
    // click: a resume that lands late in a throttled tab still resumes, whereas
    // a prompt click that lands late is a session left sitting unanswered.
    await new Promise(r => setTimeout(r, 300));
    if (stopped) return { ok: false, error: 'stopped' };

    // Looked for after the text is in, not before. A composer with nothing in it
    // need not render the control at all, and looking first reported no send
    // button on a page that grows one the moment it has something to send. It is
    // also found fresh rather than held across the two waits, since the page
    // re-renders the composer around the text and a reference taken before that
    // is a detached node.
    const sendBtn = findSendButton();
    if (!sendBtn) {
      const seen = document.querySelectorAll('button, [role="button"]').length;
      return { ok: false, error: `no send button on this page (${seen} controls seen)` };
    }
    sendBtn.click();
    return { ok: true, carriedText };
  }

  async function sendResumeMessage() {
    const result = await composeAndSend(RESUME_TEXT, { requireText: false });
    if (!result.ok) {
      if (!stopped) reportResume('could not send the resume message', true);
      return false;
    }
    recordResume(result.carriedText);
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
      const ok = await sendResumeMessage();
      if (ok) reportResume('watching');
    }
    recovering = false;
  }

  // ---------- Answering a prompt with no row ----------
  // The whole point of the tool, and the only thing that works in a background
  // tab. Chrome draws no frames for a hidden tab, so the windowed transcript
  // never mounts the row and there is no button in the document to press. The
  // pending item is in the session's own store the whole time, and the store is
  // reachable from the pill, so the answer is written there instead.
  //
  // What a click does, measured from a live session: it sends
  // removeToolApprovalOverride, then upsertChildContextItem carrying the item
  // with its toolResponse set, then changeRequestStatus. So this sets the same
  // response on the same item and starts the loop, which is what issues the
  // status change itself.
  // Read off the wire, and the store's reducer does not answer to it: it throws
  // `Unhandled match for value` naming the whole event, the same exhaustive-match
  // error store.dispatch gives. A name the network uses is not necessarily a name
  // the reducer has a case for, so this is a starting point and learnEvent()
  // replaces it with the one a click is seen to send.
  const UPSERT_EVENT = 'upsertChildContextItem';
  // What a click was measured to write. Learning replaces it when a click is
  // seen, because a measured constant is a constant that can rot.
  const DEFAULT_RESPONSE = { state: 'requested' };
  const PENDING_STATE = /pending/i;
  const STATE_INTERVAL_MS = 1000;
  // The item is nested under content on the wire and flat in the store, so a few
  // levels are searched rather than one.
  const ITEM_SEARCH_DEPTH = 4;
  const RESPONSE_LIMIT = 400;
  // Far enough to reach the store from a transcript row, which sits some sixty
  // components below it. A shorter walk reaches it from the pill and reports that
  // no store exists from anywhere else.
  const STORE_LEVELS = 200;
  const REACT_FIBER = /^__reactFiber\$|^__reactInternalInstance\$/;
  const ITEM_ID_PROPS = ['toolUseId', 'contextItemId', 'maybePendingUserActionContextItemId'];

  let lastStateTryAt = 0;
  let learnedResponse = null;
  let learnedEvent = null;
  // Set across this script's own call into the reducer, so the watch above can
  // tell the page's events from its own. __setState is synchronous, measured, so
  // the flag cannot outlive the call; the finally is there in case that changes.
  let writingOurOwn = false;
  let knownStore = null;
  let watchedAgent = null;
  let awaitingGrant = null, grantRead = false;
  const refusedWithoutARow = new Set();
  const failedToAnswer = new Set();

  function shorten(text, limit) {
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }

  function fiberFor(el) {
    const key = Object.keys(el).find(name => REACT_FIBER.test(name));
    return key ? el[key] : null;
  }

  // Anything the page threaded down as a prop, taken from wherever it is still
  // mounted. startAgentLoop is in reach from the pill, which is what lets this
  // work with no row.
  function propFrom(el, names, wanted) {
    let fiber = fiberFor(el);
    for (let level = 0; fiber && level < STORE_LEVELS; level++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      for (const name of names) {
        if (typeof props[name] === wanted && props[name]) return props[name];
      }
    }
    return null;
  }

  // The store is a context value carrying {__setState, agent, dispatch,
  // getSnapshot, subscribe} over the agent state. dispatch is there and is not
  // used: see writeAnswer. Cached, because it is the same one for the life of a
  // session and the walk is not free.
  function looksLikeStore(value) {
    return !!value && typeof value === 'object'
      && typeof value.getSnapshot === 'function'
      && typeof value.__setState === 'function'
      && !!value.agent && typeof value.agent.onEvent === 'function';
  }

  // The name of the event a click puts into the store, taken from a click rather
  // than assumed. UPSERT_EVENT is a wire name and the reducer has no case for it,
  // which is the whole reason answering without a row has never worked on this
  // build. The script presses real Allow buttons several times an hour whenever
  // the transcript has rendered the row, and each one goes through here, so the
  // right name arrives on its own and is used the next time there is no row.
  //
  // Passive: the real function is called with the same arguments and its result
  // returned untouched, and Stop puts it back. Only the type is read. The event
  // carries the item, which is somebody's transcript and their tool arguments.
  function learnEvent(store) {
    const agent = store.agent;
    if (!agent || watchedAgent === agent) return;
    watchedAgent = agent;
    const real = agent.onEvent;
    const wrapper = function (state, event) {
      // Never this script's own write. It would learn the name it just guessed,
      // print a line saying an approval sends it, and be no better informed.
      if (!writingOurOwn && event && typeof event.type === 'string' && event.contextItem
          && event.contextItem.toolResponse && learnedEvent !== event.type) {
        learnedEvent = event.type;
        appendLog(new Date().toLocaleTimeString(), `learned that an approval sends ${event.type}`);
        console.log(`[Auto FDE] an approval sends ${event.type}`);
      }
      return real.apply(this, arguments);
    };

    agent.onEvent = wrapper;
    // Checked, because this file is not a module and the assignment is not in
    // strict mode: a frozen object or an accessor with no setter takes it
    // silently and leaves the original in place, which reads exactly like a page
    // that never calls the property.
    if (agent.onEvent !== wrapper) {
      try {
        Object.defineProperty(agent, 'onEvent',
          { value: wrapper, writable: true, configurable: true });
      } catch (err) {
        console.warn(`[Auto FDE] the session's events cannot be watched: ${err.message}`);
      }
    }
    if (agent.onEvent !== wrapper) {
      watchedAgent = null;
      console.warn('[Auto FDE] the session would not let its events be watched;'
        + ' the name an approval sends cannot be learned.');
      return;
    }
    teardown.push(() => {
      agent.onEvent = real;
      if (watchedAgent === agent) watchedAgent = null;
    });
  }

  function getStore(el) {
    if (knownStore) return knownStore;
    let fiber = fiberFor(el);
    for (let level = 0; fiber && level < STORE_LEVELS; level++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object' && looksLikeStore(props.value)) {
        knownStore = props.value;
        learnEvent(knownStore);
        return knownStore;
      }
    }
    return null;
  }

  function snapshotOf(store) {
    try {
      return store.getSnapshot();
    } catch (err) {
      console.warn(`[Auto FDE] the session's store would not report its state: ${err.message}`);
      return null;
    }
  }

  function findToolResponse(value, depth) {
    if (!value || typeof value !== 'object' || depth > ITEM_SEARCH_DEPTH) return null;
    if (value.toolResponse) return value;
    for (const key of Object.keys(value)) {
      const found = findToolResponse(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function findPendingItem(map) {
    if (!map || typeof map !== 'object') return null;
    for (const key of Object.keys(map)) {
      const holder = findToolResponse(map[key], 0);
      const state = holder && holder.toolResponse && holder.toolResponse.state;
      if (typeof state === 'string' && PENDING_STATE.test(state) && holder.id) return holder;
    }
    return null;
  }

  // ---------- Learning what an approval writes ----------
  // The response a click produces, read out of the store either side of one. The
  // constant above came from this and is only a starting point: a session running
  // a newer build teaches this the current answer the first time it presses
  // anything. The item watched is the one the button belongs to, taken off its own
  // fibers, because with several prompts queued the first pending item in the map
  // is not necessarily the one being answered.
  function noteGrantBefore(el) {
    if (grantRead || awaitingGrant) return;
    const store = getStore(el);
    const snapshot = store && snapshotOf(store);
    const map = snapshot && snapshot.contextMap;
    if (!map) return;
    const id = propFrom(el, ITEM_ID_PROPS, 'string');
    const holder = id ? findToolResponse(map[id], 0) : findPendingItem(map);
    if (!holder) return;
    awaitingGrant = { id: holder.id, before: JSON.stringify(holder.toolResponse) };
  }

  function readGrantAfter() {
    if (!awaitingGrant || !knownStore) return;
    const snapshot = snapshotOf(knownStore);
    const map = snapshot && snapshot.contextMap;
    const holder = map ? findToolResponse(map[awaitingGrant.id], 0) : null;
    if (!holder) return;
    const after = JSON.stringify(holder.toolResponse);
    if (after === awaitingGrant.before) return;
    learnedResponse = holder.toolResponse;
    console.log(`[Auto FDE] an approval writes ${shorten(after, RESPONSE_LIMIT)}`);
    awaitingGrant = null;
    grantRead = true;
  }

  // ---------- Writing the answer ----------
  // What the state route could actually see, for when it declines. The reason
  // names which check stopped it; this names what was there, which is the
  // difference between the session's shape having moved and there being nothing
  // to answer. Without it a decline says a store is unreachable and not what was
  // reachable instead, and the next step is guesswork.
  //
  // Keys and response states only. A context map is somebody's transcript and a
  // tool request is their data, and this goes into a console whose contents get
  // pasted into chat windows.
  const REPORT_KEYS = 12;
  function storeReport() {
    const marker = findPendingMarker();
    if (!marker) return 'pill=none';
    const store = getStore(marker);
    if (!store) return 'pill=yes store=none';
    const snapshot = snapshotOf(store);
    if (!snapshot) return 'pill=yes store=yes snapshot=none';
    const map = snapshot.contextMap;
    if (!map || typeof map !== 'object') {
      return 'pill=yes store=yes contextMap=none'
        + ` snapshot=[${Object.keys(snapshot).slice(0, REPORT_KEYS).join(' ')}]`;
    }
    const states = [];
    let shape = 'none';
    for (const key of Object.keys(map)) {
      const holder = findToolResponse(map[key], 0);
      if (!holder) continue;
      if (shape === 'none') shape = Object.keys(holder).slice(0, REPORT_KEYS).join(' ');
      const state = holder.toolResponse && holder.toolResponse.state;
      if (typeof state !== 'string') continue;
      // Whether the holder carries an id is load-bearing: findPendingItem() needs
      // one, so an item nested a level deeper than expected reads as nothing
      // pending at all.
      states.push(holder.id ? state : `${state} (no id)`);
    }
    return `pill=yes store=yes items=${Object.keys(map).length}`
      + ` responses=[${states.slice(0, REPORT_KEYS).join(' | ') || 'none'}]`
      + ` item=[${shape}]`;
  }

  // Every way out of here used to be silent, which made a refusal look identical
  // to the feature being dead. Each reason is said once, and it goes in the panel
  // as well as the console: the console is a different console from the service
  // worker's, nobody outside this repo opens either, and a reason nobody reads is
  // the same as no reason. That is twice now that the fact needed to fix a stall
  // was sitting in a console while the panel said something unactionable.
  const declined = new Set();
  function decline(reason) {
    if (!declined.has(reason)) {
      declined.add(reason);
      appendLog(new Date().toLocaleTimeString(), reason);
      console.warn(`[Auto FDE] no-button answer declined: ${reason}. ${storeReport()}`);
    }
    return false;
  }

  // The tool's name, and nothing else. Its arguments looked like a better signal
  // and are not: update_notepad_dsl carries an entire notepad document, so a
  // transcript mentioning production anywhere refused every notepad write in the
  // session. Arguments are content, and content is not intent.
  function stateContextFor(item) {
    return `${item.toolName || ''} ${item.toolDisplayName || ''}`.toLowerCase();
  }

  // store.dispatch refuses the very event its own reducer accepts, with an
  // exhaustive match error: the page reaches the reducer through a reference the
  // store closed over, so the public property is a different door. What does work
  // is running the reducer and handing the store the result, as an updater.
  // agent.onEvent(state, event) is the exact call the page makes, observed.
  const refusedEvents = new Set();
  function writeAnswer(store, event) {
    try {
      writingOurOwn = true;
      store.__setState(current => store.agent.onEvent(current, event));
      return true;
    } catch (err) {
      if (refusedEvents.has(event.type)) return false;
      refusedEvents.add(event.type);
      // Shortened, because the page's own message embeds the entire event it
      // could not match, which is the item, which is the user's transcript and
      // their tool arguments. One refusal put a whole Slack message body and a
      // handful of RIDs into a console whose contents get pasted into chat
      // windows.
      console.warn(`[Auto FDE] the session refused ${event.type}: ${shorten(err.message, RESPONSE_LIMIT)}`);
      return false;
    } finally {
      writingOurOwn = false;
    }
  }

  // The route left when the reducer has no case for the event. It sets the
  // response on the item and hands the store the state, which is the same single
  // field the reducer would have set and nothing besides: no other item is
  // touched and nothing on this one is rewritten. It is second, not preferred,
  // because the reducer may do bookkeeping this cannot see, and it is not
  // trusted either: the caller reads the item back and records a write that did
  // not stick, and the log says which route answered.
  function writeResponseDirectly(store, pending, response) {
    try {
      store.__setState(current => {
        const map = current && current.contextMap;
        if (!map || !map[pending.id]) return current;
        const item = Object.assign({}, map[pending.id], { toolResponse: response });
        return Object.assign({}, current,
          { contextMap: Object.assign({}, map, { [pending.id]: item }) });
      });
      return true;
    } catch (err) {
      console.warn(`[Auto FDE] the session refused a direct write: ${shorten(err.message, RESPONSE_LIMIT)}`);
      return false;
    }
  }

  function answerWithoutARow(anchor) {
    const response = learnedResponse || DEFAULT_RESPONSE;
    const store = getStore(anchor);
    if (!store) return decline("the session's store is not reachable from the pill");
    const snapshot = snapshotOf(store);
    const map = snapshot && snapshot.contextMap;
    if (!map) return decline('the store reports no context map');
    const pending = findPendingItem(map);
    if (!pending) return decline('nothing in the session is pending approval');

    // Keyed on the event as well as the item, so an answer refused under the
    // wire name is tried again once a click has taught this the reducer's name
    // rather than being written off with the item.
    const type = learnedEvent || UPSERT_EVENT;
    const attempt = `${pending.id}:${type}`;
    if (failedToAnswer.has(attempt)) return false;

    const context = stateContextFor(pending);
    if (BLOCKED_CONTEXT.some(word => context.includes(word))) {
      if (!refusedWithoutARow.has(pending.id)) {
        refusedWithoutARow.add(pending.id);
        appendLog(new Date().toLocaleTimeString(), `refused ${pending.toolName || 'a prompt'}`);
        console.warn(`[Auto FDE] ${pending.toolName} is on the block list`);
      }
      return false;
    }
    const cat = categoryFor(context);
    if (!cat.enabled) return decline(`the ${cat.id} category is unticked`);

    // Only the response changes. Everything else on the item belongs to the page,
    // and rewriting any of it would be rewriting somebody's transcript.
    const item = Object.assign({}, pending, { toolResponse: response });
    let route = 'no row';
    if (!writeAnswer(store, { type, contextItem: item })) {
      // The reducer having no case for the event is not something that changes
      // between two ticks, so the direct write is tried here rather than the
      // whole thing being retried every second: one session's console held 1239
      // identical refusals of the same write.
      if (!writeResponseDirectly(store, pending, response)) {
        failedToAnswer.add(attempt);
        appendLog(new Date().toLocaleTimeString(), `the session refused a ${type} answer`);
        return false;
      }
      route = 'no row, direct';
    }

    // Verified rather than assumed. A half-answered prompt is worse than a
    // waiting one, so a write the store did not take is reported and left alone.
    const now = snapshotOf(store);
    const holder = now && now.contextMap ? findToolResponse(now.contextMap[pending.id], 0) : null;
    if (!holder || JSON.stringify(holder.toolResponse) !== JSON.stringify(response)) {
      // Recorded against the item, not just reported, so a write the session
      // ignores is attempted once rather than every second for as long as the
      // prompt is up.
      failedToAnswer.add(attempt);
      appendLog(new Date().toLocaleTimeString(), 'the session would not take the answer');
      console.warn(`[Auto FDE] ${pending.toolName} was answered and the session did not take it.`);
      return false;
    }

    // A click sends changeRequestStatus after the upsert, and that is what
    // startAgentLoop does, so the loop is started rather than the status forged.
    const start = propFrom(anchor, ['startAgentLoop'], 'function');
    if (start) {
      try {
        start();
      } catch (err) {
        console.warn(`[Auto FDE] the session's agent loop would not start: ${err.message}`);
      }
    } else {
      console.warn('[Auto FDE] no way to start the agent loop is in reach.');
    }
    record(pending.toolName || 'prompt', `${cat.id} · ${route}`);
    return true;
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
      /* Which revision is running, so a bug report can name one. */
      .ver { color: #949cab; font-size: 11px; font-variant-numeric: tabular-nums; }
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
        <span class="ver" id="af-version" title="Extension version"></span>
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
            <input type="checkbox" id="af-bridge-toggle" checked>
            <span>Accept messages from apps on this device</span>
          </label>
          <div class="hint">An app on your device can reply in this chat while you are away.</div>
        </div>

        <div class="sec">
          <div class="cap">Recent activity</div>
          <div class="log" id="af-log"></div>
        </div>

      </div>
    </div>`;

  const panel = shadow.querySelector('#af-panel');
  const header = shadow.querySelector('#af-header');
  const catsEl = shadow.querySelector('#af-cats');
  const countEl = shadow.querySelector('#af-count');
  // manifest.json holds the only version number in the repo, and background.js
  // passes it through. Run by hand there is none, so the slot comes out rather
  // than sitting empty in the header.
  const versionEl = shadow.querySelector('#af-version');
  if (config.version) versionEl.textContent = 'v' + config.version;
  else versionEl.remove();
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

  // Ticked by default: the point of it is unblocking a session while nobody is
  // at the machine, and a default that had to be set again on every open would
  // fail exactly then. Only code already running on this device can ask, and
  // every message is in the log. Unticked, requests are refused rather than
  // ignored, so whatever asked is told no instead of hanging.
  const bridgeBox = shadow.querySelector('#af-bridge-toggle');
  bridgeBox.onchange = e => { bridgeEnabled = e.target.checked; };
  bridgeEnabled = bridgeBox.checked;

  // Neither answering a prompt with no button nor telling the page it is in front
  // is a preference. The first is the job; the second is how the page is kept
  // from deferring its own work. A setting only earns its place when the answer
  // could reasonably be no, which is why the two above have one and these do not.
  startVisibilitySpoof();

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
      // The line ellipsises at the panel's width, and the reasons are sentences.
      w.title = entry.what;
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

  // ---------- Messages from apps on this device ----------
  // Code outside the page cannot reach this chat: an isolated world shares the
  // DOM but not the globals, its events arrive untrusted, and the page's CSP
  // refuses an injected script that would escape it. This script already runs in
  // the page's context, so an app asks it to do the send instead. The request
  // arrives as a body attribute and the outcome goes back as one, attributes
  // being the only thing both worlds can see.
  //
  // Writing the message to the session over Foundry's API would work from
  // anywhere, but it moves the thread version, and the page then refuses its own
  // next turn until it is reloaded, which takes this panel down with it.
  const REQUEST_ATTR = 'data-auto-fde-request';
  const RESULT_ATTR = 'data-auto-fde-result';
  const handledRequests = new Set();

  function answerRequest(id, ok, error) {
    document.body.setAttribute(RESULT_ATTR, JSON.stringify(error ? { id, ok, error } : { id, ok }));
  }

  function handleRequest(raw) {
    let request;
    try { request = JSON.parse(raw); } catch { return; }
    if (!request || typeof request.id !== 'string' || typeof request.text !== 'string') return;
    // The attribute stays on the body after it is answered, so every mutation of
    // any other attribute would otherwise resend the last message.
    if (handledRequests.has(request.id)) return;
    handledRequests.add(request.id);

    const time = new Date().toLocaleTimeString();
    if (!bridgeEnabled) {
      appendLog(time, 'refused a message from this device');
      answerRequest(request.id, false, 'the panel is not accepting messages from this device');
      return;
    }
    if (!request.text.trim()) {
      answerRequest(request.id, false, 'no text to send');
      return;
    }

    // requireText, because the words are the whole request. Sending without them
    // would press send on an empty composer, which the session answers by running
    // its previous turn again: a reply that looks delivered and never was.
    composeAndSend(request.text, { requireText: true }).then(result => {
      // Stop can land inside the send. The panel is gone by then, so there is no
      // log to write to, but whatever asked is still waiting on an answer.
      if (!stopped) {
        appendLog(new Date().toLocaleTimeString(), result.ok
          ? 'sent a message from this device'
          : 'could not send a message from this device');
      }
      answerRequest(request.id, result.ok, result.ok ? null : result.error);
    });
  }

  // An observer rather than a timer: Chrome throttles timers in a tab nobody is
  // looking at, and this has to answer while the tab is in the background.
  const requestObserver = new MutationObserver(() => {
    const raw = document.body.getAttribute(REQUEST_ATTR);
    if (raw) handleRequest(raw);
  });
  requestObserver.observe(document.body, { attributes: true, attributeFilter: [REQUEST_ATTR] });
  // A request written before the panel was opened is still worth answering: the
  // caller is waiting on the result attribute either way.
  const pendingAtStart = document.body.getAttribute(REQUEST_ATTR);
  if (pendingAtStart) handleRequest(pendingAtStart);

  teardown.push(() => {
    requestObserver.disconnect();
    document.body.removeAttribute(REQUEST_ATTR);
    document.body.removeAttribute(RESULT_ATTR);
  });


  function record(text, cat) {
    count++; countEl.textContent = count;
    const t = new Date().toLocaleTimeString();
    appendLog(t, `${text} · ${cat}`);
    console.log(`[Auto FDE] ${t} — [${cat}] clicked "${text}"`);
  }
  // Says which of the two happened. An empty send still resumes the session, so
  // a log claiming the text was sent when it was not would go unnoticed.
  function recordResume(carriedText) {
    const t = new Date().toLocaleTimeString();
    const what = carriedText ? 'sent the resume message' : 'resumed the session, without the text';
    appendLog(t, what);
    console.log(`[Auto FDE] ${t} — ${what}`);
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

  // What a stall looks like from inside. Whether there is an Allow button in the
  // document at all separates a list that has not rendered the row from a row
  // that is there and is not being matched, and nothing in the panel says which.
  // Flat text, because an object arrives in the console collapsed and comes back
  // quoted as "Object". allowByText counts textContent matches, which need no
  // rendering, so a row that is present but unmatched cannot be mistaken for one
  // that is absent. Visibility comes from the real reader, so the spoof cannot
  // lie in a diagnostic.
  function stallReport() {
    const buttons = Array.from(document.querySelectorAll('button'));
    const labels = buttons.map(labelFor).filter(t => /allow/i.test(t));
    const byText = buttons.filter(b => /allow/i.test(b.textContent || '')).length;
    return `visibility=${realVisibility()} buttons=${buttons.length}`
      + ` allow=[${labels.join(' | ') || 'none'}] allowByText=${byText}`;
  }

  // Buttons this script would press if it could read them, counted off
  // textContent, which needs no rendering of any kind. One of these sitting
  // unpressed is a row that is in the document and is not being matched, which is
  // a bug in this file; none of them is the page not having rendered the row,
  // which nothing here can fix. The two states read identically in the panel and
  // need different reports, and the fact that separates them was only ever in the
  // console.
  function unmatchedAllows() {
    return Array.from(document.querySelectorAll('button')).filter(btn =>
      !clicked.has(btn) && !btn.disabled
      && TARGET_LABELS.includes(collapse(btn.textContent).toLowerCase())).length;
  }

  function reachPendingPrompt() {
    const now = Date.now();

    // The state route goes first and on its own clock. It is not scrolling and
    // must not inherit the jump backoff: a prompt that can be answered outright
    // should not wait thirty seconds because five scrolls failed before it.
    if (now - lastStateTryAt >= STATE_INTERVAL_MS) {
      lastStateTryAt = now;
      const pendingMarker = findPendingMarker();
      if (pendingMarker && answerWithoutARow(pendingMarker)) {
        resetJumps();
        return;
      }
    }

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
      // The console changes route without reloading, so a session left behind
      // keeps a store nobody is looking at. A new pill is the cheapest honest
      // moment to look the store up again, rather than walking two hundred
      // components every second on the chance that it moved.
      knownStore = null;
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
      const unmatched = unmatchedAllows();
      const what = unmatched
        ? 'a prompt is on the page and was not matched'
        : 'off-screen prompt still out of reach';
      appendLog(new Date().toLocaleTimeString(), what);
      console.warn(`[Auto FDE] ${what}; slowing down. ${stallReport()}`);
    }
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
        // Said out loud. The count simply stopping moving is what a refusal used
        // to look like, which is indistinguishable from the script having died,
        // and the no-row route has always named the prompts it held back.
        const blocked = BLOCKED_CONTEXT.find(word => context.includes(word));
        if (blocked) {
          if (!refused.has(btn)) {
            refused.add(btn);
            appendLog(new Date().toLocaleTimeString(), `refused a prompt naming ${blocked}`);
            console.warn(`[Auto FDE] a prompt naming "${blocked}" is on the block list`);
          }
          return;
        }
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
        // Before the click, because the row unmounts as soon as the prompt is
        // answered and the item's response has to be read while it is still there.
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
    stopped = true;
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

  window.__autoFde = { show: () => { host.style.display = 'block'; }, stop: () => stopBtn.click() };
  console.log('[Auto FDE] Running on', location.href);
})();
