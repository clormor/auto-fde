# Developing Auto FDE

Everything that is not installation. See [README.md](README.md) for that.

## What this does and does not decide for you

Read this before handing it to a colleague.

The extension changes how a console script is delivered. It does not change what
the script does, and it does not review whether auto-clicking a consent prompt is
appropriate for the work in front of you. The prompts exist so a person sees what
the agent is about to do. Anyone running this is choosing to answer a class of
those prompts in advance.

The script clicks `Allow` and `Allow once`. It skips anything labelled with
`always`, `all future`, `forever`, `delete`, `force`, `production` or `deny`, and
the deploy/build category is off until you turn it on. Practical consequences
worth stating out loud:

- Categories are matched on the prompt's visible text with a handful of regexes.
  A prompt whose wording does not mention read, write, edit, update, create,
  deploy, build, publish or run falls into `Unclassified`, which is enabled. The
  default is to allow anything the script cannot classify.
- The block list is a text match on the button label, not on what the action
  does. A destructive action behind a button labelled plainly `Allow` gets
  clicked.
- Leave it running on a long unattended session and you will not know what was
  approved beyond the last ten lines in the panel and whatever is in the console.

Reasonable use is a session you are supervising, on work you would have clicked
through anyway. Unattended runs against anything touching production are a
different proposition.

## Layout

```
auto-fde/             the extension, and the folder Chrome loads
  manifest.json
  background.js       service worker: button state, injection
  gate.js             the URL gate and origin parser, no chrome APIs
  storage.js          reads and writes the configured origins
  options.html/.js    where the user adds Foundry base URLs
  auto-fde.js         the in-page script and its panel
  icons/              generated, see below
check.sh              validates, writes nothing
test/                 see Tests
tools/make-icons.mjs  renders the icons from the mark
```

## How it fits together

**`gate.js` holds no chrome APIs.** That is what lets `gate-test.mjs` import it
and run in plain node with no browser and no stubbing. Keep it that way: anything
needing `chrome.*` belongs in `background.js`, `storage.js` or `options.js`.

**No Foundry domain is hardcoded anywhere.** The origins the extension runs on
come from `chrome.storage.sync`, written by the options page. An open-source
build has no idea which instance it is pointed at, and a default would put
somebody else's hostname in everyone's extension. `PATH_MARKER` in `gate.js` is
the one fixed part of the URL, because `/ai-fde/` is how a session page is told
apart from the rest of the Foundry workspace.

**Host access is optional and requested at runtime.** `manifest.json` declares
`optional_host_permissions` rather than `host_permissions`, and the options page
calls `chrome.permissions.request` for each origin as it is added. Adding an
origin therefore has to store it *and* obtain the permission; storing without the
permission would give a button that looks live and then fails at the injection,
so the permission is asked for first and nothing is stored if the user declines.
`chrome.permissions.request` needs a user gesture, which is why that work hangs
off the options form's submit rather than running on load.

**Origins are matched exactly.** Wildcard subdomains would be convenient for
anyone with several stacks, but they widen the blast radius of a typo and invite
lookalike hosts. Adding a second origin costs one line in the options page.

**`world: "MAIN"` on the injection is required, not cosmetic.**
`setTextareaValue()` in `auto-fde.js` reaches for the page's own
`HTMLTextAreaElement` value descriptor to get past React's patched setter, which
only works from the page's context. The `window.__autoFde` guard also has
to be visible to the page so a second press finds the existing panel rather than
stacking another one on top.

**Config is injected, not imported.** A MAIN-world script cannot see
`chrome.storage`, so `background.js` writes the origins onto the page as
`window.__autoFdeConfig` in a separate `executeScript` call immediately
before injecting `auto-fde.js`. The script checks them again itself, which
catches it being run by hand against the wrong page.

**The panel lives in a shadow root.** It is injected into somebody else's
application, and the isolation cuts both ways: Foundry ships Blueprint, which
styles bare `button` and `input` elements, and nothing in the panel should leak
back into their stylesheet either. The consequence for tests is that
`document.querySelector` cannot see the panel; reach it through
`document.getElementById('af-host').shadowRoot`, as `ext-test.mjs` does.

The panel groups controls by what they decide, one captioned section each:
which prompts to allow, settings, and recent activity. Keeping the tab awake is
not a decision about which prompts to allow, so it does not belong beside the
categories, and a test enforces that it stays out of that group.

The header carries the mark as inline SVG, the running count, and the pause and
stop controls. Those are in the header rather than a footer so that
they still work while the panel is collapsed, which a test checks. There is no
state pill: the pause control carries the state instead. The glyph says what
pressing it will do, standard transport icons, and the colour says what it is
doing now, green while running and amber while paused. Both halves are asserted,
including that the two colours differ.

The panel is translucent, `rgba(23, 27, 33, .25)` over a 12px `backdrop-filter`
blur, so the page underneath stays readable through it. Two things there are
load-bearing rather than decorative. The blur, because without it the panel's own
text is unreadable over busy content. And the `text-shadow` on `.panel`, because
at a quarter opacity the panel takes on whatever colour is behind it, and the
secondary text, section captions and log timestamps do not survive a light
background without it. On Foundry's own dark chrome the shadow is invisible.

