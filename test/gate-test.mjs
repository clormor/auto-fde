// Unit tests for the URL gate, the origin parser and the sentences shown in the
// button's tooltip when a press is refused.
//
// gate.js holds no chrome APIs, so this imports it directly and runs in plain
// node with no browser and no network.
//
//   node test/gate-test.mjs

import { PATH_MARKER, isTargetUrl, normaliseOrigin, permissionPattern, describeUrlMismatch,
  describeButtonState } from '../auto-fde/gate.js';

// Two instances, so the multiple-base-URL case is covered rather than assumed.
const ORIGINS = ['https://foundry.example.com', 'https://other.example.org'];
const SESSION = '/workspace/ai-fde/session/69fa8c21-be1a-4210-bf71-a424d9b0e32d';

let failed = 0;
let total = 0;

function check(name, pass, detail = '') {
  total++;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

// --- the gate ---------------------------------------------------------------
// The accepted path shape is the one Foundry actually uses:
// https://<instance>/workspace/ai-fde/session/<uuid>
const gateCases = [
  [`https://foundry.example.com${SESSION}`, true],
  ['https://foundry.example.com/workspace/ai-fde/session-9', true],
  ['https://other.example.org/x/ai-fde/y?q=1#z', true],

  // right instance, wrong page
  ['https://foundry.example.com/workspace/home', false],
  ['https://foundry.example.com/ai-fde', false],

  // an instance nobody added, including one that only looks like one
  [`https://unlisted.example.com${SESSION}`, false],
  [`https://foundry.example.com.evil.example${SESSION}`, false],
  ['https://evil.example/?q=https://foundry.example.com/ai-fde/', false],

  // subdomains are not implied by the parent, and ports are part of the origin
  [`https://sub.foundry.example.com${SESSION}`, false],
  [`https://foundry.example.com:8443${SESSION}`, false],

  // wrong scheme, and things that are not pages
  [`http://foundry.example.com${SESSION}`, false],
  ['chrome://extensions', false],
  ['', false],
  [undefined, false],
  ['not a url at all', false],
];

for (const [url, expected] of gateCases) {
  const got = isTargetUrl(url, ORIGINS);
  check(`${expected ? 'accept' : 'reject'}  ${JSON.stringify(url)}`, got === expected);
}

check('marker is the AI FDE path segment', PATH_MARKER === '/ai-fde/', PATH_MARKER);

// With nothing configured the gate refuses everything, which is what keeps a
// fresh install from running anywhere.
check('rejects every page when no origins are configured',
  !isTargetUrl(`https://foundry.example.com${SESSION}`, []));
check('rejects every page when origins are missing entirely',
  !isTargetUrl(`https://foundry.example.com${SESSION}`, undefined));

// --- the toolbar button's state ---------------------------------------------
// The regression this guards: a non-session page on a configured instance used
// to leave the button looking usable, because chrome.action.disable() does not
// grey the icon in Manifest V3. Anything not ready must report ready: false so
// the caller paints the inactive icon.
const BUILDER = `${ORIGINS[0]}/workspace/builder/ri.eddie.main.pipeline.7043d022-c1d8-41fb-a003-102f77792f6d/sandbox/85143f9a-5818-4049-a422-d8dbe474c052`;

const buttonCases = [
  ['ready on a session page', `${ORIGINS[0]}${SESSION}`, ORIGINS,
    { ready: true, needsSetup: false }, /^Open Auto FDE$/],
  ['not ready on a builder page on the same instance', BUILDER, ORIGINS,
    { ready: false, needsSetup: false }, /^Auto FDE: not an AI FDE session\.$/],
  ['not ready on the workspace home of a configured instance',
    `${ORIGINS[0]}/workspace/home`, ORIGINS,
    { ready: false, needsSetup: false }, /^Auto FDE: not an AI FDE session\.$/],
  ['not ready on an instance that was never added',
    `https://unlisted.example.com${SESSION}`, ORIGINS,
    { ready: false, needsSetup: false }, /^Auto FDE: unlisted\.example\.com is not a base URL/],
  ['not ready when Chrome withholds the address', undefined, ORIGINS,
    { ready: false, needsSetup: false }, /^Auto FDE: Chrome will not share/],
  ['wants setting up when nothing is configured', `${ORIGINS[0]}${SESSION}`, [],
    { ready: false, needsSetup: true }, /^Auto FDE: no Foundry base URL set/],
];

for (const [name, url, origins, expected, titlePattern] of buttonCases) {
  const got = describeButtonState(url, origins);
  const pass = got.ready === expected.ready
    && got.needsSetup === expected.needsSetup
    && titlePattern.test(got.title);
  check(`button  ${name}`, pass, `ready=${got.ready} needsSetup=${got.needsSetup} "${got.title}"`);
}

// --- the origin parser ------------------------------------------------------
const originCases = [
  ['bare host gets https', 'foundry.example.com', 'https://foundry.example.com'],
  ['a full session URL is trimmed to its origin',
    `https://foundry.example.com${SESSION}`, 'https://foundry.example.com'],
  ['surrounding whitespace is ignored', '  foundry.example.com  ', 'https://foundry.example.com'],
  ['a trailing slash is dropped', 'https://foundry.example.com/', 'https://foundry.example.com'],
  ['a non-default port is kept', 'https://foundry.example.com:8443', 'https://foundry.example.com:8443'],
  ['localhost is allowed, for testing', 'localhost:8080', 'https://localhost:8080'],
  ['http is refused', 'http://foundry.example.com', null],
  ['a wildcard host is refused', 'https://*.example.com', null],
  ['a bare wildcard is refused', '*', null],
  ['empty input is refused', '   ', null],
  ['undefined is refused', undefined, null],
  ['a non-url is refused', 'not a url at all', null],
];

for (const [name, input, expected] of originCases) {
  const got = normaliseOrigin(input);
  check(`origin  ${name}`, got === expected, `${JSON.stringify(input)} -> ${JSON.stringify(got)}`);
}

check('permission pattern covers the whole instance',
  permissionPattern('https://foundry.example.com') === 'https://foundry.example.com/*');

// --- the rejection sentences ------------------------------------------------
// This is what a colleague reads in the tooltip, so it has to name the actual
// reason rather than restate that something is wrong.
const reasons = [
  ['sends an unconfigured extension to its options page',
    `https://foundry.example.com${SESSION}`, [], /^no Foundry base URL set\. Press to set one up\.$/],
  ['says so when Chrome withholds the address',
    undefined, ORIGINS, /^Chrome will not share this tab's address\.$/],
  ['names the host that is not on the list',
    `https://unlisted.example.com${SESSION}`, ORIGINS,
    /^unlisted\.example\.com is not a base URL you added\.$/],
  ['says so when the scheme is not https',
    `http://foundry.example.com${SESSION}`, ORIGINS, /^not an https page\.$/],
  ['says only that it is not a session when the instance is right',
    BUILDER, ORIGINS, /^not an AI FDE session\.$/],
  ['says so when the address will not parse',
    'not a url at all', ORIGINS, /^Chrome reported an address that will not parse\.$/],
];

for (const [name, url, origins, pattern] of reasons) {
  const got = describeUrlMismatch(url, origins);
  check(`reason  ${name}`, pattern.test(got), got);
}

// The whole point of the rewrite: these are read on a hover, so none of them may
// sprawl. Foundry paths are full of resource identifiers and used to be quoted
// back in full.
for (const [, url, origins] of reasons) {
  const got = describeUrlMismatch(url, origins);
  check(`reason stays short  ${JSON.stringify(got)}`, got.length <= 60, `${got.length} characters`);
}

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
