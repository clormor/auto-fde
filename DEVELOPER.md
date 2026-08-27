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
`production`. Practical consequences worth stating out loud:

- Every category is ticked by default, so the categories narrow nothing until
  you untick one. What holds a prompt back out of the box is the block list.
- Categories are matched on the prompt's own text with a handful of regexes,
  riskiest category first. A prompt whose wording does not mention read, write,
  edit, update, create, deploy, build, publish or run falls into `Unclassified`.
- The block list is three words in a substring match on the prompt, not a
  reading of what the action does. A destructive action whose prompt does not
  happen to use one of them gets clicked.
- Auto-resume is on by default, and it writes into the chat on your behalf. It
  is one fixed line telling the agent to carry on, sent once the connection has
  answered two probes, and every send is in the panel's log. Untick it if
  nothing should be said in your name.
- Accepting messages from apps on this device is on by default, and any of
  them can send any text into the session. It is not remote access from the
  internet: the request is a DOM attribute, so what can write it is code already
  running on this device, the page's own JavaScript included. Every message is
  in the log. Untick it if nothing outside the browser should speak here.
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
npm run test:browser  117 assertions: the in-page script and the packaged
                      extension. Needed for anything touching auto-fde.js,
                      manifest.json, options.* or the injection path.
```

That is the whole build system. There is no linter, no packaging step and no
`dist/`: the extension is distributed by cloning the repo, so a zip would only
be a second copy to keep in step with this one.

The manifest holds the only version in the repo. Chrome shows it on the
extension's card, `background.js` passes it to the page in `__autoFdeConfig`,
and the panel shows it in its header, so a bug report can name a revision.

`node --check` decides how to parse a `.js` file from the nearest
`package.json`, which is why the one at the repo root sets `"type": "module"`;
`check.sh` cd's to its own directory, so that file is always in scope.

## How it fits together

**`gate.js` holds no chrome APIs.** That is what lets `gate-test.mjs` import it
and run in plain node with no browser and no stubbing. Anything needing
`chrome.*` belongs in `background.js`, `storage.js` or `options.js`.

**No Foundry domain is hardcoded anywhere.** The origins come from
`chrome.storage.sync`, written by the options page. A default would put somebody
else's hostname in everyone's extension. `PATH_MARKER` in `gate.js` is the one
fixed part of the URL, because `/ai-fde/` is how a session page is told apart
from the rest of the Foundry workspace.

**Host access is optional and requested at runtime.** `manifest.json` declares
`optional_host_permissions` rather than `host_permissions`, and the options page
calls `chrome.permissions.request` for each origin as it is added. Storing an
origin without the permission gives a button that looks live and then fails at
the injection, so the permission is asked for first and nothing is stored if the
user declines. `chrome.permissions.request` needs a user gesture, which is why
that work hangs off the form's submit rather than running on load.

**Origins are matched exactly.** Wildcard subdomains widen the blast radius of a
typo and invite lookalike hosts. A second origin costs one line in the options
page.

**`world: "MAIN"` on the injection is required, not cosmetic.**
`setTextareaValue()` reaches for the page's own `HTMLTextAreaElement` value
descriptor to get past React's patched setter, which only works from the page's
context. The `window.__autoFde` guard also has to be visible to the page, so a
second press finds the existing panel rather than stacking another one on top.

**Config is injected, not imported.** A MAIN-world script cannot see
`chrome.storage` or `chrome.runtime`, so `background.js` writes the origins, the
path marker and the manifest version onto the page as `window.__autoFdeConfig`
in a separate `executeScript` call immediately before injecting `auto-fde.js`.
The script checks the origins again itself, which catches it being run by hand
against the wrong page.

**The panel lives in a shadow root.** It is injected into somebody else's
application, and the isolation cuts both ways: Foundry ships Blueprint, which
styles bare `button` and `input` elements, and nothing in the panel should leak
back into their stylesheet either. `document.querySelector` cannot see the
panel, so tests reach it through
`document.getElementById('af-host').shadowRoot`.

Controls are grouped by what they decide, one captioned section each: which
prompts to allow, settings, and recent activity. Keeping the tab awake is not a
decision about which prompts to allow, so a test enforces that it stays out of
that group. The panel stays bounded, because it sits over somebody's work: ten
log rows, a `max-height` on the panel, and log lines written as text nodes
rather than `innerHTML`, so a button label containing angle brackets cannot
write markup into it.

The header carries the mark as inline SVG, the version, the running count, and
the pause and stop controls. Those are in the header rather than a footer so
they still work while the panel is collapsed, which a test checks. There is no
state pill: the pause control carries the state, its glyph saying what pressing
it will do and its colour what it is doing now, green while running and amber
while paused. Both halves are asserted, including that the two colours differ.

The panel is translucent, `rgba(23, 27, 33, .25)` over a 12px `backdrop-filter`
blur. Two things there are load-bearing rather than decorative: the blur,
without which the panel's own text is unreadable over busy content, and the
`text-shadow` on `.panel`, without which the secondary text, section captions
and log timestamps do not survive a light background. On Foundry's own dark
chrome the shadow is invisible. At `.25` the hints and timestamps sit near the
floor of comfortable contrast, so if the transparency goes up, check the panel
over a bright gradient as well as a dark one and expect to have to lift the
muted greys again or thicken the shadow.

**The mark is a loop around a diamond, not a diamond.** The diamond is a
reference to AI FDE, and the loop, which is what this tool does, carries the
identity. It has to stay legible at 16px, which needs the diamond enlarged
relative to the ring.

**The click happens inside the MutationObserver callback, with no timer.** This
is the difference between working in a background tab and not. Chrome throttles
timers in a hidden tab to once a second, and to once a minute once it has been
hidden for five; MutationObserver callbacks are not throttled. A deferred click
means detection works in the background while approvals sit there until the tab
is looked at. Do not reintroduce a delay, and note that `requestAnimationFrame`
is no escape hatch, being paused in hidden tabs too. The 2000ms `setInterval`
catches a prompt that arrives without a mutation the observer sees; being a
timer is exactly why it is the backstop and not the mechanism.

**A prompt that is not in the document cannot be waited for.** The transcript is
a windowed list: rows outside the range it has rendered are not in the page at
all. An approval arriving while the user is scrolled up has no button for the
scan to find and produces no mutation for the observer to react to. The symptom
is a count that sits still for minutes and then moves the instant somebody
scrolls the tab, which reads as throttling and is not.

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
`Date.now()` readings inside the observer callback, not a timer, so it survives
a throttled tab.

**The cap sets the pace, not whether to keep trying.** A hard stop is wrong,
because there are two reasons a row can be missing and only one of them is the
rendered range. Chrome stops producing frames for a hidden tab, and a list that
mounts rows off a `ResizeObserver` or an `IntersectionObserver` cannot mount
anything until the tab is looked at, since those callbacks are delivered with
the frame. No amount of scrolling reaches a row in that state, so the only
correct behaviour is to keep trying slowly and to try properly again the moment
the tab is visible.

**Being looked at is an event to act on.** Hence the `visibilitychange`
listener, which scans and resets the jump budget. A session sitting on an
approval mutates nothing, so the observer never fires, and the 2000ms backstop
is exactly the throttled timer that cannot be relied on.

When the fast attempts run out, `stallReport()` goes to the console with the
real visibility, the number of buttons in the document and any button label
containing "allow". Whether the button is in the document at all is what
separates a list that has not rendered the row from a row that is there and not
being matched, and it cannot be read off the panel. It is flat text rather than
an object, because an object arrives in the console collapsed and comes back
quoted as "Object".

**The button is not in the document while the tab is hidden.** Measured, not
assumed: `visibility=hidden buttons=110 allow=[none] allowByText=0`, repeatedly,
with the button found on the first attempt after the tab was clicked. Chrome
draws no frames for a hidden tab, and a windowed list mounts rows off callbacks
that arrive with the frame, so the row is never there. Telling the page it is
visible does not change that either; the same reading comes back with the spoof
on. So clicking cannot answer a prompt in a background tab, and that is why
`answerWithoutARow()` exists.

**An approval is a state transition inside the page, not a request to a
server.** What follows a click is the client persisting a thread it already
owns: `itemsToWrite` carrying assistant messages, tool usages and OpenAI
reasoning items with `encryptedContent`. A client holding encrypted reasoning
state and writing the whole document is running the agent loop itself, so
posting to `/ai-fde/api/threads/{id}/update` from outside would write to the
transcript without approving anything. `world: "MAIN"` already puts this script
in the page's own context and the session's store is reachable from the pending
pill, which is in the document even in a hidden tab, so the answer is written
where the click writes it.

**What a click does, measured.** Three events, in order:

```
removeToolApprovalOverride {toolName}      synchronous, inside the click
upsertChildContextItem     {contextItem}   the answer
changeRequestStatus        {requestStatus, agentLocator}
```

and the item's `toolResponse` goes from `{"state":"pending_approval"}` to
`{"state":"requested"}`. So `answerWithoutARow()` sets that response on the
pending item, sends the answer, and calls `startAgentLoop`, which is what issues
the status change itself. Only the response is replaced; everything else on the
item belongs to the page.

**Those three names are the wire's, and the reducer does not answer to them.**
Read as store events they were wrong, and every answer written without a row came
back from a live session as `Unhandled match for value` naming the whole event,
which is the same exhaustive-match error `store.dispatch` gives. A name the
network uses is not necessarily a name the reducer has a case for, and this cost
a release to find out because the refusal only ever reached the page console.

So `learnEvent()` takes the name from a click instead. It wraps
`store.agent.onEvent` where the store is found, records the `type` of any event
carrying a `contextItem` with a `toolResponse`, and calls through untouched; Stop
puts the property back. The script presses real Allow buttons several times an
hour whenever the transcript has rendered the row, and every one of them goes
through there, so the name arrives on its own and is used the next time there is
no row. `UPSERT_EVENT` is what it starts from and nothing more.

Only the `type` is read. The event carries the item, which is somebody's
transcript and their tool arguments.

The wrap is checked rather than assumed. This file is not a module, so the
assignment is not in strict mode, and a frozen object or an accessor with no
setter takes it silently and leaves the original in place, which reads exactly
like a page that never calls the property. `Object.defineProperty` is tried next,
and if the property still is not the wrapper it is said out loud.

The watch ignores this script's own writes, via `writingOurOwn`. Without that it
learns the name it just guessed, announces that an approval sends it, and is no
better informed.

**When the reducer has no case for any name held, the response is written
directly.** `writeResponseDirectly()` sets `toolResponse` on the pending item and
hands the store the state: the same single field the reducer would have set,
nothing else on the item rewritten and no other item touched. It is second rather
than preferred, because the reducer may do bookkeeping this cannot see. It is not
trusted either: the item is read back the same way, a write that did not stick is
recorded against item and event type, and the log says `no row, direct` so the
route that answered is never a guess. `failedToAnswer` covers both routes, so a
store neither can write to costs one attempt each rather than one per tick.

**`store.dispatch` is not the door.** It refuses the very event its own reducer
accepts, with `Unhandled match for value`, and the page has never once been
observed calling it: every click reaches the reducer through a reference the
store closed over. What works is running the reducer and handing the store the
result as an updater, `__setState(current => agent.onEvent(current, event))`,
since `agent.onEvent(state, event)` is the exact call the page makes. Do not
swap that for `dispatch`.

**`DEFAULT_RESPONSE` is a measurement, and it is allowed to rot.**
`noteGrantBefore()` and `readGrantAfter()` read the item either side of every
real click, so a session on a newer build teaches itself the current answer and
stops depending on the constant. The item watched is the one the button belongs
to, taken off its own fibers: with several prompts queued, the first pending
item in the map is not necessarily the one being answered.

**`STORE_LEVELS` is 200 and that matters.** The store sits near the root, so a
short walk finds it from the pill and nothing from a transcript row sixty
components down, and then reports that no store exists at all.

**The block list reads the tool's name, never its arguments.**
`update_notepad_dsl` carries an entire notepad document, so a transcript
mentioning production anywhere would refuse every notepad write in the session.
Arguments are content, and content is not intent.

**Nothing is reported as answered that the store did not take.** The item is
read back after the write, and a mismatch is recorded against that item so it is
attempted once rather than every second. Half answered is worse than waiting.

**A write the reducer throws on is recorded the same way**, and was not: a
reducer with no case for an event does not grow one between two ticks, and one
session's console held 1239 identical refusals of the same write, each printing
the whole event back. `failedToAnswer` is keyed on the item and the event type
together, so an answer refused under the wire name is tried again once a click
has taught the reducer's name rather than being written off with the item.

**A refusal never prints the event back.** The page's own message embeds the
entire event it could not match, which is the item, which is the user's
transcript and their tool arguments. One of them put a whole Slack message body
and a handful of RIDs into a console whose contents get pasted into chat windows.
`shorten()` it.

**The direct write only touches a pending item that is the map's own value.**
`findToolResponse()` searches `ITEM_SEARCH_DEPTH` levels down, so the holder it
returns need not be `map[id]`. Assigning to `map[id]` regardless has two ways to
go wrong and the second is the dangerous one: the id may not be a key, in which
case nothing is written and it reported that it had been; or it is a key, and the
write adds a second `toolResponse` above the real one, which stays pending, and
the read-back finds the outer one, matches, and starts the agent loop on a prompt
nobody answered. Half answered, by the one route with no reducer to catch it. So
the holder is checked against the map entry first, and a nested one is refused.

**The event name is learned only while a click of this script's own is in
flight.** Carrying a `contextItem` with a `toolResponse` is not enough on its own:
the tool's result comes back the same shape under a different type seconds later,
and whichever arrived last became the name used for the next answer.
`awaitingGrant` is set immediately before the click and cleared once the item is
seen to change, which is exactly the window an approval occupies.

**`watchedAgents` is a set, not a slot.** The console changes route without
reloading, so a session can be left and come back to. A single slot held the
agent from the session in between, and coming back wrapped the wrapper: each
round trip added a layer and a `teardown` entry, and Stop unwound only the
outermost, leaving the rest on the page after the panel was gone.

**The send label is anchored.** `submit` and `send message` as substrings match
`Submit feedback` anywhere on the page, and the first in document order wins, so
the wrong control is clicked and reported as sent: the resume logs that it went
and leaves the text in the composer with the session still stalled. The old exact
label was brittle and could at least not do that. Where more than one control
still answers to Send, the composer decides, by `SEND_SCOPE` ancestors. A decoy
button sits in the mock page ahead of the real one, so every existing send
assertion guards this.

**The prompt's text is read once per button.** `scan()` runs from a
MutationObserver on a page that mutates constantly, and a prompt the block list
holds back or an unticked category skips is never added to `clicked`, so it sat
there having its context walked from scratch on every mutation: five ancestors,
four hundred text nodes each, a `closest()` per node. Caching changes no decision,
the click path having always decided on the first scan that saw the button.

**An error's phrase is printed, never what it quotes.** `reasonFrom()` cuts at
the first brace. The reducer's message is `Unhandled match for value: {…the whole
event…}`, and the event is the item, so the first four hundred characters of it
are the tool's name and its arguments rather than anything about the failure.
Truncating bounded how much of somebody's transcript reached the console; it did
not stop it.

**Every way out of `answerWithoutARow()` says why, once, in the panel.** A silent
refusal is indistinguishable from the whole feature being dead, and a reason in a
console is very nearly as silent: it is not the service worker console the
extension's own errors go to, and nobody outside this repo opens either. Twice
now the fact needed to fix a stall has been sitting in a console while the panel
said something unactionable, so the reason goes in the log, once per reason, with
a `title` on the row since the line ellipsises at the panel's width.

`storeReport()` goes to the console beside it and names what the route could
reach rather than what it could not: whether there is a pill, a store, a
snapshot, a `contextMap`, how many items are in it, the `toolResponse.state` of
each, and the keys of the first item found. That last pair is what would catch
the session's shape moving, `findPendingItem()` needing an `id` on the holder
that carries the `toolResponse`, so an item nested one level deeper than expected
reads as nothing pending at all. Keys and states only: a context map is somebody's
transcript and a tool request is their data, and this gets pasted into chat
windows.

**403s on the page's own `PUT /ai-fde/api/threads/{id}`, and `Failed to save
session`.** Seen alongside a session driven from outside, and not caused by this
extension: the initiator is Foundry's own bundle. A thread updated out of turn
leaves the open page holding a version it no longer has, and the save it then
attempts does not carry every context item, so the server refuses it rather than
letting an old save overwrite newer progress. `PROTOCOL.md` in `ai-fde-prompter`
covers the same ground from the API side and notes that a stale `threadVersion`
gives a 409; this is the neighbouring case. Known, not fixed, and a reload clears
it. Do not read one of these as the panel having half-answered something: that
condition has its own report, and is checked by reading the item back.

**A turn that stopped part-way, and how it is told from one that finished.**
Moving between masts drops the agent loop's continuation. The client sets itself
idle, renders no banner and reports no error, and the session sits until somebody
types, because typing is what starts the loop again. `autoResumeEnabled` cannot
catch it: that watches for a banner, and there is none.

Measured off a live session across twenty minutes of ordinary work:

```
agentStatus.type   awaiting_response for the whole of a turn, tools included
                   idle between turns
