// Zoomable multi-track timeline: ruler, segment blocks with trim handles,
// playhead synced to preview, filmstrips at high zoom.
import { grabFrames } from './media.js';

const LABEL_W = 132;
const ROW_H = 56;
const MIN_PPS_ZOOM_FILMSTRIP = 48;

export class Timeline {
  constructor(container, ws, player) {
    this.ws = ws;
    this.player = player;

    container.classList.add('timeline');
    container.innerHTML = `
      <div class="tl-scroller">
        <div class="tl-inner">
          <div class="tl-ruler-row"><div class="tl-corner tl-label"></div><div class="tl-ruler"></div></div>
          <div class="tl-rows"></div>
          <div class="tl-playhead" hidden></div>
        </div>
      </div>`;

    this.scroller = container.querySelector('.tl-scroller');
    this.inner = container.querySelector('.tl-inner');
    this.rulerEl = container.querySelector('.tl-ruler');
    this.rowsEl = container.querySelector('.tl-rows');
    this.playheadEl = container.querySelector('.tl-playhead');

    this.thumbs = new Map();   // clipId -> Map(interval -> Map(slotIdx -> dataURL))
    this.thumbBusy = false;
    this.draggingHandle = false;

    this.ws.onChange(() => this.rebuild());
    this.player.addEventListener('tick', (e) => this.updatePlayhead(e.detail.t));

    this.scroller.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.rulerEl.addEventListener('pointerdown', (e) => this.startScrub(e));
    this.playheadEl.addEventListener('pointerdown', (e) => this.startScrub(e));

    this.rebuild();
  }

  // ---------- layout ----------

  contentDuration() {
    return Math.max(this.ws.maxContentDuration(), this.minViewportSecs());
  }

  minViewportSecs() {
    return Math.max(5, (this.scroller.clientWidth - LABEL_W) / this.ws.pps);
  }

  rebuild() {
    const pps = this.ws.pps;
    const width = Math.ceil(this.contentDuration() * pps);

    // ruler
    this.rulerEl.style.width = `${width}px`;
    this.rulerEl.innerHTML = '';
    const step = pickStep(pps);
    for (let t = 0; t * pps <= width; t += step) {
      const tick = document.createElement('span');
      tick.className = 'tl-tick';
      tick.style.left = `${Math.round(t * pps)}px`;
      tick.textContent = fmtTick(t, step);
      this.rulerEl.appendChild(tick);
    }

    // rows
    this.rowsEl.innerHTML = '';
    if (!this.ws.tracks.length) {
      const hint = document.createElement('div');
      hint.className = 'tl-empty';
      hint.textContent = 'Drop clips above to begin — each upload becomes its own track';
      this.rowsEl.appendChild(hint);
      this.inner.style.width = '100%';
      this.playheadEl.hidden = true;
      return;
    }
    for (const track of this.ws.tracks) {
      this.rowsEl.appendChild(this.buildRow(track, pps, width));
    }

    this.inner.style.width = `${width + LABEL_W}px`;
    this.updatePlayhead(this.player.video.currentTime);
  }

  buildRow(track, pps, width) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.style.height = `${ROW_H}px`;

    const label = document.createElement('div');
    label.className = 'tl-label';
    const dur = this.ws.trackDuration(track);
    label.innerHTML = `
      <span class="tl-trackname">${track.name}</span>
      <span class="tl-trackdur">${dur.toFixed(1)}s</span>
      <button class="tl-deltrack" title="delete track">×</button>`;
    label.querySelector('.tl-deltrack').addEventListener('click',
      () => this.ws.deleteTrack(track.id));
    row.appendChild(label);

    const lane = document.createElement('div');
    lane.className = 'tl-lane';
    lane.style.width = `${width}px`;
    lane.dataset.trackId = track.id;
    row.appendChild(lane);

    let offset = 0;
    track.segments.forEach((segment) => {
      lane.appendChild(this.buildBlock(track, segment, offset, pps));
      offset += Math.max(0, segment.outPoint - segment.inPoint);
    });

