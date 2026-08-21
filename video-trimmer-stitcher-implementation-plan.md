# Implementation Plan: Static Web Video Trimmer & Stitcher

Local-only, static page (GitHub Pages compatible), built on ffmpeg.wasm
(single-threaded build). Covers: multi-clip upload well, preview player with
frame-stepping, zoomable multi-track timeline, trim, stitch/concat, export.

**Scope constraint:** source files < 1 MB and < 15 s each. Everything below is
sized for that — no stream-copy fast paths, no separate preview renders,
single unified re-encode pipeline.

---

## 1. Core Data Model

```
Workspace
├── clips: Clip[]                 // all uploaded clips, in upload order
└── timeline: Track[]             // arrangement for stitching

Clip
├── id, name
├── file: File                     // original upload, untouched
├── objectUrl: string              // for <video> preview
├── duration, width, height, fps   // probed (see §2)
├── codec                          // e.g. "h264", "hevc" (HEVC preview warning)
└── hasAudio: boolean

Track
├── id
└── clipRefs: Segment[]            // ordered left→right within this row

Segment
├── clipId
└── trim: { inPoint, outPoint }    // seconds on the SOURCE clip
```

- Trim state lives **only** on `clipRefs` entries (per-segment), never on
  `Clip` itself — one clip can appear in multiple tracks/segments with
  different trims.
- Trims are timestamps on the source; nothing destructive happens until
  export (§6).

## 2. Loading Clips & Probing Metadata

- **Content well**: drag-and-drop zone + `<input type="file" multiple accept="video/*">`.
- **Thumbnails/filmstrips**: hidden `<video>` + `<canvas>` frame grabs
  (instant, no wasm needed).
- **Metadata probe**: ffmpeg.wasm does NOT ship `ffprobe`. Instead run
  `ffmpeg -i input` with no output args and parse stderr, which contains:
  - `Duration: HH:MM:SS.ms`
  - `Stream #0:0 ... Video: h264 ..., 1920x1080 ..., 29.97 fps, 30 tbr`
  - `Stream #0:x ... Audio: aac ...` (presence ⇒ `hasAudio`)
  - codec name after `Video:` (used for the HEVC warning, §3)
  - Parse `r_frame_rate`-style fractions if needed (`30000/1001`).
- VFR phone videos make fps an average — acceptable for ~1-frame stepping
  (already an approximation by design).
- New uploads auto-populate a new track immediately.

## 3. Preview Window

- `<video>` element bound to the selected segment's source clip; playback is
  constrained to `[inPoint, outPoint]` (loop or stop at out).
- **Frame stepping**: `requestVideoFrameCallback` is supported in all major
  browsers now (Firefox since v130) — use its `mediaTime` for accurate frame
  display. Stepping primitive remains `video.currentTime ± n/probedFps`
  while paused (browsers snap to nearest decodable frame); treat as
  "step ~1 frame".
- Debounce/coalesce rapid step clicks (throttle hold-to-repeat ~80 ms).
- **HEVC caveat**: if probed codec is `hevc` (or another the browser can't
  decode), show a non-blocking warning — preview/thumbnails may fail without
  hardware decode. Export still works (wasm decodes HEVC fine).

## 4. Zoomable Timeline

- Ruler (seconds/frames depending on zoom) + one row per track.
- Zoom: slider + Ctrl/cmd+scroll adjusts `pixelsPerSecond`, centered on cursor.
- Low zoom: solid color block + clip name. High zoom: cached filmstrip
  thumbnails (~every 1 s of source, `<video>`+canvas grab).
- Trim handles at each segment's edges; playhead synced to preview;
  click-to-seek ruler; horizontal pan.
- Selected-segment toolbar: split at playhead, delete, move left/right,
  move to other track.

## 5. Trim Interaction

- Handles always visible/draggable (default mode).
- Numeric readout of trimmed duration near handles.
- "Set in / set out at playhead" buttons for frame-exact placement after
  coarse drag + frame-step fine-tune.
- Split-at-playhead creates two segments from one (covers mid-clip removal).

## 6. Unified Export Pipeline (trim AND stitch are the same operation)

**One ffmpeg invocation per export.** A single trimmed clip is just N=1.

```
inputs:   in0.mp4 in1.mp4 ...          (segments' source files)
filters:  per segment i:
            [i:v]trim=start=IN:end=OUT,setpts=PTS-STARTPTS,fps=F,scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,format=yuv420p[vi]
            [i:a]atrim=start=IN:end=OUT,asetpts=PTS-STARTPTS[ai]
          (segments missing audio get a silent lavfi anullsrc input instead)
concat:   [v0][a0][v1][a1]... concat=n=N:v=1:a=1[v][a]
encode:   -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 128k
          -movflags +faststart
```

- W/H/F come from the FIRST segment's probe (output normalized to it);
  scale/pad handles mismatched resolutions between sources.
- Always re-encode: frame-accurate, uniform output, zero detection/fallback
  logic. At <15 s/<1 MB inputs, veryfast single-threaded wasm renders take
  seconds.
- Stitch preview = just run this render and preview the resulting blob
  (seconds); true WYSIWYG, no separate low-quality pass.

## 7. Export / Download

- One output per track ("Export" exports the active track; optional
  "export all").
- Progress: ffmpeg.wasm `progress` event gives output `time` (µs); compare
  against expected total duration (sum of trimmed durations) for a real
  percentage bar, plus elapsed-time readout.
- Result blob off the wasm FS → `URL.createObjectURL` → temporary
  `<a download>` link. Also swap into the preview player.

## 8. Technical Setup Notes

- Single-threaded ffmpeg.wasm (GH Pages can't set COOP/COEP for MT).
- **All assets self-hosted and committed**: `@ffmpeg/ffmpeg`, `@ffmpeg/util`,
  and `@ffmpeg/core` copied into `vendor/` — no CDN, required for offline.
- Core loads lazily on first probe/export with a one-time "loading video
  engine…" indicator.
- **Serving requirement**: must be served over http://localhost (`npx serve`,
  `python -m http.server`) — ES modules + wasm fetch fail under `file://`.
  GH Pages serves `.wasm` correctly; `toBlobURL` used anyway for safety.
- Nothing ever leaves the browser.

## 9. File/Module Structure

```
/index.html
/style.css
/README.md                  // run instructions
/vendor/                    // committed ffmpeg libs + core (self-hosted)
/src/
  ffmpeg-loader.js          // lazy init, shared instance, probe parser
  workspace.js              // Workspace/Clip/Track model + reactive store
  upload-well.js            // drag-drop, file input, thumbnails
  preview-player.js         // <video> wrapper, frame-step logic
  timeline.js               // zoomable ruler, tracks, trim handles, playhead
  exporter.js               // unified filtergraph builder, progress, download
  main.js                   // wires it all together
/test/
  exporter.test.mjs         // node-run tests of arg builder (pure functions)
```

## 10. Build Order

1. Scaffold: package.json, vendor ffmpeg dist + core into `vendor/`.
2. `ffmpeg-loader.js` — lazy load + trivial command + probe parse.
3. `workspace.js` + `upload-well.js` — clips in, thumbnails showing.
4. `preview-player.js` — play/pause/seek + frame stepping.
5. `timeline.js` — zoom, handles, playhead sync (single track first, then multi).
6. `exporter.js` — unified pipeline; validate filtergraph builder with node tests.
7. Polish: HEVC warning, real progress bar, elapsed readout.
