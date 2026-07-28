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
- [x] **(b) monorepo verified:** `cd android && ./gradlew assembleDebug lint` builds **green in a fresh session** on the rebuilt image (the `android/` wrapper built from its subdir inside the web monorepo, web side unaffected).
- [x] **(a) off-matrix `compileSdk` overlay verified:** added `android-overlay-test/`, a fixture targeting non-baked `compileSdk 33`. Two outcomes proven in-session: with AGP SDK auto-download (default) the build self-heals with **zero agent step** (AGP fetches `android-33`, licenses pre-accepted); with auto-download off the build fails (`Failed to find target with hash string 'android-33'`) and `sdkmanager "platforms;android-33"` fixes it → green APK. **Caveat:** installs land in the container's writable layer (non-persistent, re-fetched after restart) — the persistent overlay remains future work.
- [x] **JVM test verified:** covered by `android-snapshot-test` (`GreetingTest`, a pure-logic JUnit test under `testDebugUnitTest`).
- [ ] **Off-matrix JDK — needs a platform decision, not a fixture:** only JDK 17 is baked (deliberate). A project pinning a non-17 Gradle toolchain triggers Foojay auto-provisioning (`api.foojay.io`/Adoptium), which the egress allowlist blocks. Closing it means bake a 2nd JDK *or* allowlist Foojay + enable toolchain provisioning.

### Phase 2 — snapshot tests as the visual signal (shipped)

- [x] Document the Paparazzi/Roborazzi `record`/`verify` loop in `android.md` + the skill
- [x] Document the read-the-diff-PNG → `present` habit for inline visual feedback (no new code — `present` exists)
- [x] **Verified in-session:** the baked `layoutlib` runtime runs a repo's snapshot tests headlessly — added `android-snapshot-test/`, a standalone native Compose app with a Paparazzi test. `recordPaparazziDebug` rendered the golden PNG and `verifyPaparazziDebug` passes against it on the rebuilt image, no emulator. (Doesn't wait on the SHI-205 template — this in-repo fixture exercises the path end to end.)

### Phase 3 — running-app enabler (`/dev/kvm`) (shipped)

- [x] Narrowly-scoped `devices:` allowlist in `compose-generator.ts` — accept **only** the exact `/dev/kvm:/dev/kvm` mapping (`validateDevices`), reject every other device + `/dev/kvm` remapped elsewhere
- [x] Operator kill-switch `SESSION_ALLOW_DEV_KVM=0` (`isDevKvmAllowed`) — deployment-level disable, not a per-repo field
- [x] Co-located unit tests (allow exact mapping in all forms; reject other devices/remaps/non-list; reject when kill-switch off; env parsing)
- [x] Canonical emulator Compose recipe + constraints in `compose.md`; `android.md` + skill updated with the one-device rule + kill-switch
- [x] **Operator/post-deploy only:** confirm host KVM (`kvm-ok`) and that the budtmo emulator image boots + is `adb`-reachable on a real deployment (also check the seccomp profile permits KVM ioctls) — verified on a deployment host: `kvm-ok` passes, `budtmo/docker-android:emulator_14.0` boots and `adb devices` shows `emulator-5554 device` under Docker's **default** seccomp profile (no custom profile needed). Recipe tag corrected `emulator_14`→`emulator_14.0`.

### Phases 4–5 (future work — not this session)

- [ ] Phase 4: agent `adb` debug/drive loop (logcat + tap/screenshot/snapshot triad, optional Maestro) + interactive preview via `x-shipit-preview`
  - [x] **User preview root-cause fixed:** the shipped recipe never started the noVNC web UI — `budtmo` needs `WEB_VNC=true` (the boot test's `vnc_web` crash). Added `WEB_VNC=true` + `EMULATOR_DEVICE` to the recipe in `android.md`/`compose.md`/`plan.md`, and confirmed the preview proxy already forwards WebSocket upgrades generically (`preview-proxy.ts`) so noVNC streams through `x-shipit-preview`. Added the emulator as a **manual** dogfood service in the repo's `docker-compose.yml`.
  - [x] **Agent-free build + hot reload via Compose:** the build lives in the Compose stack (not `agent.install`), like the web `dev` service. Added `docker/Dockerfile.android-dev` (SDK+Gradle, mirrors the session-worker bake) + `docker/android-hot-reload.sh` (build → `adb install` → launch, then poll-watch the source and rebuild+reinstall+relaunch on change) + an `android` service in `docker-compose.yml`; `emulator depends_on: [android]` so opening the preview brings the builder up. Honest scope: rebuild+reinstall on change (native Android has no headless hot-swap), not code-level HMR.
  - [ ] **Host verification (operator, needs KVM + image build):** start the `emulator` preview on a KVM host; confirm port 6080 serves noVNC and renders in the preview pane, the `android` builder builds + installs the APK, and editing `android/app/src` triggers a rebuild+relaunch. (Also confirm Compose service containers have egress for Gradle dep resolution.)
- [ ] Phase 5: Firebase Test Lab / GMD-on-KVM for instrumented tests; results as inline PR artifacts
- [ ] Persistent SDK overlay so on-demand `sdkmanager` installs survive a container restart
