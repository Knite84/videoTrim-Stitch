// Preview player: playback constrained to the selected segment's trim range,
// frame stepping, set-in/set-out at playhead.
import { Workspace } from './workspace.js';

const MIN_DUR = 1 / 120;

export class PreviewPlayer extends EventTarget {
  constructor(container, ws) {
    super();
    this.ws = ws;
    this.boundSegId = null;
    this.range = { in: 0, out: 0 };
    this.fps = 30;
    this.playing = false;
    this.raf = null;
    // set while previewing an exported render; any explicit bind() clears it
    this.previewOverride = false;

    container.classList.add('player');
    container.innerHTML = `
      <div class="video-box">
        <video id="previewVideo" playsinline></video>
        <div class="video-warn" id="videoWarn" hidden></div>
      </div>
      <div class="p-controls">
        <button id="toIn" title="jump to in point (Home)">⇤</button>
        <button id="stepB" title="previous frame (←)">◀|</button>
        <button id="playBtn" title="play/pause (space)">▶</button>
        <button id="stepF" title="next frame (→)">|▶</button>
        <button id="toOut" title="jump to out point (End)">⇥</button>
        <span class="timecode" id="timecode">0:00.000 / 0:00.000</span>
        <input type="range" id="vol" min="0" max="1" step="0.01" value="1" title="volume">
        <span class="spacer"></span>
        <button id="setIn" title="set in point at playhead (I)">Set in</button>
        <button id="setOut" title="set out point at playhead (O)">Set out</button>
      </div>`;

    this.video = container.querySelector('#previewVideo');
    this.warnBox = container.querySelector('#videoWarn');
    this.playBtn = container.querySelector('#playBtn');
    this.timecode = container.querySelector('#timecode');

    this.video.addEventListener('seeked', () => this.emitTick());
    this.video.addEventListener('timeupdate', () => { if (!this.playing) this.emitTick(); });
    this.video.addEventListener('play', () => { this.playing = true; this.syncBtn(); this.loop(); });
    this.video.addEventListener('pause', () => {
      this.playing = false;
      this.syncBtn();
      cancelAnimationFrame(this.raf);
    });

    const holdable = (el, fn) => {
      let to = null;
      let iv = null;
      const start = () => { fn(); to = setTimeout(() => { iv = setInterval(fn, 90); }, 350); };
      const stop = () => { clearTimeout(to); clearInterval(iv); to = iv = null; };
      el.addEventListener('pointerdown', start);
      for (const e of ['pointerup', 'pointerleave', 'pointercancel']) {
        el.addEventListener(e, stop);
      }
    };

    holdable(container.querySelector('#stepB'), () => this.step(-1));
    holdable(container.querySelector('#stepF'), () => this.step(1));
    container.querySelector('#toIn').addEventListener('click', () => this.seekToSource(this.range.in));
    container.querySelector('#toOut').addEventListener('click', () => this.seekToSource(this.range.out));
    this.playBtn.addEventListener('click', () => this.toggle());
    container.querySelector('#vol').addEventListener('input', (e) => {
      this.video.volume = Number(e.target.value);
    });
    container.querySelector('#setIn').addEventListener('click', () => this.setIn());
    container.querySelector('#setOut').addEventListener('click', () => this.setOut());

    this.ws.onChange(() => this.refreshFromStore());
    // initial empty state
    this.refreshFromStore();
  }

  refreshFromStore() {
    if (this.previewOverride) return;
    const hit = this.ws.selection();
    if (!hit) {
      this.boundSegId = null;
      return;
    }
    const selChanged = this.boundSegId !== hit.segment.id;
    const bound = this.seg();
    if (!bound || selChanged) {
      this.bind(hit.segment.id);
    } else {
      // trims may have changed elsewhere (timeline drag committed etc.)
      this.range = {
        in: bound.segment.inPoint,
        out: bound.segment.outPoint,
      };
      this.clampToRange();
      this.updateTimecode();
    }
  }

  seg() {
    return this.ws.seg(this.boundSegId);
  }

  bind(segId) {
    const hit = this.ws.seg(segId);
    if (!hit) return;
    this.previewOverride = false;
    this.pause();
    this.boundSegId = segId;
    const clip = this.ws.getClip(hit.segment.clipId);
    this.range = { in: hit.segment.inPoint, out: hit.segment.outPoint };
    this.fps = clip?.probe?.fps || 30;

    const src = clip?.objectUrl;
    if (src && this.video.src !== src) {
      this.video.src = src;
      this.warnBox.hidden = !clip?.warnHevc;
      if (clip?.warnHevc) {
        this.warnBox.textContent =
          'Preview may not play (codec not supported by this browser). Export still works.';
      }
    } else {
      this.warnBox.hidden = true;
    }
    if (Number.isFinite(this.video.duration)) {
      this.seekToSource(this.range.in);
    } else {
      this.video.addEventListener('loadedmetadata',
        () => this.seekToSource(this.range.in), { once: true });
    }
    this.updateTimecode();
  }

  clampToRange() {
    const t = this.video.currentTime;
    if (t < this.range.in - 1e-4 || t > this.range.out + 1e-4) {
      this.seekToSource(Math.min(Math.max(t, this.range.in), this.range.out));
    }
  }

  seekToSource(t) {
    const clamped = Math.min(Math.max(t, this.range.in), this.range.out || t);
    if (Number.isFinite(this.video.duration)) {
      try { this.video.currentTime = clamped; } catch { /* not ready */ }
    }
    this.emitTick();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.boundSegId) return;
    let t = this.video.currentTime;
    if (!(t >= this.range.in && t < this.range.out - 1e-3)) {
      this.seekToSource(this.range.in);
    }
    this.video.play().catch(() => {});
  }

  pause() {
    this.video.pause();
  }

  step(frames) {
    this.pause();
    const dt = frames / this.fps;
    const target = Math.min(
      Math.max(this.video.currentTime + dt, this.range.in),
      this.range.out
    );
    // browsers snap to the nearest decodable frame — treat as "~1 frame"
    try { this.video.currentTime = target; } catch { /* not ready */ }
    this.emitTick();
  }

  setIn() {
    if (!this.boundSegId) return;
    const t = this.video.currentTime;
    if (t < this.range.out - MIN_DUR) {
      this.ws.setTrim(this.boundSegId, t, this.range.out);
      this.range.in = t;
      this.updateTimecode();
    }
  }

  setOut() {
    if (!this.boundSegId) return;
    const t = this.video.currentTime;
    if (t > this.range.in + MIN_DUR) {
      this.ws.setTrim(this.boundSegId, this.range.in, t);
      this.range.out = t;
      this.updateTimecode();
    }
  }

  loop() {
    if (!this.playing) return;
    if (this.video.currentTime >= this.range.out - 1 / this.fps) {
      this.pause();
      this.seekToSource(this.range.out);
      return;
    }
    this.emitTick();
    this.raf = requestAnimationFrame(() => this.loop());
  }

  syncBtn() {
    this.playBtn.textContent = this.playing ? '❚❚' : '▶';
  }

  updateTimecode() {
    const dur = Math.max(0, this.range.out - this.range.in);
    this.timecode.textContent =
      `${fmt(this.video.currentTime - this.range.in)} / ${fmt(dur)}`;
  }

  emitTick() {
    this.updateTimecode();
    this.dispatchEvent(new CustomEvent('tick', { detail: { t: this.video.currentTime } }));
  }
}

function fmt(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
}
