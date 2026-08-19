// Unit test for the URL gate in background.js.
//
// Runs in plain node with no browser and no network: the chrome API is stubbed
// so background.js can be evaluated, then isTargetUrl is pulled out and checked
// against a table of URLs.
//
//   node test/gate-test.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'ai-fde-autoallow', 'background.js'), 'utf8');

const event = () => ({ addListener() {} });
const sandbox = {
  URL,
  console,
  setTimeout,
  chrome: {
    runtime: { onInstalled: event(), onStartup: event() },
    tabs: { onUpdated: event(), onActivated: event(), query() {} },
    action: {
      onClicked: event(),
      enable() {}, disable() {},
      setTitle() {}, setBadgeText() {}, setBadgeBackgroundColor() {},
    },
    commands: { onCommand: event() },
    scripting: { executeScript() {} },
  },
};

const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx);
const isTargetUrl = vm.runInContext('isTargetUrl', ctx);

const cases = [
  // should be accepted
  ['https://valliance.palantirfoundry.com/workspace/ai-fde/session-9', true],
  ['https://palantirfoundry.com/ai-fde/x', true],
  ['https://a.b.palantirfoundry.com/x/ai-fde/y?q=1#z', true],

  // wrong page on the right host
  ['https://valliance.palantirfoundry.com/workspace/home', false],
  ['https://valliance.palantirfoundry.com/ai-fde', false],

  // lookalike hosts
  ['https://notpalantirfoundry.com/ai-fde/x', false],
  ['https://palantirfoundry.com.evil.example/ai-fde/x', false],
  ['https://evil.example/?q=palantirfoundry.com/ai-fde/', false],

  // wrong scheme, and things that are not pages
  ['http://valliance.palantirfoundry.com/ai-fde/x', false],
  ['chrome://extensions', false],
  ['', false],
  [undefined, false],
  ['not a url at all', false],
];

let failed = 0;
for (const [url, expected] of cases) {
  const got = isTargetUrl(url);
  const pass = got === expected;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${expected ? 'accept' : 'reject'}  ${JSON.stringify(url)}`);
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