    return row;
  }

  buildBlock(track, segment, outOffset, pps) {
    const clip = this.ws.getClip(segment.clipId);
    const sel = this.ws.selectedSegId === segment.id;
    const dur = Math.max(0, segment.outPoint - segment.inPoint);

    const block = document.createElement('div');
    block.className = `tl-seg${sel ? ' sel' : ''}`;
    block.style.left = `${outOffset * pps}px`;
    block.style.width = `${Math.max(6, dur * pps)}px`;
    if (clip?.thumb) {
      block.style.setProperty('--edge', dominantColor(clip.thumb) || '#3b82f6');
    }

    const name = document.createElement('span');
    name.className = 'tl-segname';
    name.textContent = clip?.name || '?';
    name.title = `${clip?.name || ''}\ntrim ${segment.inPoint.toFixed(2)}s – ${segment.outPoint.toFixed(2)}s`;

    const readout = document.createElement('span');
    readout.className = 'tl-segdur';
    readout.textContent = `${dur.toFixed(dur < 10 ? 2 : 1)}s`;

    block.append(name, readout);

    for (const side of ['l', 'r']) {
      const h = document.createElement('div');
      h.className = `tl-hdl tl-hdl-${side}`;
      h.addEventListener('pointerdown', (e) =>
        this.startHandleDrag(e, segment, side, block, readout, pps));
      block.appendChild(h);
    }

    block.addEventListener('dragstart', (e) => e.preventDefault());
    block.addEventListener('pointerdown', (e) =>
      this.startMoveDrag(e, segment, block, pps));

    block.addEventListener('click', () => {
      this.ws.select(segment.id);
      this.player.bind(segment.id);
      this.rebuild();
    });

    if (pps >= MIN_PPS_ZOOM_FILMSTRIP && clip) {
      this.attachFilmstrip(block, clip, segment, pps);
    }
    return block;
  }

  // ---------- filmstrips ----------

  attachFilmstrip(block, clip, segment, pps) {
    const dur = segment.outPoint - segment.inPoint;
    const interval = pickThumbInterval(pps);
    let cache = this.thumbs.get(clip.id);
    if (!cache) this.thumbs.set(clip.id, (cache = new Map()));
    let slots = cache.get(interval);
    if (!slots) cache.set(interval, (slots = new Map()));

    const nSlots = Math.min(80, Math.ceil(dur / interval));
    const startSlot = Math.floor(segment.inPoint / interval);
    const wanted = [];
    for (let i = 0; i < nSlots; i++) {
      const slotIdx = startSlot + i;
      const tSrc = slotIdx * interval + interval / 2;
      if (tSrc >= segment.outPoint) break;
      const img = document.createElement('img');
      img.className = 'tl-thumb';
      img.style.left = `${((slotIdx * interval + interval / 2 - segment.inPoint) * pps - (interval * pps) / 2).toFixed(1)}px`;
      img.style.width = `${(interval * pps).toFixed(1)}px`;
      const cached = slots.get(slotIdx);
      if (cached) {
        img.src = cached;
        block.appendChild(img);
      } else {
        wanted.push({ slotIdx, tSrc });
      }
    }
    if (wanted.length && !this.thumbBusy) {
      this.requestThumbs(clip, slots, wanted.map((w) => w.slotIdx),
        wanted.map((w) => w.tSrc));
    }
  }

  requestThumbs(clip, slots, slotIdxs, times) {
    this.thumbBusy = true;
    grabFrames(clip.objectUrl, times, 96).then((urls) => {
      urls.forEach((u, i) => { if (u) slots.set(slotIdxs[i], u); });
    }).catch(() => { /* undecodable — skip */ })
      .finally(() => {
        this.thumbBusy = false;
        this.rebuild();
      });
  }

  // ---------- interactions ----------

  startHandleDrag(evt, segment, side, block, readout, pps) {
    evt.preventDefault();
    evt.stopPropagation();
    this.ws.select(segment.id);
    this.player.bind(segment.id);
    this.draggingHandle = true;
    const startX = evt.clientX;
    const startIn = segment.inPoint;
    const startOut = segment.outPoint;

    // window-level listeners (pointer capture unreliable — see startMoveDrag)
    const onMove = (e) => {
      const dt = (e.clientX - startX) / pps;
      if (side === 'l') {
        this.ws.setTrim(segment.id, startIn + dt, startOut, { silent: true });
        this.previewEdge(segment, segment.inPoint);
      } else {
        this.ws.setTrim(segment.id, startIn, startOut + dt, { silent: true });
        this.previewEdge(segment, segment.outPoint);
      }
      const dur = segment.outPoint - segment.inPoint;
      block.style.left = `${this.rowOffsetOf(segment.id) * pps}px`;
      block.style.width = `${Math.max(6, dur * pps)}px`;
      readout.textContent = `${dur.toFixed(dur < 10 ? 2 : 1)}s`;
      this.updatePlayhead(this.player.video.currentTime);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.draggingHandle = false;
      this.ws.setTrim(segment.id, segment.inPoint, segment.outPoint); // commit + emit
      this.player.range = { in: segment.inPoint, out: segment.outPoint };
      this.player.updateTimecode();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  previewEdge(segment, edgeTime) {
    // live-preview the frame at the dragged handle
    if (this.ws.selectedSegId === segment.id) {
      this.player.range = { in: segment.inPoint, out: segment.outPoint };
      this.player.seekToSource(edgeTime);
    }
  }

  // ---------- cross-track segment dragging ----------

  startMoveDrag(evt, segment, block, pps) {
    if (evt.button !== 0) return;
    evt.preventDefault();
    const startX = evt.clientX;
    const startY = evt.clientY;
    const clip = this.ws.getClip(segment.clipId);
    const dur = Math.max(0, segment.outPoint - segment.inPoint);

    let active = false;
    let ghost = null;
    let mark = null;
    let pending = null; // { trackId, index }

    // NOTE: window-level listeners — pointer capture proved unreliable
    // (Chromium reports hasPointerCapture but keeps hit-test targeting).
    const begin = () => {
      active = true;
      ghost = document.createElement('div');
      ghost.className = 'tl-ghost';
      ghost.textContent = `${clip?.name || '?'} · ${dur.toFixed(1)}s`;
      ghost.style.width = `${Math.max(48, Math.min(240, dur * pps))}px`;
      document.body.appendChild(ghost);
      mark = document.createElement('div');
      mark.className = 'tl-dropmark';
    };

    const onMove = (e) => {
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        begin();
      }
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;

      const row = this.rowAtY(e.clientY);
      if (!row) {
        pending = null;
        mark.remove();
        return;
      }
      const gT = Math.max(0, this.timeAtClientX(e.clientX));
      const slot = nearestSlot(this.ws.pps, row.track, gT);
      pending = { trackId: row.track.id, index: slot.index };
      if (mark.parentElement !== row.laneEl) {
        mark.remove();
        row.laneEl.appendChild(mark);
      }
      mark.style.left = `${slot.xPx.toFixed(1)}px`;
    };

    const finish = (commit) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      ghost?.remove();
      mark?.remove();
      if (commit && pending) {
        this.ws.moveSegmentTo(segment.id, pending.trackId, pending.index);
        this.ws.select(segment.id);
        this.player.bind(segment.id);
      }
      this.rebuild();
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  // which timeline row is under this clientY?
  rowAtY(clientY) {
    for (const rowEl of this.rowsEl.children) {
      if (!rowEl.classList.contains('tl-row')) continue;
      const r = rowEl.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) {
        const laneEl = rowEl.querySelector('.tl-lane');
        const trackId = laneEl?.dataset.trackId;
        const track = this.ws.tracks.find((t) => t.id === trackId);
        if (track && laneEl) return { track, laneEl };
      }
    }
    return null;
  }

  rowOffsetOf(segId) {
    const hit = this.ws.seg(segId);
    return hit ? this.ws.offsetBefore(hit.track, hit.segment.id) : 0;
  }

  timeAtClientX(clientX) {
    const rect = this.inner.getBoundingClientRect();
    return (clientX - rect.left - LABEL_W) / this.ws.pps;
  }

  startScrub(downEvt) {
    downEvt.preventDefault();
    const move = (clientX) => {
      const gT = Math.max(0, this.timeAtClientX(clientX));
      this.seekGlobal(gT);
    };
    move(downEvt.clientX);

    const onMove = (e) => move(e.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // map an output-time on the selected track's ruler to a segment + source time
  seekGlobal(gT) {
    const hit = this.ws.selection();
    let track = hit?.track;
    if (!track || !track.segments.length) {
      track = this.ws.tracks.find((t) => t.segments.length) || null;
    }
    if (!track) return;
    let offset = 0;
    let target = null;
    for (const s of track.segments) {
      const d = Math.max(0, s.outPoint - s.inPoint);
      if (gT < offset + d || (s === track.segments[track.segments.length - 1])) {
        target = s;
        break;
      }
      offset += d;
    }
    if (!target) return;
    const local = Math.min(Math.max(gT - offset, 0),
      Math.max(0, target.outPoint - target.inPoint));
    if (this.ws.selectedSegId !== target.id) {
      this.ws.select(target.id);
    }
    // bind unconditionally: clears any export-preview override, no-ops
    // the src swap when it's already the right clip
    this.player.bind(target.id);
    this.player.seekToSource(target.inPoint + local);
  }

  onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = this.scroller.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const contentX = cursorX + this.scroller.scrollLeft;
      const tAnchor = (contentX - LABEL_W) / this.ws.pps;
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      this.ws.setPps(this.ws.pps * factor);
      this.scroller.scrollLeft =
        Math.max(0, tAnchor * this.ws.pps + LABEL_W - cursorX);
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      this.scroller.scrollLeft += e.deltaY;
    }
  }

  // ---------- playhead ----------

  updatePlayhead(sourceT) {
    const hit = this.ws.selection();
    if (!hit) {
      this.playheadEl.hidden = true;
      return;
    }
    const off = this.ws.offsetBefore(hit.track, hit.segment.id);
    const local = sourceT - hit.segment.inPoint;
    const x = LABEL_W + (off + local) * this.ws.pps;
    this.playheadEl.style.left = `${x.toFixed(1)}px`;
    this.playheadEl.hidden = false;
    // keep playhead visible while playing
    const view = this.scroller.scrollLeft;
    const vw = this.scroller.clientWidth;
    if (x > view + vw - 30 || x < view + LABEL_W) {
      this.scroller.scrollLeft = Math.max(0, x - vw / 2);
    }
  }
}