requestStatus.type none throughout. Says nothing; do not read it
```

Idle alone is not the signal, because idle is also what waiting for the user
looks like. The last item in `contextOrder` is what separates them:

```
idle + assistant-message      finished; the user's turn
idle + tool-usage completed   the loop took the result and stopped
```

The second cannot be a finished turn. A model handed a tool result owes a reply,
so a turn ending there is one that was dropped. That is a structural check rather
than a timeout, which is what makes it safe to act on: a session genuinely waiting
for its user can never satisfy it.

`STALL_GRACE_MS` is 30s. A tool completing and the loop carrying on took four to
six seconds on the session this was measured from, and the grace is counted from
the item rather than the clock, so an ordinary turn never approaches it. Once per
item id: a restart that does not take is not worth repeating every two seconds.

`restartTurn()` calls `startAgentLoop`, the page's own continuation, which adds
nothing to the transcript. Failing that it presses send on an **empty** composer,
which `PROTOCOL.md` records as running a turn on what is already in the thread
without adding a user item, and only with Slate's placeholder showing, since
pressing send on somebody's half-written message would send it. Neither writes
anything in the user's name, which is what separates this from the network-error
resume and why it is the mildest of the three settings that act.

**Foundry's own approval settings are not a substitute.** The session metadata
carries `toolApprovalSettingsOverrides` and `bulkApprovalSettings`, with
`askUser` against `autoApprove` per tool. They do not cover every tool and do
not reliably hold. Issue #5.

**The visibility spoof answers the page, not the browser.** `document.hidden`
and `document.visibilityState` are given own properties on `document` that
report visible, and the going-hidden `visibilitychange` is stopped at the window
in the capture phase, upstream of anything the page has on `document`.
Applications defer work by reading those two and by acting on that event, and
this stops Foundry doing so on its own account. It cannot make Chrome draw the
tab and was measured not to fix the missing row, so do not describe it as what
makes a background tab work. That is `answerWithoutARow()`.

Three details are load-bearing. The coming-back event is let through, because
that is the one the page needs in order to catch up on anything it did defer.
`realVisibility()` keeps a reference to the prototype getter taken before the
properties are defined, so the script's own decisions and its diagnostics read
the truth rather than its own answer. And Stop deletes the properties, since a
page left reading its visibility off a panel that has been removed is a worse
state than either setting.

**Categories are matched riskiest first, which is not the order they are shown
in.** A prompt reading "deploy the build, view the plan first" matches both read
and deploy, and taking the first match in display order classes it as read,
which lets a deploy through with the deploy category unticked. Each category
carries a `risk` and `BY_RISK` sorts on it; `other` matches everything and has
the lowest risk, so it stays the fallback.

**The block list reads the prompt, not the button.** `TARGET_LABELS` is an exact
match on `allow` or `allow once`, so a list of blocked labels can never match
anything that exact match has not already excluded, and `delete`, `force` and
`production` are not button labels in the first place. They are matched against
the prompt's text, which is where the risk is. `always` and `forever` stay out
of that list: a prompt offering `Allow` beside `Always allow` carries the second
label in its own text, and blocking on it would refuse the ordinary case.

**Nothing about a prompt is read through a property that needs layout, and
nothing is read off the button's parent.** Both were, and both were wrong on the
real page in a way no fixture caught, because every fixture put the prompt in a
`role="dialog"` with a bare `<button>` in it. A real approval is a transcript
row: it is not a dialog, the sentence is a sibling of the buttons rather than
their parent's text, and the buttons carry an `aria-label` describing the action
rather than naming the control.

- `promptContextFor()` fell back to `btn.parentElement`, which is the action row,
  whose text is `Deny Allow`. So every prompt in a live session classified as
  `Unclassified` and the block list never saw the word it exists to catch: a
  prompt naming `production` was clicked. It now climbs to the first ancestor
  carrying words that are not on a button, bounded by `PROMPT_LEVELS` because the
  container above the row is the transcript and matching the block list against a
  whole session would refuse on something somebody typed an hour ago.
- `labelFor()` read `aria-label` ahead of `textContent`. `innerText` is empty for
  a row the page has not laid out, which is the state a windowed transcript keeps
  its off-screen rows in, so the aria-label answered, and `Allow this tool use
  once` is not in `TARGET_LABELS`. The row went unmatched, the pill above it was
  still up, and the panel reported `off-screen prompt still out of reach` with
  the button sitting in the document. `aria-label` now goes last, where it only
  answers for a button with no text of its own, which is what it is for.

Both read `textContent` through `collapse()`, since `textContent` keeps the
newlines a button written across three lines of JSX has between its words and
`TARGET_LABELS` is an exact match.

**The stall report names which of the two states it is.** `unmatchedAllows()`
counts buttons whose `textContent` is exactly a target label and that have not
been pressed. None of them is the page not having rendered the row, which nothing
here can fix; one of them is a row in the document that is not being matched,
which is a bug in this file. The two read identically in the panel, and the fact
that separated them was only ever in the console, which is what left the bug
above unfound. The panel now says `a prompt is on the page and was not matched`
for the second.

**A refusal is said out loud in both routes.** `answerWithoutARow()` always named
the prompts it held back; the click path returned silently, so a blocked prompt
looked exactly like the script having died. Once per button, via `refused`.

**Every setting's default lives in the markup**, and the variable behind it is
read from the checkbox at startup, so the two cannot drift. All three settings
are ticked, for the same reason: the tab is in the background and nobody is
watching it, which is the situation the whole thing exists for.

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

**The keep-alive builds no AudioContext before the page has been activated.**
Silent audio marks the tab as audible, which exempts the whole page from
Chrome's intensive throttling, so Foundry's own rendering and network activity
keep up in the background. A context created without a user gesture cannot
start, and Chrome writes its own warning into the page's console saying so,
which is somebody else's console to be littering. So
`navigator.userActivation.hasBeenActive` decides, and if it is false a one-shot
`pointerdown`/`keydown` listener builds the context on the first click or
keypress. `settleKeepAlive()` calls `resume()` and re-arms if the context comes
back suspended anyway. Headless Chromium reports `hasBeenActive` as true from
the start, so the suite covers the waiting path by stubbing
`navigator.userActivation`.

**Settings hints say what a setting does, not what it is doing.** No setting
carries a status field; `reportKeepAlive()` and `reportResume()` log state to
the console. Failures are the exception and go in the activity log, a silent
failure being the one thing that cannot be assumed away: a resume that could not
be sent, a prompt that cannot be reached, a message that could not be delivered,
and the keep-alive waiting for its gesture. That last earns its line because a
ticked box with a suspended context looks exactly like one that worked while the
tab is being throttled anyway, and one click on the page fixes it. A browser
test covers it with a stub context that stays suspended, since headless Chromium
does not apply the autoplay policy the same way.

**Putting text into the chat.** The composer is a Slate editor and builds its
model from trusted input. Code outside the page's own JavaScript context is in
an isolated world: it shares the DOM but not the globals, its events arrive with
`isTrusted` false, and the page's CSP refuses an injected `<script>`. A
synthetic `paste`, an `InputEvent('beforeinput')` and
`document.execCommand('insertText')` all leave Slate's model empty, and two of
them paint the text into the DOM regardless, so the composer looks filled while
the send button sends nothing. Range operations on the editor strip its
`data-slate-string` leaves and leave a composer that needs a page reload.

So the text goes through Slate's own editor object: the editable element's React
fiber is walked up to the `editor` prop, the selection is set to the end of the
document if nothing has been clicked in it, and `editor.insertText()` does the
work. Same shape as reaching the store from the pending pill, for the same
reason.

**Nothing is sent unverified.** After the insert, the send path reads back
`[data-slate-string]`, which is what Slate renders its model into, and refuses
when the text is not there. An empty send is not a no-op: the session answers it
by running its previous turn again, which looks and logs like a delivered reply.

**The send control is found after the text is in, and by pattern.** Both halves
were wrong and produced `no send button on this page` against a composer that
plainly has one. Looked up first, a composer with nothing in it need not render
one at all; held across the two 300ms waits, the page re-renders the composer
around the text and the reference is a detached node. And the lookup was a single
exact `aria-label`, which is the same brittleness that stopped Allow buttons
being matched. It is `aria-label` across every `button` and `[role="button"]`
first, then visible text, the pattern `ai-fde-prompter` already uses against this
page. The failure counts the controls it saw, so the next report says whether the
page had none or the match missed.

One consequence, deliberate: a send that fails now leaves the text in the
composer, where before the early return meant nothing was ever inserted. That is
the better of the two, the text being visible and the failure reported, but it
does mean a refused request leaves something for the user to clear.

**Requests from apps on this device.** The request arrives as
`data-auto-fde-request` on the body and the outcome goes back as
`data-auto-fde-result`, attributes being the only thing both worlds can see. A
`MutationObserver` reads it rather than a timer, since Chrome throttles timers
in a tab nobody is looking at and the tab will be in the background. Handled ids
are remembered, because the attribute stays on the body once answered and a
later mutation would otherwise resend it. Anything that can run script on this
device can write that attribute, the page's own JavaScript included.

Writing the message straight to the session over Foundry's API works from
anywhere, but it moves the thread version, so the page refuses its own next turn
as a conflict until it is reloaded, and the reload takes this panel down.

**Failures go in the tooltip.** Anything the service worker logs lands in the
service worker console, which is a different console from the page's and which
nobody outside this repo thinks to open. `describeUrlMismatch()` produces a
sentence naming the actual reason and `flagProblem()` puts it in the button's
tooltip. A successful injection flashes a green `on` badge, so a press that
worked looks different from one that did not. Those sentences are kept short
because they are read on a hover: a test caps them at sixty characters.

**The button state follows SPA navigation.** The AI FDE console changes route
without a full reload, which `chrome.tabs.onUpdated` catches. Moving between a
session and a Pipeline Builder page inside the console never reloads, and the
icon has to follow. `refreshAllTabs()` sweeps every open tab on install, on
browser startup, when the stored origins change and when host permissions are
granted or revoked, because none of the per-tab events fire for a tab already
sitting open.

**`chrome.action.disable()` is never called, and reintroducing it is a
regression.** In Manifest V3 it no longer greys the toolbar icon, so the only
thing it changes is the click, and a disabled action's click opens the
extension's context menu instead of firing `onClicked`. The result is a
full-colour button that appears to do nothing, which is worse than no signal at
all. The button is live on every page and the signal is the icon:
`describeButtonState()` in `gate.js` decides between the green icon and the grey
one and writes the reason into the tooltip, so hovering explains the state
without a press, and a press somewhere it cannot run flashes `!` with the same
reason. The grey icon is also `action.default_icon` in the manifest, so a tab
that has not been examined yet fails safe rather than looking ready.

**With nothing configured, a press opens the options page** rather than
reporting a problem, because that is the only useful thing it could do.

**Both icon sets are generated, not drawn.** `npm run icons` pulls the mark out
of `auto-fde.js` and rasterises it with Playwright at 16, 32, 48 and 128, once
in colour and once in flat grey. The mark is defined in exactly one place, so
the toolbar icon and the panel header cannot drift apart. Re-run it after
touching the mark and commit what it writes.

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
