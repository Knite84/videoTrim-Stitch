// Repro: two clips on one track, export via exportSegments, dump ffmpeg logs.
// Run: node tests/repro-export.mjs http://localhost:8123
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8123';
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
page.on('console', (m) => console.log(`[console:${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__trimstitch);

// attach a global ffmpeg log capture
const logs = [];
await page.evaluate(async () => {
  const { getFFmpeg } = await import('/src/ffmpeg-loader.js');
  const ff = await getFFmpeg();
  window.__logs = [];
  ff.on('log', ({ message }) => window.__logs.push(message));
});

const bufs = await page.evaluate(async () => {
  const { getFFmpeg } = await import('/src/ffmpeg-loader.js');
  const ff = await getFFmpeg();
  const enc = async (name, freq) => {
    const code = await ff.exec([
      '-hide_banner',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=2',
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', name,
    ]);
    if (code !== 0) throw new Error(`synthetic encode failed: ${name}`);
    return Array.from(new Uint8Array(await ff.readFile(name)));
  };
  return [await enc('genA.mp4', 440), await enc('genB.mp4', 660)];
});

const result = await page.evaluate(async (bufs) => {
  const { well, ws } = window.__trimstitch;
  await well.addFiles(bufs.map((b, i) =>
    new File([new Uint8Array(b)], `clip${i}.mp4`, { type: 'video/mp4' })));
  return 'added';
}, bufs);
console.log('addFiles:', result);

await page.waitForFunction(() => {
  const { ws } = window.__trimstitch;
  return ws.clips.length === 2 && ws.clips.every((c) => c.probe?.fps > 0);
}, null, { timeout: 90000 });

// merge into one track like the user did (second clip onto track 1)
await page.evaluate(() => {
  const { ws } = window.__trimstitch;
  const t2 = ws.tracks[1];
  ws.tracks[0].segments.push(...t2.segments);
  ws.deleteTrack(t2.id, { silent: true });
  ws.emit();
});
await page.waitForTimeout(500);

const out = await page.evaluate(async () => {
  const { ws } = window.__trimstitch;
  const { exportSegments } = await import('/src/exporter.js');
  const logs = [];
  try {
    const segs = ws.tracks[0].segments.map((s) => ({
      clip: ws.getClip(s.clipId),
      trim: { inPoint: s.inPoint, outPoint: s.outPoint },
      probe: ws.getClip(s.clipId)?.probe,
    }));
    const r = await exportSegments(segs, {
      onProgress: (p) => console.log(`[export progress] ${(p * 100).toFixed(1)}%`),
    });
    return { ok: true, bytes: r.bytes, args: r.args, logs };
  } catch (e) {
    return { ok: false, error: e.message, logs };
  }
});
console.log('export args:', result?.args || out.args || '(n/a)');
out.logs.forEach(() => {});
(await page.evaluate(() => window.__logs)).forEach((l) => console.log('[ffmpeg]', l));
console.log('RESULT:', out.ok ? `ok ${out.bytes} bytes` : `FAILED: ${out.error}`);

await browser.close();
