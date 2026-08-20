# Developing Auto FDE

Everything that is not installation. See [README.md](README.md) for that.

## What this does and does not decide for you

Read this before handing it to a colleague.

The extension changes how a console script is delivered. It does not change what
the script does, and it does not review whether auto-clicking a consent prompt
is appropriate for the work in front of you. The prompts exist so a person sees
what the agent is about to do. Anyone running this is choosing to answer a class
of those prompts in advance.

The script clicks a button labelled exactly `Allow` or `Allow once`, so
`Always allow`, `Allow all future` and `Deny` are never candidates. It then
skips the prompt outright if the prompt's own text mentions `delete`, `force` or
`production`, and the deploy/build category is off until you turn it on.
Practical consequences worth stating out loud:

- Categories are matched on the prompt's visible text with a handful of regexes,
  riskiest category first. A prompt whose wording does not mention read, write,
  edit, update, create, deploy, build, publish or run falls into `Unclassified`,
  which is enabled. The default is to allow anything the script cannot classify.
- The block list is three words in a substring match on the prompt, not a
  reading of what the action does. A destructive action whose prompt does not
  happen to use one of them gets clicked.
- Auto-resume is on by default, and it writes into the chat on your behalf. It
  is one fixed line telling the agent to carry on, sent once the connection has
  answered two probes, and every send is in the panel's log. Untick it if
  nothing should be said in your name.
- Leave it running on a long unattended session and you will not know what was
  approved beyond the last ten lines in the panel and whatever is in the
  console.

Reasonable use is a session you are supervising, on work you would have clicked
through anyway. Unattended runs against anything touching production are a
different proposition.

## Layout

```
auto-fde/             the extension, and the folder Chrome loads
  manifest.json       holds the only version number in the repo
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

## Making a change

Edit the extension, bump `version` in `auto-fde/manifest.json`, verify, then
press the reload arrow on the extension's card at `chrome://extensions`. Anyone
else needs to pull and press the same arrow.

```
npm test              49 assertions: the gate, the origin parser, the tooltip
                      sentences. Node only, no browser, no network.
./check.sh            required files, manifest parses, all JS parses, version

npm install && npx playwright install chromium   (once)
npm run test:browser  83 assertions: the in-page script and the packaged
                      extension. Needed for anything touching auto-fde.js,
                      manifest.json, options.* or the injection path.
```

That is the whole build system. There is no linter, no packaging step and no
`dist/`: the extension is distributed by cloning the repo, so a zip would only
be a second copy to keep in step with this one. Git history has the old
packaging script if this ever goes to the Chrome Web Store, which does want a
zip with `manifest.json` at the root.

The version in the manifest is the only version in the repo, and Chrome shows it
on the extension's card, which is the only way anyone can tell which revision
they are running. `node --check` decides how to parse a `.js` file from the
nearest `package.json`, which is why the one at the repo root sets
`"type": "module"`; `check.sh` cd's to its own directory, so that file is always
in scope.

## How it fits together

**`gate.js` holds no chrome APIs.** That is what lets `gate-test.mjs` import it
and run in plain node with no browser and no stubbing. Keep it that way:
anything needing `chrome.*` belongs in `background.js`, `storage.js` or
`options.js`.

**No Foundry domain is hardcoded anywhere.** The origins the extension runs on
come from `chrome.storage.sync`, written by the options page. An open-source
build has no idea which instance it is pointed at, and a default would put
somebody else's hostname in everyone's extension. `PATH_MARKER` in `gate.js` is
the one fixed part of the URL, because `/ai-fde/` is how a session page is told
apart from the rest of the Foundry workspace.

**Host access is optional and requested at runtime.** `manifest.json` declares
`optional_host_permissions` rather than `host_permissions`, and the options page
calls `chrome.permissions.request` for each origin as it is added. Storing an
origin without the permission would give a button that looks live and then fails
at the injection, so the permission is asked for first and nothing is stored if
the user declines. `chrome.permissions.request` needs a user gesture, which is
why that work hangs off the form's submit rather than running on load.

**Origins are matched exactly.** Wildcard subdomains would be convenient for
anyone with several stacks, but they widen the blast radius of a typo and invite
lookalike hosts. Adding a second origin costs one line in the options page.

