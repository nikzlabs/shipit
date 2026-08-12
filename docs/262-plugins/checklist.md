# Plugin repositories — checklist

Design phase (this slice):

- [x] Consumer declaration format (`plugins:` in shipit.yaml) — plan.md §1a
- [x] Plugin manifest format (`exports.plugins:`) — plan.md §1b
- [x] In-session usage contract (paths, env, CLI surface, refresh, feedback) — plan.md §2
- [x] UI surfaces mapped to existing components, with committed prototypes (mockup.html A–C) — plan.md §3
- [x] Apply independent design-review findings (12 correctness, 2 simplification bundles — resolutions on planning#355)

Next design slice (server mechanics):

- [ ] Checkout + mount mechanics: bare-cache reuse (docs/192), read-only mounts, per-plugin copy-on-write install layer (reqs 2, 7)
- [ ] Generation staging/activation: stage → validate → install → prepare → atomic swap; old-generation semantics for concurrent CLI calls (reqs 12, 15)
- [ ] Per-plugin per-session shared state directory, mounted into services and exposed to CLIs (reqs 17, 18)
- [ ] Published-port stability per (session, service) so the preview origin survives a fragment port edit (req 18)
- [ ] Compose-fragment merging + security validation of plugin services (reqs 3, 5, 16, 20)
- [ ] Skills materialization into each backend's discovery root + refresh re-scan (req 22, docs/209)
- [ ] Credential name resolution + `secrets_status` plugin grouping (req 23)
- [ ] CLI PATH mechanism + collision checks (reqs 17, 20)
- [ ] Skills disclosure via docs/209 mechanism (req 22)
- [ ] Feedback-channel registration as issue destination (req 25)
- [ ] GitHub App mode: multi-repo token minting for declared plugin repos (req 10)

Implementation: not started.
