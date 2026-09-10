// Unified export: builds the single-invocation trim+concat job (filtergraph.js)
// and runs it against ffmpeg.wasm with progress reporting.
import { getFFmpeg, runFFmpeg } from './ffmpeg-loader.js';
import { buildExportJob } from './filtergraph.js';

export async function exportSegments(segments, { onProgress, kind = 'video' } = {}) {
  // segments: [{ clip: Clip, trim: {inPoint,outPoint}, probe, muted }]
  const job = buildExportJob(segments, { kind });
  const ffmpeg = await getFFmpeg();

  const started = performance.now();
  const total = job.totalDuration;

  for (let i = 0; i < segments.length; i++) {
    const data = new Uint8Array(await segments[i].clip.file.arrayBuffer());
    await ffmpeg.writeFile(`in${i}.mp4`, data);
  }
  try {
    await ffmpeg.deleteFile(job.out);
  } catch { /* first run */ }

  let stderrTail = '';
  const onProg = (evt) => {
    // evt.time is output media time in microseconds
    const t = Number(evt?.time || 0) / 1e6;
    const pct = total > 0 ? Math.min(0.999, t / total) : 0;
    onProgress?.(pct, performance.now() - started);
  };
  const res = await runFFmpeg(job.args, {
    onLog: (msg) => {
      stderrTail = (stderrTail + '\n' + msg).split('\n').slice(-15).join('\n');
    },
    onProgress: onProg,
  });

  if (res.code !== 0) {
    throw new Error(
      `ffmpeg exited with code ${res.code}\n${stderrTail}`
    );
  }
  const data = await ffmpeg.readFile(job.out);
  if (!data || !data.length) throw new Error('ffmpeg produced no output');

  // cleanup inputs (best effort)
  for (let i = 0; i < segments.length; i++) {
    try { await ffmpeg.deleteFile(`in${i}.mp4`); } catch { /* ignore */ }
  }

  const blob = new Blob([data], { type: job.mime });
  onProgress?.(1, performance.now() - started);
  return {
    blob,
    url: URL.createObjectURL(blob),
    audioOnly: job.kind === 'audio',
    durationSec: total,
    bytes: blob.size,
    elapsedMs: performance.now() - started,
    args: job.args,
  };
}

// Extract a single frame from a source clip at timeSec.
// format: 'webp' (default, via libwebp) or 'jpg' (mjpeg).
export async function exportFrame(clip, timeSec, { format = 'webp' } = {}) {
  if (!clip?.file) throw new Error('no clip selected');
  const t = Number(timeSec);
  if (!Number.isFinite(t) || t < 0) throw new Error('invalid playhead time');

  const ffmpeg = await getFFmpeg();
  const m = /\.([a-z0-9]{1,5})$/i.exec(clip.file?.name || '');
  const inName = `frame-src.${(m?.[1] || 'mp4').toLowerCase()}`;
  const outName = `frame-out.${format === 'jpg' ? 'jpg' : 'webp'}`;

  await ffmpeg.writeFile(inName, new Uint8Array(await clip.file.arrayBuffer()));
  let stderrTail = '';
  const res = await runFFmpeg([
    '-hide_banner',
    '-ss', String(Number(t.toFixed(6))),
    '-i', inName,
    '-frames:v', '1',
    '-an',
    ...(format === 'jpg' ? ['-q:v', '2'] : ['-q:v', '80']),
    outName,
  ], {
    onLog: (msg) => {
      stderrTail = (stderrTail + '\n' + msg).split('\n').slice(-15).join('\n');
    },
  });
  try { await ffmpeg.deleteFile(inName); } catch { /* ignore */ }
  if (res.code !== 0) {
    throw new Error(`frame export failed (ffmpeg code ${res.code})\n${stderrTail}`);
  }
  const data = await ffmpeg.readFile(outName);
  if (!data || !data.length) throw new Error('frame export produced no output');
  try { await ffmpeg.deleteFile(outName); } catch { /* ignore */ }

  const mime = format === 'jpg' ? 'image/jpeg' : 'image/webp';
  return { blob: new Blob([data], { type: mime }), bytes: data.length, timeSec: t };
}
