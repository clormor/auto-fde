# Auto FDE

A Chrome extension that clicks the `Allow` prompts in a Palantir Foundry AI FDE
session for you. One button, no DevTools, no pasting.

Read [what it does and does not decide for you](DEVELOPER.md#what-this-does-and-does-not-decide-for-you)
before leaving it running. It approves a class of consent prompts in advance,
which is a choice, not a convenience.

## Install

Nothing is published to the Chrome Web Store, so this is an unpacked extension
loaded straight from a clone.

1. Clone this repo somewhere permanent. Chrome reads the folder off disk every
   time it starts, so if it moves or goes in the bin the extension stops
   working.

   ```
   git clone <this repo>
   ```
2. Open `chrome://extensions`
3. Turn on **Developer mode**, top right
4. Click **Load unpacked**, top left, and select the `auto-fde` folder
5. Click the jigsaw icon in Chrome's toolbar and pin Auto FDE so the button
   stays visible

## Add your Foundry base URL

This step is required. The extension ships knowing about no Foundry instance at
all, so until you add one it will not run anywhere.

Installing opens the options page by itself. To get back to it later, right-click
the toolbar button and choose **Options**.

Type your Foundry host, usually something like `yourcompany.palantirfoundry.com`,
and press **Add**. Pasting a whole session URL works too; everything after the
host is discarded. Chrome will ask permission to access that host, which the
extension needs in order to run on it. Add as many instances as you use.

Wildcards are not accepted, so add each instance separately. Your list is stored
in your Chrome profile and follows it to your other machines. It is never written
into this repo.

## Use it

The button's tick is grey everywhere except on an AI FDE session page on one of
your base URLs, where it turns green. Hover it and the tooltip says either that
it is ready or exactly why it is not. Press it, or press Alt+Shift+A, and a panel
appears in the bottom right.

Pressing it on a page it cannot run on is harmless: it flashes a red `!` and puts
the reason in the tooltip. Note that "one of your base URLs" is not enough on its
own. The rest of the Foundry workspace, a Pipeline Builder page for instance, is
on the same host but is not a session, so the button stays grey there.

The panel has checkboxes for which kinds of prompt to click, a counter, and the
last ten prompts it clicked. Pause and stop are icons in its title bar, so they
still work when the panel is collapsed down to a single bar with the chevron.
Paused shows an amber play icon, running shows a green pause icon. Drag it by the
title bar to move it; position and collapsed state are remembered.

**Keep the tab awake** is on by default, since a tab left in the background is
the usual reason to run this. Chrome will not let a page start audio until
somebody touches it, so the panel shows `starts on your next click` until you
click anywhere on the page, then `On`.

**Stop** shuts it down, and so does reloading the page. Press the toolbar button
again to start it back up.

## If nothing happens

**Hover the button.** The tooltip is the diagnostic. A press that worked flashes
a green `on`; a press that failed flashes a red `!` and puts the reason in the
tooltip for fifteen seconds, in plain words: an instance you have not added, a
page that is not a session, or Chrome refusing the injection.

A press always does something, so if nothing at all happens, not even a badge,
the extension has stopped loading. That usually means its folder moved or was
deleted. Check the card at `chrome://extensions` is still there and enabled, and
look for an **Errors** button on it. Those errors do not appear in the page's
DevTools console, and neither does anything this extension logs: that goes to the
**service worker** console, reached by the link of that name on the same card.

Anything beyond that is in [DEVELOPER.md](DEVELOPER.md).
