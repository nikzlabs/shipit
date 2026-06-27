package com.shipit.snapshottest

import org.junit.Assert.assertEquals
import org.junit.Test

/** Plain JVM unit test (no Android framework, no device) — the JVM unit-test tier. */
class GreetingTest {
    @Test
    fun trimsWhitespace() {
        assertEquals("ShipIt", displayName("  ShipIt  "))
    }

    @Test
    fun fallsBackWhenBlank() {
        assertEquals("there", displayName("   "))
    }
}
