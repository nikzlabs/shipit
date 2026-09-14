# Antigravity CLI harness — integration checklist

Copied from
[docs/266-harness-integration-recipe/integration-checklist.md](../266-harness-integration-recipe/integration-checklist.md);
the expansion of every line, with file pointers and gotchas, is in
[that recipe's plan.md](../266-harness-integration-recipe/plan.md). What is
Antigravity-specific is in [plan.md](./plan.md).

**Phase 0 — assess (before any code)**
- [x] Candidate passes the capability checklist items 1–5, 7–10 and 12
      (stream schema: documented and captured; auth: account token file +
      `GEMINI_API_KEY`; reasoning levels: `--effort low|medium|high`); the
      install mechanism (a non-npm branch of the same script) is the user's
      decision of 2026-09-13
- [x] Item 11 settled by a REAL probe: redirected to a local recorder
      (`probes/recorder.js`), `GOOGLE_GEMINI_BASE_URL` sends
      `<base>/v1beta/models/<id>:streamGenerateContent?alt=sse` with the key
      on `x-goog-api-key` (`probes/endpoint-redirect.ndjson`)
- [x] Item 6, runtime half: CLOSED, two ways. A read-only install makes the
      updater skip itself (probed, with a writable control), and
      `AGY_CLI_DISABLE_AUTO_UPDATE=true` stops it even for root — measured on a
      writable install, so mode bits cannot be doing the work. `=1` fails
      silently. This corrects candidates.md's "no off-switch" record
- [x] `supportsCompaction` (item 14) settled by a REAL probe on BOTH the first
      round's 1.2.2 and the pinned 1.1.27: `/compact` as a resumed headless
      turn's prompt reaches the model as text, no summary step — `false`,
      probed (`probes/compact-b.ndjson`, `probes/compact-1127.ndjson`)
- [x] `supportsReview` (item 15) settled `true` by the REAL depth-0 probe on
      1.1.27, once the key became billable (2026-09-14): the verbatim
      `composeReviewMessage` run inside a ShipIt session container, the CLI
      running `shipit agent run --role reviewer` itself, reading the markdown off
      stdout and applying the fixes (`probes/review.ndjson`, 419 s, exit 0). The
      duration half is measured separately — a 250 s `run_command` is
      backgrounded and polled, never killed (`probes/longcmd.ndjson`)
- [x] Every capability `false` (item 13) says WHY beside it (`harnesses.ts`)

**1 — Types**
- [x] `AgentId` widened; `LoginIntegrationId` gains `google-antigravity-oauth`;
      `QuotaIntegrationId` gains `google-antigravity-usage` (declared with no
      reader, so the account shows no meters); `ANTIGRAVITY_PERMISSION_MODES`
      has the full-auto member only (req 8)
- [x] ESLint leak-guard regex widened + the two folder exemptions added

**2 — Catalogue**
- [x] `HarnessDef` row (`styles: ["gemini-generate-content"]`); the `google`
      `ServiceDef` gained a `sub` mode for the account; the docs/302
      "vendor no harness speaks yet" guard is now join assertions
- [x] `GEMINI_API_KEY` declared in the `dev` compose service's
      `x-shipit-secrets` block (docs/302; `agent: true` since PR #2752)
- [x] `ANTIGRAVITY_TOOL_NAMES` (57 names, from `probes/flash-test.ndjson`)

**3 — Install & images**
- [x] `install-agent-clis.sh`: known set, `harness_pkg_prefix` sentinel arm,
      binary, tarball fetch + checksum + `chmod -R a-w` into
      `/opt/antigravity`, prune arm, `installed.json`
- [x] Version pin 1.1.27 (published 2026-09-05), hand-verified against the
      release list as the newest ≥ 7 days old
- [x] `SHIPIT_HARNESSES` defaults unchanged (installable-but-unchecked,
      docs/271); `HARNESS_ROWS` in both `deployment/*/setup.sh`
- [x] Dogfood opt-in: `antigravity` added to the hard-coded `SHIPIT_HARNESSES`
      build arg in BOTH dogfood blocks of `docker-compose.yml`
- [x] Credential symlink `/credentials/.gemini` in the 4 Dockerfiles + the
      `entrypoint.sh` gosu `mkdir -p` block and its read-only-home symlink
      block (which was also missing `.grok`)

**4 — Tables**
- [x] Every required `Record<AgentId, …>` table
- [x] `buildLocalAgentFactory` switch
- [x] The `buildAgentRuntime` maps (auth manager, run-params prep, parallel
      sessions) + the local `PARALLEL_SESSIONS_SECTIONS` map; the auth manager
      is covered by `catalogue.test.ts`'s "every declared login backed by a
      real auth manager" guard

**5 — Silent sites**
- [x] Validators, `?? "claude"` defaults, registry probes, MCP tool subset,
      shim help text, UI name tables, egress allowlist
- [x] Revocation: `SUBTREE_STATE_SUBPATHS` entry for `.gemini` listing the
      state subpaths *under* `antigravity-cli/`, and the removal now walks a
      preserved PATH rather than a bare name
- [x] Nested token path: `tokenFileNamesForSubtree` returns root-relative
      remainders, so `.gemini/antigravity-cli/antigravity-oauth-token` is
      visible to orphan discovery and leak repair
- [x] `settings.json` (`modelProvider`) derived by the adapter at every spawn
      from the home's own token presence
- [x] The updater cannot replace the pinned binary in ANY spawn path:
      `ANTIGRAVITY_SPAWN_ENV` carries `AGY_CLI_DISABLE_AUTO_UPDATE=true` into
      the turn adapter, the sign-in manager and the session namer. The earlier
      claim that the orchestrator images do not install the CLI was wrong —
      `Dockerfile.prod`, `.dev` and `.dogfood` all run `install-agent-clis`

**6 — Session adapter**
- [x] `session/agents/antigravity/` (adapter + tool normalizer + tests) and
      `shared/antigravity-{home,stream}.ts`; registered in `createWorkerAgent`
- [x] Token accounting: the turn's step usages summed (a resumed run's
      `result.usage` is cumulative), context = last step's `input + cache_read`
      (cache reads sit outside `input`); the vendored captures are the fixtures

**7 — Orchestrator folder**
- [x] `orchestrator/agents/antigravity/` (auth manager with `submitCode`,
      run-params prep, system prompt; no limits provider — no usage reader
      exists) + one entry per runtime map
- [x] The *existing* backends' prompts, shipit-docs and the voice vocabulary
      updated to name the fifth CLI

**8 — Client**
- [x] Theme CSS ×2 + `index.css` + `useTheme`
- [x] Auth card: `ServicesPanel.tsx` paste-shape gate is now a set of
      paste-shaped providers; `ProviderAccountRows` label table

**9 — Tests**
- [x] The build-breaking parity tests extended (installer↔catalogue, registry
      list, reviewer ordering, headless validator message)
- [x] Token freshness reader against a committed fixture — see the caveat in
      `token-freshness-guard.test.ts`'s header: the KEY SET is a real
      observation, the file was not re-captured
- [x] Stream conformance replayed from the vendored `probes/*.ndjson`, and an
      adapter test whose guards were each proved red by mutation

**10 — Verify empirically**
- [x] KEY mode verified on 2026-09-14 against the now-billable
      `GEMINI_API_KEY`: real Pro turns through ShipIt's own adapter in the
      dogfood, and `shipit agent run --role reviewer` driven BY the harness
      (`probes/review.ndjson`). This is what found the `--add-dir` defect below
- [x] ACCOUNT mode verified on 2026-09-14 after a real Google sign-in. Getting
      there needed a fix of its own: the CLI starts an interactive login only
      when stdin is a character device and ShipIt spawned it on a pipe, so no
      sign-in could complete (`probes/signin-stdin-shape.md`). With the pty in
      place the sign-in completed, and a turn on `route=account:<id>` read the
      repository and answered — no key, credentials scrubbed. It found three
      more defects, all fixed: the token file's real shape, the absent identity,
      and the egress host (all below)
- [ ] Event-conversion verification: the docs/272 recipe, run and recorded at
      `docs/272-harness-conversion-verification/runs/2026-09-14-1050-antigravity-1.1.27.md`
      — **PARTIAL**. Steps 1, 2, 3 and 5 in full; three defects found and fixed.
      Three gaps left: the subagent surface has no observed driver (the model
      answers the tour's step 7 with a shell command), Step 4's UI-snapshot and
      reload half was not taken, and no run exercised ACCOUNT mode
- [x] The failure **after partial output** fixture captured
      (`probes/partial-fail.ndjson`): exit 1, `result.status: "ERROR"`, empty
      stderr, after a complete `agent_response` step
- [x] The freshness fixture is now a REAL capture, and it corrected the reader:
      a sign-in writes `{auth_method, token:{…}}`, so the credential fields sit
      one level down. Read at the top level, freshness was `null` for every real
      token — `token-freshness=unorderable outcome=stranded-rotation`, so a
      refreshed token was never published back. The reconstructed fixture was
      flat and carried an `id_token`, which is why the pre-existing guard
      (`token-freshness-guard.test.ts`, planning#449) could not fail
- [x] Account identity is honestly ABSENT: a `consumer` sign-in's token has no
      `id_token` at all — only an opaque `access_token`, a `refresh_token`,
      `token_type` and `expiry` — so no email or external id can be shown. The
      reader still handles a nested `id_token` for a method not yet seen

## Still open

- **Concurrent spawns share one durable directory.** Two Antigravity runs
  against the same session's credential subtree — a key-mode and an account-mode
  consult, or local mode — can change each other's credentials and
  `settings.json` mid-run, so one can end up billed to the other's route. The
  per-spawn HOME isolates `config/` and deliberately not the durable directory,
  which is where the token and conversations live; the cause is ShipIt's
  cross-harness BORROW path, which provisions one subtree per session without
  serializing the runs. PR #2772 fixed the cleanup half — the ledger now tracks
  the spawns holding a subtree, so an earlier release no longer wipes a consult
  still running — and the OVERWRITE half is untouched: a second borrow still
  replaces the first's credentials while it runs. The settings write is atomic,
  which stops a torn read and fixes nothing else. This is not Antigravity-specific.
- ~~**The account-mode host is inferred, not observed.**~~ **Measured 2026-09-14
  and it WAS wrong.** A real account turn sent every `loadCodeAssist` and
  `streamGenerateContent` to `daily-cloudcode-pa.googleapis.com`; the bare
  `cloudcode-pa.googleapis.com` the binary's compiled hosts named appeared
  nowhere. Allowlist entries are exact unless they start with a dot, so the bare
  entry did not cover it and account mode would have been blocked wherever
  egress is enforced. Both are now listed.
