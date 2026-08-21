// Pure ffmpeg command builder for the unified trim+stitch pipeline.
// No DOM/wasm imports so it runs under Node for testing.
//
// One invocation per export: N inputs, per-segment trim/atrim + normalize
// filters, joined by the concat filter, encoded once.
// A single trimmed clip is just N=1.

const SAMPLE_RATE = 44100;

function fmt(x) {
  return String(Number(Number(x).toFixed(6)));
}

function clampFps(fps) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return 30;
  return Math.min(120, Math.max(1, Number(f.toFixed(3))));
}

function segDuration(seg) {
  const d = Number(seg.trim.outPoint) - Number(seg.trim.inPoint);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

export function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('export needs at least one segment');
  }
  segments.forEach((seg, i) => {
    const tin = Number(seg.trim?.inPoint);
    const tout = Number(seg.trim?.outPoint);
    if (!Number.isFinite(tin) || !Number.isFinite(tout) || tout - tin <= 0) {
      throw new Error(`segment ${i}: invalid trim [${tin}, ${tout}]`);
    }
    if (!seg.probe) throw new Error(`segment ${i}: missing probe`);
  });
}

export function buildExportJob(segments) {
  validateSegments(segments);

  const ref = segments[0].probe;
  const W = Number.isFinite(ref.width) && ref.width > 0 ? Math.round(ref.width) : 640;
  const H = Number.isFinite(ref.height) && ref.height > 0 ? Math.round(ref.height) : 360;
  const F = clampFps(ref.fps);

  const N = segments.length;
  const inputArgs = [];
  const chains = [];
  const videoLabels = [];
  const audioLabels = [];
  let anyAudio = false;
  let nextInputIdx = N; // lavfi silent-audio inputs appended after file inputs

  segments.forEach((seg, i) => {
    const dur = Number.isFinite(seg.probe.duration) ? seg.probe.duration : Infinity;
    const tin = Math.max(0, Number(seg.trim.inPoint));
    const tout = Math.min(dur, Number(seg.trim.outPoint));
    const len = tout - tin;
    if (len <= 0) throw new Error(`segment ${i}: empty after clamping to source`);

    inputArgs.push('-i', `in${i}.mp4`);

    chains.push(
      `[${i}:v]trim=start=${fmt(tin)}:end=${fmt(tout)},` +
      `setpts=PTS-STARTPTS,` +
      `fps=${F},` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,` +
      `format=yuv420p[v${i}]`
    );
    videoLabels.push(`[v${i}]`);

    if (seg.probe.hasAudio) {
      anyAudio = true;
      chains.push(
        `[${i}:a]atrim=start=${fmt(tin)}:end=${fmt(tout)},` +
        `asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo[a${i}]`
      );
    } else {
      // silent audio so mixed audio/no-audio sequences still concat cleanly
      inputArgs.push('-f', 'lavfi', '-t', fmt(len + 1 / F), '-i',
        `anullsrc=r=${SAMPLE_RATE}:cl=stereo`);
      chains.push(
        `[${nextInputIdx}:a]` +
        `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo[a${i}]`
      );
      nextInputIdx++;
    }
    audioLabels.push(`[a${i}]`);
  });

  const filterComplex = [];
  if (anyAudio) {
    filterComplex.push(
      `${videoLabels.join('')}${audioLabels.join('')}concat=n=${N}:v=1:a=1[vout][aout]`
    );
  } else {
    filterComplex.push(`${videoLabels.join('')}concat=n=${N}:v=1:a=0[vout]`);
  }
  filterComplex.push(...chains);

  const args = [
    '-hide_banner',
    ...inputArgs,
    '-filter_complex', filterComplex.join(';'),
    '-map', '[vout]',
  ];
  if (anyAudio) args.push('-map', '[aout]');
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
  );
  if (anyAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart', 'out.mp4');

  const totalDuration = segments.reduce((s, g) => s + segDuration(g), 0);

  return { args, totalDuration, width: W, height: H, fps: F };
}

// Parse `ffmpeg -i input` stderr (wasm core ships no ffprobe).
export function parseProbe(logText) {
  const text = String(logText);
  const probe = {
    duration: null, width: null, height: null, fps: null,
    codec: null, hasAudio: false,
  };

  const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) {
    probe.duration =
      parseInt(dur[1], 10) * 3600 + parseInt(dur[2], 10) * 60 + parseFloat(dur[3]);
  }

  const streamLines = text.split('\n').filter((l) => /Stream #\d+:\d+/.test(l));

  // first non-attached-pic video stream (mp4 cover art shows up as mjpeg/png)
  const videoLine = streamLines.find(
    (l) => /: Video: /.test(l) && !/attached pic/.test(l)
  );
  if (videoLine) {
    const codec = videoLine.match(/: Video: ([A-Za-z0-9_]+)/);
    if (codec) probe.codec = codec[1].toLowerCase();
    const res = videoLine.match(/(\d{2,5})x(\d{2,5})/);
    if (res) {
      probe.width = parseInt(res[1], 10);
      probe.height = parseInt(res[2], 10);
    }
    const fpsM = videoLine.match(/([\d.]+)\s+fps/) ||
                 videoLine.match(/([\d.]+)\s+tbr/);
    if (fpsM) probe.fps = parseFloat(fpsM[1]);
  }

  probe.hasAudio = streamLines.some((l) => /: Audio: /.test(l));

  return probe;
}
