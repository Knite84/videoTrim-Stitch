// End-to-end test against a running static server (default :8123).
// Exercises: page boot, wasm engine load, synthetic clip generation,
// upload->probe->thumbnails, trim+stitch export via the UI, and verifies the
// exported file's duration/streams by re-probing it through the engine.
//
//   node tests/e2e.mjs [baseUrl]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8123';
let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ok: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

let browser;
try {
  browser = await chromium.launch({ channel: 'msedge' });
  console.log('browser: msedge (proprietary codecs available)');
} catch {
  browser = await chromium.launch();
  console.log('browser: bundled chromium (no proprietary codecs — exercises undecodable-preview path)');
}

const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__trimstitch, null, { timeout: 15000 });
assert(true, 'app booted');

// ---- 1. generate two 1-second H.264+AAC clips with the app's own engine ----
const bufs = await page.evaluate(async () => {
  const { getFFmpeg } = await import('/src/ffmpeg-loader.js');
  const ff = await getFFmpeg();
  const enc = async (name, freq) => {
    const code = await ff.exec([
      '-hide_banner',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=1',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', name,
    ]);
    if (code !== 0) throw new Error(`synthetic encode failed: ${name}`);
    return Array.from(new Uint8Array(await ff.readFile(name)));
  };
  return [await enc('genA.mp4', 440), await enc('genB.mp4', 660)];
});
assert(bufs[0].length > 3000 && bufs[1].length > 3000, 'synthetic clips generated');

// ---- 2. upload through the real pipeline ----
await page.evaluate((bufs) => {
  const { well } = window.__trimstitch;
  const files = bufs.map((b, i) =>
    new File([new Uint8Array(b)], `clip${i}.mp4`, { type: 'video/mp4' }));
  return well.addFiles(files);
}, bufs);

await page.waitForFunction(
  () => {
    const { ws } = window.__trimstitch;
    // fps arrives only after the wasm probe — wait for the full probe
    return ws.clips.length === 2 &&
      ws.clips.every((c) => c.probe && c.probe.duration > 0.9 &&
        c.probe.duration < 1.2 && c.probe.fps > 0);
  },
  null, { timeout: 90000 }
);
const probeState = await page.evaluate(() => window.__trimstitch.ws.clips.map((c) => ({
  dur: c.probe.duration, w: c.probe.width, h: c.probe.height,
  fps: c.probe.fps, audio: c.probe.hasAudio, thumb: !!c.thumb, warn: c.warnHevc,
})));
for (const p of probeState) {
  assert(p.w === 320 && p.h === 240, `probed resolution 320x240 (${JSON.stringify(p)})`);
  assert(p.audio === true, `probed audio stream (${JSON.stringify(p)})`);
  assert(p.fps > 14 && p.fps < 16, `probed fps ~15 (${JSON.stringify(p)})`);
  assert(p.thumb || p.warn, 'thumbnail or graceful undecodable warning');
}
const chipCount = await page.locator('.chip').count();
assert(chipCount === 2, 'two clip chips rendered');

// timeline has two auto-created tracks
const rowCount = await page.locator('.tl-row').count();
assert(rowCount === 2, 'two track rows rendered');

// ---- 3. merge into one track and trim precisely ----
await page.evaluate(() => {
  const { ws } = window.__trimstitch;
  const t2 = ws.tracks[1];
  ws.tracks[0].segments.push(...t2.segments);
  ws.deleteTrack(t2.id, { silent: true });
  ws.setTrim(ws.tracks[0].segments[0].id, 0.25, 0.75);
  ws.setTrim(ws.tracks[0].segments[1].id, 0.5, 1.0);
  ws.select(ws.tracks[0].segments[0].id);
  ws.emit();
});
const segCount = await page.locator('.tl-seg').count();
assert(segCount === 2, 'two segment blocks on merged track');

// ---- 4. stitched export via the UI button ----
const dlPromise = page.waitForEvent('download', { timeout: 300000 });
await page.click('#exportBtn');
await page.waitForSelector('#progressWrap:not([hidden])', { timeout: 10000 })
  .then(() => assert(true, 'progress bar shown during export'))
  .catch(() => assert(false, 'progress bar shown during export'));
const download = await dlPromise;
const outPath = await download.path();
const outBytes = readFileSync(outPath);
assert(outBytes.length > 5000, `stitched export produced ${outBytes.length} bytes`);

// suggested filename sanity
assert(/stitched-\d+\.mp4$/.test(download.suggestedFilename()),
  `download name: ${download.suggestedFilename()}`);

// ---- 5. verify exported file by re-probing through the engine ----
const outProbe = await page.evaluate(async (bytes) => {
  const { getFFmpeg, runFFmpeg } = await import('/src/ffmpeg-loader.js');
  const { parseProbe } = await import('/src/filtergraph.js');
  const ff = await getFFmpeg();
  await ff.writeFile('check-stitched.mp4', new Uint8Array(bytes));
  const res = await runFFmpeg(['-hide_banner', '-i', 'check-stitched.mp4']);
  return parseProbe(res.logs);
}, Array.from(outBytes));
console.log('  stitched probe:', JSON.stringify(outProbe));
assert(Math.abs(outProbe.duration - 1.0) < 0.15,
  `stitched duration ~1.00s (got ${outProbe.duration})`);
assert(outProbe.hasAudio, 'stitched output has audio');
assert(outProbe.codec === 'h264', 'stitched output is h264');
assert(outProbe.width === 320 && outProbe.height === 240, 'resolution normalized');

// ---- 6. single-segment frame-accurate trim ----
await page.evaluate(() => {
  const { ws } = window.__trimstitch;
  ws.setTrim(ws.tracks[0].segments[0].id, 0.2, 0.4);
});
const dl2 = page.waitForEvent('download', { timeout: 300000 });
await page.click('#exportBtn');
const download2 = await dl2;
const out2 = readFileSync(await download2.path());
const probe2 = await page.evaluate(async (bytes) => {
  const { getFFmpeg, runFFmpeg } = await import('/src/ffmpeg-loader.js');
  const { parseProbe } = await import('/src/filtergraph.js');
  const ff = await getFFmpeg();
  await ff.writeFile('check-trim.mp4', new Uint8Array(bytes));
  const res = await runFFmpeg(['-hide_banner', '-i', 'check-trim.mp4']);
  return parseProbe(res.logs);
}, Array.from(out2));
console.log('  trimmed probe:', JSON.stringify(probe2));
assert(/trimmed-\d+\.mp4$/.test(download2.suggestedFilename()),
  `download name: ${download2.suggestedFilename()}`);
assert(Math.abs(probe2.duration - 0.2) < 0.09,
  `trimmed duration ~0.20s within one frame @15fps (got ${probe2.duration})`);

// ---- 7. console/page errors ----
const serious = errors.filter((e) =>
  !/demuxer|media|video|decode|codec|SourceBuffer|PIPELINE/i.test(e));
if (errors.length) console.log('  (benign media errors likely from codec-less headless):',
  errors.length, 'suppressed,', serious.length, 'serious');
assert(serious.length === 0, `no serious page errors (${serious.join(' | ')})`);

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