function pickStep(pps) {
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60]) {
    if (s * pps >= 64) return s;
  }
  return 60;
}

function fmtTick(t, step) {
  if (step < 1) return `${t.toFixed(1)}s`;
  const m = Math.floor(t / 60);
  const s = Math.round(t - m * 60);
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function pickThumbInterval(pps) {
  for (const k of [0.2, 0.5, 1, 2]) {
    if (k * pps >= 44) return k;
  }
  return 2;
}

// insertion slot whose boundary (in output time) is nearest to gT
function nearestSlot(pps, track, gT) {
  const bounds = [0];
  let cum = 0;
  for (const s of track.segments) {
    cum += Math.max(0, s.outPoint - s.inPoint);
    bounds.push(cum);
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < bounds.length; i++) {
    const d = Math.abs(gT - bounds[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, xPx: bounds[best] * pps };
}

// extract an average color from a thumbnail dataURL for block edge tint
const colorCache = new Map();
function dominantColor(dataUrl) {
  if (!dataUrl) return null;
  if (colorCache.has(dataUrl)) return colorCache.get(dataUrl);
  try {
    const img = new Image();
    img.src = dataUrl;
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 8, 8);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      let r = 0; let g = 0; let b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      const col = `rgb(${(r / n) | 0},${(g / n) | 0},${(b / n) | 0})`;
      colorCache.set(dataUrl, col);
      document.dispatchEvent(new CustomEvent('thumbcolor'));
    };
  } catch { /* ignore */ }
  return null;
}
