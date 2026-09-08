import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
await page.goto('http://localhost:8123', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__trimstitch, null, { timeout: 15000 });
const enc = await page.evaluate(async () => {
  const { getFFmpeg, runFFmpeg } = await import('/src/ffmpeg-loader.js');
  await getFFmpeg();
  const encRes = await runFFmpeg(['-hide_banner', '-encoders']);
  const lines = encRes.logs.split('\n');
  const fmt = `
 V....D webp                    WebP image
`.trim();
  return {
    webpEnc: lines.filter((l) => /webp|mjpeg|libwebp/i.test(l)),
  };
});
console.log(JSON.stringify(enc, null, 2));
await browser.close();