**`world: "MAIN"` on the injection is required, not cosmetic.**
`setTextareaValue()` in `auto-fde.js` reaches for the page's own
`HTMLTextAreaElement` value descriptor to get past React's patched setter, which
only works from the page's context. The `window.__autoFde` guard also has to be
visible to the page so a second press finds the existing panel rather than
stacking another one on top.

**Config is injected, not imported.** A MAIN-world script cannot see
`chrome.storage`, so `background.js` writes the origins onto the page as
`window.__autoFdeConfig` in a separate `executeScript` call immediately before
injecting `auto-fde.js`. The script checks them again itself, which catches it
being run by hand against the wrong page.

**The panel lives in a shadow root.** It is injected into somebody else's
application, and the isolation cuts both ways: Foundry ships Blueprint, which
styles bare `button` and `input` elements, and nothing in the panel should leak
back into their stylesheet either. The consequence for tests is that
`document.querySelector` cannot see the panel; reach it through
`document.getElementById('af-host').shadowRoot`, as `ext-test.mjs` does.

Controls are grouped by what they decide, one captioned section each: which
prompts to allow, settings, and recent activity. Keeping the tab awake is not a
decision about which prompts to allow, so a test enforces that it stays out of
that group.

The header carries the mark as inline SVG, the running count, and the pause and
stop controls. Those are in the header rather than a footer so they still work
while the panel is collapsed, which a test checks. There is no state pill: the
pause control carries the state instead. The glyph says what pressing it will
do, standard transport icons, and the colour says what it is doing now, green
while running and amber while paused. Both halves are asserted, including that
the two colours differ.

The panel is translucent, `rgba(23, 27, 33, .25)` over a 12px `backdrop-filter`
blur. Two things there are load-bearing rather than decorative: the blur,
because without it the panel's own text is unreadable over busy content, and the
`text-shadow` on `.panel`, because at a quarter opacity the panel takes on
whatever colour is behind it, and the secondary text, section captions and log
timestamps do not survive a light background without it. On Foundry's own dark
chrome the shadow is invisible.

At `.25` the hints and timestamps are near the floor of comfortable contrast on
a light background. Both were checked by rendering the panel over a bright
gradient as well as a dark one. If the transparency goes up again, check it the
same way rather than trusting the dark case, and expect to have to lift the
muted greys again or thicken the shadow.

**The mark is a loop around a diamond, not a diamond.** A bare AI FDE diamond
read as part of the product rather than as something clicking through it, so the
diamond shrank to a reference and the loop, which is what this tool does,
carries the identity. It also survives 16px, which the first attempt did not:
the diamond disappeared until it was enlarged relative to the ring.

**The click happens inside the MutationObserver callback, with no timer.** This
is the difference between working in a background tab and not. Chrome throttles
timers in a hidden tab to once a second, and to once a minute once it has been
hidden for five. MutationObserver callbacks are not throttled. The original
script deferred the click by 300ms, which meant detection worked in the
background but approvals sat there until the tab was looked at, at which point
the throttle lifted and everything pending fired at once. Do not reintroduce a
delay: there is no unthrottled way to wait, since `requestAnimationFrame` is
paused in hidden tabs too. The 2000ms `setInterval` catches a prompt that
arrives without a mutation the observer sees; being a timer is exactly why it is
the backstop and not the mechanism.

**A prompt that is not in the document cannot be waited for.** The transcript is
a windowed list: rows outside the range it has rendered are not in the page at
all. An approval that arrives while the user is scrolled up therefore has no
button for the scan to find and produces no mutation for the observer to react
to, and an unthrottled observer is no help against a button that does not exist.
The symptom was a panel whose count sat still for minutes and then moved the
instant somebody scrolled the tab, which reads as throttling and is not.

`reachPendingPrompt()` runs when a scan finds no prompt anywhere on the page. It
looks for the pill Foundry floats over the transcript to say an approval is
pending, matched on its text because the sentence belongs to the product and the
class does not, presses it, and assigns `scrollTop` on the transcript. Both
halves earn their place: the pill is the page's own route back to the row, and
the assignment is the half that still works in a tab Chrome has stopped
painting, since a smooth scroll is driven by frames and frames stop. A test
asserts the scroll arrives in a single event rather than a run of them.

