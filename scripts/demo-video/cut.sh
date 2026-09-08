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
# build: the `trim`, `setpts`, `concat` and `blackdetect` filters plus the
# libvpx-vp9 encoder. Playwright's bundled ffmpeg is libvpx (VP8) only and has
# no concat filter, so it cannot do this — install ffmpeg on the demo host
# (plan §5). FFPROBE=<path> likewise; by default the ffprobe beside $FFMPEG is
# used, else the one on PATH. CUT_UNANCHORED=1 lets a take whose anchor cannot
# be found in the file be cut anyway (see "Anchor" below).
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
for f in trim setpts concat blackdetect; do has_filter "$f" || missing+=("filter $f"); done
has_encoder libvpx-vp9 || missing+=("encoder libvpx-vp9")
if [ ${#missing[@]} -gt 0 ]; then
  echo "cut: $FFMPEG lacks: ${missing[*]}. A full ffmpeg is required (Playwright's bundled build is libvpx/VP8 only; docs/296 plan §5)." >&2
  exit 1
fi

# ── Anchor ───────────────────────────────────────────────────────────────────
# The driver's stamps are on its own clock, which starts before Playwright's
# first frame. run.json's `anchor.wallAt` is the moment the driver left its
# black splash for the instance; the first non-black frame of the recording
# (ffmpeg blackdetect) is that moment on the video's clock, and cut-plan.mjs
# shifts the slices by the difference. A run.json with an anchor but no way
# to find it in the file is a hard failure — CUT_UNANCHORED=1 overrides, and
# then the wall − video fallback (cut-plan `anchorOffset`) is used if it can
# be, else the raw stamps. A run.json without an anchor (a take from before
# the splash) goes straight to that fallback, with the same warning.
ANCHOR=()
RUN_JSON=$(dirname "$BEATS")/run.json
FFPROBE=${FFPROBE:-}
if [ -z "$FFPROBE" ]; then
  beside="$(dirname "$(command -v "$FFMPEG")")/ffprobe"
  if [ -x "$beside" ]; then FFPROBE=$beside; else FFPROBE=ffprobe; fi
fi

read_run_field() {
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],r);if(Number.isFinite(v))process.stdout.write(String(v))' "$RUN_JSON" "$1"
}

if [ -f "$RUN_JSON" ]; then
  ANCHOR_WALL=$(read_run_field anchor.wallAt)
  WALL=$(read_run_field wallDuration)
  VIDEO=""
  if command -v "$FFPROBE" >/dev/null 2>&1; then
    VIDEO=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$RECORDING" 2>/dev/null || true)
  fi
  ANCHOR_VIDEO=""
  if [ -n "$ANCHOR_WALL" ]; then
    # blackdetect logs to stderr; the first black_end is the splash ending.
    ANCHOR_VIDEO=$("$FFMPEG" -hide_banner -nostats -i "$RECORDING" -vf blackdetect=d=0.08:pix_th=0.10 -an -f null - 2>&1 \
      | grep -o 'black_end:[0-9.]*' | head -n1 | cut -d: -f2 || true)
  fi

  if [ -n "$ANCHOR_WALL" ] && [ -n "$ANCHOR_VIDEO" ] && [ -n "$VIDEO" ]; then
    ANCHOR=(--anchor-wall "$ANCHOR_WALL" --anchor-video "$ANCHOR_VIDEO" --video-duration "$VIDEO")
    echo "cut: anchor: driver left the splash at ${ANCHOR_WALL}s, video shows it at ${ANCHOR_VIDEO}s (file ${VIDEO}s)" >&2
  elif [ -n "$ANCHOR_WALL" ] && [ "${CUT_UNANCHORED:-0}" != "1" ]; then
    if [ -z "$VIDEO" ]; then
      echo "cut: run.json has an anchor but ffprobe could not read the duration of $RECORDING ($FFPROBE; set FFPROBE=<path>)." >&2
    else
      echo "cut: run.json has an anchor but blackdetect found no black splash in $RECORDING." >&2
    fi
    echo "cut: refusing to cut on unanchored stamps (the holds would land in the wrong footage). CUT_UNANCHORED=1 overrides." >&2
    exit 1
  else
    if [ -n "$WALL" ] && [ -n "$VIDEO" ]; then
      ANCHOR=(--wall-duration "$WALL" --video-duration "$VIDEO")
      echo "cut: WARNING: no black-splash anchor; falling back to wall − video (${WALL}s − ${VIDEO}s), which is off by up to 1 s (Playwright pads the tail)" >&2
    else
      echo "cut: WARNING: no anchor at all; cutting on the driver's raw stamps" >&2
    fi
  fi
else
  echo "cut: WARNING: no run.json beside $BEATS; cutting on the driver's raw stamps" >&2
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
