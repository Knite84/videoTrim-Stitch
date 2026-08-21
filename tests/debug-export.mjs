// Debug: replicate upload->export with full console piping.
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ acceptDownloads: true });
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 3000)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://localhost:8123', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__trimstitch, null, { timeout: 15000 });

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
    if (code !== 0) throw new Error(`encode failed ${name}`);
    return Array.from(new Uint8Array(await ff.readFile(name)));
  };
  return [await enc('genA.mp4', 440), await enc('genB.mp4', 660)];
});
console.log('-- clips generated:', bufs.map((b) => b.length).join(', '));

await page.evaluate((bufs) => {
  const { well } = window.__trimstitch;
  return well.addFiles(bufs.map((b, i) =>
    new File([new Uint8Array(b)], `clip${i}.mp4`, { type: 'video/mp4' })));
}, bufs);

await page.waitForFunction(() => {
  const { ws } = window.__trimstitch;
  return ws.clips.length === 2 &&
    ws.clips.every((c) => c.probe?.fps > 0);
}, null, { timeout: 90000 });
console.log('-- uploaded + probed');

// run the export directly (bypasses UI) so we see the raw failure
const result = await page.evaluate(async () => {
  const { ws, exportSegments } = window.__trimstitch;
  ws.setTrim(ws.tracks[1].segments[0].id, 0.25, 0.75);
  const track = ws.tracks.find((t) => t.segments.length);
  const segs = track.segments.map((s) => ({
    clip: ws.getClip(s.clipId),
    trim: { inPoint: s.inPoint, outPoint: s.outPoint },
    probe: ws.getClip(s.clipId)?.probe,
  }));
  try {
    const r = await exportSegments(segs, {});
    return { ok: true, bytes: r.bytes, dur: r.durationSec };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
});
console.log('-- direct export result:', JSON.stringify(result).slice(0, 4000));

await page.evaluate(async () => {
  const { getFFmpeg, runFFmpeg } = await import('/src/ffmpeg-loader.js');
  const res = await runFFmpeg(['-hide_banner',
    '-i', 'in0.mp4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
    '-filter_complex',
    '[0:v]trim=start=0.25:end=0.75,setpts=PTS-STARTPTS,fps=15,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v0];' +
    '[0:a]atrim=start=0.25:end=0.75,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0];' +
    '[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1];' +
    '[v0][a0][a1]concat=n=2:v=1:a=1[vout][aout]',
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', 'dbg.mp4']).catch?.(() => {}) ?? {};
  console.log('[dbg] minimal filtergraph exit code:', JSON.stringify(res.code));
});