A prompt the script can see and has decided not to press counts as a prompt
seen, so a refused prompt sitting under a pill does not have the transcript
scrolled every couple of seconds for as long as it is up. `MAX_JUMPS` attempts
`JUMP_INTERVAL_MS` apart then back off to `JUMP_BACKOFF_MS`, and the pill's text
names the row it is waiting on, so a different pill is a different prompt and
gets the fast attempts again. The interval is the distance between two
`Date.now()` readings inside the observer callback, not a timer, so it survives a
throttled tab.

**The cap sets the pace, not whether to keep trying.** It shipped as a hard stop
and that was worse than the bug it guarded against. A session sat for nineteen
minutes behind a prompt the page had not rendered: five attempts failed inside
half a minute, the panel logged that it had given up, and then nothing tried
again until the tab was clicked. What that reveals is a second reason a row can
be missing, on top of being outside the rendered range: Chrome stops producing
frames for a hidden tab, and a list that mounts rows off a `ResizeObserver` or an
`IntersectionObserver` cannot mount anything until the tab is looked at, because
those callbacks are delivered with the frame. No amount of scrolling reaches a
row in that state, so the only correct behaviour is to keep trying slowly and to
try properly again the moment the tab is visible.

**Being looked at is an event to act on.** Hence the `visibilitychange`
listener, which scans and resets the jump budget. It is not a convenience: a
session sitting on an approval mutates nothing, so the observer never fires, and
the 2000ms backstop is exactly the throttled timer that cannot be relied on.
Without the listener the first thing to notice the tab was back was whatever the
page happened to redraw.

When the fast attempts run out, `stallReport()` goes to the console with the real
visibility, the number of buttons in the document and any button label containing
"allow". Whether the button is in the document at all is what separates a list
that has not rendered the row from a row that is there and not being matched, and
it cannot be read off the panel. It is flat text rather than an object because an
object arrives in the console collapsed and comes back reported as "Object".

**The button is not in the document while the tab is hidden.** That is measured,
not assumed. A jump is only ever attempted when no `Allow`-labelled button exists
anywhere in the document, and a session logged six of them across a minute in the
background, then found the button on the first attempt after the tab was clicked.
So the pending row is not mounted at all while Chrome is not drawing the tab,
which fits a list that mounts rows off a `ResizeObserver` or an
`IntersectionObserver`: those callbacks are delivered with the frame, and there
is no frame.

**Measured, with the spoof on: a hidden tab cannot be made to work.** The stall
report from a background tab running the spoof reads
`visibility=hidden buttons=77 allow=[none] allowByText=0`. Seventy-seven buttons
in the document, none of them an approval, and the transcript rows not among
them. Telling the page it is visible did not change that, so what stops the row
being mounted is Chrome not drawing the tab rather than Foundry deciding to stand
down. Nothing an extension can reach from inside the page fixes that, and the
options that would are outside it: keep the tab active in a window that is at
least partly visible, which works and is what the README recommends, or answer
the approval through Foundry's own API rather than its DOM, which is a different
tool from this one. Do not spend another round on the DOM.

`allowByText` in the report is what makes that reading safe. It counts buttons
whose `textContent` matches, which needs no rendering at all, so a row that is
present but unmatched cannot be mistaken for a row that is absent. `labelFor()`
falls back to `textContent` for the same reason, and a test covers a button whose
label is inside a `display:none` child, where `innerText` is empty and the button
is real.

**Pasting the script into the console is not different from injecting it.** This
comes up because the tool started life as a console paste and seemed to work in
the background then. Delivery cannot be the reason. Both routes run the identical
source in the page's own world, and the thing that fails is a property of the
page: there is no button in the document. What actually changed is session
length. A short transcript is not windowed, so a new row is in the document as
soon as React commits it, and a commit needs no frame. Long transcripts are
windowed, and mounting a row in one needs a measurement that needs a frame. So it
did work, and it stopped working as sessions got longer, not as the delivery
changed.

The one real difference with DevTools open is that Chrome exempts the page from
freezing and discarding, which matters for timers rather than for mounting. If
that is ever in doubt, the way to test it is to leave DevTools open on the tab and
background it with the extension unchanged: same code, one variable. There is no
point building a clipboard-paste mode to answer it.

