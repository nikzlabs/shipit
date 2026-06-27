package com.shipit.snapshottest

import androidx.compose.material3.MaterialTheme
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import org.junit.Rule
import org.junit.Test

/**
 * Renders [GreetingCard] to a PNG via Paparazzi (layoutlib, no emulator) and
 * diffs it against the committed golden under src/test/snapshots/.
 *
 *   ./gradlew :app:recordPaparazziDebug   # regenerate goldens after a UI change
 *   ./gradlew :app:verifyPaparazziDebug   # fail if the render drifts from golden
 */
class GreetingCardSnapshotTest {
    @get:Rule
    val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5)

    @Test
    fun greetingCard() {
        paparazzi.snapshot {
            MaterialTheme {
                GreetingCard(name = "ShipIt")
            }
        }
    }
}
