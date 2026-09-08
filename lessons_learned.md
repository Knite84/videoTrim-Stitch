# Lessons learned — TrimStitch

Living document. Add anything that cost real debugging time and isn't obvious
from the code. Keep entries short: the bug, the tell, the fix/rule.

## 2026-09-08 — ffmpeg concat filter pad ordering (mjs:1 fixed post-merge)

- **Bug:** ffmpeg exited with code 1 on any *stitched* export of 2+ audio-bearing
  clips while single-trim exports worked fine. stderr said
  `Media type mismatch between ... 'Parsed_aformat_N' ... and 'Parsed_concat_0'
  filter input pad 2 (video)`.
- **Cause:** concat input labels were built as `[v0][v1][a0][a1]` (all video,
  then all audio). With `concat=n=N:v=1:a=1` the inputs must be per-segment
  pairs interleaved: `[v0][a0][v1][a1]`. Otherwise audio chains get wired to
  concat's video pads and the whole filter graph fails to init.
- **Rule:** whenever building a concat/merge filter graph, emit labels in the
  exact pad order the filter expects (pairs for v=1:a=1). Don't group by kind.
- **Related pitfall we explored:** putting the concat line *before* the chain
  definitions in the filter_complex string also changes how forward-referenced
  labels bind. Definitions first, consumer (concat) last.
- **Meta-lesson:** the exporter swallowed ffmpeg stderr ("exited with code 1"
  told us nothing). We burned time reproducing with Playwright just to see the
  real message. Exporters/FFmpeg runners should always capture and surface a
  tail of stderr in the thrown error.
- **Repro harness:** `tests/repro-export.mjs` attaches a `log` listener on the
  wasm FFmpeg instance and dumps the full stderr — reuse it for any export
  failure instead of guessing.
- **Infrastructure gotcha:** background `Start-Process` servers die when the
  parent shell exits; launch the static server *and* the test in ONE command
  (Start-Process … ; Start-Sleep 8 ; node test) or the second script gets
  ERR_CONNECTION_REFUSED.
- **Editing hazard:** inserting a new top-level export by matching a short
  comment string (`// cleanup inputs`) inside a function body split the old
  function in half — the file only fails at runtime "Unexpected token
  'export'". Always `node --check` edited files before running tests.

## Testing notes

- `tests/e2e.mjs` runs against a *statically served* copy (port 8123 in
  scripts/repro runs; `npm run serve` is 8080). Chromium without proprietary
  codecs can't decode h264 previews — use `channel: 'msedge'` like e2e does,
  or you'll conflate codec-missing failures with real bugs.
- `@ffmpeg/core` (wasm) DOES include libx264, aac, libwebp and mjpeg encoders —
  don't assume a missing-encoder failure without asking it (`-encoders`).
- favicon 404 is normal (no favicon committed); exclude it from "serious page
  error" checks in e2e.
