// End-to-end test for the extension against a mock AI FDE page.
//
// The page is served by Playwright's request interception, so nothing leaves the
// browser and no request reaches any real Foundry instance. That lets the test
// use whatever hostname it likes; example.com stands in for a configured
// instance throughout.
//
//   npm install                        (once, pulls in playwright)
//   npx playwright install chromium    (once)
//   node test/ext-test.mjs

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(root, 'auto-fde');
const SCRIPT = fs.readFileSync(path.join(EXT, 'auto-fde.js'), 'utf8');

const ORIGIN = 'https://foundry.example.com';
const SESSION_URL = `${ORIGIN}/workspace/ai-fde/session/69fa8c21-be1a-4210-bf71-a424d9b0e32d`;
const LOG_LIMIT = 10;

const PAGE = `<!doctype html><html><body style="font-family:sans-serif">
<h1>Mock AI FDE session</h1>

<div role="dialog" id="d1">
  <p>Agent wants to read the dataset preview.</p>
  <button id="allow1">Allow</button>
  <button id="always1">Always allow</button>
</div>

<div role="dialog" id="d2">
  <p>Agent wants to deploy the build to production.</p>
  <button id="allow2">Allow</button>
</div>

<div role="dialog" id="d3">
  <p>Agent wants to create and update the ontology object.</p>
  <button id="allow4" disabled>Allow</button>
  <button id="allow3">Allow</button>
</div>

<script>
  window.__hits = [];
  document.addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON' && e.target.id) window.__hits.push(e.target.id);
  }, true);
</script>
</body></html>`;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// The panel lives in a shadow root, so document.querySelector cannot see into
// it. Everything below reaches through the host element the way a user's click
// does.
const has = (page, sel) => page.evaluate(s => {
  const r = document.getElementById('af-host');
  return !!(r && r.shadowRoot && r.shadowRoot.querySelector(s));
}, sel);
const text = (page, sel) => page.evaluate(s => {
  const r = document.getElementById('af-host');
  const el = r && r.shadowRoot ? r.shadowRoot.querySelector(s) : null;
  return el ? el.textContent.trim() : null;
}, sel);
const press = (page, sel) => page.evaluate(s => {
  document.getElementById('af-host').shadowRoot.querySelector(s).click();
}, sel);
const countOf = (page, sel) => page.evaluate(s => {
  const r = document.getElementById('af-host');
  return r && r.shadowRoot ? r.shadowRoot.querySelectorAll(s).length : 0;
}, sel);
const gone = page => page.evaluate(() => !document.getElementById('af-host'));

// The script reads its configuration off the page because a MAIN-world script
// cannot see chrome.storage. background.js writes it in before injecting; here
// the test does the same thing by hand.
async function mockPage(browser, url, config = { origins: [ORIGIN], pathMarker: '/ai-fde/' }) {
  const page = await browser.newPage();
  await page.route('**/*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  // Every AudioContext the keep-alive creates gets recorded, so unticking the box
  // can be checked for a leak. Nothing in the extension is involved in observing.
  await page.addInitScript(() => {
    window.__ctxs = [];
    const Real = window.AudioContext;
    window.AudioContext = function (...args) {
      const ctx = new Real(...args);
      window.__ctxs.push(ctx);
      return ctx;
    };
    window.AudioContext.prototype = Real.prototype;
  });
  await page.goto(url);
  if (config) await page.evaluate(c => { window.__autoFdeConfig = c; }, config);
  return page;
}

// ---------------------------------------------------------------------------
// Part 1 — how the script behaves on a page shaped like an AI FDE session
// ---------------------------------------------------------------------------
const browser = await chromium.launch();

const p1 = await mockPage(browser, SESSION_URL);
await p1.evaluate(SCRIPT);
await p1.waitForTimeout(1200);

check('panel renders', await has(p1, '#af-panel'));
check('the header carries the AI FDE diamond', await has(p1, '.hd svg.mark'));
check('handle exposed on window', await p1.evaluate(() => !!window.__autoFde));

const hits = await p1.evaluate(() => window.__hits);
check('clicked the read-category Allow', hits.includes('allow1'), JSON.stringify(hits));
check('clicked the write-category Allow', hits.includes('allow3'));
check('left "Always allow" alone', !hits.includes('always1'));
check('left the deploy-category Allow alone (off by default)', !hits.includes('allow2'));
check('left the disabled button alone', !hits.includes('allow4'));

const count = await text(p1, '#af-count');
check('counter matches the number of clicks', count === '2', `counter=${count}`);

// The transport controls are icons in the header, not labelled buttons in a
// footer, so that they still work when the panel is collapsed.
check('stop is an icon button in the header', await p1.evaluate(() => {
  const root = document.getElementById('af-host').shadowRoot;
  const stop = root.querySelector('#af-stop');
  return stop.getAttribute('aria-label') === 'Stop'
    && !!stop.querySelector('svg')
    && stop.closest('#af-header') !== null;
}));
check('pause is an icon button in the header', await p1.evaluate(() => {
  const root = document.getElementById('af-host').shadowRoot;
  const toggle = root.querySelector('#af-toggle');
  return toggle.getAttribute('aria-label') === 'Pause'
    && !!toggle.querySelector('svg')
    && toggle.closest('#af-header') !== null;
}));
check('the active-state pill is gone', !(await has(p1, '#af-status')));

check('keeping the tab awake is on by default',
  await p1.evaluate(() => document.getElementById('af-host').shadowRoot
    .querySelector('#af-keepalive').checked));

check('the resume toggle says what it does',
  (await text(p1, 'label:has(#af-resume-toggle)'))
    .startsWith('Automatically resume'));

check('the tab and network toggles share one Settings group', await p1.evaluate(() => {
  const root = document.getElementById('af-host').shadowRoot;
  const sec = root.querySelector('#af-keepalive').closest('.sec');
  return sec.querySelector('.cap').textContent.trim() === 'Settings'
    && sec.contains(root.querySelector('#af-resume-toggle'));
}));

check('the panel is translucent and blurs what is behind it', await p1.evaluate(() => {
  const style = getComputedStyle(document.getElementById('af-host').shadowRoot.querySelector('#af-panel'));
  const alpha = Number((style.backgroundColor.match(/rgba?\([^)]*?([\d.]+)\)$/) || [])[1]);
  const blur = style.backdropFilter || style.webkitBackdropFilter;
  return alpha > 0 && alpha < 1 && /blur/.test(blur);
}));

