# Checklist — 213 Android build/test/debug/preview as a platform capability

This doc is a **design/recommendation** deliverable. The items below track the doc; the implementation
phases are future work (the session brief said do not commit to a heavy implementation here).

## Design doc

- [x] Investigate the runtime reality (host vs session-container KVM, JDK, Gradle, memory, disk) — measured in-session
- [x] Frame as a platform capability for ANY Android repo (incl. web/Android monorepos)
- [x] Build toolchain: provisioning options + recommendation (read-only base store + per-session overlay)
- [x] Toolchain derived-not-declared + optional override; staged requirement resolver; path-scoped detection
- [x] Headless tier (assembleDebug / lint / JVM unit / Robolectric / Paparazzi-Roborazzi + static `apkanalyzer`/`aapt2`)
- [x] Running-app tier: emulator as a user-defined Compose service + gated `/dev/kvm` allowance; `adb` debug/drive; Firebase fallback
- [x] Debugging & inspection + interactive control (press / screenshot / snapshot — the Playwright `browser_*` analog)
- [x] Preview tiers: P1 rendered gallery → P2 emulator Compose service → P3 cloud device farm
- [x] Agent surfacing (shipit-docs entry + .claude/skills skill)
- [x] Coherence pass — restructure around the two-runtime-surfaces spine, dedupe
- [x] Linear tracker issue created + linked in `plan.md` frontmatter
- [x] Open PR with the doc

## Implementation (future work — not this session)

- [ ] Phase 0: commit Gradle wrapper (8.7); `shipit.yaml` `android:` schema + path-scoped detection + staged resolver
- [ ] Phase 1: base store + writable overlay + AGP→Gradle→JDK resolution; green build/lint/test for a generic repo and a monorepo; `shipit-docs/android.md` + skill
- [ ] Phase 2: P1 render harness (Paparazzi/Roborazzi via init script, ComposablePreviewScanner + manifest/`res/layout`) wired into the preview pane
- [ ] Phase 3: narrowly-scoped `/dev/kvm` `devices:` allowance in `compose-generator.ts` + canonical emulator Compose recipe; confirm host KVM
- [ ] Phase 4: agent `adb` debug/drive loop (logcat + tap/screenshot/snapshot triad, optional Maestro) + interactive preview via `x-shipit-preview`
- [ ] Phase 5: Firebase Test Lab / GMD-on-KVM for instrumented tests; results as inline PR artifacts
