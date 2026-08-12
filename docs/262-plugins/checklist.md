# Plugin repositories — checklist

Design phase (this slice):

- [x] Consumer declaration format (`plugins:` in shipit.yaml) — plan.md §1a
- [x] Plugin manifest format (`exports.plugins:`) — plan.md §1b
- [x] In-session usage contract (paths, env, CLI surface, refresh, feedback) — plan.md §2
- [x] UI surfaces mapped to existing components, with committed prototypes (mockup.html A–D) — plan.md §3
- [ ] Apply independent design-review findings

Next design slice (server mechanics):

- [ ] Checkout + mount mechanics: bare-cache reuse (docs/192), read-only mounts, per-plugin writable install layer (reqs 2, 7)
- [ ] Compose-fragment merging + security validation of plugin services (reqs 3, 5, 16, 20)
- [ ] Refresh implementation: coherent update, install re-run, service/CLI reload (reqs 12, 15)
- [ ] Credential name resolution + `secrets_status` plugin grouping (req 23)
- [ ] CLI PATH mechanism + collision checks (reqs 17, 20)
- [ ] Skills disclosure via docs/209 mechanism (req 22)
- [ ] Feedback-channel registration as issue destination (req 25)
- [ ] GitHub App mode: multi-repo token minting for declared plugin repos (req 10)

Implementation: not started.
