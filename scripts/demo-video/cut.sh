#!/usr/bin/env bash
# Cut a demo recording down to the storyboard's slices — docs/296 plan §5.
#
#   cut.sh <recording.webm> <beats.json> <storyboard.json> <out-base>
#
# Writes <out-base>.webm (VP9) and, when the ffmpeg has libx264, <out-base>.mp4
# (h264, yuv420p, even dimensions, faststart). Both muted (req 9), both at the
# recorded viewport. The slice math lives in cut-plan.mjs; this is the wrapper.
#
# FFMPEG=<path> overrides the binary (default: `ffmpeg` on PATH). Needs a full
# build: the `trim`, `setpts` and `concat` filters plus the libvpx-vp9 encoder.
# Playwright's bundled ffmpeg is libvpx (VP8) only and has no concat filter, so
# it cannot do this — install ffmpeg on the demo host (plan §5).
set -euo pipefail

if [ $# -ne 4 ]; then
  echo "usage: cut.sh <recording.webm> <beats.json> <storyboard.json> <out-base>" >&2
  exit 2
fi

RECORDING=$1
BEATS=$2
STORYBOARD=$3
OUT=$4
FFMPEG=${FFMPEG:-ffmpeg}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

for f in "$RECORDING" "$BEATS" "$STORYBOARD"; do
  if [ ! -f "$f" ]; then
    echo "cut: no such file: $f" >&2
    exit 1
  fi
done

if ! command -v "$FFMPEG" >/dev/null 2>&1; then
  echo "cut: ffmpeg not found: $FFMPEG (set FFMPEG=<path> or install ffmpeg on this host, docs/296 plan §5)" >&2
  exit 1
fi

# ── Capabilities ─────────────────────────────────────────────────────────────
filters=$("$FFMPEG" -hide_banner -filters 2>/dev/null || true)
encoders=$("$FFMPEG" -hide_banner -encoders 2>/dev/null || true)
has_filter() { grep -Eq "^ *[A-Z.]+ +$1 +" <<<"$filters"; }
has_encoder() { grep -Eq "^ *[A-Z.]+ +$1 +" <<<"$encoders"; }

missing=()
for f in trim setpts concat; do has_filter "$f" || missing+=("filter $f"); done
has_encoder libvpx-vp9 || missing+=("encoder libvpx-vp9")
if [ ${#missing[@]} -gt 0 ]; then
  echo "cut: $FFMPEG lacks: ${missing[*]}. A full ffmpeg is required (Playwright's bundled build is libvpx/VP8 only; docs/296 plan §5)." >&2
  exit 1
fi

# ── Anchor ───────────────────────────────────────────────────────────────────
# The driver's stamps run from before Playwright's first frame; the file's
# duration against the driver's wall clock (run.json) gives the gap. Without
# run.json (or ffprobe) the plan is used as stamped.
ANCHOR=()
RUN_JSON=$(dirname "$BEATS")/run.json
FFPROBE=${FFPROBE:-$(dirname "$(command -v "$FFMPEG")")/ffprobe}
if [ -f "$RUN_JSON" ] && command -v "$FFPROBE" >/dev/null 2>&1; then
  WALL=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(Number.isFinite(r.wallDuration))process.stdout.write(String(r.wallDuration))' "$RUN_JSON")
  VIDEO=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$RECORDING" 2>/dev/null || true)
  if [ -n "$WALL" ] && [ -n "$VIDEO" ]; then
    ANCHOR=(--wall-duration "$WALL" --video-duration "$VIDEO")
    echo "cut: re-anchoring beats: wall ${WALL}s, video ${VIDEO}s" >&2
  fi
fi

# ── Plan ─────────────────────────────────────────────────────────────────────
FILTER=$(node "$HERE/cut-plan.mjs" "$BEATS" "$STORYBOARD" --print filter "${ANCHOR[@]}")
KEPT=$(node "$HERE/cut-plan.mjs" "$BEATS" "$STORYBOARD" --print kept "${ANCHOR[@]}")
echo "cut: keeping ${KEPT}s of $RECORDING" >&2

# ── Exports ──────────────────────────────────────────────────────────────────
"$FFMPEG" -y -hide_banner -loglevel error -i "$RECORDING" \
  -filter_complex "$FILTER" -map "[v]" -an \
  -c:v libvpx-vp9 -b:v 0 -crf 30 -row-mt 1 \
  "$OUT.webm"
echo "cut: wrote $OUT.webm" >&2

if has_encoder libx264; then
  # Even dimensions are a yuv420p requirement; `pad` is a no-op on an even
  # viewport and adds at most one pixel on an odd one, so nothing is scaled.
  "$FFMPEG" -y -hide_banner -loglevel error -i "$RECORDING" \
    -filter_complex "$FILTER;[v]pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p[m]" -map "[m]" -an \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
    "$OUT.mp4"
  echo "cut: wrote $OUT.mp4" >&2
else
  echo "cut: skipping $OUT.mp4 — $FFMPEG has no libx264 encoder" >&2
fi
