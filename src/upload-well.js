// Content well: drag-drop / file input, clip chips, thumbnail + probe pipeline.
import { makeThumb, videoMeta } from './media.js';
import { probeClip, isFFmpegLoaded } from './ffmpeg-loader.js';

export class UploadWell {
  constructor(container, workspace, hooks = {}) {
    this.container = container;
    this.ws = workspace;
    this.dropRoot = hooks.dropRoot || container; // whole left column by default
    this.onNotify = hooks.onNotify || (() => {});
    this.onEngineStatus = hooks.onEngineStatus || (() => {});
    this.queue = [];
    this.probing = false;
    this.render();
    this.bindDnD();
  }

  render() {
    this.container.innerHTML = '';
    this.dropzone = document.createElement('div');
    this.dropzone.className = 'dropzone';
    this.dropzone.innerHTML = `
      <span class="dz-icon">⬇</span>
      <span>Drop clips anywhere in this column, or <button class="linkish">browse</button></span>
      <span class="dz-hint">video files · processed entirely in your browser</span>`;
    this.chips = document.createElement('div');
    this.chips.className = 'chips';
    this.container.append(this.dropzone, this.chips);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.multiple = true;
    input.hidden = true;
    this.fileInput = input;
    this.container.appendChild(input);
    this.dropzone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => this.addFiles(input.files));
  }

  bindDnD() {
    const root = this.dropRoot;
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    let depth = 0;
    root.addEventListener('dragenter', (e) => {
      stop(e);
      if (++depth === 1) root.classList.add('dragging');
    });
    root.addEventListener('dragover', stop);
    root.addEventListener('dragleave', (e) => {
      stop(e);
      if (--depth <= 0) {
        depth = 0;
        root.classList.remove('dragging');
      }
    });
    root.addEventListener('drop', (e) => {
      depth = 0;
      root.classList.remove('dragging');
      stop(e);
      if (e.dataTransfer?.files?.length) this.addFiles(e.dataTransfer.files);
    });
  }

  async addFiles(fileList) {
    const files = [...fileList].filter(
      (f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(f.name)
    );
    if (!files.length) return;
    for (const file of files) {
      const clip = {
        id: `clip_${Math.random().toString(36).slice(2, 9)}`,
        name: file.name,
        file,
        objectUrl: URL.createObjectURL(file),
        thumb: null,
        probe: null,
        warnHevc: false,
      };
      this.ws.addClip(clip);
      this.renderChip(clip);
      this.queue.push(clip);
    }
    this.processQueue();
  }

  renderChip(clip) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.clipId = clip.id;
    chip.title = `${clip.name} — click to append to last track`;
    chip.innerHTML = `
      <img class="chip-thumb" alt="" ${clip.thumb ? `src="${clip.thumb}"` : ''}>
      <span class="chip-name">${escapeHtml(clip.name)}</span>
      <span class="chip-meta"></span>
      <button class="chip-x" title="remove">×</button>`;
    chip.querySelector('.chip-x').addEventListener('click', (e) => {
      e.stopPropagation();
      this.ws.removeClip(clip.id);
      chip.remove();
    });
    chip.addEventListener('click', () => {
      // append as a new segment at the end of the last track
      const track = this.ws.tracks[this.ws.tracks.length - 1];
      if (!track || !this.ws.getClip(clip.id)) return;
      const dur = clip.probe?.duration ?? 0;
      track.segments.push({
        id: `seg_${Math.random().toString(36).slice(2, 9)}`,
        clipId: clip.id,
        inPoint: 0,
        outPoint: dur,
      });
      this.ws.emit();
    });
    this.chips.appendChild(chip);
    this.refreshChipMeta(clip);
  }

  refreshChipMeta(clip) {
    const chipEl = this.chips.querySelector(`[data-clip-id="${clip.id}"]`);
    if (!chipEl) return;
    const img = chipEl.querySelector('.chip-thumb');
    if (clip.thumb && !img.src) img.src = clip.thumb;
    const meta = chipEl.querySelector('.chip-meta');
    const p = clip.probe;
    meta.textContent = p
      ? `${fmtDur(p.duration)}${p.width ? ` · ${p.width}×${p.height}` : ''}${p.fps ? ` · ${p.fps.toFixed(2)}fps` : ''}`
      : 'probing…';
    meta.classList.toggle('warn', !!clip.warnHevc);
    if (clip.warnHevc) meta.textContent += ' · HEVC: preview may not play';
  }

  async processQueue() {
    if (this.probing) return;
    this.probing = true;
    while (this.queue.length) {
      const clip = this.queue.shift();

      // 1. fast browser metadata (duration/size) — works even before wasm loads
      try {
        const meta = await videoMeta(clip.objectUrl);
        this.ws.updateClipProbe(clip.id, {
          ...(clip.probe || {}),
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          fps: null,
          codec: null,
          hasAudio: true,
        }, { silent: !isFFmpegLoaded() });
      } catch {
        clip.warnHevc = true; // browser can't decode it at all
      }

      // 2. thumbnail
      if (!clip.thumb) {
        clip.thumb = await makeThumb(clip.objectUrl, clip.probe?.duration);
        this.refreshChipMeta(clip);
      }

      // 3. precise wasm probe (triggers lazy engine load on first upload)
      try {
        const probe = await probeClip(clip.file);
        this.ws.updateClipProbe(clip.id, { ...probe, duration: probe.duration ?? clip.probe?.duration });
        if (clip.warnHevc) {
          this.onNotify(`${clip.name}: browser can't preview this codec — export will still work`);
        } else if (['hevc', 'h265'].includes(probe.codec)) {
          this.onNotify(`${clip.name}: HEVC detected — preview may not play without hardware decode`);
        }
      } catch (err) {
        this.onNotify(`Could not probe ${clip.name}: ${err.message}`);
      }
      this.refreshChipMeta(clip);
    }
    this.probing = false;
  }
}

function fmtDur(s) {
  if (!Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
