package com.shipit.snapshottest

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme

/**
 * Launchable entry point, so this module is not only rendered headlessly by
 * Paparazzi but can also be **installed and launched on the emulator** — the
 * running-app tier of the preview stack (docs/213). It renders the same
 * [GreetingCard] the snapshot test renders, so what you see on the device and
 * what the golden PNG captures stay in sync.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                GreetingCard(name = "ShipIt")
            }
        }
    }
}
