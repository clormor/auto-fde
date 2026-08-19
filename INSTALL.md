# AI FDE AutoAllow — install

This adds a button to Chrome that clicks the `Allow` prompts in a Foundry AI FDE session for you.

## Install, once, about a minute

1. Move the `ai-fde-autoallow` folder somewhere permanent — Documents is fine. Chrome reads it off disk every time it starts, so if the folder moves or goes in the bin, the extension stops working.
2. Open a new tab and go to `chrome://extensions`
3. Turn on **Developer mode**, top right
4. Click **Load unpacked**, top left, and select the `ai-fde-autoallow` folder
5. Click the jigsaw-piece icon in Chrome's toolbar, find AI FDE AutoAllow, and click the pin so the button stays visible

## Using it

The button is grey everywhere except on an AI FDE session page. Open one and it turns colour. Press it, or press Alt+Shift+A, and a small panel appears in the bottom right.

The panel has checkboxes for which kinds of prompt to click, a counter, and a log of the last few. Drag it by its title bar if it's in the way. Stop and Remove shuts it down, and so does reloading the page.

## Before you leave it running

It clicks `Allow` and `Allow once`. It skips anything saying always, all future, forever, delete, force, production or deny, and deploy/build prompts are off until you tick that box.

Two things to know, because they will bite otherwise:

- Prompts it can't categorise from their wording land in `Uncategorized`, which is **on**. The default is to allow what it doesn't understand.
- The skip list matches the wording on the button, not what the action actually does. Something destructive behind a button labelled plainly `Allow` will get clicked.

So: fine on a session you're watching, doing work you'd have clicked through anyway. Not something to leave running unattended against anything that matters.

## If nothing happens

**Hover the button.** The tooltip is the diagnostic. A press that worked flashes a
green `on`; a press that failed flashes a red `!` and puts the reason in the
tooltip for fifteen seconds, in plain words: wrong host, wrong path, or Chrome
refusing the injection. Read that before anything else.

If the button is permanently grey and the tooltip says it only runs on session
pages, the page's address does not match what the extension expects. Copy the
address out of the bar and send it on; the pattern it matches on is the literal
text `/ai-fde/` in the path, on a `palantirfoundry.com` host, over https.

If nothing at all happens on a press, not even a badge, the extension has stopped
loading. That usually means the folder moved or was deleted; Chrome reads it off
disk every time it starts. Go to `chrome://extensions`, check the card is still
there and enabled, and look for an **Errors** button on it. Those errors do not
appear in the page's DevTools console. The service worker has its own console,
reached by the **service worker** link on the same card, and that is where this
extension's own logging goes.