At `.25` the hints and timestamps are near the floor of comfortable contrast on a
light background. Both were checked by rendering the panel over a bright gradient
as well as a dark one; if the transparency goes up again, check it the same way
rather than trusting the dark case, and expect to have to lift the muted greys
again or thicken the shadow.

**The mark is a loop around a diamond, not a diamond.** A bare AI FDE diamond
read as part of the product rather than as something clicking through it. The
diamond shrank to a reference and the loop, which is what this tool does, carries
the identity. It also survives 16px, which the first attempt did not: the diamond
disappeared until it was enlarged relative to the ring.


**The click happens inside the MutationObserver callback, with no timer.** This
is the difference between working in a background tab and not. Chrome throttles
timers in a hidden tab to once a second, and to once a minute once it has been
hidden for five. MutationObserver callbacks are not throttled. The original
script deferred the click by 300ms, which meant detection worked in the
background but approvals sat there until the tab was looked at, at which point
the throttle lifted and everything pending fired at once. Do not reintroduce a
delay: there is no unthrottled way to wait, since `requestAnimationFrame` is
paused in hidden tabs too.

There is a 2000ms `setInterval` backstop for a prompt that arrives without a
mutation the observer sees. It is a timer, so it is throttled in a hidden tab,
which is exactly why it is the backstop and not the mechanism.

The keep-alive checkbox is the other half of this. Silent audio marks the tab as
audible, which exempts the whole page from Chrome's intensive throttling, so
Foundry's own rendering and network activity keep up while the tab is in the
background. It is ticked by default, because running unattended in a background
tab is the usual reason to reach for this at all.

That default needs care. An `AudioContext` created without a user gesture starts
suspended, and injection by a toolbar press does not give the page one, so a
ticked box is not proof that any audio is playing. `settleKeepAlive()` calls
`resume()`, and if the context is still suspended it arms a one-shot
`pointerdown`/`keydown` listener and retries on the first click or keypress.

Neither setting carries a status field in the panel: each hint says what the
setting does, not what it is currently doing. `reportKeepAlive()` and
`reportResume()` log the state to the console instead, which is enough to check
"ticked but suspended" when it matters. The exception is a resume that fails to
send, which goes into the activity log, because a silent failure is the one thing
that cannot be assumed away.

**Failures go in the tooltip.** Anything the service worker logs lands in the
service worker console, which is a different console from the page's and which
nobody outside this repo thinks to open. `describeUrlMismatch()` produces a
sentence naming the actual reason, and `flagProblem()` puts it in the button's
tooltip. A successful injection flashes a green `on` badge so a press that worked
looks different from one that did not.

Those sentences are kept short on purpose. They are read on a hover, and quoting
a Foundry path back in full buried the point in eighty characters of resource
identifier. A test caps them at sixty characters.

**The button state follows SPA navigation.** The AI FDE console changes route
without a full reload, which `chrome.tabs.onUpdated` catches. That matters more
than it sounds: moving between a session and a Pipeline Builder page inside the
console never reloads, and the icon has to follow. `refreshAllTabs()`
sweeps every open tab on install, on browser startup, when the stored origins
change and when host permissions are granted or revoked, because none of the
per-tab events fire for a tab that is already sitting open.

**`chrome.action.disable()` is never called, and reintroducing it is a
regression.** In Manifest V3 it no longer greys the toolbar icon, so the only
thing it changes is the click, and a disabled action's click opens the
extension's context menu instead of firing `onClicked`. The result is a
full-colour button that appears to do nothing, which is worse than no signal at
all. It also gave a README that was simply untrue: the button looked ready on
every page of a configured instance, session or not.

So the button is live on every page, and the signal moved to the icon.
`describeButtonState()` in `gate.js` decides between the green icon and the grey
one and writes the reason into the tooltip, so hovering explains the state
without a press, and a press somewhere it cannot run flashes `!` with the same
reason. The grey icon is also `action.default_icon` in the manifest, so a tab
that has not been examined yet fails safe rather than looking ready.

Both icon sets are generated, not drawn:

```
npm run icons
```

`tools/make-icons.mjs` pulls the mark out of `auto-fde.js` and rasterises it with
Playwright at 16, 32, 48 and 128, once in colour and once in flat grey. The mark
is defined in exactly one place, the inline SVG in `auto-fde.js`, so the toolbar
icon and the panel header cannot drift apart. Re-run it after touching the mark
and commit what it writes.

**With nothing configured, a press opens the options page** rather than
reporting a problem, because that is the only useful thing it could do.

## Tests

```
npm test                              the gate, the origin parser, the tooltip
                                      sentences. Node only, no browser, no network.

npm install
npx playwright install chromium
npm run test:browser                  the in-page script and the packaged extension
```

Both suites pass, 49/49 and 44/44.

