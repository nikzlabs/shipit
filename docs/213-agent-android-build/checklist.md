# Checklist — 213 agent Android build/test

This doc is a **design/recommendation** deliverable. The items below track the doc itself; the
implementation phases are intentionally left unchecked as future work (the session brief said do not
commit to a heavy implementation here).

## Design doc

- [x] Investigate container reality (KVM, JDK, Gradle, memory, disk) — measured in-session
- [x] Evaluate headless tier (assembleDebug / lint / JVM unit / Robolectric / Paparazzi)
- [x] Evaluate emulator/instrumented tier (KVM, Gradle Managed Devices, Firebase Test Lab)
- [x] Decide where the toolchain lives (agent.install vs image vs compose service) + costs
- [x] Define agent surfacing (shipit-docs entry + .claude/skills skill)
- [x] Lead with recommendation + phased plan (headless/Paparazzi first, emulator later)
- [x] Note relationship to API-35 edge-to-edge work and SHI-53; defer live preview
- [x] Create Linear tracker issue and link it in `plan.md` frontmatter
- [x] Open PR with the doc

## Implementation (future work — not this session)

- [ ] Phase 0: commit Gradle wrapper (8.7); gitignore `android/.android-sdk/`
- [ ] Phase 1: `install-sdk.sh` + `agent.install` wiring; green `assembleDebug` + `lint` + first JVM unit test in-container
- [ ] Phase 1: `src/server/shipit-docs/android.md` + `.claude/skills/android-build` skill
- [ ] Phase 2: add Paparazzi (pinned to AGP) + first golden for cog overlay / system-bar insets; optional Robolectric
- [ ] Phase 3 (CI/cloud only): GMD on KVM runner or Firebase Test Lab job, results as PR artifacts
</content>
