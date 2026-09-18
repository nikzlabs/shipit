package com.shipit.snapshottest

import org.junit.Assert.assertEquals
import org.junit.Test

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
