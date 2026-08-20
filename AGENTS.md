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
npm run test:browser                             43 assertions
```

There is no linter and no build step. `check.sh` validates and writes nothing.
The extension is distributed by cloning the repo, so there is nothing to
package and no `dist/`.

## Rules specific to this repo

- **Never hardcode a Foundry hostname.** Not in `manifest.json`, not in a
  constant, not as a default in `storage.js`, not as a fallback. Origins come
  from `chrome.storage.sync` via the options page. Tests use `example.com` hosts.
- **Keep `gate.js` free of `chrome.*`.** It is imported directly by the node test
  suite. Anything needing a chrome API goes in `background.js`, `storage.js` or
  `options.js`.
- **Do not add permissions to widen access.** Host access is
  `optional_host_permissions`, requested per origin at runtime. Adding
  `host_permissions` or a `tabs` permission to make something easier is a
  regression, not a fix.
- **`world: "MAIN"` on the injection is load-bearing, not preference.** See
  DEVELOPER.md. Moving `auto-fde.js` to an isolated world breaks React value
  setting and the double-press guard.
- **A MAIN-world script cannot see `chrome.*`.** Config reaches `auto-fde.js`
  through `window.__autoFdeConfig`, injected by `background.js` first.
- **Never call `chrome.action.disable()`.** In Manifest V3 it does not grey the
  icon; it only breaks the click, turning it into a context menu. The button must
  stay live on every page. Signal readiness with `chrome.action.setIcon()` and
  the tooltip, via `describeButtonState()` in `gate.js`.
- **Report failures where a non-technical user will see them.** The service
  worker console is not that place. Reasons belong in the action's tooltip via
  `describeUrlMismatch()` and `flagProblem()`.
- **Never put the prompt click behind a timer.** Chrome throttles timers in
  hidden tabs, so a deferred click means nothing gets approved until the tab is
  looked at. Click inside the MutationObserver callback, which is not throttled.
  `requestAnimationFrame` is not an escape hatch; it is paused in hidden tabs.
- **The panel lives in a shadow root** (`#af-host`), in the system font, grouped
  into captioned sections by what each control decides. Do not move controls
  between those groups: keeping the tab awake is not a decision about which
  prompts to allow. `document.querySelector` cannot see into it, so tests reach
  it through `document.getElementById('af-host').shadowRoot`.
- **The mark lives in one place**, the inline SVG in `auto-fde.js`. The toolbar
  PNGs are generated from it with `npm run icons`; never hand-edit them, and
  re-run it after changing the mark.
- **Never let a control claim a state it is not in.** The keep-alive box is
  ticked by default, but an `AudioContext` starts suspended without a user
  gesture, so the panel reports `starts on your next click` until it is really
  running.
- **Pause and stop live in the header**, as icons, so they work while the panel
  is collapsed. Do not move them into a footer. The glyph shows the action, the
  colour shows the current state.
- **Keep tooltip and badge text short.** They are read on a hover. A test caps
  the mismatch sentences at sixty characters.
- **The panel must stay bounded.** It sits over somebody's work. Ten log rows, a
  `max-height` on the panel, and log lines written as text nodes rather than
  `innerHTML`.
- **Bump `version` in `auto-fde/manifest.json`** for any shipped change.
  It is the only place a version lives.
- **Docs split:** README.md is installation and setup only. Anything more
  involved goes in DEVELOPER.md.

## Writing style

British English. No em dashes. No filler, hype or soft closers. Comments explain
why, not what, and only where the reason is not obvious from the code. Commit
subjects are imperative and 72 characters or fewer; the body explains why.
