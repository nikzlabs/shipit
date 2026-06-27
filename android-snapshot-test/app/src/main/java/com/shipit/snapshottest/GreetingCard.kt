package com.shipit.snapshottest

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

/**
 * A minimal real Compose UI with layout, spacing, and typography — enough for
 * layoutlib to render something whose pixels change when the layout changes,
 * which is the whole point of a snapshot test. Deliberately self-contained
 * (no resources, no Activity) so it renders headlessly.
 */
@Composable
fun GreetingCard(name: String, modifier: Modifier = Modifier) {
    Surface(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(24.dp)) {
            Text(text = "Hello,", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Text(text = displayName(name), style = MaterialTheme.typography.headlineLarge)
        }
    }
}

@Preview
@Composable
private fun GreetingCardPreview() {
    MaterialTheme {
        GreetingCard(name = "ShipIt")
    }
}
