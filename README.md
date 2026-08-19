# AI FDE AutoAllow

A Chrome extension that runs the AutoAllow script on a Foundry AI FDE session page. One button, no DevTools, no pasting.

The script itself is unchanged from the console version. It clicks `Allow` and `Allow once` prompts, can keep the tab awake with silent audio, and can resend a resume message after a network error. It skips anything labelled with `always`, `all future`, `forever`, `delete`, `force`, `production` or `deny`, and the deploy/build category is switched off until you turn it on.

## What this does and does not decide for you

Read this before handing it to a colleague.

The extension changes how the script is delivered. It does not change what the script does, and it does not review whether auto-clicking a consent prompt is appropriate for the work in front of you. The prompts exist so a person sees what the agent is about to do. Anyone running this is choosing to answer a class of those prompts in advance.

Practical consequences worth stating out loud:

- The categories are matched on the prompt's visible text with a handful of regexes. A prompt whose wording does not mention read, write, edit, update, create, deploy, build, publish or run falls into `Uncategorized`, which is enabled. So the default is to allow anything the script cannot classify.
- The block list is a text match on the button label, not on what the action does. A destructive action behind a button labelled plainly `Allow` will be clicked.
- Leave it running on a long unattended session and you will not know what was approved beyond the last five lines in the panel and whatever is in the console.

Reasonable use is a session you are supervising, on work you would have clicked through anyway. Unattended runs against anything touching production are a different proposition.

## Layout

```
ai-fde-autoallow/     the extension — this is the folder Chrome loads
  manifest.json
  background.js       decides when the button is live, injects the script
  autoallow.js        the script, unchanged
  icons/
build.sh              validates and packages
test/                 tests (see below)
dist/                 build output, gitignored
```

## Installing it for yourself

```
git clone <this repo>
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on Developer mode, top right
3. Click Load unpacked and select the `ai-fde-autoallow` folder
4. Click the jigsaw icon in the toolbar and pin AI FDE AutoAllow so the button stays visible

The button is greyed out everywhere except an AI FDE session page. Open one and it lights up. Press it, or Alt+Shift+A, and the panel appears bottom right. The panel's own Stop and Remove button shuts it down.

## Sending it to a colleague

```
./build.sh
```

That validates the extension and writes `dist/ai-fde-autoallow-v1.0.0.zip`. Send them the zip and the install steps above, with one extra step at the front: unzip it somewhere permanent first. Chrome reads an unpacked extension off disk every time it starts, so if the folder moves or goes in the bin the extension breaks.

`./build.sh --check` validates without writing anything. `./build.sh --store` also writes a second zip with `manifest.json` at the root, which is the shape the Chrome Web Store requires.

Nothing is ever overwritten. Build twice at the same version and you get a `-2` suffix. Bump `version` in `ai-fde-autoallow/manifest.json` when you ship a real change.

## Updating the script

Edit `ai-fde-autoallow/autoallow.js`, bump the version in `manifest.json`, then press the reload arrow on the extension's card at `chrome://extensions`. Colleagues on the zip need a new zip.

## Tests

```
npm test            URL gate only. Node, no browser, no network.
npm install && npx playwright install chromium
npm run test:browser   full run against a mock AI FDE page
```

The browser test serves its mock page through Playwright's request interception, so no request reaches Palantir. It checks that the panel renders, that a read-category and a write-category `Allow` get clicked, that `Always allow`, disabled buttons and the deploy category are left alone, that the counter agrees, that pressing the button twice does not stack two panels, and that the script refuses to run outside `/ai-fde/`.

`npm test` passes 13/13 on this machine. `npm run test:browser` has never been executed, because the machine it was authored on had no way to install Playwright — treat it as unproven until you have seen it pass.

## Notes for whoever maintains this

`background.js` injects into the page's own JavaScript context, set by `world: "MAIN"`. That is required, not cosmetic: `setTextareaValue()` reaches for the page's `HTMLTextAreaElement` descriptor to get past React's patched value setter, and the `window.__aiFdeAutoAllow` guard has to be visible to the page so a second press finds the existing panel rather than building another one.

The extension asks for `scripting` plus host access to `https://*.palantirfoundry.com/*`. The host permission is what lets the button grey itself out on pages where the script would refuse to run. If your Foundry instance is on a different domain, change it in two places: `host_permissions` in `manifest.json`, and the `HOST` constant at the top of `background.js`. The script's own guard in `autoallow.js` checks the hostname a third time and would need the same edit.

The AI FDE console navigates without full page reloads. `chrome.tabs.onUpdated` catches those, which is why the button state tracks in-app navigation rather than only hard loads.
