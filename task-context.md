# task-context — AI FDE AutoAllow extension

Last updated: 2026-08-19

## Brief

Chris had a console script (`chrome-ai-fde-autoallow.js`) that he pasted into DevTools on Foundry AI FDE session pages. He wanted it wrapped so colleagues who don't know browser debugging can run it, then asked for `~/git/scripts` repackaged to hold the script plus the infra to build and package the extension.

## Decisions taken

From the questions answered at the start of the session: runs on demand per tab, not auto-injected; colleagues are on unmanaged Chrome so Load unpacked is available; the script draws its own UI overlay.

Delivery route: unpacked MV3 extension with a toolbar button. Rejected alternatives, for the record:

- bookmarklets are blocked by Content Security Policy on many real sites and fail silently
- DevTools snippets need the Sources panel and a manual paste per Chrome profile
- pasting into the console now requires typing "allow pasting" first, which stops non-technical colleagues dead

## Layout

```
ai-fde-autoallow/   manifest.json, background.js, autoallow.js, icons/
build.sh            validate + package, never overwrites
test/               gate-test.mjs (node only), ext-test.mjs (playwright)
package.json        npm run check / build / test
dist/               gitignored build output
```

The original `chrome-ai-fde-autoallow.js` was moved to `ai-fde-autoallow/autoallow.js` rather than copied, so there is one source of truth and no drift. Content is unchanged.

## Implementation notes

`world: "MAIN"` on the injection is required. `setTextareaValue()` in the script reaches for the page's own `HTMLTextAreaElement` value descriptor to defeat React's patched setter, which only works from the page's context, and the `window.__aiFdeAutoAllow` guard has to be visible to the page so a second button press finds the existing panel instead of stacking another.

Permissions are `scripting` plus `https://*.palantirfoundry.com/*`. The host permission buys the greyed-out button on non-AI-FDE pages, which pre-empts "why isn't it doing anything". The domain is hardcoded in three places: `host_permissions`, the `HOST` constant in `background.js`, and the script's own guard.

`chrome.tabs.onUpdated` handles the AI FDE console's in-app navigation, so the button state follows SPA route changes rather than only hard reloads.

## Verified on Chris's machine

- `./build.sh --check` clean: required files present, `manifest.json` parses, both JS files pass `node --check`
- `./build.sh --store` produced both zips with the right internal structure — wrapper folder in one, `manifest.json` at the root in the other
- rerunning at the same version wrote `-2` rather than overwriting, as intended
- `node test/gate-test.mjs` passes 13/13, including the lookalike-host and wrong-scheme rejections
- `autoallow.js` in the built zip is 11421 bytes with its original mtime, so the shipped file is Chris's own, untouched

## Not verified

- `test/ext-test.mjs`, the browser run. Needs Playwright, which could not be installed on either machine involved. The click, category, block-list and toggle behaviour is therefore unproven.
- Whether the icons render legibly in the real toolbar at 16px.

## Fixed in 1.0.2, after a failure on a fresh session

Symptom: on a freshly added extension the button did nothing on an already-open
AI FDE session, or flashed a red `!` with no visible explanation.

Two causes, both in `background.js`:

- `onInstalled` and `onStartup` disabled the action globally and then waited for
  `tabs.onUpdated` or `tabs.onActivated` to re-enable it per tab. Neither event
  fires for a tab that is already sitting open, so the button stayed greyed
  until the page was reloaded or the tab was switched away from and back.
  `refreshAllTabs()` now sweeps `chrome.tabs.query({})` on install and startup.
  No new permission needed: the host permission already exposes those URLs.
- `flagProblem()` reported its reason only through `console.warn`, which lands in
  the service worker console. That is a different console from the page's, and
  nobody outside this repo thinks to open it, so every failure looked identical
  from outside. The reason now goes into the button's tooltip for fifteen
  seconds via `describeUrlMismatch()`, and a successful injection flashes a green
  `on` badge so a press that worked looks different from one that did not.

The URL gate itself was never at fault. Confirmed against a real session URL,
`https://valliance.palantirfoundry.com/workspace/ai-fde/session/<uuid>`, which is
now the first case in `gate-test.mjs` and the only one there that is not invented.
Chrome accepts the manifest; that part of "not verified" above is settled.

## Fixed during the build

`zip` assembles its output as a temp file in the target directory and then renames it. The Cowork device bridge forbids that rename, so the first build failed with "Operation not permitted" and left temp files behind. `build.sh` now stages the zip in `mktemp -d` and copies it into `dist/`, which also makes it safe on network shares and sync folders. The stray files from the failed attempt are in `dist/_to_delete/` awaiting Chris — the bridge cannot delete.

## Open

The README carries a section on what the tool does and does not decide, covering the `Uncategorized` category defaulting to enabled, the block list matching button labels rather than actions, and the thin audit trail. Worth a look before this circulates widely inside Valliance.
