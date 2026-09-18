package com.shipit.overlaytest

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

/** Pure-framework activity for the off-matrix SDK fixture. */
class OverlayActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = "overlay fixture" })
    }
}
