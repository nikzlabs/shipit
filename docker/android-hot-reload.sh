#!/usr/bin/env bash
#
# Rebuild, reinstall, and relaunch the Android preview after source changes.
set -uo pipefail

ADB_TARGET="${ADB_TARGET:-emulator:5555}"
# Override these defaults for another Gradle app.
APP_DIR="${APP_DIR:-/workspace/android-snapshot-test}"
APK="${APK:-$APP_DIR/app/build/outputs/apk/debug/app-debug.apk}"
PKG="${PKG:-com.shipit.snapshottest}"
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

# Poll because Docker bind mounts can drop inotify events.
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
    last="$(sig)"
  fi
done
