# Release from ShipIt — checklist

This tracks the implementation work the design implies.

**Phase 1 (MVP) is implemented** — see the key files added below. Phases 2–5
remain.

## Phase 1 — MVP (tag-triggered, Node repo with existing workflow)

- [ ] Product sign-off on the §5 stance (chat-initiated, agent-actor, inline card,
      confirmation control is not a shell-shaped affordance). *(Process item — the
      implementation follows the stance; explicit sign-off is still pending.)*
- [x] `ReleaseStatusPoller` (new) modeled on `pr-status-poller.ts`: supervisor
      tick, fast/slow cadence, global poll gate reuse, `release_status` SSE event.
      → `src/server/orchestrator/release-status-poller.ts`, constructed in
      `buildApp()` and snapshotted on `/api/events`.
- [x] `release-store.ts` (new) on the client, modeled on `pr-store.ts`; card state
      machine `proposed | tagging | gating | published | deploying | released | failed`.
      → `src/client/stores/release-store.ts`, wired to the `release_status` SSE
      event in `useServerEvents.ts`.
- [x] Release lifecycle card UI: version, bump type, gate/CI checks, tag, grouped
      notes, prerelease badge, deploy status, overflow "View on GitHub".
      → `src/client/components/ReleaseLifecycleCard.tsx` (Phosphor icons +
      `ICON_SIZE` tokens), rendered in `App.tsx` next to the PR card.
- [x] Confirmation control on the card (`Confirm & publish` / `Cancel`) + chat
      "yes ship it" path; wire to the same answer-question surface as PR confirms.
      → card buttons send a chat message via `sendUserMessage` (App.tsx
      `handleReleaseConfirm`/`handleReleaseCancel`) — answers the agent's
      proposal, not a shell command (CLAUDE.md §5).
- [x] Agent instruction block "How to cut a release" in `agent-instructions.ts`
      (shared section): read version source, compute next version, **never push a
      tag without confirmation**, use `git tag -a`, never run `gh release`.
- [x] Carve-out in `ws-handlers/post-turn.ts`: auto-push must never push a **tag**;
      tag push is always confirmation-gated (auto-push is branch-only via
      `GitManager.push(remote, branch)`; documented carve-out at the
      `scheduleAutoPush` call).
- [x] `package.json` version-source detection + next-version (semver) computation.
      → `src/server/orchestrator/release-version.ts`.
- [x] Idempotency: existing-tag check (local + remote) before tagging (agent-side,
      per `/shipit-docs/release.md`); "already released" card state; poller dedup
      per `{repo, tag}` (`releasedByKey`).
- [x] Reuse `getCheckStatus()` against the tag commit SHA for gate status.
- [x] Read the published Release via tag (`GET …/releases/tags/{tag}`) and render
      grouped notes inline. → read-only `getReleaseByTag` in new
      `github-auth-releases.ts` (NO write-side `createRelease` — that's Phase 4).
- [x] `/shipit-docs/release.md` baked into the session image; referenced from the
      platform-docs section of the instructions.
- [x] Tests: poller unit tests (cadence, dedup, state transitions), card store
      tests, integration test for the confirm → tag → publish flow with a fake
      GitHub auth manager. → `release-status-poller.test.ts`,
      `release-markers.test.ts`, `release-version.test.ts`,
      `release-store.test.ts`, `integration_tests/release-flow.test.ts`.

### How the agent ↔ orchestrator seam works (Phase 1)

The MVP needs **no** new agent tool or `gh` shim change (docs/171 "Agent
backends"). The agent emits a small HTML-comment **release marker** in its turn
text (`<!--shipit:release {…}-->`); the shared turn executor's post-turn step
(`postTurnReleaseFlow`, fired every turn — a proposal turn makes no commit)
parses it (`release-markers.ts`) and drives the poller via
`services/release-flow.ts`. Confirmation is a normal chat reply from the card.

## Phase 2 — Multi-ecosystem detection + `release:` block

- [x] Detection for `Cargo.toml`, `pyproject.toml`, `VERSION`, tag-only schemes.
      → `readCargoTomlVersion`, `readPyprojectVersion`, `readVersionFile`,
      `detectAllVersionSources` in `release-version.ts`.
- [x] `ReleaseConfig` type on `ShipitConfig` + `release` added to
      `KNOWN_TOP_LEVEL_KEYS`; parser + validation in `shipit-config.ts`.
      → `ReleaseConfig`, `ReleaseVersionSource`, `ReleaseMechanism`,
      `parseReleaseConfig` in `shipit-config.ts`.
- [ ] `prerelease-pattern` / `-rc.N` auto-increment from highest existing rc tag.
- [x] Agent-guided clarification for monorepo / ambiguous version sources; offer
      to persist the resolved choice into `shipit.yaml`.
      → `agent-instructions.ts` + `shipit-docs/release.md` updated.
- [x] Surface ("log"/card) what could not be auto-detected — never silently pick a
      wrong scheme. → agent instructions now require surfacing ambiguity vs. guessing.
- [ ] Update `shipit-yaml.md` with the `release:` schema.

## Phase 3 — Scaffold a release workflow

- [ ] Generalized `release.yml` + `.github/release.yml` scaffold templates in
      `templates*.ts`.
- [ ] "Repo has no release workflow → offer to scaffold" card/chat flow; open the
      scaffold as a PR via the existing auto-PR flow.
- [ ] Grace window before concluding "tag pushed but no workflow ran" (avoid
      premature `failed`).

## Phase 4 — Orchestrator-brokered release (option b)

- [ ] Product sign-off that a confirmation-gated brokered Release is consistent
      with the `gh release` block.
- [ ] `github-auth-releases.ts` (new) — `createRelease()` + `getReleaseByTag()`
      via raw REST, modeled on `github-auth-prs.ts` / `-issues.ts`.
- [ ] Wrapper on `GitHubAuthManager` (next to `createIssue()`), service in
      `services/github.ts`, route in `api-routes-github.ts` mirroring
      `/api/sessions/:id/pr`.
- [ ] `403` → `scopeError` handling ("reconnect with release/contents scope").
- [ ] `mechanism: brokered` honored from `release:` config.

## Phase 5 — Channel promotion for arbitrary repos (only if demand)

- [ ] Generalize the stable/edge fast-forward-pointer model (`docs/162`) so a repo
      can define promotion channels.

## Deferred / out of scope

- [ ] Android / mobile artifacts (Linear SHI-66).
- [ ] Package-registry publishing (npm publish, crates.io, Docker push) — left to
      repo CI the tag already triggers.
