// Unified export: builds the single-invocation trim+concat job (filtergraph.js)
// and runs it against ffmpeg.wasm with progress reporting.
import { getFFmpeg, runFFmpeg } from './ffmpeg-loader.js';
import { buildExportJob } from './filtergraph.js';

export async function exportSegments(segments, { onProgress } = {}) {
  // segments: [{ clip: Clip, trim: {inPoint,outPoint}, probe }]
  const job = buildExportJob(segments);
  const ffmpeg = await getFFmpeg();

  const started = performance.now();
  const total = job.totalDuration;

  for (let i = 0; i < segments.length; i++) {
    const data = new Uint8Array(await segments[i].clip.file.arrayBuffer());
    await ffmpeg.writeFile(`in${i}.mp4`, data);
  }
  try {
    await ffmpeg.deleteFile('out.mp4');
  } catch { /* first run */ }

  const onProg = (evt) => {
    // evt.time is output media time in microseconds
    const t = Number(evt?.time || 0) / 1e6;
    const pct = total > 0 ? Math.min(0.999, t / total) : 0;
    onProgress?.(pct, performance.now() - started);
  };
  const res = await runFFmpeg(job.args, { onProgress: onProg });

  if (res.code !== 0) {
    throw new Error(`ffmpeg exited with code ${res.code}`);
  }
  const data = await ffmpeg.readFile('out.mp4');
  if (!data || !data.length) throw new Error('ffmpeg produced no output');

  // cleanup inputs (best effort)
  for (let i = 0; i < segments.length; i++) {
    try { await ffmpeg.deleteFile(`in${i}.mp4`); } catch { /* ignore */ }
  }

  const blob = new Blob([data], { type: 'video/mp4' });
  onProgress?.(1, performance.now() - started);
  return {
    blob,
    url: URL.createObjectURL(blob),
    durationSec: total,
    bytes: blob.size,
    elapsedMs: performance.now() - started,
    args: job.args,
  };
}