**`window.__autoFde.watchTraffic()`** is the first step of the other route, and
the only one that needs a real session. It wraps `fetch`, `XMLHttpRequest` and
`WebSocket.prototype.send`. It logs no headers, deliberately: that is where the
session token is, and these lines get copied into chat windows. Stop unwraps all
four, and a test asserts both the log line and the absence of the header.

Three things it learned the hard way, all from one capture against a real
session:

- **Printing the body is useless.** A Foundry thread body is hundreds of item
  ids and a tool configuration block, and the field that matters is past any
  reasonable truncation. So the body is parsed and walked, and only the paths
  whose key or string value carries the word are reported. A wall of thread
  document becomes two or three lines.
- **The word is not enough on its own.** `QuickApprovalProjectQuery`, a
  repository pull request query with nothing to do with a session, was the
  loudest thing in the log. Outside the window below, a request has to be on
  `/ai-fde/api/` as well as carry the word. `watchTraffic({ all: true })` drops
  both bars for when the grant is named after nothing at all.
- **The window has to open before the click, not after.** The page sends the
  grant synchronously from its own click handler, so a window opened in
  `record()`, which runs after `btn.click()`, has already missed the request it
  exists to catch. `markApprovalClick()` is called immediately before the click
  instead, and the marker line in the log is what tells the grant apart from
  everything else the session was doing at the time.

What the captures showed. The grant is the `POST
/ai-fde/api/threads/{id}/update` that follows the click, carrying
`currentVersion` and `itemIdsInOrder`, and it reported `fields: none`: nothing in
it is named after approval. So searching for the word cannot find the grant, and
the body has to be read. Read whole it is unreadable, because it leads with
hundreds of item ids, which is why `describeBody()` reports every top-level key
with an array of nothing but strings summarised as a count and everything else
in full.

The shape that makes it a document update with optimistic concurrency is the
thing to weigh before building on it. Sending one means holding a version the
server still accepts and an item list that is correct, and getting either wrong
writes junk into a live session.

**There is no approval to send.** The third capture settles it. What follows a
click is the client persisting the thread it already owns: `itemsToWrite` full of
assistant messages, tool usages, and OpenAI reasoning items carrying
`encryptedContent`. A client holding encrypted reasoning state and writing the
whole document is a client running the agent loop itself, and an approval in that
architecture is a state transition inside the page, not a request to a server. So
posting an `/update` from outside would write to the transcript without approving
anything, because nothing on the far end is waiting to be told.

The same capture shows the lever that does exist:

```
agentStateModification.sessionState.toolApprovalSettingsOverrides =
  {"load_skill":{"type":"default","rules":[],"default":{"type":"askUser"}}, ...}
agentStateModification.sessionState.bulkApprovalSettings =
  {"create":null,"edit":null,"import":null,"deploy":null,"tag":null,
   "agentSelf":{"type":"default","rules":[],"default":{"type":"autoApprove"}}}
```

`askUser` against `autoApprove`, per tool, plus bulk categories that are the ones
this extension approximates with regexes on prompt text. It is recorded as issue
#5 and it is not the answer: the settings do not cover every tool and do not
reliably hold, which is the reason this tool exists. `POLICY_FIELD` in the
traffic watch prints that object at a longer limit than everything else because
it is worth reading, not because it is the plan.

**The state is the route, and this script is already in it.** That an approval is
a transition inside the page is what makes the third route possible rather than
closing the last one. `world: "MAIN"` puts this script in the page's own context,
so the function the button calls is reachable whether or not the button is. And
the state is mounted in a hidden tab: the pending pill renders from it, which is
the only reason the pill can be found there at all. What is missing is not access
but a map.

`window.__autoFde.probeApproval()` draws it. It walks up React's fiber tree from
an anchor, preferring an Allow button that carries a fiber, falling back to the
pill, and reports each component's name, its function props by name, and its
other props by shape. An anchor with no fiber on it loses to one that has it,
because the first Allow in the document is not necessarily the mounted one.

Shapes, never contents. Props on a thread component are as likely to be the whole
conversation as a flag, `JSON.stringify` on a fiber prop finds a cycle sooner or
later, and this output gets pasted into chat windows. A test asserts a
`transcript` prop is reported as `array[1]` and that its contents do not appear.

The two anchors answer different halves. From a mounted Allow button the walk
reaches the handler the click runs and the props it closes over. From the pill it
reaches whatever is still mounted in a hidden tab, which is the set actually
available when it matters. Comparing them is the point: the approval has to be
driven from something in the second set.

