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
  <p>Agent wants to deploy the build to the staging stack.</p>
  <button id="allow2">Allow</button>
</div>

<div role="dialog" id="d4">
  <p>Agent wants to delete the production dataset.</p>
  <button id="allow5">Allow</button>
</div>

<div role="dialog" id="d5">
  <p>Agent wants to deploy the pipeline build, view the plan first.</p>
  <button id="allow6">Allow</button>
</div>

<div role="dialog" id="d3">
  <p>Agent wants to create and update the ontology object.</p>
  <button id="allow4" disabled>Allow</button>
  <button id="allow3">Allow</button>
</div>

<div role="combobox" contenteditable="true" id="chat"></div>
<button id="send" aria-label="Send message"></button>

<script>
  window.__hits = [];
  document.addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON' && e.target.id) window.__hits.push(e.target.id);
  }, true);
</script>
</body></html>`;

// A transcript shaped the way Foundry's is: a windowed list that only has the
// rows near the scroll position in the document. The approval below is not in
// the page at all until the list is put at the bottom, which is the state that
// left prompts sitting unanswered until somebody scrolled the tab.
const WINDOWED_PAGE = `<!doctype html><html><body style="margin:0">
<div id="scroller" style="height:400px;overflow-y:auto">
  <div style="height:4000px">transcript</div>
</div>
<div id="pill">239 Waiting for tool approval</div>

<script>
  window.__hits = [];
  document.addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON' && e.target.id) window.__hits.push(e.target.id);
  }, true);

  // The windowing. The pill is inert, as a pill that only reports the state
  // would be, so the only way to this prompt is the scroll. Every scroll is
  // recorded: one that arrives in a single step was not animated.
  window.__scrolls = [];
  document.getElementById('scroller').addEventListener('scroll', () => {
    const box = document.getElementById('scroller');
    window.__scrolls.push(box.scrollTop);
    if (box.scrollTop + box.clientHeight < box.scrollHeight - 1) return;
    if (document.getElementById('offscreen')) return;
    const row = document.createElement('div');
    row.setAttribute('role', 'dialog');
    row.innerHTML = '<p>Agent wants to read the pending record.</p>';
    const b = document.createElement('button');
    b.id = 'offscreen';
    b.textContent = 'Allow';
    row.appendChild(b);
    box.appendChild(row);
    document.getElementById('pill').remove();
  });
</script>
</body></html>`;

// The same situation, reached the other way: the pill is the page's own control
// for jumping to the pending row, and there is nothing here to scroll.
const PILL_PAGE = `<!doctype html><html><body>
<div>transcript</div>
<button id="pill">240 Waiting for tool approval</button>

<script>
  window.__hits = [];
  document.addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON' && e.target.id) window.__hits.push(e.target.id);
  }, true);

  document.getElementById('pill').addEventListener('click', () => {
    const row = document.createElement('div');
    row.setAttribute('role', 'dialog');
    row.innerHTML = '<p>Agent wants to read the pending record.</p>';
    const b = document.createElement('button');
    b.id = 'jumped';
    b.textContent = 'Allow';
    row.appendChild(b);
    document.body.appendChild(row);
    document.getElementById('pill').remove();
  });
</script>
</body></html>`;

// A prompt the script can see and has decided not to press, with the pill still
// up because the page is still waiting for an answer. Going to fetch this one
// would take the scrollbar off the user for as long as the prompt is there.
const REFUSED_PAGE = `<!doctype html><html><body style="margin:0">
<div id="scroller" style="height:400px;overflow-y:auto">
  <div style="height:4000px">transcript</div>
  <div role="dialog">
    <p>Agent wants to delete the production dataset.</p>
    <button id="refused">Allow</button>
  </div>
</div>
<div id="pill">241 Waiting for tool approval</div>

<script>
  window.__hits = [];
  document.addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON' && e.target.id) window.__hits.push(e.target.id);
  }, true);
