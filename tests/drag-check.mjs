// Verifies cross-track segment dragging: generates two clips (two tracks),
// drags track 2's segment onto the END of track 1 with real mouse events,
// then exercises within-track reordering through the store API.
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8123', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__trimstitch, null, { timeout: 15000 });

// -- setup: two clips -> two tracks --
await page.evaluate(async () => {
  const { getFFmpeg } = await import('/src/ffmpeg-loader.js');
  const ff = await getFFmpeg();
  const enc = async (name, freq) => {
    const c = await ff.exec([
      '-hide_banner',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=1',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', name,
    ]);
    if (c !== 0) throw new Error(`encode failed ${name}`);
    return Array.from(new Uint8Array(await ff.readFile(name)));
  };
  return [await enc('dA.mp4', 440), await enc('dB.mp4', 660)];
}).then((bufs) => page.evaluate((bufs) => {
  const { well } = window.__trimstitch;
  return well.addFiles(bufs.map((b, i) =>
    new File([new Uint8Array(b)], `dragclip${i}.mp4`, { type: 'video/mp4' })));
}, bufs));

await page.waitForFunction(() => {
  const { ws } = window.__trimstitch;
  return ws.tracks.length === 2 &&
    ws.tracks.every((t) => t.segments.length === 1 && t.segments[0].outPoint > 0.9);
}, null, { timeout: 90000 });
const ids = await page.evaluate(() => ({
  a: window.__trimstitch.ws.tracks[0].segments[0].id,
  b: window.__trimstitch.ws.tracks[1].segments[0].id,
}));

// -- UI drag: track 2's block -> right end of track 1's lane --
const src = await page.evaluate(() => {
  const rows = document.querySelectorAll('.tl-row');
  const r = rows[1].querySelector('.tl-seg').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const dst = await page.evaluate(() => {
  const lane = document.querySelector('.tl-row .tl-lane');
  const r = lane.getBoundingClientRect();
  const row = document.querySelector('.tl-row').getBoundingClientRect();
  return { x: r.right - 30, y: row.y + row.height / 2 };
});

await page.mouse.move(src.x, src.y);
await page.mouse.down();
for (let i = 1; i <= 8; i++) {
  await page.mouse.move(
    src.x + ((dst.x - src.x) * i) / 8,
    src.y + ((dst.y - src.y) * i) / 8
  );
}
// insertion marker should be visible over the target lane mid-drag
const markerVisible = await page.evaluate(() =>
  !!document.querySelector('.tl-dropmark'));
await page.mouse.up();
await page.waitForTimeout(100);

let ok = true;
const assert = (c, m) => { console.log((c ? '  ok: ' : '  FAIL: ') + m); if (!c) ok = false; };

assert(markerVisible, 'insertion marker visible during drag');
const after = await page.evaluate(() => {
  const { ws } = window.__trimstitch;
  return {
    t0: ws.tracks[0].segments.map((s) => s.id),
    t1: ws.tracks[1]?.segments.map((s) => s.id) ?? [],
    ghosts: document.querySelectorAll('.tl-ghost').length,
    marks: document.querySelectorAll('.tl-dropmark').length,
  };
});
assert(JSON.stringify(after.t0) === JSON.stringify([ids.a, ids.b]),
  `segment appended to end of track 1 (${JSON.stringify(after.t0)})`);
assert(after.t1.length === 0, 'track 2 left empty');
assert(after.ghosts === 0 && after.marks === 0, 'drag artifacts cleaned up');

// -- within-track reorder via store API --
const order = await page.evaluate(({ a, b }) => {
  const { ws } = window.__trimstitch;
  ws.moveSegmentTo(ws.tracks[0].segments[1].id, ws.tracks[0].id, 0);
  const o1 = ws.tracks[0].segments.map((s) => s.id);
  ws.moveSegmentTo(ws.tracks[0].segments[0].id, ws.tracks[0].id, 2);
  const o2 = ws.tracks[0].segments.map((s) => s.id);
  return { o1, o2 };
}, { a: ids.a, b: ids.b });
assert(JSON.stringify(order.o1) === JSON.stringify([ids.b, ids.a]),
  'within-track reorder to front works');
assert(JSON.stringify(order.o2) === JSON.stringify([ids.a, ids.b]),
  'within-track append to end works');

await browser.close();
console.log(ok ? 'drag OK' : 'drag BROKEN');
process.exit(ok ? 0 : 1);
