// Wires everything together: toolbar, keyboard shortcuts, status bar, export.
import { Workspace } from './workspace.js';
import { UploadWell } from './upload-well.js';
import { PreviewPlayer } from './preview-player.js';
import { Timeline } from './timeline.js';
import { exportSegments } from './exporter.js';
import { getFFmpeg, isFFmpegLoaded } from './ffmpeg-loader.js';

const ws = new Workspace();
const $ = (id) => document.getElementById(id);

// ---------- modules ----------
const well = new UploadWell($('well'), ws, {
  onNotify: notify,
  onEngineStatus: setEngineStatus,
});

const player = new PreviewPlayer($('playerBox'), ws);
const timeline = new Timeline($('timeline'), ws, player);

// ---------- toolbar ----------
$('zoom').addEventListener('input', (e) => {
  ws.setPps(Number(e.target.value));
});
ws.addEventListener('zoom', () => {
  $('zoom').value = String(ws.pps);
});

$('splitBtn').addEventListener('click', () => {
  const hit = ws.selection();
  if (!hit) return notify('Select a segment first');
  const ok = ws.splitSegment(hit.segment.id, player.video.currentTime);
  if (!ok) notify('Playhead must be inside the segment to split');
});
$('delSegBtn').addEventListener('click', () => {
  if (!ws.selectedSegId) return notify('Select a segment first');
  ws.deleteSegment(ws.selectedSegId);
});
$('leftBtn').addEventListener('click', () => ws.selectedSegId && ws.moveSegment(ws.selectedSegId, -1));
$('rightBtn').addEventListener('click', () => ws.selectedSegId && ws.moveSegment(ws.selectedSegId, 1));
$('newTrackBtn').addEventListener('click', () => {
  if (!ws.selectedSegId) return notify('Select a segment first');
  ws.moveSegmentToNewTrack(ws.selectedSegId);
});
$('addTrackBtn').addEventListener('click', () => ws.addTrack());

// ---------- export ----------
let exporting = false;
$('exportBtn').addEventListener('click', async () => {
  if (exporting) return;
  const hit = ws.selection();
  const track = (hit?.track?.segments.length ? hit.track : null) ||
    ws.tracks.find((t) => t.segments.length);
  if (!track) return notify('Nothing to export — add a clip first');

  exporting = true;
  $('exportBtn').disabled = true;
  showProgress(0);

  try {
    await getFFmpeg(setEngineStatus);
    const segs = track.segments.map((s) => ({
      clip: ws.getClip(s.clipId),
      trim: { inPoint: s.inPoint, outPoint: s.outPoint },
      probe: ws.getClip(s.clipId)?.probe,
    })).filter((s) => s.clip && s.probe?.duration > 0);

    if (!segs.length) throw new Error('track has no probed segments yet');

    const result = await exportSegments(segs, {
      onProgress: (pct, elapsedMs) => showProgress(pct, elapsedMs),
    });

    // auto-download + preview the real result
    const a = document.createElement('a');
    a.href = result.url;
    a.download = `${(segs.length > 1 ? 'stitched' : 'trimmed')}-${Date.now()}.mp4`;
    a.click();
    swapPreview(result.url);
    notify(`Exported ${(result.bytes / 1048576).toFixed(2)} MB in ${(result.elapsedMs / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(err);
    notify(`Export failed: ${err.message}`, true);
  } finally {
    exporting = false;
    $('exportBtn').disabled = false;
    setTimeout(hideProgress, 1500);
  }
});

function swapPreview(url) {
  player.pause();
  player.previewOverride = true; // keep this source until user picks a segment
  player.boundSegId = null;
  player.video.src = url; // preview the actual exported file — WYSIWYG
  player.warnBox.hidden = true;
  player.video.addEventListener('loadedmetadata', () => {
    player.range = { in: 0, out: player.video.duration || Infinity };
    try { player.video.currentTime = 0; } catch { /* ignore */ }
    player.updateTimecode?.();
  }, { once: true });
}

function showProgress(pct, elapsedMs = 0) {
  const bar = $('progressBar');
  const wrap = $('progressWrap');
  wrap.hidden = false;
  bar.style.width = `${Math.round(pct * 100)}%`;
  $('progressPct').textContent = `${Math.round(pct * 100)}% · ${(elapsedMs / 1000).toFixed(1)}s`;
}
function hideProgress() {
  $('progressWrap').hidden = true;
}

// ---------- status / notices ----------
function setEngineStatus(status) {
  const el = $('engineStatus');
  if (status === 'loading') {
    el.textContent = 'loading video engine…';
    el.classList.add('busy');
  } else if (status === 'ready') {
    el.textContent = '';
    el.classList.remove('busy');
  } else if (status === 'error') {
    el.textContent = 'engine failed to load';
    el.classList.add('busy');
  }
}

function notify(msg, isError = false) {
  const box = $('notices');
  const div = document.createElement('div');
  div.className = `notice${isError ? ' err' : ''}`;
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => div.remove(), 6000);
}

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const sel = ws.selection();
  switch (e.key) {
    case ' ':
      e.preventDefault();
      player.toggle();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      player.step(e.shiftKey ? -10 : -1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      player.step(e.shiftKey ? 10 : 1);
      break;
    case 'Home': player.seekToSource(player.range.in); break;
    case 'End': player.seekToSource(player.range.out); break;
    case 'i': case 'I': player.setIn(); break;
    case 'o': case 'O': player.setOut(); break;
    case 's': case 'S':
      if (sel) ws.splitSegment(sel.segment.id, player.video.currentTime);
      break;
    case 'Delete': case 'Backspace':
      if (sel) ws.deleteSegment(sel.segment.id);
      break;
    default:
      return;
  }
});

// ---------- boot ----------
setEngineStatus(isFFmpegLoaded() ? 'ready' : '');

// test hook (harmless in production)
window.__trimstitch = { ws, player, timeline, well, exportSegments };