// The keep-alive is on by default, so the audio has to actually stop when it is
// turned off. A suspended context is fine; a running one that nobody can reach
// is a tab quietly playing audio for ever.
check('the keep-alive really did open an audio context',
  (await p1.evaluate(() => window.__ctxs.length)) >= 1);

await p1.evaluate(() => document.getElementById('af-host').shadowRoot
  .querySelector('#af-keepalive').click());
await p1.waitForTimeout(500);

check('unticking the keep-alive closes every audio context it opened',
  await p1.evaluate(() => window.__ctxs.every(c => c.state === 'closed')),
  JSON.stringify(await p1.evaluate(() => window.__ctxs.map(c => c.state))));
// Neither setting carries a status field: the panel assumes they work, and the
// hint says what the setting does rather than what it is currently doing.
check('the settings carry no status readout',
  !(await has(p1, '#af-keepalive-status')) && !(await has(p1, '#af-resume-status')));
check('the keep-alive hint ends after the sentence',
  (await text(p1, '#af-keepalive')).length === 0
    && (await p1.evaluate(() => document.getElementById('af-host').shadowRoot
      .querySelector('#af-keepalive').closest('.sec').querySelector('.hint').textContent.trim()))
      === 'Inaudible audio stops Chrome throttling this tab.');

// Keeping the tab awake is not a decision about which prompts to allow, so it
// must not sit in the same group as the prompt categories.
check('keeping the tab awake is not grouped with the prompt categories',
  await p1.evaluate(() => {
    const root = document.getElementById('af-host').shadowRoot;
    const cats = root.querySelector('#af-cats');
    const keepAlive = root.querySelector('#af-keepalive');
    return !cats.contains(keepAlive) && keepAlive.closest('.sec') !== cats.closest('.sec');
  }));

check('every section is captioned', await p1.evaluate(() => {
  const root = document.getElementById('af-host').shadowRoot;
  return [...root.querySelectorAll('.sec')].every(s => s.querySelector('.cap'));
}));

check('nothing renders in a monospace font', await p1.evaluate(() => {
  const root = document.getElementById('af-host').shadowRoot;
  return [...root.querySelectorAll('.panel, .panel *')]
    .every(el => !/monospace|courier/i.test(getComputedStyle(el).fontFamily));
}));

// turning the deploy category on should release the one it held back
await press(p1, 'input[data-cat="deploy"]');
await p1.evaluate(() => document.body.appendChild(document.createElement('span'))); // nudge the observer
await p1.waitForTimeout(1200);
check('deploy Allow clicked once its category is enabled',
  (await p1.evaluate(() => window.__hits)).includes('allow2'));