</script>
</body></html>`;

// A pill that leads nowhere. Whatever it is up for, the script must stop trying
// to reach it rather than scroll the page every couple of seconds for ever.
const DEAD_PILL_PAGE = `<!doctype html><html><body>
<div>transcript</div>
<button id="deadpill">242 Waiting for tool approval</button>

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
async function mockPage(browser, url, config = { origins: [ORIGIN], pathMarker: '/ai-fde/' }, body = PAGE) {
  const page = await browser.newPage();
  await page.route('**/*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body }));
  // Two things are watched from outside the extension. Every AudioContext the
  // keep-alive opens is recorded, so unticking the box can be checked for a leak.
  // Every listener the script puts on window is counted in and out, so Stop can
  // be checked for leaving any behind; the page's own listener is on document, so
  // it is not counted here.
  await page.addInitScript(() => {
    window.__winListeners = {};
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    const tally = (type, by) => {
      window.__winListeners[type] = (window.__winListeners[type] || 0) + by;
    };
    window.addEventListener = (type, fn, opts) => { tally(type, 1); return add(type, fn, opts); };
    window.removeEventListener = (type, fn, opts) => { tally(type, -1); return remove(type, fn, opts); };

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
// The block list reads the prompt, not the button label. An exact match on
// "Allow" already rules out "Always allow", so a label-only list matched nothing
// at all; what it has to catch is what the prompt is asking for.
check('left a prompt naming a blocked word alone', !hits.includes('allow5'));
// Categories are matched riskiest first. This prompt matches read and deploy,
// and read winning would let a deploy through with its category switched off.
check('judged a read-and-deploy prompt by the riskier of the two',
  !hits.includes('allow6'));

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

check('resuming after a network error is on by default',
  await p1.evaluate(() => document.getElementById('af-host').shadowRoot
    .querySelector('#af-resume-toggle').checked));

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
const afterDeployOn = await p1.evaluate(() => window.__hits);
check('deploy Allow clicked once its category is enabled',
  afterDeployOn.includes('allow2'));
check('the read-and-deploy prompt goes through once deploy is enabled',
  afterDeployOn.includes('allow6'));
check('a prompt naming a blocked word stays blocked with every category on',
  !afterDeployOn.includes('allow5'));

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
  bulkCount === 18, `counter=${bulkCount}`);

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

// ---------------------------------------------------------------------------
// Auto-resume. The banner is what starts a recovery, and Foundry's callout does
// not always clear itself once the connection is back, so the banner still being
// there must not send the agent a second instruction.
// ---------------------------------------------------------------------------
// waitForStableConnection() probes the origin twice before it believes the
// connection is back. No test here reaches a network, so the probe is answered
// in the page.
await p1.evaluate(() => { window.fetch = async () => ({ ok: true, status: 200 }); });

const sendsSoFar = (await p1.evaluate(() => window.__hits)).filter(h => h === 'send').length;
await p1.evaluate(() => {
  const banner = document.createElement('div');
  banner.className = 'bp6-callout-intent-danger';
  banner.textContent = 'Network error: the request could not be completed.';
  document.body.appendChild(banner);
});
// Two successful probes a second apart, then 300ms for the editor.
await p1.waitForTimeout(4000);
const sendsAfter = (await p1.evaluate(() => window.__hits)).filter(h => h === 'send').length;
check('a network banner sends one resume message', sendsAfter === sendsSoFar + 1,
  `sends=${sendsAfter - sendsSoFar}`);
check('the resume went into the log',
  (await text(p1, '#af-log')).includes('sent the resume message'));

await p1.evaluate(() => document.body.appendChild(document.createElement('span')));
await p1.waitForTimeout(3000);
const sendsLater = (await p1.evaluate(() => window.__hits)).filter(h => h === 'send').length;
check('a banner still on screen does not send a second resume message',
  sendsLater === sendsAfter, `sends=${sendsLater - sendsAfter}`);

// ---------------------------------------------------------------------------
// The header is the drag handle and the transport controls sit inside it, so a
// press on one of those must not drag the panel out from under the pointer.
// ---------------------------------------------------------------------------
const beforeDragAttempt = await p1.evaluate(() =>
  JSON.stringify(document.getElementById('af-host').getBoundingClientRect().toJSON()));
const togglePoint = await p1.evaluate(() => {
  const r = document.getElementById('af-host').shadowRoot
    .querySelector('#af-toggle').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await p1.mouse.move(togglePoint.x, togglePoint.y);
await p1.mouse.down();
await p1.mouse.move(togglePoint.x - 80, togglePoint.y - 80, { steps: 4 });
await p1.mouse.up();
const afterDragAttempt = await p1.evaluate(() =>
  JSON.stringify(document.getElementById('af-host').getBoundingClientRect().toJSON()));
check('dragging from a header control does not move the panel',
  beforeDragAttempt === afterDragAttempt);

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
// Stop can be followed by another press of the toolbar button on the same page,
// so a listener left on window is a leak that compounds.
const leftOnWindow = await p1.evaluate(() =>
  Object.entries(window.__winListeners).filter(([, n]) => n > 0));
check('stop leaves no listeners behind on window',
  leftOnWindow.length === 0, JSON.stringify(leftOnWindow));

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

// A position saved on a wide screen puts the panel off the edge of a narrow one,
// and a panel nobody can reach cannot be stopped.
const p5 = await mockPage(browser, SESSION_URL);
await p5.evaluate(() =>
  localStorage.setItem('__autoFdePos', JSON.stringify({ left: 99999, top: 99999 })));
await p5.evaluate(SCRIPT);
await p5.waitForTimeout(300);
check('a position saved off the edge of the screen is clamped back into view',
  await p5.evaluate(() => {
    const r = document.getElementById('af-host').getBoundingClientRect();
    return r.left >= 0 && r.top >= 0
      && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
  }));

// ---------------------------------------------------------------------------
// A prompt that is not in the document. The transcript is a windowed list, so an
// approval arriving while the user is scrolled up leaves nothing to press and
// nothing for the observer to react to. Waiting does not fix it, which is what
// made the count sit still until somebody scrolled the tab.
// ---------------------------------------------------------------------------
const MAX_JUMPS = 5;
const JUMP_INTERVAL_MS = 1500;

const p6 = await mockPage(browser, SESSION_URL, undefined, WINDOWED_PAGE);
await p6.evaluate(SCRIPT);
await p6.waitForTimeout(600);
check('a prompt the list had not rendered is reached and approved',
  (await p6.evaluate(() => window.__hits)).includes('offscreen'),
  JSON.stringify(await p6.evaluate(() => window.__hits)));
// Assigning scrollTop needs no frame, which is what makes it the half of this
// that still works in a tab Chrome has stopped painting. A smooth scroll would
// arrive as a run of events instead, and would not arrive at all in a tab Chrome
// is not painting, since it is driven by frames.
const scrolls = await p6.evaluate(() => window.__scrolls);
check('the transcript arrives at the bottom in one step, not animated',
  scrolls.length === 1 && scrolls[0] === 3600, JSON.stringify(scrolls));

const p7 = await mockPage(browser, SESSION_URL, undefined, PILL_PAGE);
await p7.evaluate(SCRIPT);
await p7.waitForTimeout(600);
check('the page\'s own pending-prompt control is pressed when there is no scroll',
  (await p7.evaluate(() => window.__hits)).includes('jumped'),
  JSON.stringify(await p7.evaluate(() => window.__hits)));

// A refused prompt is still a prompt this script can see, and seeing one is what
// stops it going anywhere.
const p8 = await mockPage(browser, SESSION_URL, undefined, REFUSED_PAGE);
await p8.evaluate(SCRIPT);
await p8.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
await p8.waitForTimeout(JUMP_INTERVAL_MS * 2);
check('a prompt on screen that is refused leaves the scroll position alone',
  (await p8.evaluate(() => document.getElementById('scroller').scrollTop)) === 0);
check('a prompt naming a blocked word is still refused',
  !(await p8.evaluate(() => window.__hits)).includes('refused'));

// The cap. Every mutation is a chance to try again, so a pill that leads nowhere
// has to be given up on rather than chased for as long as the panel is open.
const p9 = await mockPage(browser, SESSION_URL, undefined, DEAD_PILL_PAGE);
await p9.evaluate(SCRIPT);
await p9.evaluate(() => {
  window.__nudge = setInterval(() => document.body.appendChild(document.createElement('span')), 100);
});
await p9.waitForTimeout(JUMP_INTERVAL_MS * (MAX_JUMPS + 1) + 800);
await p9.evaluate(() => clearInterval(window.__nudge));
const deadPresses = (await p9.evaluate(() => window.__hits)).filter(h => h === 'deadpill').length;
check(`a pill that leads nowhere is tried ${MAX_JUMPS} times and no more`,
  deadPresses === MAX_JUMPS, `presses=${deadPresses}`);
check('giving up on an unreachable prompt goes in the log',
  (await text(p9, '#af-log')).includes('could not reach an off-screen prompt'));

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