**It runs itself, because the interesting half cannot be reached by hand.** The
first attempt at this asked for a console command while the tab was hidden, which
is not a thing anyone can do: typing it means focusing DevTools, and the question
is what the page looks like when nobody is looking at it. So the probe fires from
the first Allow the panel presses, before the click since the row unmounts once
the prompt is answered, and again from the pill when a stall is reported. Once
each. It is a map, not a running commentary.

**What the first real walk found, from a hidden tab with no row in the
document.** Forty levels up from the pill, all of it mounted:

- `startAgentLoop`, `abortAgentLoop`, `onEnterSubAgent`, `onExitSubAgent`
- `lastPersistedAgentState={contextMap, contextOrder, name, agentSystemPrompt,
  modeConfig, toolConfigurations, modelConfiguration, todoItems, sessionState}`
- `activeThread`, `loadedThreadInfo={id, name, version, …}`,
  `lastReadThreadVersionRef`
- `userBulkApprovalSettings={create, edit, import, deploy, tag, agentSelf}`
- `initialState={agentStatus, …, requestStatus, sessionState, …}`
- and at level 7, the pill's own row component reporting `item=undefined`, which
  is the missing row stated by the page itself

So the thread, the agent state and the loop control are all reachable while
Chrome is not drawing the tab. What is not there is any way to change them:
every one of those is a prop, and props are what a component was handed. The
functions that answer a prompt live in a context value or a hook, which is why
`stateShapes()` reports both, filtered to shapes whose keys match
`PROBE_ACTIONS` or `PROBE_INTERESTING`. A provider value is otherwise most of
the application.

One trap in testing it. Only props whose names match `PROBE_INTERESTING` are
reported at all, so asserting that the contents of a prop named `transcript` do
not leak proves nothing: that prop is never printed under any circumstances. The
tests name it `threadItems` instead, which is reported, and assert it comes out
as `array[1]` with its contents absent. An assertion about privacy has to be made
against something the code actually prints.

It is reached from the console rather than the panel because it is not a decision
anyone makes while using this. Detection is already solved for the API route, as
it happens: the pending pill is in the document even in a hidden tab, which is how
`reachPendingPrompt()` knows to run at all. What is missing is what the page sends
and whether every part of it can be assembled without the row.

**The visibility spoof is what is left of the page's half, and it answers the
page rather than the browser.** `document.hidden` and `document.visibilityState` are given own
properties on `document` that report visible, and the going-hidden
`visibilitychange` is stopped at the window in the capture phase, upstream of
anything the page has on `document`. Applications defer work by reading those two
properties and by acting on that event, and this stops Foundry doing so on its own
account. What it cannot do is make Chrome draw the tab, so it fixes the page's
half of the problem and not the compositor's. Whether that is enough is a question
about Foundry that cannot be answered from here, which is why it is a checkbox,
ticked by default.

Three details are load-bearing. The coming-back event is let through, because that
is the one the page needs in order to catch up on anything it did defer.
`realVisibility()` keeps a reference to the prototype getter taken before the
properties are defined, so the script's own decisions and its diagnostics read the
truth rather than its own answer. And Stop deletes the properties, uncovering the
real getters, because a page left reading its visibility off a panel that has been
removed is a worse state than either setting.

**Categories are matched riskiest first, which is not the order they are shown
in.** A prompt reading "deploy the build, view the plan first" matches both read
and deploy, and taking the first match in display order classed it as read,
which let a deploy through with the deploy category switched off. Each category
carries a `risk` and `BY_RISK` sorts on it; `other` matches everything and has
the lowest risk, so it stays the fallback.

**The block list reads the prompt, not the button.** `TARGET_LABELS` is an exact
match on `allow` or `allow once`, so a list of blocked labels can never match
anything that exact match has not already excluded, and `delete`, `force` and
`production` are not button labels in the first place. They are matched against
the prompt's text, which is where the risk is. `always` and `forever` stay out
of that list: a prompt offering `Allow` beside `Always allow` carries the second
label in its own text, and blocking on it would refuse the ordinary case.