// ---------------------------------------------------------------------------
// The click must not depend on a timer. Chrome throttles timers in a hidden tab
// to once a second, and to once a minute once it has been hidden for five, so a
// deferred click meant approvals sat there until the tab was looked at.
// MutationObserver callbacks are not throttled, so the click happens inside one.
// ---------------------------------------------------------------------------
const clickedWithoutATimer = await p1.evaluate(() => {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.innerHTML = '<p>Agent wants to read the sync log.</p>';
  const b = document.createElement('button');
  b.id = 'notimer';
  b.textContent = 'Allow';
  d.appendChild(b);
  document.body.appendChild(d);

  // MutationObserver callbacks are microtasks. Draining a couple of microtask
  // turns without yielding to the task queue gives any setTimeout no chance to
  // run, so a click seen here happened without one.
  return new Promise(resolve => {
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() =>
      resolve(window.__hits.includes('notimer')))));
  });
});
check('the click needs no timer, so tab throttling cannot delay it',
  clickedWithoutATimer);

// Headless Chromium has no way to genuinely background a page: there is no CDP
// visibility override, and bringing another page to the front leaves
// document.visibilityState as "visible". So this is the closest achievable
// check. A click that lands inside 200ms cannot have come from the 300ms timer
// this replaced, and cannot have come from the 2000ms backstop either.
await p1.evaluate(() => {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.innerHTML = '<p>Agent wants to read the background record.</p>';
  const b = document.createElement('button');
  b.id = 'background';
  b.textContent = 'Allow';
  d.appendChild(b);
  document.body.appendChild(d);
});
await p1.waitForTimeout(200);
check('a prompt is approved faster than any timer in the old path allowed',
  (await p1.evaluate(() => window.__hits)).includes('background'));

// ---------------------------------------------------------------------------
// The panel must not grow with the click count. Twelve more prompts on top of
// the five already handled takes the log well past its limit.
// ---------------------------------------------------------------------------
await p1.evaluate(() => {
  for (let i = 0; i < 12; i++) {
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.innerHTML = `<p>Agent wants to read record ${i}.</p><button id="bulk${i}">Allow</button>`;
    document.body.appendChild(d);
  }
});
await p1.waitForTimeout(3000);

const logRows = await countOf(p1, '#af-log > div');
check(`log holds at most ${LOG_LIMIT} rows once more than that has been clicked`,
  logRows === LOG_LIMIT, `rows=${logRows}`);

const bulkCount = Number(await text(p1, '#af-count'));
check('the counter keeps the running total the log does not',
  bulkCount === 17, `counter=${bulkCount}`);

const fitsViewport = await p1.evaluate(() => {
  const r = document.getElementById('af-host').getBoundingClientRect();
  return r.height <= window.innerHeight && r.bottom <= window.innerHeight + 1;
});
check('the panel still fits inside the viewport', fitsViewport);

// Collapsing has to leave the header, because that is what carries the count and
// the active state.
await press(p1, '#af-collapse');
check('collapsing hides the body and keeps the header', await p1.evaluate(() => {
  const root = document.getElementById('af-host').shadowRoot;
  const collapsed = root.querySelector('#af-panel').hasAttribute('data-collapsed');
  const bodyHidden = getComputedStyle(root.querySelector('#af-body')).display === 'none';
  const headerVisible = root.querySelector('#af-header').getBoundingClientRect().height > 0;
  const countVisible = root.querySelector('#af-count').getBoundingClientRect().height > 0;
  // The whole reason the transport controls moved into the header.
  const canPause = root.querySelector('#af-toggle').getBoundingClientRect().height > 0;
  const canStop = root.querySelector('#af-stop').getBoundingClientRect().height > 0;
  return collapsed && bodyHidden && headerVisible && countVisible && canPause && canStop;
}));

const collapsedHeight = await p1.evaluate(() =>
  document.getElementById('af-host').getBoundingClientRect().height);
await press(p1, '#af-collapse');
const expandedHeight = await p1.evaluate(() =>
  document.getElementById('af-host').getBoundingClientRect().height);
check('expanding brings the body back', expandedHeight > collapsedHeight,
  `${collapsedHeight} -> ${expandedHeight}`);

// A label containing markup must not be able to write into the panel.
await p1.evaluate(() => {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.innerHTML = '<p>Agent wants to read this.</p>';
  const b = document.createElement('button');
  b.id = 'nasty';
  b.textContent = '<img src=x onerror=window.__pwned=1>Allow';
  d.appendChild(b);
  document.body.appendChild(d);
});
await p1.waitForTimeout(800);
check('a button label cannot inject markup into the log',
  await p1.evaluate(() => !window.__pwned)
    && !(await has(p1, '#af-log img')));

