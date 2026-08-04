# android-snapshot-test

The **canonical native Android target** in this repo — a standalone Jetpack
Compose app used to validate ShipIt's Android platform capability end to end.

It replaced the old `android/` WebView wrapper, which was removed (superseded by
the installable PWA — see `docs/222-pwa-installable/`). The wrapper was a thin
WebView shell and `layoutlib` cannot render a `WebView`, so it could never
exercise the snapshot, emulator, or interactive tiers. This module can. See
`docs/213-agent-android-build/plan.md`.

## What it validates

| Tier | Covered by | Command |
|------|------------|---------|
| Compile + package | `assembleDebug` | `./gradlew :app:assembleDebug` |
| JVM unit tests (pure logic, no device) | `GreetingTest` | `./gradlew :app:testDebugUnitTest` |
| **Snapshot tests** (Compose → PNG via `layoutlib`, no emulator) | `GreetingCardSnapshotTest` (Paparazzi) | see below |
| **Running app** (install + launch on the emulator preview) | `MainActivity` | started automatically by the `android` Compose service |

`MainActivity` renders the same `GreetingCard` the snapshot test renders, so the
device view and the golden PNG stay in sync. The emulator preview stack
(`docker-compose.yml` → `emulator` + `android` services) builds this app,
installs it, and hot-reloads it on source changes.

### Snapshot loop

```bash
./gradlew :app:recordPaparazziDebug   # (re)generate the golden after a UI change
./gradlew :app:verifyPaparazziDebug   # fail if the render drifts from the golden
```

The golden lives at
`app/src/test/snapshots/images/com.shipit.snapshottest_GreetingCardSnapshotTest_greetingCard.png`
and **is committed** — that's what `verify` diffs against. Read the diff PNG (or
`present` it) when a snapshot test fails.

## Toolchain

Versions track Paparazzi's supported toolchain, all compatible with the baked
session image (`/opt/android-sdk`: `android-34`/`35`, build-tools `34.0.0`/`35.0.0`;
`/opt/java` JDK 17; Gradle 8.7):

- AGP 8.5.2 · Kotlin 2.0.21 (Compose compiler via `org.jetbrains.kotlin.plugin.compose`)
- Paparazzi 1.3.5 · Compose BOM 2024.06.00
- `compileSdk` / `targetSdk` 34 (baked — this module deliberately stays *on*-matrix
  so it builds with zero on-demand SDK installs)

This is a separate Gradle root from `android/`; Node tooling ignores it (build
artifacts are gitignored at the repo root).
