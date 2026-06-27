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

## Implementation

### Phase 1 — build toolchain (shipped)

- [x] Bake SDK + JDK 17 + Gradle 8.7 into `Dockerfile.session-worker.prod` + `.dev` (after the Playwright block; `.docker` inherits via `FROM`)
- [x] Wire `ANDROID_SDK_ROOT` / `ANDROID_HOME` / `JAVA_HOME` at the launch boundary (`container-lifecycle.ts` `buildEnv`) + guard test
- [x] Commit the `android/` Gradle wrapper (8.7) — `gradlew`, `gradlew.bat`, `gradle/wrapper/*`
- [x] On-demand SDK components via `sdkmanager` (agent-run, error-driven) instead of an orchestrator-side staged resolver — SDK dirs made writable for the runtime user
- [x] `shipit-docs/android.md` (platform-global) + `.claude/skills/android-build` skill + `environment.md`/`README.md` updates
- [ ] **CI/post-deploy only:** green `assembleDebug` + `lint` + a JVM test for (a) a generic repo and (b) a monorepo — needs the rebuilt session-worker image (can't build in-session)

### Phase 2 — snapshot tests as the visual signal (shipped)

- [x] Document the Paparazzi/Roborazzi `record`/`verify` loop in `android.md` + the skill
- [x] Document the read-the-diff-PNG → `present` habit for inline visual feedback (no new code — `present` exists)
- [ ] **CI/post-deploy only:** confirm the baked `layoutlib` runtime runs a repo's snapshot tests headlessly (needs the rebuilt image; a SHI-205 native test app exercises it end to end)

### Phase 3 — running-app enabler (`/dev/kvm`) (shipped)

- [x] Narrowly-scoped `devices:` allowlist in `compose-generator.ts` — accept **only** the exact `/dev/kvm:/dev/kvm` mapping (`validateDevices`), reject every other device + `/dev/kvm` remapped elsewhere
- [x] Operator kill-switch `SESSION_ALLOW_DEV_KVM=0` (`isDevKvmAllowed`) — deployment-level disable, not a per-repo field
- [x] Co-located unit tests (allow exact mapping in all forms; reject other devices/remaps/non-list; reject when kill-switch off; env parsing)
- [x] Canonical emulator Compose recipe + constraints in `compose.md`; `android.md` + skill updated with the one-device rule + kill-switch
- [x] **Operator/post-deploy only:** confirm host KVM (`kvm-ok`) and that the budtmo emulator image boots + is `adb`-reachable on a real deployment (also check the seccomp profile permits KVM ioctls) — verified on a deployment host: `kvm-ok` passes, `budtmo/docker-android:emulator_14.0` boots and `adb devices` shows `emulator-5554 device` under Docker's **default** seccomp profile (no custom profile needed). Recipe tag corrected `emulator_14`→`emulator_14.0`.

### Phases 4–5 (future work — not this session)

- [ ] Phase 4: agent `adb` debug/drive loop (logcat + tap/screenshot/snapshot triad, optional Maestro) + interactive preview via `x-shipit-preview`
- [ ] Phase 5: Firebase Test Lab / GMD-on-KVM for instrumented tests; results as inline PR artifacts
- [ ] Persistent SDK overlay so on-demand `sdkmanager` installs survive a container restart
