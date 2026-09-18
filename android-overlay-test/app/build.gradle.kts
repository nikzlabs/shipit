plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.shipit.overlaytest"
    // Keep off-matrix to test on-demand SDK provisioning.
    compileSdk = 33

    defaultConfig {
        applicationId = "com.shipit.overlaytest"
        minSdk = 24
        targetSdk = 33
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// AndroidX would force compileSdk 34 and invalidate this fixture.
dependencies {
}