// The glyph says what pressing it does, the colour says what it is doing now, so
// pausing has to change both.
const beforePause = await p1.evaluate(() => {
  const t = document.getElementById('af-host').shadowRoot.querySelector('#af-toggle');
  return { state: t.dataset.state, glyph: t.innerHTML, colour: getComputedStyle(t).color };
});
await press(p1, '#af-toggle');
const afterPause = await p1.evaluate(() => {
  const t = document.getElementById('af-host').shadowRoot.querySelector('#af-toggle');
  return { state: t.dataset.state, glyph: t.innerHTML, colour: getComputedStyle(t).color,
           label: t.getAttribute('aria-label') };
});
check('pausing switches the glyph to play and relabels the button',
  afterPause.state === 'paused' && afterPause.label === 'Resume'
    && afterPause.glyph !== beforePause.glyph,
  `${beforePause.state} -> ${afterPause.state}`);
check('the paused glyph is a different colour from the running one',
  afterPause.colour !== beforePause.colour,
  `${beforePause.colour} -> ${afterPause.colour}`);

await p1.evaluate(SCRIPT);
check('re-injecting does not stack a second panel',
  (await p1.evaluate(() => document.querySelectorAll('#af-host').length)) === 1);

await press(p1, '#af-stop');
check('stop removes the panel and the handle',
  await p1.evaluate(() => !document.getElementById('af-host') && !window.__autoFde));

// ---------------------------------------------------------------------------
// The script's own guard, which is the second line of defence behind the gate
// in background.js.
// ---------------------------------------------------------------------------
const p2 = await mockPage(browser, `${ORIGIN}/workspace/home`);
await p2.evaluate(SCRIPT);
await p2.waitForTimeout(300);
check('refuses to run outside /ai-fde/', await gone(p2));

const p3 = await mockPage(browser, 'https://unlisted.example.com/workspace/ai-fde/session/1');
await p3.evaluate(SCRIPT);
await p3.waitForTimeout(300);
check('refuses to run on an origin that was not configured', await gone(p3));

const p4 = await mockPage(browser, SESSION_URL, null);
await p4.evaluate(SCRIPT);
await p4.waitForTimeout(300);
check('refuses to run with no configuration on the page at all', await gone(p4));

await browser.close();

// ---------------------------------------------------------------------------
// Part 2 — does Chrome accept the extension, and does the gate hold up inside a
// real service worker?
// ---------------------------------------------------------------------------
// channel: 'chromium' is load-bearing. The default download is the headless
// shell, which has no extension support at all, so --load-extension is silently
// ignored there and no service worker ever appears. The full Chromium build in
// its new headless mode does load extensions.
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

// The worker is registered lazily, so wait for it rather than sampling once.
let sw = ctx.serviceWorkers()[0];
if (!sw) {
  sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
}
check('Chrome loaded the extension and started its service worker', !!sw,
  sw ? sw.url() : 'no service worker');

// The gate itself is covered exhaustively by gate-test.mjs against the same
// module. What can only be checked here is that Chrome accepts this manifest,
// starts a module service worker from it, and serves the options page.
//
// Adding a valid origin cannot be driven from a test: chrome.permissions.request
// raises a native dialog that Playwright cannot reach. The rejection path needs
// no dialog, because normaliseOrigin refuses the input before any permission is
// asked for, so that is what gets exercised.
if (sw) {
  const extensionId = new URL(sw.url()).host;
  const options = await ctx.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForSelector('#origin-list li');

  check('the options page ships nothing configured by default',
    (await options.textContent('#origin-list')).includes('Nothing added yet'));

  await options.fill('#origin-input', 'http://foundry.example.com');
  await options.click('#add-form button[type=submit]');
  await options.waitForFunction(() => document.querySelector('#status').textContent.length > 0);

  check('the options page refuses a host it cannot use',
    (await options.textContent('#status')).includes('not a host Auto FDE can use'));

  const stored = await options.evaluate(async () => {
    const all = await chrome.storage.sync.get('foundryOrigins');
    return all.foundryOrigins;
  });
  check('a refused host is not stored', stored === undefined, JSON.stringify(stored));

  await options.fill('#origin-input', 'https://*.example.com');
  await options.click('#add-form button[type=submit]');
  await options.waitForTimeout(200);
  check('the options page refuses a wildcard host',
    (await options.textContent('#status')).includes('not a host Auto FDE can use'));
}

await ctx.close();

const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
