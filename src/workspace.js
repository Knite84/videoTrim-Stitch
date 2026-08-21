// Workspace model + tiny reactive store.
// Trim state lives ONLY on segments (clipRefs), never on clips — one clip can
// appear in multiple tracks/segments with different trims.

let counter = 0;
const uid = (p) => `${p}_${++counter}`;

const MIN_DUR = 1 / 120; // guard against zero-length segments

export class Workspace extends EventTarget {
  constructor() {
    super();
    this.clips = [];      // {id,name,file,objectUrl,thumb,probe:{duration,width,height,fps,codec,hasAudio},warnHevc}
    this.tracks = [];     // {id,name,segments:[{id,clipId,inPoint,outPoint}]}
    this.selectedSegId = null;
    this.pps = 60;        // pixels per second (zoom)
  }

  emit(type = 'change') {
    this.dispatchEvent(new CustomEvent(type));
  }
  onChange(fn) {
    this.addEventListener('change', fn);
  }

  // ---- clips ----
  getClip(id) {
    return this.clips.find((c) => c.id === id) || null;
  }

  addClip(clip, { autoTrack = true } = {}) {
    this.clips.push(clip);
    if (autoTrack) {
      const dur = clip.probe?.duration ?? 0;
      this.tracks.push({
        id: uid('track'),
        name: `Track ${this.tracks.length + 1}`,
        segments: [{ id: uid('seg'), clipId: clip.id, inPoint: 0, outPoint: dur }],
      });
      const track = this.tracks[this.tracks.length - 1];
      this.selectedSegId = track.segments[0].id;
    }
    this.emit();
  }

  updateClipProbe(clipId, probe, { silent = false } = {}) {
    const clip = this.getClip(clipId);
    if (!clip) return;
    clip.probe = probe;
    clip.warnHevc = ['hevc', 'h265'].includes(probe.codec);
    // clamp existing trims into the newly-known duration
    if (Number.isFinite(probe.duration)) {
      for (const t of this.tracks) {
        for (const s of t.segments) {
          if (s.clipId !== clipId) continue;
          s.outPoint = Math.min(s.outPoint || probe.duration, probe.duration);
          s.inPoint = Math.min(s.inPoint, Math.max(0, s.outPoint - MIN_DUR));
        }
      }
    }
    if (!silent) this.emit();
  }

  removeClip(clipId) {
    this.clips = this.clips.filter((c) => c.id !== clipId);
    for (const t of [...this.tracks]) {
      t.segments = t.segments.filter((s) => s.clipId !== clipId);
      if (!t.segments.length) this.deleteTrack(t.id, { silent: true });
    }
    if (!this.seg(this.selectedSegId)) this.selectedSegId = null;
    this.emit();
  }

  // ---- segment lookup ----
  seg(segId) {
    for (const track of this.tracks) {
      const index = track.segments.findIndex((s) => s.id === segId);
      if (index !== -1) return { track, segment: track.segments[index], index };
    }
    return null;
  }

  selection() {
    return this.selectedSegId ? this.seg(this.selectedSegId) : null;
  }

  select(segId) {
    if (this.selectedSegId === segId) return;
    this.selectedSegId = segId;
    this.emit('selection');
    this.emit();
  }

  // ---- trims ----
  setTrim(segId, inPoint, outPoint, { silent = false } = {}) {
    const hit = this.seg(segId);
    if (!hit) return;
    const dur = this.getClip(hit.segment.clipId)?.probe?.duration ?? Infinity;
    let a = Math.max(0, Math.min(inPoint, dur - MIN_DUR));
    let b = Math.min(dur, Math.max(outPoint, a + MIN_DUR));
    hit.segment.inPoint = a;
    hit.segment.outPoint = b;
    if (!silent) this.emit();
  }

  splitSegment(segId, srcTime, { silent = false } = {}) {
    const hit = this.seg(segId);
    if (!hit) return false;
    const { track, segment } = hit;
    const t = Number(srcTime);
    if (!(t > segment.inPoint + MIN_DUR && t < segment.outPoint - MIN_DUR)) return false;
    const right = {
      id: uid('seg'),
      clipId: segment.clipId,
      inPoint: t,
      outPoint: segment.outPoint,
    };
    segment.outPoint = t;
    track.segments.splice(hit.index + 1, 0, right);
    if (!silent) this.emit();
    return true;
  }

  deleteSegment(segId) {
    const hit = this.seg(segId);
    if (!hit) return;
    hit.track.segments.splice(hit.index, 1);
    if (!hit.track.segments.length) this.deleteTrack(hit.track.id, { silent: true });
    if (this.selectedSegId === segId) this.selectedSegId = null;
    this.emit();
  }

  moveSegment(segId, dir) {
    const hit = this.seg(segId);
    if (!hit) return;
    const { track, index } = hit;
    const j = index + dir;
    if (j < 0 || j >= track.segments.length) return;
    [track.segments[index], track.segments[j]] = [track.segments[j], track.segments[index]];
    this.emit();
  }

  moveSegmentToNewTrack(segId) {
    const hit = this.seg(segId);
    if (!hit || hit.track.segments.length < 2) return;
    const [seg] = hit.track.segments.splice(hit.index, 1);
    this.tracks.push({
      id: uid('track'),
      name: `Track ${this.tracks.length + 1}`,
      segments: [seg],
    });
    this.emit();
  }

  // ---- tracks ----
  addTrack() {
    this.tracks.push({
      id: uid('track'),
      name: `Track ${this.tracks.length + 1}`,
      segments: [],
    });
    this.emit();
  }

  deleteTrack(trackId, { silent = false } = {}) {
    this.tracks = this.tracks.filter((t) => t.id !== trackId);
    if (!silent) this.emit();
  }

  trackDuration(track) {
    return track.segments.reduce(
      (sum, s) => sum + Math.max(0, s.outPoint - s.inPoint), 0
    );
  }

  // offset (in output time) of a segment within its track
  offsetBefore(track, segId) {
    let off = 0;
    for (const s of track.segments) {
      if (s.id === segId) break;
      off += Math.max(0, s.outPoint - s.inPoint);
    }
    return off;
  }

  maxContentDuration() {
    return Math.max(1, ...this.tracks.map((t) => this.trackDuration(t)));
  }

  setPps(pps) {
    this.pps = Math.max(4, Math.min(600, pps));
    this.emit('zoom');
    this.emit();
  }
}
