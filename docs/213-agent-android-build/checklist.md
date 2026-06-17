# Checklist — 213 Android build/test/preview as a platform capability

This doc is a **design/recommendation** deliverable. The items below track the doc; the implementation
phases are future work (the session brief said do not commit to a heavy implementation here).

## Design doc

- [x] Investigate container reality (KVM, JDK, Gradle, memory, disk) — measured in-session
- [x] Reframe from repo-scoped to **platform capability** — works for ANY Android repo, zero setup
- [x] Toolchain provisioning options (shared read-only mount vs image variant vs base image vs agent.install) + recommendation
- [x] Zero-config Android-project detection heuristic
- [x] Headless tier (assembleDebug / lint / JVM unit / Robolectric / Paparazzi-Roborazzi)
- [x] Emulator/instrumented tier (KVM, Gradle Managed Devices, Firebase Test Lab)
- [x] **Preview** designed & phased: P1 rendered-screen gallery (zero-KVM) → P2 streamed emulator (KVM host pool) → P3 cloud device farm
- [x] Agent surfacing (shipit-docs entry + .claude/skills skill)
- [x] Relationship to API-35 work and SHI-53
- [x] Linear tracker issue created + linked in `plan.md` frontmatter
- [x] Open PR with the doc

## Implementation (future work — not this session)

- [ ] Phase 0: commit Gradle wrapper (8.7); add Android-project detection at session setup
- [ ] Phase 1: build pinned platform SDK+JDK asset; read-only mount auto-attached on detection; green `assembleDebug`+`lint`+unit test for a generic Android repo; `shipit-docs/android.md` + skill
- [ ] Phase 2: Paparazzi/Roborazzi (pinned to AGP) + **P1 rendered-screen preview** in the preview pane (ComposablePreviewScanner discovery)
- [ ] Phase 3: **P2** KVM emulator host pool + emulator service + WebRTC bridge through the preview proxy + APK push on build
- [ ] Phase 4: **P3** Firebase Test Lab / GMD-on-KVM for instrumented tests; results as inline PR artifacts
</content>
