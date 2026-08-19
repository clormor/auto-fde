// End-to-end test for the extension against a mock AI FDE page.
//
// The page is served by Playwright's request interception, so nothing leaves the
// browser and no request reaches Palantir. That lets the test use a real
// palantirfoundry.com URL, which autoallow.js requires before it will run.
//
//   npm install          (once, pulls in playwright)
//   npx playwright install chromium   (once)
//   node test/ext-test.mjs

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(root, 'ai-fde-autoallow');
const SCRIPT = fs.readFileSync(path.join(EXT, 'autoallow.js'), 'utf8');

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
  <button id="allow3">Allow</button>
  <button id="allow4" disabled>Allow</button>
</div>

<script>
  window.__hits = [];
  for (const b of document.querySelectorAll('button')) {
    b.addEventListener('click', () => window.__hits.push(b.id));
  }
</script>
</body></html>`;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function mockPage(browser, url) {
  const page = await browser.newPage();
  await page.route('**/*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  await page.goto(url);
  return page;
}

// ---------------------------------------------------------------------------
// Part 1 — how the script behaves on a page shaped like an AI FDE session
// ---------------------------------------------------------------------------
const browser = await chromium.launch();

const p1 = await mockPage(browser, 'https://valliance.palantirfoundry.com/workspace/ai-fde/session-1');
await p1.evaluate(SCRIPT);
await p1.waitForTimeout(1200);

check('panel renders', await p1.evaluate(() => !!document.querySelector('#aa-count')));
check('handle exposed on window', await p1.evaluate(() => !!window.__aiFdeAutoAllow));

const hits = await p1.evaluate(() => window.__hits);
check('clicked the read-category Allow', hits.includes('allow1'), JSON.stringify(hits));
check('clicked the write-category Allow', hits.includes('allow3'));
check('left "Always allow" alone', !hits.includes('always1'));
check('left the deploy-category Allow alone (off by default)', !hits.includes('allow2'));
check('left the disabled button alone', !hits.includes('allow4'));

const count = await p1.evaluate(() => document.querySelector('#aa-count').textContent);
check('counter matches the number of clicks', count === '2', `counter=${count}`);

// turning the deploy category on should release the one it held back
await p1.evaluate(() => {
  document.querySelector('input[data-cat="deploy"]').click();
  document.body.appendChild(document.createElement('span')); // nudge the observer
});
await p1.waitForTimeout(1200);
check('deploy Allow clicked once its category is enabled',
  (await p1.evaluate(() => window.__hits)).includes('allow2'));

await p1.evaluate(() => document.querySelector('#aa-toggle').click());
check('pause flips the status to PAUSED',
  (await p1.evaluate(() => document.querySelector('#aa-status').textContent)) === 'PAUSED');

await p1.evaluate(SCRIPT);
check('re-injecting does not stack a second panel',
  (await p1.evaluate(() => document.querySelectorAll('#aa-count').length)) === 1);

await p1.evaluate(() => document.querySelector('#aa-stop').click());
check('stop removes the panel and the handle',
  await p1.evaluate(() => !document.querySelector('#aa-count') && !window.__aiFdeAutoAllow));

const p2 = await mockPage(browser, 'https://valliance.palantirfoundry.com/workspace/home');
await p2.evaluate(SCRIPT);
await p2.waitForTimeout(300);
check('refuses to run outside /ai-fde/',
  await p2.evaluate(() => !document.querySelector('#aa-count')));

await browser.close();

// ---------------------------------------------------------------------------
// Part 2 — does Chrome accept the extension, and does the URL gate hold up
// inside a real service worker?
// ---------------------------------------------------------------------------
const ctx = await chromium.launchPersistentContext('', {
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await new Promise(r => setTimeout(r, 3000));
const sw = ctx.serviceWorkers()[0];
check('Chrome loaded the extension and started its service worker', !!sw,
  sw ? sw.url() : 'no service worker');

if (sw) {
  const cases = [
    ['https://valliance.palantirfoundry.com/workspace/ai-fde/session-9', true],
    ['https://palantirfoundry.com/ai-fde/x', true],
    ['https://valliance.palantirfoundry.com/workspace/home', false],
    ['https://notpalantirfoundry.com/ai-fde/x', false],
    ['http://valliance.palantirfoundry.com/ai-fde/x', false],
    ['chrome://extensions', false],
  ];
  let allOk = true;
  for (const [url, expected] of cases) {
    const got = await sw.evaluate(u => isTargetUrl(u), url);
    if (got !== expected) { allOk = false; console.log(`   gate wrong for ${url}: got ${got}`); }
  }
  check('URL gate accepts only https AI FDE pages on palantirfoundry.com', allOk);
}

await ctx.close();

const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
