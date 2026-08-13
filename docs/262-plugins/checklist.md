# Plugin repositories — checklist

Design phase (this slice):

- [x] Consumer declaration format (`plugins:` in shipit.yaml) — plan.md §1a
- [x] Plugin manifest format (`exports.plugins:`) — plan.md §1b
- [x] In-session usage contract (paths, env, CLI surface, refresh, feedback) — plan.md §2
- [x] UI surfaces mapped to existing components, with committed prototypes (mockup.html services panel; mockup-plugins-tab.html right-rail tab) — plan.md §3
- [x] Apply independent design-review findings (12 correctness, 2 simplification bundles — resolutions on planning#355)

Next design slice (server mechanics):

- [x] Checkout mechanics: bare-cache reuse (serialized per cache), per-generation checkout in the session state dir (req 2). **The writable layer is the generation directory itself** — a per-session, per-commit, disposable copy already confines any build output, so the CoW layer buys nothing; read-only for the agent is enforced at the `:ro` mount
- [ ] Mounts: `/plugins/<name>` read-only into the agent container, plus `/project` for services (reqs 2, 21)
- [x] Generation staging/activation: stage → validate (incl. phase-2 selectors) → atomic symlink swap; the record lives inside the generation so reads are atomic; failure keeps the prior generation whole and live; a per-repo serial QUEUE (not promise-joining, so a mid-flight declaration edit is never lost); prune never deletes the live generation (reqs 12, 13, 14, 15). Service prepare/recreate lands with the compose work
- [ ] Per-plugin per-session shared state directory, mounted into services and exposed to CLIs (reqs 17, 18)
- [ ] Published-port stability per (session, service) so the preview origin survives a fragment port edit (req 18)
- [ ] Compose-fragment merging + security validation of plugin services, preserving fragment-relative path resolution (paths resolve against the fragment's directory in the checkout — set by the fixture) (reqs 3, 5, 16, 20)
- [ ] Agent refresh transport: `shipit plugin` shim → worker agent-ops relay → orchestrator, with guard tests (req 12; orchestrator routes are container-denied)
- [ ] Egress execution-surface semantics: host satisfaction is agent-container truth today (services are unconfined, docs/172); decide whether plugin services get their own containment (req 24)
- [ ] Credential name resolution + `secrets_status` plugin grouping (req 23)
- [ ] CLI PATH mechanism + collision checks (reqs 17, 20)
- [ ] Skills materialization into each backend's discovery root, namespaced, with refresh re-scan (req 22, docs/209 — one mechanism, one item)
- [ ] Feedback-channel registration as issue destination (req 25)
- [x] Pin durability (`plugin-pins.ts`): resolved SHA persisted **orchestrator-wide, keyed by the consuming project's declaration** — not per session, or two sessions of one project could resolve a moved tag differently. A recorded pin is honored without re-resolving (a deleted or now-ambiguous tag still activates), a moved tag warns, writes are atomic, and only a declaration edit re-resolves (req 8)
- [ ] Plugin `install` execution + stamping (req 7) — deliberately NOT orchestrator-side: an earlier draft ran repo-authored install strings in the orchestrator process with its full environment (ShipIt's PAT, unrestricted host access), which is strictly more privileged than `agent.install`. It lands with the container wiring, where it runs with the authority `agent.install` already has. Stamping (commit / install string / `install-inputs` content) is designed and moves with it
- [ ] Settings file: validate declared settings + consumer values, materialize the `SHIPIT_SETTINGS` JSON per imported plugin (req 26)
- [ ] Fetch-authority boundary: repository fetches stay orchestrator-side; guard test that plugin install/services/CLIs cannot reach fetch credentials; standing-grant activation without prompts, identity always visible (req 19)
- [ ] Self-use mode (`repo: self`, req 27): live working-tree activation, no generations/refresh, consumer-path parity for services/CLIs/skills/settings
- [ ] GitHub App mode: multi-repo token minting for declared plugin repos (req 10)

Verification (plan.md §5 — drives the implementation):

- [x] Test plugin authored (`test-plugin/`): one tiny service, one CLI, one skill, one setting, one credential name, one host — every export a self-reporting probe; manifest + `repo: self` declaration live in this repo's shipit.yaml; `plugins`/`exports` reserved in shipit-config.ts with a guard test
- [ ] Test plugin exercised via TWO fixtures once slice 2 lands: self-declared (`repo: self`, live path — no `SHIPIT_PLUGIN_COMMIT`) and consumer-declared by `owner/name` (checkout/generation/refresh path — commit set, `install.matchesActiveCommit: true`). **Activation half done live** (see below); the `SHIPIT_PLUGIN_COMMIT` / `install.matchesActiveCommit` half needs the container wiring
- [x] Dogfood the ACTIVATION spine in the inner instance (`RUNTIME_MODE=local` skips Docker) — done 2026-08-13 against todo-list's consumer fixture: a real checkout under the session state dir, the `active` symlink and in-generation record, `active` at the exact commit, a durable pin resolved from a tag and recorded project-scoped, a declaration edit re-activating, `degraded` keeping the prior generation whole and live, and the `plugin_repos_updated` push arriving over WS. Found and fixed one defect: the degraded card stated one fact twice
- [ ] Dogfood the rest in the inner instance: needs, CLI wrappers, skills via the self fixture; the refresh relay via the consumer fixture — including admitting the relay in local mode's explicit agent-ops route allowlist (`local-agent-ops.ts`) with the parity test extended
- [ ] Service path via integration tests (isTestMode fakes): fragment merge, per-service startup/overrides, origin on service messages, collision failures
- [ ] One real-instance end-to-end: plugin service + preview + `window.shipit` interaction

Implementation:

- [x] Generation engine — `plugin-generations.ts`: on-disk layout under the session state dir (docs/246, so a plugin checkout can never be staged into the user's repo), commit resolution (branch tip / pin / durable pin record), staging, phase-2 selector validation, atomic symlink publish (record inside the generation), old-generation pruning that never deletes the live one, a per-repo serial queue, and cancellation checks so a disposed session's activation publishes nothing. Runs no plugin-authored code
- [x] Activation lifecycle — `services/plugin-activation.ts` + wiring through `bootstrap-managers` → `runner-registry-factory` → `service-manager-setup`: runs on session activation and on a `shipit.yaml` edit (container mode) or when a turn ends (local mode, which has no in-container file watcher), fire-and-forget so a slow fetch never delays a session opening (req 13); per-repo independence (req 14); last-attempt state feeds the tab without a GET ever activating anything
- [x] Snapshot + tab states: `active` (with the exact commit), `activating`, `degraded` (prior generation still live — req 15), `unavailable`; tracked-repo selectors resolve against the LIVE generation's manifest (phase 2). The server pushes `plugin_repos_updated` when an activation round settles and the client refetches; the `activating` poll remains as a fallback

- [x] Phase-1 declaration parsing — `src/server/shared/plugin-repos.ts` (called from `shipit-config.ts`; trackers parse first): consumer `repos`+`use` grammar, `exports.plugins` manifest, cross-block name reservation with the same-destination alias exception, alias uniqueness, branch/pin exclusivity, `repo: self` rules; nothing fatal (reqs 11, 13, 27; req 20 phase 1)
- [x] `GET /api/plugin-repos` snapshot — `api-routes-plugin-repos.ts`: per-request config read (issues.trackers precedent), self selectors resolved against the same file's manifest, `consumerRepoUrl`, malformed-document degradation with a warning
- [x] Plugins tab v0 — `plugin-repos-store.ts` (session-scoped; three race guards: foreign-session drop, latest-wins generation, `pending` retry), `PluginReposPanel.tsx`, App.tsx rail wiring: intent gating incl. warnings-only snapshots (req 13), warn dot via `Tab.badge` with accessible label, effective-tab fallback, `useTabLabelCollapse` dep, session reset, `files_changed` shipit.yaml refetch. Tracked repos render an honest "declared — mechanics pending" state that does NOT count toward the dot (the design's never-fetched means "tried and failed"; the full active/degraded/collision states arrive with the slice-2 mechanics). Verified live in the dogfood inner instance against todo-list's merged fixture.
