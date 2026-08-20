// Renders the panel's mark into the toolbar icon PNGs.
//
//   node tools/make-icons.mjs
//
// The mark is defined once, as inline SVG inside auto-fde.js, and pulled out of
// there rather than copied, so the toolbar icon and the panel header cannot
// drift apart. Playwright does the rasterising: it is already a dev dependency,
// and an element screenshot with omitBackground gives an exact-size PNG with
// transparency, which is what chrome.action.setIcon wants.
//
// Two sets come out of it. The colour one is the active icon; the grey one is
// what the toolbar shows on any page Auto FDE cannot run on, which is the only
// visual signal there is, because chrome.action.disable() does not grey an icon
// in Manifest V3.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'auto-fde', 'auto-fde.js');
const OUT = path.join(root, 'auto-fde', 'icons');
const SIZES = [16, 32, 48, 128];

const source = fs.readFileSync(SRC, 'utf8');
const start = source.indexOf('<svg class="mark"');
const end = source.indexOf('</svg>', start);
if (start === -1 || end === -1) {
  console.error('could not find the mark in auto-fde.js: look for <svg class="mark">');
  process.exit(1);
}
const mark = source.slice(start, end + '</svg>'.length);

// Flat mid-grey, chosen to stay legible against both a light and a dark toolbar.
const GREY = '#8b93a1';
const grey = mark.replace(/stop-color="#[0-9a-fA-F]+"/g, `stop-color="${GREY}"`);

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const [svg, suffix] of [[mark, ''], [grey, '-inactive']]) {
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</body>`);
    const file = path.join(OUT, `icon${size}${suffix}.png`);
    await page.locator('svg').screenshot({ path: file, omitBackground: true });
    console.log(`wrote ${path.relative(root, file)}`);
  }
}

await browser.close();
