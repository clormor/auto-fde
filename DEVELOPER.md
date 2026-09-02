# Developing Auto FDE

Everything that is not installation. See [README.md](README.md) for that.

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

Keep two clones: the one Chrome loads and a separate one you edit in. Chrome
reads the extension folder off disk, and it does not wait for you to finish.
An edit saved half-way through, or a branch switched under it, is what it picks
up on the next reload, so working in the folder Chrome points at means breaking
the extension while you are using it, on the session you were using it for.
Point **Load unpacked** at the first clone and leave it alone; do the work in
the second, and pull into the first when you want to run it.

Edit the extension, bump `version` in `auto-fde/manifest.json`, verify, then
press the reload arrow on the extension's card at `chrome://extensions`. Anyone
else needs to pull and press the same arrow.

```
npm test              the gate, the origin parser, the tooltip sentences.
                      Node only, no browser, no network.
./check.sh            required files, manifest parses, all JS parses, version

npm install && npx playwright install chromium   (once)
npm run test:browser  the in-page script and the packaged extension. Needed
                      for anything touching auto-fde.js, manifest.json,
                      options.* or the injection path.
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
