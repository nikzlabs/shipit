# android-snapshot-test

A **standalone native Android app** whose only job is to validate ShipIt's
headless Android test path in a real session — the part the `android/` WebView
wrapper can't exercise.

`android/` is a thin WebView shell: `layoutlib` cannot render a `WebView`, so it
can never validate the **snapshot-test** path (render a screen to a PNG with no
emulator). This module is a real Jetpack Compose UI, so it can. See
`docs/213-agent-android-build/plan.md` (Phase 2).

## What it validates

| Tier | Covered by | Command |
|------|------------|---------|
| Compile + package | `assembleDebug` | `./gradlew :app:assembleDebug` |
| JVM unit tests (pure logic, no device) | `GreetingTest` | `./gradlew :app:testDebugUnitTest` |
| **Snapshot tests** (Compose → PNG via `layoutlib`, no emulator) | `GreetingCardSnapshotTest` (Paparazzi) | see below |

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
