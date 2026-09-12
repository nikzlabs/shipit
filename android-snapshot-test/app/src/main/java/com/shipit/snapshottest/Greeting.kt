package com.shipit.snapshottest

fun displayName(raw: String): String = raw.trim().ifEmpty { "there" }
