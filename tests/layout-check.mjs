import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:8123', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__trimstitch, null, { timeout: 15000 });

const r = await page.evaluate(() => {
  const g = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  return {
    well: g('#well'),
    video: g('.video-box'),
    controls: g('.p-controls'),
    timeline: g('#timeline'),
    scroller: g('.tl-scroller'),
    exportBtn: g('#exportBtn'),
    tlToolbar: g('#tlToolbar'),
    zoom: g('#zoom'),
  };
});
console.log(JSON.stringify(r, null, 2));

let ok = true;
const assert = (c, m) => { console.log((c ? '  ok: ' : '  FAIL: ') + m); if (!c) ok = false; };

assert(r.well && r.video && r.timeline && r.exportBtn && r.tlToolbar, 'all regions present');
assert(r.well.x + r.well.w <= r.video.x + 1, 'well sits left of preview');
assert(r.video.w > r.well.w * 1.5, `preview is dominant (${r.video.w}px vs ${r.well.w}px)`);
assert(r.timeline.y >= r.controls.y + r.controls.h - 2, 'timeline below preview');
assert(r.scroller.h > 100, `timeline has usable height (${r.scroller.h}px)`);
assert(r.video.h > 300, `preview tall enough (${r.video.h}px)`);
assert(r.exportBtn.x >= r.well.x - 1 &&
       r.exportBtn.x + r.exportBtn.w <= r.well.x + r.well.w + 1,
  'Export button inside library rail');
assert(r.tlToolbar.y >= r.scroller.y + r.scroller.h - 3,
  'editing toolbar sits below track rows');

// ---- vertical split: drag anchor at bottom of preview ----
const hBefore = await page.evaluate(() =>
  document.querySelector('#rightPane').getBoundingClientRect().height);
const vBefore = await page.evaluate(() =>
  document.querySelector('.video-box').getBoundingClientRect().height);

const sp = await page.evaluate(() => {
  const s = document.querySelector('#vSplit').getBoundingClientRect();
  return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
});
await page.mouse.move(sp.x, sp.y);
await page.mouse.down();
await page.mouse.move(sp.x, sp.y + 90, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(50);

const after = await page.evaluate(() => ({
  pane: document.querySelector('#rightPane').getBoundingClientRect().height,
  video: document.querySelector('.video-box').getBoundingClientRect().height,
}));
assert(Math.abs(after.pane - (hBefore - 90)) < 4,
  `dragging anchor down shrinks timeline by ~90px (${Math.round(hBefore)} -> ${Math.round(after.pane)})`);
assert(after.video > vBefore + 70,
  `preview grows taller when timeline shrinks (${Math.round(vBefore)} -> ${Math.round(after.video)})`);

await page.dblclick('#vSplit');
await page.waitForTimeout(50);
const reset = await page.evaluate(() =>
  document.querySelector('#rightPane').getBoundingClientRect().height);
assert(Math.abs(reset - hBefore) < 4,
  `double-click resets split (${Math.round(reset)} vs original ${Math.round(hBefore)})`);

await browser.close();
console.log(ok ? 'layout OK' : 'layout BROKEN');
process.exit(ok ? 0 : 1);
