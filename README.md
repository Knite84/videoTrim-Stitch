# TrimStitch — local video trimmer & stitcher

Static, offline-capable web app for frame-accurate trimming and stitching of
short clips (< ~15 s, < ~1 MB each). Everything runs in your browser via
ffmpeg.wasm — files never leave your machine.

## Run locally

Any static file server works. Two options:

```sh
npm run serve          # npx serve on http://localhost:8080
# or
python -m http.server 8080
```

Then open http://localhost:8080.

> Opening `index.html` directly from disk (`file://`) will NOT work — browsers
> block ES modules and WebAssembly fetches on file:// URLs. A localhost server
> is required.

## GitHub Pages

Everything needed (including the ~32 MB ffmpeg core in `vendor/`) is committed,
so pushing this repo to GitHub Pages just works — no CDN, no build step, no
special headers (single-threaded wasm avoids the COOP/COEP requirement).

## Usage

1. Drop clips into the well (top left). Each upload becomes its own track.
2. Trim by dragging the edge handles; fine-tune with the preview player's
   frame-step buttons and **Set in / Set out**.
3. Stitch: **drag segments between tracks** (drop past a track's last segment
   to append at the end), click a chip in the well to append it to the last
   track, or use the ◀ ▶ toolbar actions. Split at playhead with ✂ / `S`.
4. Zoom the timeline with Ctrl+scroll or the slider.
5. Drag the bar between preview and timeline to give portrait clips more
   height (double-click the bar to reset).
6. **Audio tracks:** **+ audio track** adds an audio-only row (green,
   ♪-marked). Drag a video segment onto it to keep only its sound, or use
   **Mute** (`M`) to strip a segment's audio from the video export.
7. **Export ⤓ frame** saves the paused preview frame as a webp
   (shift-click for .jpg); **Export ⤓ mp4** renders the selected track —
   to an mp4 (H.264 + AAC, crf 18) for a video track, or an audio-only
   .m4a (AAC) for an audio track — and auto-downloads it. The export *is*
   the preview render — what you see is what you get.

### Keyboard

| key | action |
| --- | ------ |
| space | play / pause |
| ← / → | step one frame |
| shift+← / → | step ten frames |
| Home / End | jump to in / out point |
| I / O | set in / out at playhead |
| S | split segment at playhead |
| M | mute / unmute selected segment |
| Del | delete selected segment |

## Notes

- HEVC/iPhone clips: export works, but live preview may be blank if your
  browser/hardware can't decode HEVC (a warning will show).
- Mixed codecs/resolutions/fps across stitched segments are handled — output
  is normalized to the first segment's properties (scale + pad + fps).
- Segments without audio get silent audio so mixed sequences still concat.
- Muting every segment on a track yields a video-only mp4 (no audio stream).
- Frame export uses the wasm core's libwebp/mjpeg encoders and is
  frame-accurate (`ffmpeg -ss <t> -frames:v 1`).
- Nothing persists between reloads yet.

## Dev

```sh
npm test        # node tests for the ffmpeg command builder (src/filtergraph.js)
npm run test:e2e      # full browser flow (serve :8123 first — see tests/e2e.mjs)
npm run test:frame    # frame-export button: webp + jpg end-to-end
npm run test:layout   # layout sanity
npm run test:dnd      # drag & drop layout checks
npm run test:drag     # cross-track segment dragging
```

(e2e/frame tests need a static server on :8123 and are Playwright-driven;
they use msedge when available for proprietary codecs.)
"# videoTrim-Stitch"