**Auto-resume is ticked by default, for the same reason the keep-alive is.**
The tab is in the background and nobody is watching it, so an agent sitting
behind an error banner until somebody looks at the tab is the failure the whole
thing is here to prevent. The checkbox in the markup carries that default and
`autoResumeEnabled` is read from it at startup, so the two cannot drift.

**One recovery per error banner.** Foundry's callout does not reliably clear
itself once the connection is back, so a banner still on screen after the resume
has been sent gets found by the next mutation, and the agent is told to carry on
again, and again. `handledBanners` is a `WeakSet` of the elements already acted
on. The 300ms wait before the send button is pressed is the one deferred action
in the script, and it is not the prompt click: a resume that lands late in a
throttled tab still resumes.

**Stop has to undo everything, because start can follow it.** The panel is
removed and `window.__autoFde` deleted, but the drag listeners live on `window`
and would outlive it, so every listener registered outside the host element goes
through `on()`, which records how to remove it. A browser test asserts nothing
is left on `window` after Stop.

The keep-alive checkbox is the other half of this. Silent audio marks the tab as
audible, which exempts the whole page from Chrome's intensive throttling, so
Foundry's own rendering and network activity keep up in the background. It is
ticked by default, because running unattended in a background tab is the usual
reason to reach for this at all.

That default needs care. An `AudioContext` created without a user gesture starts
suspended, and injection by a toolbar press does not give the page one, so a
ticked box is not proof that any audio is playing. `settleKeepAlive()` calls
`resume()`, and if the context is still suspended it arms a one-shot
`pointerdown`/`keydown` listener and retries on the first click or keypress.

Neither setting carries a status field in the panel: each hint says what the
setting does, not what it is currently doing. `reportKeepAlive()` and
`reportResume()` log the state to the console instead. Failures are the
exception, and they go in the activity log, because a silent failure is the one
thing that cannot be assumed away: a resume that could not be sent, a prompt
that cannot be reached, and the keep-alive waiting for its gesture. That last
one earns its line because a ticked box with a suspended context looks exactly
like one that worked while the tab is being throttled anyway, and one click on
the page fixes it. A browser test covers it with a stub context that stays
suspended, since headless Chromium does not apply the autoplay policy the same
way.

**Failures go in the tooltip.** Anything the service worker logs lands in the
service worker console, which is a different console from the page's and which
nobody outside this repo thinks to open. `describeUrlMismatch()` produces a
sentence naming the actual reason, and `flagProblem()` puts it in the button's
tooltip. A successful injection flashes a green `on` badge so a press that
worked looks different from one that did not. Those sentences are kept short on
purpose: they are read on a hover, and quoting a Foundry path back in full
buried the point in eighty characters of resource identifier. A test caps them
at sixty characters.

**The button state follows SPA navigation.** The AI FDE console changes route
without a full reload, which `chrome.tabs.onUpdated` catches. That matters more
than it sounds: moving between a session and a Pipeline Builder page inside the
console never reloads, and the icon has to follow. `refreshAllTabs()` sweeps
every open tab on install, on browser startup, when the stored origins change
and when host permissions are granted or revoked, because none of the per-tab
events fire for a tab that is already sitting open.

**`chrome.action.disable()` is never called, and reintroducing it is a
regression.** In Manifest V3 it no longer greys the toolbar icon, so the only
thing it changes is the click, and a disabled action's click opens the
extension's context menu instead of firing `onClicked`. The result is a
full-colour button that appears to do nothing, which is worse than no signal at
all. So the button is live on every page and the signal moved to the icon.
`describeButtonState()` in `gate.js` decides between the green icon and the grey
one and writes the reason into the tooltip, so hovering explains the state
without a press, and a press somewhere it cannot run flashes `!` with the same
reason. The grey icon is also `action.default_icon` in the manifest, so a tab
that has not been examined yet fails safe rather than looking ready.

**With nothing configured, a press opens the options page** rather than
reporting a problem, because that is the only useful thing it could do.

**Both icon sets are generated, not drawn.** `npm run icons` pulls the mark out
of `auto-fde.js` and rasterises it with Playwright at 16, 32, 48 and 128, once
in colour and once in flat grey. The mark is defined in exactly one place, the
inline SVG in `auto-fde.js`, so the toolbar icon and the panel header cannot
drift apart. Re-run it after touching the mark and commit what it writes.

## Tests

