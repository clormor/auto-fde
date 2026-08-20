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

Two settings sit below the categories:

- **Keep the tab awake**, on by default, since a tab left in the background is
  the usual reason to run this. Inaudible audio stops Chrome throttling the tab.
  Chrome will not let a page start audio until somebody touches it, so click
  anywhere in the tab once.
- **Automatically resume after a network error**, on by default, since a
  dropped connection is what actually ends an unattended session. Once the
  connection has been back for a couple of seconds it types one line into the
  chat telling the agent to carry on, and sends it. Every send is in the panel's
  log. Untick it if you would rather nothing was said on your behalf.

If a prompt arrives while you are scrolled up the transcript, the panel scrolls
you to the bottom to reach it. Foundry only keeps the part of a long session you
are looking at on the page, so there is no other way to press a button that is
not there. If it cannot get to one, the log says so and you can scroll to it
yourself.

**Stop** shuts it down, and so does reloading the page. Press the toolbar button
again to start it back up.

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

**A prompt sitting unanswered.** The panel goes and gets prompts that are off
screen, so this should be rare. When it happens the log line reads `could not
reach an off-screen prompt`: scroll to the prompt and it will be pressed. A
prompt that stays put once it is in front of you is one the panel is refusing,
either because its category is unticked or because the prompt mentions deleting,
forcing or production.

Anything beyond that is in [DEVELOPER.md](DEVELOPER.md).
