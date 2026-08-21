import { buildExportJob, parseProbe } from '../src/filtergraph.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', msg); }
}

function seg(trimIn, trimOut, probe) {
  return {
    trim: { inPoint: trimIn, outPoint: trimOut },
    probe: {
      duration: 10, width: 1920, height: 1080, fps: 30,
      hasAudio: true, codec: 'h264', ...probe,
    },
  };
}

// --- 1: single segment with audio ---
{
  const job = buildExportJob([seg(2, 5.5)]);
  const a = job.args;
  assert(a.filter((x) => x === '-i').length === 1, 'one input');
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert(fc.includes('trim=start=2:end=5.5'), 'video trim');
  assert(fc.includes('atrim=start=2:end=5.5'), 'audio trim');
  assert(fc.includes('concat=n=1:v=1:a=1[vout][aout]'), 'concat n=1 with audio');
  assert(a.includes('-map') && a[a.indexOf('-map') + 1] === '[vout]' &&
         a.lastIndexOf('[aout]') > -1 && a.includes('-c:a'), 'maps + audio encode');
  assert(!a.includes('anullsrc'), 'no lavfi needed');
  assert(job.totalDuration === 3.5, `total duration 3.5, got ${job.totalDuration}`);
  assert(a.includes('libx264') && a.includes('veryfast') && a.includes('18'),
    'encode flags');
  assert(a[a.length - 1] === 'out.mp4', 'output name last');
}

// --- 2: two segments, second without audio -> lavfi fill ---
{
  const job = buildExportJob([
    seg(0, 4),
    seg(1, 6, { hasAudio: false }),
  ]);
  const a = job.args;
  assert(a.includes('anullsrc=r=44100:cl=stereo'), 'silent audio input present');
  const fc = a[a.indexOf('-filter_complex') + 1];
  // file inputs are 0,1; lavfi input gets index 2
  assert(fc.includes('[2:a]aformat='), 'lavfi mapped as [2:a]');
  assert(fc.includes('concat=n=2:v=1:a=1[vout][aout]'), 'concat n=2 mixed->a=1');
  assert(a.includes('-c:a'), 'audio encoded');
  // lavfi duration covers segment + 1 frame
  const tIdx = a.indexOf('-t');
  const lavfiDur = parseFloat(a[tIdx + 1]);
  assert(Math.abs(lavfiDur - (5 + 1 / 30)) < 1e-6, `lavfi dur ${lavfiDur}`);
  assert(job.totalDuration === 9, `total 9, got ${job.totalDuration}`);
}

// --- 3: nobody has audio -> video-only concat ---
{
  const job = buildExportJob([
    seg(0, 3, { hasAudio: false }),
    seg(0, 3, { hasAudio: false }),
  ]);
  const fc = job.args[job.args.indexOf('-filter_complex') + 1];
  assert(fc.includes('concat=n=2:v=1:a=0[vout]'), 'concat v only');
  assert(!job.args.includes('-c:a') && !job.args.includes('-map', 0) === false,
    'no audio encode'); // just check -c:a absent
  assert(!job.args.some((v, i) => v === '-map' && job.args[i + 1] === '[aout]'),
    'no [aout] map');
}

// --- 4: outPoint clamped to source duration ---
{
  const job = buildExportJob([seg(8, 99, { duration: 10 })]);
  const fc = job.args[job.args.indexOf('-filter_complex') + 1];
  assert(fc.includes('trim=start=8:end=10,'), `clamp end, got: ${fc.split(';')[0]}`);
}

// --- 5: mismatched resolution normalizes to first segment's dims ---
{
  const job = buildExportJob([
    seg(0, 2, { width: 1280, height: 720 }),
    seg(0, 2, { width: 1920, height: 1080 }),
  ]);
  const fc = job.args[job.args.indexOf('-filter_complex') + 1];
  assert((fc.match(/scale=1280:720:force_original_aspect_ratio=decrease/g) || []).length === 2,
    'both chains scaled to first segment dims');
  assert((fc.match(/pad=1280:720/g) || []).length === 2, 'both padded to 1280x720');
}

// --- 6: fps normalization uses first segment fps ---
{
  const job = buildExportJob([
    seg(0, 2, { fps: 29.97 }),
    seg(0, 2, { fps: 60 }),
  ]);
  const fc = job.args[job.args.indexOf('-filter_complex') + 1];
  assert((fc.match(/fps=29\.97,/g) || []).length === 2, 'fps normalized to first');
}

// --- 7: validation errors ---
{
  let threw = false;
  try { buildExportJob([]); } catch { threw = true; }
  assert(threw, 'empty segments throw');

  threw = false;
  try { buildExportJob([seg(5, 5)]); } catch { threw = true; }
  assert(threw, 'zero-length trim throws');

  threw = false;
  try { buildExportJob([{ trim: { inPoint: 0, outPoint: 1 } }]); } catch { threw = true; }
  assert(threw, 'missing probe throws');
}

// --- 8: number formatting is ffmpeg-safe ---
{
  const job = buildExportJob([seg(0.10000000001, 2.0000004)]);
  const fc = job.args[job.args.indexOf('-filter_complex') + 1];
  assert(!/e-?\d/i.test(fc), 'no exponent notation');
  assert(fc.includes('trim=start=0.1:end=2,'), `clean numbers: ${fc.slice(0, 120)}`);
}

// --- 9: parseProbe on realistic ffmpeg stderr ---
{
  const sample = [
    'ffmpeg version n7.1 Copyright (c) 2000-2024 the FFmpeg developers',
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in0.mp4':",
    '  Duration: 00:00:12.35, start: 0.000000, bitrate: 954 kb/s',
    '    Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 975 kb/s, 29.97 fps, 30 tbr, 30k tbn (default)',
    '    Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6D703461), 44100 Hz, stereo, fltp, 128 kb/s (default)',
  ].join('\n');
  const p = parseProbe(sample);
  assert(p.duration === 12.35, `duration ${p.duration}`);
  assert(p.codec === 'h264', `codec ${p.codec}`);
  assert(p.width === 1920 && p.height === 1080, 'resolution');
  assert(p.fps === 29.97, `fps ${p.fps}`);
  assert(p.hasAudio === true, 'hasAudio');

  const hevc = parseProbe(sample.replace('h264 (High)', 'hevc (Main)').replace(
    'Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6D703461), 44100 Hz, stereo, fltp, 128 kb/s (default)', ''));
  assert(hevc.codec === 'hevc' && hevc.hasAudio === false, 'hevc + no audio');
}

// --- 10: attached-pic cover art ignored ---
{
  const p = parseProbe([
    '  Duration: 00:00:05.00, start: 0.000000, bitrate: 954 kb/s',
    '    Stream #0:0[0x1]: Video: mjpeg (Progressive), yuvj420p(pc), 240x240 [attached pic]',
    '    Stream #0:1[0x2](und): Video: h264 (Main), yuv420p, 3840x2160, 30 fps',
  ].join('\n'));
  assert(p.width === 3840 && p.height === 2160 && p.codec === 'h264',
    'cover art skipped');
  assert(p.fps === 30, 'fps from real stream');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
