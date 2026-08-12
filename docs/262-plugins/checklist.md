# Plugin repositories — checklist

Design phase (this slice):

- [x] Consumer declaration format (`plugins:` in shipit.yaml) — plan.md §1a
- [x] Plugin manifest format (`exports.plugins:`) — plan.md §1b
- [x] In-session usage contract (paths, env, CLI surface, refresh, feedback) — plan.md §2
- [x] UI surfaces mapped to existing components, with committed prototypes (mockup.html services panel; mockup-plugins-tab.html right-rail tab) — plan.md §3
- [x] Apply independent design-review findings (12 correctness, 2 simplification bundles — resolutions on planning#355)

Next design slice (server mechanics):

- [ ] Checkout + mount mechanics: bare-cache reuse (docs/192), read-only mounts, per-plugin copy-on-write install layer (reqs 2, 7)
- [ ] Generation staging/activation: stage → validate → install → prepare → atomic swap; old-generation semantics for concurrent CLI calls (reqs 12, 15)
- [ ] Per-plugin per-session shared state directory, mounted into services and exposed to CLIs (reqs 17, 18)
- [ ] Published-port stability per (session, service) so the preview origin survives a fragment port edit (req 18)
- [ ] Compose-fragment merging + security validation of plugin services, preserving fragment-relative path resolution (paths resolve against the fragment's directory in the checkout — set by the fixture) (reqs 3, 5, 16, 20)
- [ ] Agent refresh transport: `shipit plugin` shim → worker agent-ops relay → orchestrator, with guard tests (req 12; orchestrator routes are container-denied)
- [ ] Egress execution-surface semantics: host satisfaction is agent-container truth today (services are unconfined, docs/172); decide whether plugin services get their own containment (req 24)
- [ ] Credential name resolution + `secrets_status` plugin grouping (req 23)
- [ ] CLI PATH mechanism + collision checks (reqs 17, 20)
- [ ] Skills materialization into each backend's discovery root, namespaced, with refresh re-scan (req 22, docs/209 — one mechanism, one item)
- [ ] Feedback-channel registration as issue destination (req 25)
- [ ] Pin durability: persist the resolved SHA keyed by the consumer declaration; warn when a tag moves (req 8)
- [ ] Install stamping: re-run on plugin commit / install string / `install-inputs` content change, mirroring agent.install's convention (req 7)
- [ ] Settings file: validate declared settings + consumer values, materialize the `SHIPIT_SETTINGS` JSON per imported plugin (req 26)
- [ ] Fetch-authority boundary: repository fetches stay orchestrator-side; guard test that plugin install/services/CLIs cannot reach fetch credentials; standing-grant activation without prompts, identity always visible (req 19)
- [ ] Self-use mode (`repo: self`, req 27): live working-tree activation, no generations/refresh, consumer-path parity for services/CLIs/skills/settings
- [ ] GitHub App mode: multi-repo token minting for declared plugin repos (req 10)

Verification (plan.md §5 — drives the implementation):

- [x] Test plugin authored (`test-plugin/`): one tiny service, one CLI, one skill, one setting, one credential name, one host — every export a self-reporting probe; manifest + `repo: self` declaration live in this repo's shipit.yaml; `plugins`/`exports` reserved in shipit-config.ts with a guard test
- [ ] Test plugin exercised via TWO fixtures once slice 2 lands: self-declared (`repo: self`, live path — no `SHIPIT_PLUGIN_COMMIT`) and consumer-declared by `owner/name` (checkout/generation/refresh path — commit set, `install.matchesActiveCommit: true`)
- [ ] Dogfood everything but services in the inner instance (`RUNTIME_MODE=local` skips Docker): parsing, tab, needs, CLI wrappers, skills via the self fixture; generations + refresh relay via the consumer fixture — including admitting the relay in local mode's explicit agent-ops route allowlist (`local-agent-ops.ts`) with the parity test extended
- [ ] Service path via integration tests (isTestMode fakes): fragment merge, per-service startup/overrides, origin on service messages, collision failures
- [ ] One real-instance end-to-end: plugin service + preview + `window.shipit` interaction

Implementation:

- [x] Phase-1 declaration parsing — `src/server/shared/plugin-repos.ts` (called from `shipit-config.ts`; trackers parse first): consumer `repos`+`use` grammar, `exports.plugins` manifest, cross-block name reservation with the same-destination alias exception, alias uniqueness, branch/pin exclusivity, `repo: self` rules; nothing fatal (reqs 11, 13, 27; req 20 phase 1)
- [x] `GET /api/plugin-repos` snapshot — `api-routes-plugin-repos.ts`: per-request config read (issues.trackers precedent), self selectors resolved against the same file's manifest, `consumerRepoUrl`, malformed-document degradation with a warning
- [x] Plugins tab v0 — `plugin-repos-store.ts` (session-scoped; three race guards: foreign-session drop, latest-wins generation, `pending` retry), `PluginReposPanel.tsx`, App.tsx rail wiring: intent gating incl. warnings-only snapshots (req 13), warn dot via `Tab.badge` with accessible label, effective-tab fallback, `useTabLabelCollapse` dep, session reset, `files_changed` shipit.yaml refetch. Tracked repos render an honest "declared — mechanics pending" state that does NOT count toward the dot (the design's never-fetched means "tried and failed"; the full active/degraded/collision states arrive with the slice-2 mechanics). Verified live in the dogfood inner instance against todo-list's merged fixture.
