# Auto FDE

A Chrome extension that clicks the `Allow` prompts in a Palantir Foundry AI FDE
session for you. One button, no DevTools, no pasting.

It answers a class of consent prompts in advance, which is a choice rather than
a convenience. Before leaving it running, read
[what it does and does not decide for you](DEVELOPER.md#what-this-does-and-does-not-decide-for-you).

## Install

Nothing is published to the Chrome Web Store, so this loads unpacked from a
clone.

1. Clone the repo somewhere permanent. Chrome reads the folder off disk every
   time it starts, so if it moves or goes in the bin the extension stops
   working.
2. Open `chrome://extensions` and turn on **Developer mode**, top right.
3. Click **Load unpacked**, top left, and select the `auto-fde` folder.
4. Click the jigsaw icon in Chrome's toolbar and pin Auto FDE, so the button
   stays visible.
5. On the options page that opens by itself, type your Foundry host, usually
   something like `yourcompany.palantirfoundry.com`, and press **Add**. Chrome
   asks permission to access that host, which the extension needs in order to
   run there.

Step 5 is required: the extension ships knowing about no Foundry instance at
all, so until you add one it will not run anywhere. To get back to the options
page later, right-click the toolbar button and choose **Options**.

Pasting a whole session URL works too; everything after the host is discarded.
Wildcards are not accepted, so add each instance separately. Your list is stored
in your Chrome profile and follows it to your other machines. It is never
written into this repo.

## Use it

The button's tick is grey everywhere except on an AI FDE session page on one of
your base URLs, where it turns green. Hover it and the tooltip says either that
it is ready or exactly why it is not. Press it, or press Alt+Shift+A, and a
panel appears in the bottom right. One of your base URLs is not enough on its
own: the rest of the Foundry workspace, a Pipeline Builder page for instance, is
on the same host but is not a session, so the button stays grey there.

The panel has checkboxes for which kinds of prompt to click, a counter, and the
last ten prompts it clicked. Drag it by the title bar to move it; position and
collapsed state are remembered. Pause and stop are icons in the title bar, so
they still work when the panel is collapsed down to a single bar with the
chevron. Paused shows an amber play icon, running shows a green pause icon.

Three settings sit below the categories:

- **Keep the tab awake**, on by default. Inaudible audio marks the tab as
  audible, which stops Chrome throttling its timers and stops the tab being
  frozen or discarded on a long session. Chrome will not let a page start audio
  until somebody touches it, so click anywhere in the tab once.
- **Automatically resume after a network error**, on by default, since a
  dropped connection is what actually ends an unattended session. Once the
  connection has been back for a couple of seconds it types one line into the
  chat telling the agent to carry on, and sends it. Every send is in the panel's
  log. Untick it if you would rather nothing was said on your behalf.
- **Tell the page the tab is visible**, on by default. Foundry is told the tab is
  in front even when it is not, so it does not defer its own work while you are
  elsewhere. It does not make a background tab work, for the reason in the next
  section. Untick it if anything about the session behaves oddly.

If a prompt arrives while you are scrolled up the transcript, the panel scrolls
you to the bottom to reach it. Foundry only keeps the part of a long session you
are looking at on the page, so there is no other way to press a button that is
not there. If it cannot get to one it keeps trying, more slowly, and says so in
the log.

**Stop** shuts it down, and so does reloading the page. Press the toolbar button
again to start it back up.

## Keep the session in front of you

**A background tab does not work, and cannot be made to.** Chrome stops drawing a
tab you are not looking at, and Foundry does not add the message to a page it is
not drawing, so the prompt arrives with no button on the page for anything to
press. That has been measured rather than guessed: in a background tab there are
dozens of buttons in the page and not one of them is an approval. No extension
can reach a button that is not there. The panel keeps checking, and it presses the
prompt within a second of your coming back to the tab, but while you are away
nothing happens.

What does work is keeping the session in its own window and leaving any sliver of
it uncovered, then working in another app. Chrome keeps drawing a window you can
see even when it is not the one you are typing in, so the session keeps running
and prompts get pressed while you are elsewhere. A window fully hidden behind
another window counts as not visible, so leave an edge of it showing.

Clicking once in the tab after you open the panel is worth doing whatever you
choose, since that is what lets the keep-alive start. The log says so if it has
not.

## If nothing happens

**Hover the button.** The tooltip is the diagnostic. A press that worked flashes
a green `on`; a press that failed flashes a red `!` and puts the reason in the
tooltip for fifteen seconds, in plain words: an instance you have not added, a
page that is not a session, or Chrome refusing the injection. Pressing it
somewhere it cannot run is harmless.

A press always does something, so if nothing at all happens, not even a badge,
the extension has stopped loading. That usually means its folder moved or was
deleted. Check the card at `chrome://extensions` is still there and enabled, and
look for an **Errors** button on it. Those errors do not appear in the page's
DevTools console, and neither does anything this extension logs: that goes to
the **service worker** console, reached by the link of that name on the same
card.

**A prompt sitting unanswered.** If the tab is in the background, see the section
above: that is expected and switching to the tab settles it within a second. In
the tab, the panel goes and gets prompts that are off screen, so it should be
rare; when it cannot, the log reads `off-screen prompt still out of reach`. A prompt that stays put once it is in front of you is a different
thing: that one is being refused, either because its category is unticked or
because the prompt mentions deleting, forcing or production.

**`click the page once to keep the tab awake` in the log.** Chrome will not let a
page start audio until somebody touches it, and the keep-alive is that audio, so
until you click anywhere in the tab Chrome throttles it. Click once and the line
stops appearing.

Anything beyond that is in [DEVELOPER.md](DEVELOPER.md).
