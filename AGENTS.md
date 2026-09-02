# AGENTS.md

Instructions for coding agents working in this repository. Humans want
[README.md](README.md) or [DEVELOPER.md](DEVELOPER.md).

## What this is

An unpacked Manifest V3 Chrome extension that clicks `Allow` prompts on Palantir
Foundry AI FDE session pages. It is open source and instance-agnostic: the
Foundry origins it runs on are configured by the user at runtime.

## Verify before reporting done

```
npm test      node only, no browser, no network
./check.sh    required files, manifest parses, all JS parses, version
```

For anything touching `auto-fde.js`, `manifest.json`, `options.*` or the
injection path, also run the browser suite:

```
npm install && npx playwright install chromium   (once)
npm run test:browser
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
  an isolated world breaks React value setting and the double-press guard.
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
- **A prompt in a hidden tab has no button, and clicking cannot answer it.**
  Chrome draws no frames for a tab nobody is looking at, so the windowed
  transcript never mounts the row. Measured repeatedly:
  `visibility=hidden buttons=110 allow=[none] allowByText=0`. Anything that only
  looks at `document.querySelectorAll` is dead in that state.
- **`answerWithoutARow()` is the feature, not a fallback.** The pending item is in
  the session's store throughout, reachable from the pending pill, so the answer
  is written there: `toolResponse` set to `{state: "requested"}`,
  `upsertChildContextItem` sent, `startAgentLoop` called. That is what a click
  does, measured from a live session.
- **Write through the reducer, never `store.dispatch`.** dispatch refuses the very
  event the reducer accepts, with `Unhandled match for value`; the page reaches the
  reducer through a closed-over reference. Use
  `__setState(current => agent.onEvent(current, event))`.
- **`STORE_LEVELS` is 200 because a transcript row sits some sixty components
  below the store.** A walk short enough to be worth printing finds the store from
  the pill and nothing from anywhere else, then reports that no store exists.
- **Only the response is rewritten.** Everything else on a context item belongs to
  the page; rewriting any of it rewrites somebody's transcript.
- **Nothing is reported as answered that the store did not take**, and a rejected
  write is recorded against that item rather than retried every second.
- **The block list reads the tool's name, never its arguments.** Arguments are
  content: `update_notepad_dsl` carries a whole notepad, so one mention of
  production refused every notepad write in the session.
- **Every refusal says why, once.** Silence made a refused prompt look identical to
  the whole feature being dead, twice.
- **Foundry's own approval settings are not a substitute.** They do not cover every
  tool and do not reliably hold. Issue #5.
- **The visibility spoof answers the page, not the browser.** `document.hidden`
  and `document.visibilityState` report visible and the going-hidden event is
  stopped at the window in the capture phase, so the page does not defer its own
  work. It cannot make Chrome draw the tab and was measured not to fix the missing
  row, so do not describe it as what makes a background tab work. Let the
  coming-back event through, keep `realVisibility()` reading the truth off the
  prototype, and undo the properties on Stop.
- **Do not bring back the silent-audio keep-alive.** An inaudible oscillator was
  meant to mark the tab audible and exempt it from Chrome's intensive throttling.
  Chrome will not start audio without a gesture on the page and a toolbar press is
  not one, so the box sat ticked while nothing played, and the throttling it was
  supposed to prevent went on regardless. What actually answers a prompt in a
  background tab is `answerWithoutARow()`, which needs no timer to be unthrottled.
- **Neither of those two is a setting.** Answering a prompt with no button is the
  job, and telling the page it is in front is not a preference. A checkbox earns
  its place only where the answer could reasonably be no, which is why
  auto-resume has one and these do not.
- **The panel lives in a shadow root** (`#af-host`), in the system font, grouped
  into captioned sections by what each control decides. Do not move controls
  between those groups: resuming after a network error is not a decision about
  which prompts to allow. `document.querySelector` cannot see into it, so tests
  reach it through `document.getElementById('af-host').shadowRoot`.
- **The mark lives in one place**, the inline SVG in `auto-fde.js`. The toolbar
  PNGs are generated from it with `npm run icons`; never hand-edit them, and
  re-run it after changing the mark.
- **Settings hints say what a setting does, not what it is doing.** There are no
  status readouts in the panel; state goes to the console. A genuine failure
  goes in the activity log: a resume that could not be sent, or a prompt that
  cannot be reached.
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
- **Do not quote counts in the docs.** An assertion total, a file count or a
  line number goes stale on the next change and nobody updates it, so it ends
  up lying. Name the suite and let it report its own total.

## Writing style

British English. No em dashes. No filler, hype or soft closers. Comments explain
why, not what, and only where the reason is not obvious from the code. Commit
subjects are imperative and 72 characters or fewer; the body explains why.
