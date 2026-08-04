package com.shipit.overlaytest

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

/**
 * A pure-framework Activity (no androidx) so the app compiles against the
 * deliberately off-matrix compileSdk 33 without any dependency forcing 34.
 * The point of this fixture is the *build*, not the UI — it exists to prove the
 * on-demand SDK overlay provisions a non-baked platform.
 */
class OverlayActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = "overlay fixture" })
    }
}
