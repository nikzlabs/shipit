// Top-level build file. No source here — everything lives in :app.
plugins {
    // AGP 8.6.x is the minimum that supports compileSdk 35 (Android 15); it
    // requires Gradle >= 8.7, which the CI workflow already pins
    // (.github/workflows/android.yml gradle-version: "8.7").
    id("com.android.application") version "8.6.1" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
