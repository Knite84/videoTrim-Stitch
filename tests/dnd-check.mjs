// Verifies whole-left-column drag & drop: synthesizes a clip in-page,
// fires dragenter/dragover/drop on the library FOOTER (not the dropzone),
// and confirms the highlight + chip ingestion.
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8123', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__trimstitch, null, { timeout: 15000 });

const res = await page.evaluate(async () => {
  const { getFFmpeg } = await import('/src/ffmpeg-loader.js');
  const ff = await getFFmpeg();
  const code = await ff.exec([
    '-hide_banner',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', 'g.mp4',
  ]);
  if (code !== 0) throw new Error('synthetic encode failed');
  const bytes = await ff.readFile('g.mp4');

  const dt = new DataTransfer();
  dt.items.add(new File([bytes], 'dropped.mp4', { type: 'video/mp4' }));
  const opts = { bubbles: true, cancelable: true, dataTransfer: dt };

  const rail = document.querySelector('#leftRail');
  const target = document.querySelector('#libFooter'); // not the dropzone!
  target.dispatchEvent(new DragEvent('dragenter', opts));
  target.dispatchEvent(new DragEvent('dragover', opts));
  const highlighted = rail.classList.contains('dragging');
  target.dispatchEvent(new DragEvent('drop', opts));

  return {
    highlighted,
    dropAccepted: window.__trimstitch.ws.clips.length === 1,
    chips: document.querySelectorAll('.chip').length,
  };
});

console.log(JSON.stringify(res));
let ok = true;
const assert = (c, m) => { console.log((c ? '  ok: ' : '  FAIL: ') + m); if (!c) ok = false; };
assert(res.highlighted, 'rail shows dragging highlight when hovering footer');
assert(res.dropAccepted && res.chips === 1, 'drop on footer ingests clip + renders chip');

await browser.close();
console.log(ok ? 'dnd OK' : 'dnd BROKEN');
process.exit(ok ? 0 : 1);
