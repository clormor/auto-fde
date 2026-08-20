# AGENTS.md

Instructions for coding agents working in this repository. Humans want
[README.md](README.md) or [DEVELOPER.md](DEVELOPER.md).

## What this is

An unpacked Manifest V3 Chrome extension that clicks `Allow` prompts on Palantir
Foundry AI FDE session pages. It is open source and instance-agnostic: the
Foundry origins it runs on are configured by the user at runtime.

## Verify before reporting done

```
npm test      49 assertions, node only, no browser, no network
./check.sh    required files, manifest parses, all JS parses, version
```

For anything touching `auto-fde.js`, `manifest.json`, `options.*` or the
injection path, also run the browser suite:

```
npm install && npx playwright install chromium   (once)
npm run test:browser                             82 assertions
```

There is no linter and no build step. `check.sh` validates and writes nothing.
The extension is distributed by cloning the repo, so there is nothing to package
and no `dist/`.

## Rules specific to this repo

- **Never hardcode a Foundry hostname.** Not in `manifest.json`, not in a
  constant, not as a default in `storage.js`, not as a fallback. Origins come
  from `chrome.storage.sync` via the options page. Tests use `example.com`
  hosts.
- **Keep `gate.js` free of `chrome.*`.** It is imported directly by the node
  test suite. Anything needing a chrome API goes in `background.js`,
  `storage.js` or `options.js`.
- **Do not add permissions to widen access.** Host access is
  `optional_host_permissions`, requested per origin at runtime. Adding
  `host_permissions` or a `tabs` permission to make something easier is a
  regression, not a fix.
- **`world: "MAIN"` on the injection is load-bearing.** Moving `auto-fde.js` to
  an isolated world breaks React value setting and the double-press guard. See
  DEVELOPER.md.
- **A MAIN-world script cannot see `chrome.*`.** Config reaches `auto-fde.js`
  through `window.__autoFdeConfig`, injected by `background.js` first.
- **Never call `chrome.action.disable()`.** In Manifest V3 it does not grey the
  icon; it only breaks the click, turning it into a context menu. The button
  must stay live on every page. Signal readiness with `chrome.action.setIcon()`
  and the tooltip, via `describeButtonState()` in `gate.js`.
- **Report failures where a non-technical user will see them.** The service
  worker console is not that place. Reasons belong in the action's tooltip via
  `describeUrlMismatch()` and `flagProblem()`.
- **Never put the prompt click behind a timer.** Chrome throttles timers in
  hidden tabs, so a deferred click means nothing gets approved until the tab is
  looked at. Click inside the MutationObserver callback, which is not throttled.
  `requestAnimationFrame` is not an escape hatch; it is paused in hidden tabs.
- **A prompt may not be in the document at all.** The transcript is a windowed
  list, so an approval that arrives while the user is scrolled up has no button
  to press and produces no mutation. When a scan finds no prompt anywhere,
  `reachPendingPrompt()` presses the page's own "Waiting for tool approval" pill
  and puts the transcript at the bottom by assigning `scrollTop`. Keep both
  halves: the pill is the page's intended route, the assignment is the one that
  works in a tab Chrome has stopped painting. `MAX_JUMPS` sets the pace, not
  whether to keep trying: it must back off to `JUMP_BACKOFF_MS` and never stop,
  because a page that will not render a row while the tab is hidden renders it
  the moment the tab is looked at.
- **Being looked at is an event to act on, not to wait through.** A session
  sitting on an approval mutates nothing, so the observer never fires and the
  backstop timer is throttled to once a minute. The `visibilitychange` listener
  scans immediately and resets the jump budget. Do not remove it.
- **A hidden tab cannot be made to work, and this is settled.** Measured with
  the spoof on, from a background tab: `visibility=hidden buttons=77
  allow=[none] allowByText=0`. Foundry does not mount the row while Chrome is
  not drawing the tab, and no button in the document means nothing to press. The
  answer is a visible window, which the README says, or Foundry's own API, which
  is a different tool. Do not spend another round on the DOM.
- **A console paste and an injection are the same thing.** Identical source, same
  world. If background behaviour differs between them the reason is elsewhere,
  usually session length: a short transcript is not windowed, so a row is in the
  document as soon as React commits it, and a commit needs no frame. Do not add a
  clipboard mode to chase this.
- **`watchTraffic()` logs no headers.** It is the capture step for sending an
  approval rather than clicking one, reached from the console as
  `window.__autoFde.watchTraffic()`, and its output gets pasted into chat
  windows. Headers never. Stop unwraps `fetch`, `XMLHttpRequest` and
  `WebSocket.prototype.send`.
- **`probeApproval()` reports shapes, never contents.** It walks React fibers
  from an Allow button or the pending pill and names components and function
  props. Props on a thread component hold the conversation, fiber props are
  cyclic, and the output gets pasted into chat windows. Do not start printing
  prop values.
- **It reports fields, not bodies, and the click window opens before the
  click.** A thread body buries the field that matters past any truncation, so
  the body is walked and only matching paths are printed. The page sends the
  grant synchronously from its own click handler, so `markApprovalClick()` runs
  immediately before `btn.click()`; moving it into `record()` puts it after the
  click and misses the request.
- **The visibility spoof answers the page, not the browser.** `document.hidden`
  and `document.visibilityState` report visible and the going-hidden event is
  stopped at the window in the capture phase, so the page does not stand down of
  its own accord. It cannot make Chrome draw the tab, so do not describe it as
  fixing background operation. Let the coming-back event through, keep
  `realVisibility()` reading the truth off the prototype for the script's own
  decisions and diagnostics, and undo the properties on Stop.
- **The panel lives in a shadow root** (`#af-host`), in the system font, grouped
  into captioned sections by what each control decides. Do not move controls
  between those groups: keeping the tab awake is not a decision about which
  prompts to allow. `document.querySelector` cannot see into it, so tests reach
  it through `document.getElementById('af-host').shadowRoot`.
- **The mark lives in one place**, the inline SVG in `auto-fde.js`. The toolbar
  PNGs are generated from it with `npm run icons`; never hand-edit them, and
  re-run it after changing the mark.
- **Settings hints say what a setting does, not what it is doing.** There are no
  status readouts in the panel; state goes to the console. A genuine failure
  goes in the activity log: a resume that could not be sent, a prompt that
  cannot be reached, or a keep-alive still waiting for the click on the page
  that Chrome requires before it will start audio.
- **Pause and stop live in the header**, as icons, so they work while the panel
  is collapsed. Do not move them into a footer. The glyph shows the action, the
  colour shows the current state.
- **Keep tooltip and badge text short.** They are read on a hover. A test caps
  the mismatch sentences at sixty characters.
- **The panel must stay bounded.** It sits over somebody's work. Ten log rows, a
  `max-height` on the panel, and log lines written as text nodes rather than
  `innerHTML`.
- **Bump `version` in `auto-fde/manifest.json`** for any shipped change. It is
  the only place a version lives.
- **Docs split:** README.md covers installing, adding a base URL, everyday use
  and first-line troubleshooting, in that order. Design rationale, tests and
  anything a user cannot act on go in DEVELOPER.md.
- **Assertion counts are quoted in this file and DEVELOPER.md.** Change a suite
  and update both.

## Writing style

British English. No em dashes. No filler, hype or soft closers. Comments explain
why, not what, and only where the reason is not obvious from the code. Commit
subjects are imperative and 72 characters or fewer; the body explains why.