The browser suite serves its mock page through Playwright's request
interception, so no request reaches Palantir and the test can use `example.com`
hosts. Part one covers the in-page script: rendering, clicking, the guards, the
panel's structure and styling. Part two loads the real extension into Chrome and
drives the options page.

`channel: 'chromium'` in `ext-test.mjs` is load-bearing. Playwright's default
download is the headless shell, which has no extension support at all, so
`--load-extension` is silently ignored there and no service worker ever appears.

Three things the browser suite cannot do, all worth knowing before you trust a
green run:

- **Adding a valid origin.** `chrome.permissions.request` raises a native dialog
  Playwright cannot reach, so only the rejection path is exercised. The happy
  path is manual.
- **Genuinely backgrounding a tab.** There is no CDP visibility override, and
  bringing another page to the front leaves `document.visibilityState` as
  `visible`. The throttling regression is covered instead by draining microtasks
  to prove the click needs no timer, which is the property that actually
  matters.
- **Reaching into the service worker.** `background.js` is an ES module, so the
  gate is not on the global object, and `import()` is forbidden in worker scope.
  The gate is covered by the node suite against the same module instead.

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
  Manifest V3, and it made the README simply untrue.
- **Approvals only landed when the tab was in focus.** The click was deferred by
  300ms and Chrome throttles timers in hidden tabs.
- **Approvals still only landed when somebody scrolled the tab.** The same
  symptom, a different cause, and the timer fix hid it: the transcript is a
  windowed list, so a prompt arriving while the user was scrolled up was not in
  the document for the observer to find. Hence `reachPendingPrompt()`. Anything
  that only ever looks at what `document.querySelectorAll` returns now has this
  to answer for.
- **And then only when somebody clicked the tab.** `reachPendingPrompt()`
  shipped with a hard cap on attempts, so a prompt the page would not render
  while the tab was hidden was logged as unreachable and never tried again. The
  cap now backs off instead of stopping, and `visibilitychange` is acted on.
- **The first stall report was unreadable.** It passed an object to
  `console.warn`, which arrives collapsed, so the one fact worth having came
  back quoted as "Object". Diagnostics that have to survive being copied out of
  somebody else's console are flat text.
- **The name.** It shipped as `AI FDE AutoAllow` in an `ai-fde-autoallow`
  folder. Renaming to `Auto FDE` changed the folder, which changes the extension
  ID that Chrome derives from an unpacked path, which means the configured base
  URLs in `chrome.storage.sync` do not carry over. Anyone upgrading re-adds the
  folder, re-pins the button, and re-enters their base URL. The internal
  identifiers moved with it: `window.__autoFde`, `__autoFdePos`,
  `__autoFdeCollapsed`, and the `af-` prefix on the panel's element ids.
- **A button in the panel that opened the service worker console.** It needed a
  postMessage bridge in the ISOLATED world to reach the worker, because the
  panel has no chrome APIs, and then `chrome.tabs.create` would not navigate to
  `chrome://extensions/?id=<id>` anyway, so pressing it did nothing at all.
  There is no API for opening DevTools on a service worker. Removed rather than
  left as a dead control. To reach that console: `chrome://extensions`, then the
  **service worker** link on this extension's card.
- **The panel was styled like a debug overlay.** Monospace at 12px, the
  keep-alive checkbox grouped in with the prompt categories as though it were
  another kind of prompt, no way to get it out of the way, and no mark on it. It
  is now a shadow-root panel in the system font, sectioned by what each control
  decides, collapsible, and headed by the mark.
- **The block list matched nothing.** It was checked against the button label,
  which by that point had already been narrowed to exactly `allow` or
  `allow once`, so no entry in it could ever match. `delete`, `force` and
  `production` are matched against the prompt's text now.
- **A read-only word anywhere in a deploy prompt let the deploy through.**
  Categories were matched in display order and read comes first, so the deploy
  category being off decided nothing. They are matched in risk order now.
- **A banner that did not clear itself resumed the agent over and over.** Every
  mutation while it was on screen started another recovery.
- **Stop left its drag listeners on `window`.** Each start and stop on the same
  page added another pair.
- **The log grew with the click count.** It is capped at ten rows, the panel has
  a `max-height` of the viewport, and log lines are written as text nodes rather
  than `innerHTML`, so a button label containing angle brackets cannot write
  markup into the panel.
