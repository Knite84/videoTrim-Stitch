// Repro: frame export button — select segment, seek to a frame, click ⤓ frame.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8123';
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__trimstitch, null, { timeout: 15000 });

const buf = await page.evaluate(async () => {
  const { getFFmpeg } = await import('/src/ffmpeg-loader.js');
  const ff = await getFFmpeg();
  const code = await ff.exec([
    '-hide_banner',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', 'gen.mp4',
  ]);
  if (code !== 0) throw new Error('synthetic encode failed');
  return Array.from(new Uint8Array(await ff.readFile('gen.mp4')));
});

await page.evaluate((b) => window.__trimstitch.well.addFiles(
  [new File([new Uint8Array(b)], 'clip0.mp4', { type: 'video/mp4' })]), buf);
await page.waitForFunction(() => {
  const { ws } = window.__trimstitch;
  return ws.clips.length === 1 && ws.clips[0].probe?.fps > 0;
}, null, { timeout: 60000 });

for (const [label, shift, ext, mime] of [
  ['webp', false, 'webp', 'image/webp'],
  ['jpg', true, 'jpg', 'image/jpeg'],
]) {
  // seek to t=1.0 (middle of the 2s source) and pause
  await page.evaluate(() => window.__trimstitch.player.seekToSource(1.0));
  await page.waitForTimeout(400);
  const dlPromise = page.waitForEvent('download', { timeout: 60000 });
  if (shift) await page.click('#exportFrameBtn', { modifiers: ['Shift'] });
  else await page.click('#exportFrameBtn');
  const download = await dlPromise;
  const name = download.suggestedFilename();
  const ok = name.endsWith(`.${ext}`) && /^frame-1(_|\.)0/.test(name);
  console.log(`${ok ? 'ok' : 'FAIL'}: download name ${name}`);
  const out = readFileSync(await download.path());
  console.log(`${out.length > 500 ? 'ok' : 'FAIL'}: ${out.length} bytes, magic: ${
    out.subarray(0, 12).toString('hex')}`);
  // RIFF....WEBP magic for webp / ff d8 for jpg
  const magicOk = (ext === 'webp' &&
      out.subarray(0, 4).toString() === 'RIFF' && out.subarray(8, 12).toString() === 'WEBP') ||
    (ext === 'jpg' && out.subarray(0, 2).toString('hex') === 'ffd8');
  console.log(`${magicOk ? 'ok' : 'FAIL'}: magic bytes match ${ext} (${mime})`);
}
await browser.close();
