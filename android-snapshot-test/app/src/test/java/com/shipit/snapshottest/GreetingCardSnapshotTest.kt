package com.shipit.snapshottest

import androidx.compose.material3.MaterialTheme
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import org.junit.Rule
import org.junit.Test

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