The browser suite serves its mock page through Playwright's request interception,
so no request reaches Palantir and the test can use `example.com` hosts. Part one
covers the panel rendering, the read and write categories getting clicked,
`Always allow` and disabled buttons and the deploy category being left alone, the
counter, the log capping at ten rows, the panel staying inside the viewport,
collapse and expand, the keep-alive staying out of the prompt-category group,
every section being captioned, no monospace surviving anywhere, the transport
controls being header icons that survive collapsing, the keep-alive default, the
glyph and colour swapping on pause, the panel being translucent and blurred, the
click happening without a timer, a button label being unable to inject markup into the
log, pause, stop, double injection, and all three refusal paths in the script's
own guard. Part two loads
the real extension into Chrome and drives the options page.

Two things the browser suite cannot do, both worth knowing before you trust a
green run:

- **Adding a valid origin.** `chrome.permissions.request` raises a native dialog
  Playwright cannot reach, so only the rejection path is exercised. The happy
  path is manual.
- **Genuinely backgrounding a tab.** There is no CDP visibility override, and
  bringing another page to the front leaves `document.visibilityState` as
  `visible`. The throttling regression is covered instead by draining microtasks
  to prove the click needs no timer, which is the property that actually matters.
- **Reaching into the service worker.** `background.js` is an ES module, so the
  gate is not on the global object, and `import()` is forbidden in worker scope.
  The gate is covered by the node suite against the same module instead.

`channel: 'chromium'` in `ext-test.mjs` is load-bearing. Playwright's default
download is the headless shell, which has no extension support at all, so
`--load-extension` is silently ignored there and no service worker ever appears.

## Validating

```
./check.sh    required files, manifest parses, all JS parses, version
```

That is the whole build system. There is no packaging step and no `dist/`: the
extension is distributed by cloning the repo and pointing Chrome's "Load
unpacked" at the `auto-fde` folder, so a zip would only be a second copy
to keep in step with this one. Git history has the old packaging script if this
ever goes to the Chrome Web Store, which does want a zip with `manifest.json` at
the root.

`node --check` decides how to parse a `.js` file from the nearest `package.json`,
which is why the one at the repo root sets `"type": "module"`. `check.sh` cd's to
its own directory, so that file is always in scope.

The version in `auto-fde/manifest.json` is the only version in the repo.
Chrome shows it on the extension's card, which is the only way anyone can tell
which revision they are running, so bump it for any real change.

## Making a change

Edit the extension, bump `version` in `manifest.json`, run `npm test` and
`./check.sh`, then press the reload arrow on the extension's card at
`chrome://extensions`. Anyone else needs to pull and press the same arrow.

## Fixed along the way

Kept because each one is a trap that is easy to reintroduce.

- **The button was dead on a session tab that was already open.** `onInstalled`
  and `onStartup` disabled the action globally and left `tabs.onUpdated` and
  `tabs.onActivated` to re-enable it per tab. Neither fires for a tab already
  sitting open, so the button stayed grey until the page was reloaded. Hence
  `refreshAllTabs()`.
- **Every failure looked identical from outside.** The reason went only to
  `console.warn` in the service worker console. Hence the tooltip.
- **The button looked ready on every page of a configured instance.** It relied
  on `chrome.action.disable()` for the grey state, which does nothing visible in
  Manifest V3. See the note above.
- **The name.** It shipped as `AI FDE AutoAllow` in an `ai-fde-autoallow` folder.
  Renaming to `Auto FDE` changed the folder, which changes the extension ID that
  Chrome derives from an unpacked path, which means the configured base URLs in
  `chrome.storage.sync` do not carry over. Anyone upgrading re-adds the folder,
  re-pins the button, and re-enters their base URL. The internal identifiers moved
  with it: `window.__autoFde`, `__autoFdePos`, `__autoFdeCollapsed`, and the
  `af-` prefix on the panel's element ids.
- **A button in the panel that opened the service worker console.** It needed a
  postMessage bridge in the ISOLATED world to reach the worker, because the panel
  has no chrome APIs, and then `chrome.tabs.create` would not navigate to
  `chrome://extensions/?id=<id>` anyway, so pressing it did nothing at all. There
  is no API for opening DevTools on a service worker. Removed rather than left as
  a dead control. To reach that console: `chrome://extensions`, then the
  **service worker** link on this extension's card.
- **Approvals only landed when the tab was in focus.** The click was deferred by
  300ms and Chrome throttles timers in hidden tabs. See the note above.
- **The panel was styled like a debug overlay.** Monospace at 12px, the
  keep-alive checkbox grouped in with the prompt categories as though it were
  another kind of prompt, no way to get it out of the way, and no mark on it. It
  is now a shadow-root panel in the system font, sectioned by what each control
  decides, collapsible, and headed by the AI FDE diamond.
- **The log grew with the click count.** It is capped at ten rows, the panel has
  a `max-height` of the viewport, and log lines are written as text nodes rather
  than `innerHTML`, so a button label containing angle brackets cannot write
  markup into the panel.
