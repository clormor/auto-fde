// Unit test for the URL gate in background.js, and for the sentences it hands
// back when a URL is rejected.
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
const describeUrlMismatch = vm.runInContext('describeUrlMismatch', ctx);

const cases = [
  // should be accepted. The first is a real session URL off Chris's browser on
  // 2026-08-19, so the /ai-fde/ marker is confirmed against Foundry rather than
  // assumed. Keep it: it is the only case here that is not invented.
  ['https://valliance.palantirfoundry.com/workspace/ai-fde/session/69fa8c21-be1a-4210-bf71-a424d9b0e32d', true],
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
let total = 0;

for (const [url, expected] of cases) {
  const got = isTargetUrl(url);
  const pass = got === expected;
  total++;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${expected ? 'accept' : 'reject'}  ${JSON.stringify(url)}`);
}

// The rejection sentence is what a colleague sees in the button's tooltip, so it
// has to name the actual reason rather than restate that something is wrong.
const reasons = [
  ['names the missing address when Chrome withholds the url',
    undefined, /outside the sites/],
  ['names the wrong host',
    'https://evil.example/ai-fde/x', /on evil\.example, not palantirfoundry\.com/],
  ['names the scheme when it is not https',
    'http://valliance.palantirfoundry.com/ai-fde/x', /http: not https/],
  ['names the path when the host is right but the page is not a session',
    'https://valliance.palantirfoundry.com/workspace/home', /path is \/workspace\/home/],
  ['quotes the address when it will not parse',
    'not a url at all', /could not parse: not a url at all/],
];

for (const [name, url, pattern] of reasons) {
  const got = describeUrlMismatch(url);
  const pass = pattern.test(got);
  total++;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  reason  ${name}\n        ${got}`);
}

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
