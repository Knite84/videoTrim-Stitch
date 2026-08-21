// Lazy ffmpeg.wasm bootstrap + shared instance.
// Core files are self-hosted in /vendor/core (committed) so everything works
// offline; toBlobURL sidesteps MIME/CORS edge cases in the worker.
import { FFmpeg } from '../vendor/ffmpeg/index.js';
import { toBlobURL } from '../vendor/util/index.js';
import { parseProbe } from './filtergraph.js';

const CORE_BASE = new URL('../vendor/core/', import.meta.url);

let ffmpegPromise = null;
const logListeners = new Set();
const progressListeners = new Set();

export function getFFmpeg(onStatus) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => {
        logListeners.forEach((fn) => fn(message));
      });
      ffmpeg.on('progress', (evt) => {
        progressListeners.forEach((fn) => fn(evt));
      });
      onStatus?.('loading');
      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(`${CORE_BASE}ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${CORE_BASE}ffmpeg-core.wasm`, 'application/wasm'),
        });
      } catch (err) {
        onStatus?.('error');
        ffmpegPromise = null;
        throw err;
      }
      onStatus?.('ready');
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

export function isFFmpegLoaded() {
  return !!ffmpegPromise;
}

async function withListeners(onLog, onProgress, fn) {
  if (onLog) logListeners.add(onLog);
  if (onProgress) progressListeners.add(onProgress);
  try {
    return await fn();
  } finally {
    if (onLog) logListeners.delete(onLog);
    if (onProgress) progressListeners.delete(onProgress);
  }
}

// Run an ffmpeg command; resolves { code, logs }. Nonzero code is NOT thrown —
// callers decide (a bare `-i` probe exits 1 by design).
export function runFFmpeg(args, { onLog, onProgress } = {}) {
  return withListeners(onLog, onProgress, async () => {
    const ffmpeg = await getFFmpeg();
    const logs = [];
    const collect = (m) => {
      logs.push(m);
      onLog?.(m);
    };
    logListeners.add(collect);
    try {
      const code = await ffmpeg.exec(args);
      return { code, logs: logs.join('\n') };
    } finally {
      logListeners.delete(collect);
    }
  });
}

// The wasm core ships no ffprobe binary; `ffmpeg -i` prints stream info to
// stderr before failing with "At least one output file must be specified".
export async function probeClip(file) {
  const ffmpeg = await getFFmpeg();
  const name = 'probe-input';
  await ffmpeg.writeFile(name, new Uint8Array(await file.arrayBuffer()));
  let res;
  try {
    res = await runFFmpeg(['-hide_banner', '-i', name]);
  } finally {
    try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
  }
  const probe = parseProbe(res.logs);
  if (!probe.duration && !probe.codec) {
    throw new Error(`could not probe ${file.name}`);
  }
  return probe;
}
