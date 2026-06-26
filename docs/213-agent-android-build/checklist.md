# Checklist — 213 Android build/test/debug/preview as a platform capability

This doc is a **design/recommendation** deliverable. The items below track the doc; the implementation
phases are future work (the session brief said do not commit to a heavy implementation here).

## Design doc

- [x] Investigate the runtime reality (host vs session-container KVM, JDK, Gradle, memory, disk) — measured in-session
- [x] Frame as a platform capability for ANY Android repo (incl. web/Android monorepos)
- [x] Build toolchain: bake the SDK+JDK base into the session image (ambient) + on-demand per-session overlay
- [x] **No new `shipit.yaml` fields** — toolchain ambient + emulator is an ordinary Compose service, so nothing Android-specific to declare
- [x] Headless tier (assembleDebug / lint / JVM unit / Robolectric / **snapshot tests** + static `apkanalyzer`/`aapt2`)
- [x] Snapshot tests (Paparazzi/Roborazzi) are the visual verification — the test sets up the render; no platform render harness
- [x] Running-app tier: emulator as a user-defined Compose service + gated `/dev/kvm` allowance; `adb` debug/drive; Firebase fallback
- [x] Debugging & inspection + interactive control (press / screenshot / snapshot — the Playwright `browser_*` analog)
- [x] Preview: emulator web UI via `x-shipit-preview` (interactive) + snapshot PNGs surfaced inline (static)
- [x] Agent surfacing (shipit-docs entry + .claude/skills skill)
- [x] Coherence pass — restructure around the two-runtime-surfaces spine, drop the `android:` schema
- [x] Linear tracker issue created + linked in `plan.md` frontmatter
- [x] Open PR with the doc

## Implementation (future work — not this session)

- [ ] Phase 1: bake SDK+JDK base into `Dockerfile.session-worker.*` + on-demand overlay + AGP→Gradle→JDK resolution; commit `android/` Gradle wrapper (8.7); green build/lint/test for a generic repo and a monorepo (zero repo config); `shipit-docs/android.md` + skill
- [ ] Phase 2: confirm `layoutlib` runtime runs the repo's Paparazzi/Roborazzi tests headlessly; document record/verify; surface rendered/diff PNGs inline
- [ ] Phase 3: narrowly-scoped `/dev/kvm` `devices:` allowance in `compose-generator.ts` + canonical emulator Compose recipe; confirm host KVM
- [ ] Phase 4: agent `adb` debug/drive loop (logcat + tap/screenshot/snapshot triad, optional Maestro) + interactive preview via `x-shipit-preview`
- [ ] Phase 5: Firebase Test Lab / GMD-on-KVM for instrumented tests; results as inline PR artifacts
