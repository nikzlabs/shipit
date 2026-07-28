#!/usr/bin/env bash
#
# Android "hot reload" loop for the emulator preview (docs/213).
#
# HONEST SCOPE: native Android has no headless hot-SWAP (Android Studio's "Apply
# Changes" / Compose "Live Edit" are IDE-bound and not available from the CLI).
# This is the practical agent-free equivalent: on every source change, rebuild
# the debug APK, reinstall it (`-r` keeps app data), and relaunch — so the
# emulator preview always reflects the current code. Coarser than web HMR (full
# rebuild + reinstall, a few seconds to minutes), but it's the real story.
#
# Runs in the `android` Compose service (Dockerfile.android-dev: SDK + Gradle).
# Reaches the budtmo `emulator` service over the Compose network by service DNS.
set -uo pipefail

ADB_TARGET="${ADB_TARGET:-emulator:5555}"
APP_DIR="${APP_DIR:-/workspace/android}"
APK="${APK:-$APP_DIR/app/build/outputs/apk/debug/app-debug.apk}"
PKG="${PKG:-com.shipit.wrapper.debug}"   # android/ debug applicationId (.debug suffix)
POLL_SECONDS="${POLL_SECONDS:-2}"

cd "$APP_DIR" || { echo "[android] no $APP_DIR — nothing to build"; exec tail -f /dev/null; }

echo "[android] waiting for the emulator device…"
until adb connect "$ADB_TARGET" 2>/dev/null | grep -qiE "connected|already"; do sleep "$POLL_SECONDS"; done
until [ "$(adb -s "$ADB_TARGET" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep "$POLL_SECONDS"; done
echo "[android] emulator ready at $ADB_TARGET"

build_deploy() {
  echo "[android] building (assembleDebug)…"
  if ./gradlew :app:assembleDebug -q --console=plain; then
    adb -s "$ADB_TARGET" install -r "$APK" \
      && adb -s "$ADB_TARGET" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
      && echo "[android] deployed at $(date +%T)"
  else
    echo "[android] build FAILED — leaving the previously deployed app running"
  fi
}

# Signature of the watched source tree: any change to a tracked source file
# flips the hash. Polling (not inotify) because Docker bind-mounts drop inotify
# events — same rationale as CHOKIDAR_USEPOLLING on the web `dev` service.
sig() {
  find app/src build.gradle.kts app/build.gradle.kts settings.gradle.kts gradle.properties \
    -type f 2>/dev/null -printf '%T@ %p\n' | sort | md5sum
}

build_deploy
echo "[android] watching for source changes (poll ${POLL_SECONDS}s)…"
last="$(sig)"
while true; do
  sleep "$POLL_SECONDS"
  now="$(sig)"
  if [ "$now" != "$last" ]; then
    echo "[android] change detected — rebuilding"
    build_deploy
    last="$(sig)"   # re-read: the build writes nothing under app/src, but re-stamp to be safe
  fi
done
