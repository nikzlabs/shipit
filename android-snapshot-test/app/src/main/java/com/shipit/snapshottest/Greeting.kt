package com.shipit.snapshottest

/**
 * Pure (no-Android) logic, exercised by [GreetingCard] and covered by a plain
 * JVM unit test (GreetingTest). Lets this fixture validate the JVM unit-test
 * tier — the "did `testDebugUnitTest` run pure logic on the JVM?" signal —
 * alongside the Paparazzi snapshot tier.
 */
fun displayName(raw: String): String = raw.trim().ifEmpty { "there" }
