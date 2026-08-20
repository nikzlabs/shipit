# Grok Build harness — integration checklist

Copied from
[docs/266-harness-integration-recipe/integration-checklist.md](../266-harness-integration-recipe/integration-checklist.md);
the expansion of every line, with file pointers and gotchas, is in
[that recipe's plan.md](../266-harness-integration-recipe/plan.md).

**Phase 0 — assess (before any code)**
- [x] Candidate passes the 13-point capability checklist; start-blockers
      cleared or explicitly signed off (stream schema: captured both
      formats; auth: key-only launch signed off, subscription deferred to
      planning#435; pinnable install: npm `@xai-official/grok@1.0.1`;
      reasoning levels: none in key mode — reviewer-default no-levels
      extension approved 2026-08-18)

**1 — Types**
- [x] Widen `AgentId` (no `LoginIntegrationId`/`QuotaIntegrationId` — key-only
      at launch, req 6; `GROK_PERMISSION_MODES` added beside
      `CLAUDE_PERMISSION_MODES`)
- [x] Widen the ESLint leak-guard regex + add the two folder exemptions
      (same commit)

**2 — Catalogue**
- [x] `HarnessDef` row (+ the xAI `ServiceDef`; no new `ApiStyle` — both of
      Grok's are already declared)
- [x] New-vendor `storageEnv` declared in the `dev` compose service's
      `x-shipit-secrets` block (guard-tested; never in `onboarding`) —
      for Grok: `XAI_API_KEY` on the xAI `ServiceDef`
- [x] `GROK_TOOL_NAMES`
- [x] Composer / Cursor on the xAI subscription — probed 2026-08-20, **not
      served.** Binary 1.0.1 contains `composer-2.5-fast` (one hit, Cursor-compat
      harness default) plus `composerId`/`composerHeaders` (Cursor session SQL).
      Live `grok models` + `GET cli-chat-proxy.grok.com/v1/models` return only
      `grok-4.6` and `grok-4.5`. The string is inert from ShipIt's perspective
      today; do not re-run. Receipt in plan.md.

**3 — Install & images**
- [x] `install-agent-clis.sh`: known set, pkg prefix, binary. (The original
      `npm rebuild @xai-official/grok` line assumed the OpenCode shape; it is
      not — the postinstall installs outside node_modules. Replaced by an
      in-place build-time decompress + direct binary link, planning#442.)
- [x] Pinned dep in `docker/agent-cli/package.json` + lockfile
      (`@xai-official/grok@1.0.1`)
- [x] `SHIPIT_HARNESSES` defaults unchanged — Grok ships
      installable-but-unchecked (req 4, docs/271). `deployment/vps/setup.sh`
      gains the picker row without joining `HARNESS_DEFAULT`.
- [x] Dogfood opt-in: `SHIPIT_HARNESSES` build arg added to BOTH dogfood
      build blocks in `docker-compose.yml` (dev + onboarding) — required
      precisely because Grok is not in the default set
- [x] Credential symlinks in the 3 Dockerfiles (`/credentials/.grok`)

**4 — Tables**
- [x] Every required `Record<AgentId, …>` table (the compiler listed them:
      credential paths, credential vars, tool maps, auth error, limit
      labels, provider labels ×2, legacy paths/markers, reviewer default,
      client harness names)
- [x] `buildLocalAgentFactory` switch
- [x] The four `buildAgentRuntime` Maps + the local
      `PARALLEL_SESSIONS_SECTIONS` map (NOT compiler-forced) — Grok gets
      `runParamsPreps` and `parallelSessionsSections`; no auth manager and no
      limits provider (req 6)

**5 — Silent sites**
- [x] Worked end to end: the persisted-route and DB-row validators, the
      provider-account HTTP gate, both query-param validators, the two
      client localStorage validators, `AUTH_ENV_KEYS`, the shim help text,
      `SUB_AGENT_DISPLAY_NAMES`, the `RoleEditor` cast, and the egress
      allowlists (`api.x.ai` — exact host, in all three lists)
- [x] Audited and deliberately unchanged: the `?? "claude"` defaults (Grok is
      not the default harness), Claude-only `--resume` recovery,
      `token-sync-manager` stale-resume (OAuth backends only),
      `ensureCodexHomeInitialized` (Grok creates its own root), and
      `LOCAL_WORKSPACE_TRUST` / `POST_PROVISION_CONFIG` — **probed live: a
      headless run on a never-seen repo needs no trust grant**

**6 — Session adapter**
- [x] `session/agents/grok/` — `adapter.ts`, `stream.ts`, `config-toml.ts`,
      `tool-map.ts` + tests; registered in the barrel, `AGENT_TOOL_MAPS` and
      `createWorkerAgent` (factory test extended in the same commit)
- [x] No token-usage normalizer — the CLI's figures are disjoint (verified
      arithmetically on a real terminal event)

**7 — Orchestrator folder**
- [x] `orchestrator/agents/grok/` (run-params prep + system prompt; no auth
      manager, no limits provider) + one entry per runtime map
- [x] Updated the *existing* backends' prompts, shipit-docs
      (`agent.md`, `environment.md`, `skills.md`) and the voice dictation
      vocabulary

**8 — Client**
- [x] Theme CSS ×2 (`grok.css`, `grok-light.css`) + `index.css` ×4 edits +
      `useTheme`
- [x] `ProviderAccountRows` label table, `ServiceLogo` xAI mark, misc UI
      tables. No `ServicesPanel` sign-in card — Grok has no login flow at
      launch (req 6), so the API-key row is the whole surface.

**9 — Tests**
- [x] Extended the build-breaking parity tests (installer↔catalogue,
      registry counts ×3, reviewer-default guard, headless valid-agents
      message, plugin-skill roots, egress endpoints, theme count / palette /
      contrast); added `adapter.test.ts` and `config-toml.test.ts`

**10 — Verify empirically**
- [x] Skills-disclosure probe (docs/209): `.grok/skills/` AND `.claude/skills/`
      both disclosed, no symlink needed
- [x] Stream-capture conformance test: the two real tool-tour captures are
      vendored under `__fixtures__/` and replayed byte-for-byte, including a
      truncated-stream synthesized-result case
- [x] Live probes that changed the design: `--prompt-file`, `-s`/`-r`
      session-id pre-assignment, `$GROK_HOME/config.toml` as the only MCP
      path, `GROK_HOME`'s real layout, the `--output-format json` envelope,
      workspace trust
- [x] One dogfood turn per auth mode (billing route!) — **key mode only is
      in scope; the subscription turn is planning#435**. Done 2026-08-18 in
      two phases (first attempt blocked on egress; operator granted
      `api.x.ai` mid-run): full tour turn completed on grok-4.6 via the
      `xai:key` route (inner session `6305255a…`, 29s, side effects on
      disk, $0.1247 metered), and the **billing route is proven** by a
      canary + control pair — an invalid *stored* credential fails the turn
      with the CLI's auth error while the valid ambient env key sits unused,
      and restoring the stored value makes the same spawn succeed. Evidence:
      [docs/272 run 2026-08-18-1240](../272-harness-conversion-verification/runs/2026-08-18-1240-grok-1.0.1.md).
- [x] `shipit agent run` both directions — **DONE 2026-08-19 13:09Z, verdict
      GREEN**, on a session-worker image rebuilt with the planning#444 fix.
      Evidence:
      [docs/272 run 2026-08-19-1309](../272-harness-conversion-verification/runs/2026-08-19-1309-grok-1.0.1-agent-run.md).
      All in **real session containers** (a dogfood run cannot settle this —
      `Dockerfile.dev` creates no `.grok` symlink, so the bug cannot exist
      there). INBOUND `shipit agent run --role Grok` → `eb61663c…`,
      `status: success`, 13.3s, $0.0619, coherent output. OUTBOUND from a
      grok-pinned child session (`c57755ea…`, orchestrator-resolved
      `agent: grok` / `grok-4.6`) → `shipit agent run --role Fable`
      `47b49de6…`, exit 0. The optional role-less explicit target
      (`--agent grok --service xai --billing-mode key --model grok-4.6`, no
      `--effort`, docs/275's acceptance case) → `96b99b49…`, success, and
      carries no `roleName`. Exactly three spawns, one turn, no retry.
      The planning#444 fix confirmed by three checks: a grok-pinned session
      completes its first turn (and a second) where the pre-fix symptom was
      `error` / `error_during_execution` / `duration_ms 0`; `command -v grok`
      answers `/usr/local/bin/grok` in both containers (the `.bin` launcher
      shim no longer exists, so `PATH` order stopped mattering); and three
      per-turn `GROK_HOME` roots across two containers all show no `bin/`
      payload at 1MB — measured both in-band by the CLI and out-of-band by a
      5Hz watcher whose 69 samples are uniformly `bin=no`. The **root** cause
      is fixed rather than survived: both spawn homes link
      `sessions -> /home/shipit/.grok/sessions`, which is `makeSpawnHome`'s
      success path, not its degraded self-contained fallback, and
      `/credentials/.grok` now exists. No new defect found; planning#442 was
      not re-tested. planning#438 is still open but did not bite — with grok
      starting successfully there was no startup-dead turn to be silent about.
      Still out of scope: the subscription-mode turn (planning#435).

      <details><summary>History — why this took three attempts</summary>

      The structural blockers cleared 2026-08-18 ~16:00Z (outer redeployed with grok in the
      installed set; role `Grok` exists) and target resolution proves out end
      to end in BOTH directions — the inbound one-shot resolves role `Grok` →
      xai:key grok-4.6 and an outbound grok-pinned child session
      (`556b60ca…`, via `shipit session create --role Grok`) resolved
      identically. **planning#442 is verified fixed** (rerun 2026-08-19:
      `grok --version` → 1.0.1, the real binary spawns and executes a full
      turn) — do not re-test it. The consult then died one step later, for
      **two** causes found together and filed as planning#444:
      (a) `~/.grok` is a dangling symlink in every session container (nothing
      creates `/credentials/.grok` in key mode), `makeSpawnHome`'s opening
      `mkdirSync` throws ENOENT through it, and the catch fell back to handing
      the CLI that same dangling path as `GROK_HOME` — so it died at its own
      session creation, `duration_ms: 0`, before any event; and (b) `grok`
      spawned by NAME resolved to the npm **launcher** rather than the real
      binary, because every image puts `node_modules/.bin` ahead of
      `/usr/local/bin` — so fixing (a) alone would have bought a ~157MB
      bootstrap into the throwaway `GROK_HOME` per turn rather than a working
      one. A three-case controlled test with `GROK_HOME` as the only variable
      succeeds ($0.0435, exit 0) and pins (a); `command -v grok` answering the
      `.bin` path in a live container pins (b). The green dogfood runs are
      explained by `Dockerfile.dev` creating no `.grok` symlink at all — so a
      dogfood run can neither reproduce this nor demonstrate the fix.
      **The failure was never consult-specific**: `makeSpawnHome` sits on the
      single spawn path for every grok turn, and an ordinary grok-pinned
      session reproduces it (probe session `3c992d1a…`, first turn `error`,
      subtype `error_during_execution`), so grok was non-functional in every
      real session container. OUTBOUND and the optional role-less explicit
      target were not reached — the per-turn spawn cap (3, shared with
      `shipit session create`) was consumed by the inbound attempts.
      planning#438's silence reproduced and materially raised the cost of
      diagnosis; planning#443 (marker reader drops grok) was found in the
      previous run. Prior attempts:
      [docs/272 run 2026-08-19-1048](../272-harness-conversion-verification/runs/2026-08-19-1048-grok-1.0.1-agent-run.md),
      [2026-08-18-1600](../272-harness-conversion-verification/runs/2026-08-18-1600-grok-1.0.1-agent-run.md).
      Separately, the *design*-level blocker this item also carried — an
      explicit grok target being unassemblable, since the five-flag rule
      demanded a level grok declares none of — was removed by
      docs/275-roleless-explicit-run (planning#441), which makes the four
      identity flags a complete grok target.

      </details>
- [x] Event-conversion verification: the full docs/272 recipe run
      (tool-tour capture ✅, inventory diff, recognition matrix on persisted
      history + UI) —
      `docs/272-harness-conversion-verification/verification-checklist.md`.
      Ran 2026-08-18, **verdict RED, recorded**: the Step-2 inventory diff
      found no recognition registry claims any grok tool name — the adapter
      ships no transcript-vocabulary normalizer (planning#432 pattern) —
      and the Step-4 live tour confirmed it in persisted history AND the
      rendered DOM on the rehydration path (no task panel, no diff blocks,
      no subagent card; raw-name chips). Filed as **planning#437**; the
      matrix rows go green when it lands, with this run as the baseline to
      diff against. Also **planning#438** (a startup-dead grok turn
      persists no error row), observed live. Evidence:
      [docs/272 run 2026-08-18-1240](../272-harness-conversion-verification/runs/2026-08-18-1240-grok-1.0.1.md).
      **Rerun 2026-08-18 16:16Z after the planning#437 normalizer landed:
      verdict GREEN** — every failed row passes in the rendered DOM (task
      panel with `merge:true` patches applied, diff blocks with `+N -M`,
      SubagentCall card with an unwrapped report, one-word icon labels).
      Evidence:
      [docs/272 run 2026-08-18-1616](../272-harness-conversion-verification/runs/2026-08-18-1616-grok-1.0.1.md).

**11 — Subscription mode (planning#435)**
- [x] Device-code login verified live (2026-08-19): `grok login --device-auth`
      completes and writes a scope-keyed `~/.grok/auth.json` (0600). Required an
      egress grant first — the container reaches `auth.x.ai` for the flow AND
      for the ~6h token refresh.
- [x] The open reasoning question settled: subscription mode **does** honour
      `--reasoning-effort`, wire-verified with a negative control. Receipt and
      evidence in requirements.md; req 14 supersedes req 8's key-mode finding.
- [x] Egress: `auth.x.ai` + `cli-chat-proxy.grok.com` in all three lists, exact
      hosts. `accounts.x.ai` deliberately excluded (the user's browser loads it,
      not the container).
- [x] Reasoning-resolution mechanism: `ModelDef.reasoningEfforts` +
      `reasoningOptionsFor()` / `selectionHonoursEffort()`, with the
      `[] ≠ absent` distinction and a build-breaking invariant that a row may
      only narrow its harness's vocabulary. `reviewer-model.test.ts`'s guard
      rewritten to ask the resolver rather than the harness list — it had been
      passing only because grok's vocabulary was empty too.
- [x] Latent eligibility hole closed pre-emptively: `carriers` now restricts
      **account** credentials too, in both join sites. Without it, giving grok
      an `account` target offers it a ChatGPT subscription (a guaranteed 401,
      the docs/268 class).
- [x] **The `xai-oauth` auth manager** — the device flow driven from inside
      ShipIt (req 11), on the Codex device-auth precedent, landed together with
      everything downstream of it: the xAI `sub` mode, the `LoginIntegrationId`
      member, grok's `account` credential target, and grok's reasoning
      vocabulary + the harness×mode axis. Two live differences from the Codex
      flow, each a silent failure if copied: the challenge prints on **stderr**,
      and the user code is **four-and-four**, not four-and-five.
- [x] Token landing for the ~6h rotating token (req 13) — grok declares its
      token file and a freshness reader, so it joins the existing per-turn
      sync-in / mid-turn watch / publish-back path rather than getting a new
      mechanism. **The freshness reader is the load-bearing part**: `expires_at`
      is an ISO-8601 *string*, and a reader that returns null does not fail safe
      — the sync guard then copies the source over a session's freshly-refreshed
      token. Covered by unit tests against the real file shape; not exercised by
      the dogfood run, which is local mode and keeps no per-session copy.
- [x] Account identity on the row (req 15) — `user_id` as the stable external
      id, `email` as the label, read from the scope-keyed file. **No plan**: xAI
      reports none anywhere, and `tier: 1` in the token is an opaque integer, so
      req 15 was reworded rather than half-met (receipt in requirements.md).
- [x] Quota (req 16) — **reversed and rebuilt.** It first took the documented
      no-reader route (`quota: null`, a new arm of `BillingModeDef`) on a probe
      that had missed a query parameter. `GET /v1/billing?format=credits`
      returns the weekly pool, so `xai:sub` now declares `xai-plan-usage` with
      `XaiLimitsProvider` behind it, refreshable on demand; the `null` arm is
      removed with the claim that motivated it. See plan.md, "Quota: the empty
      pill, and the reader that turned out to exist".
- [x] The pill draws only the windows a reading carries (`windowsShown`) — not
      a fixed 5h/7d pair. SuperGrok has one weekly pool and no short window, and
      Codex and GLM plans exist that report no 5-hour figure either. Derived
      from the reading, so no service is named: a `null` window inside a
      snapshot means "this plan has no such window", while NO snapshot still
      draws both as unread.
- [x] Exhaustion-pattern channel finding (planning#453) — which matcher
      applies to a turn error vs. conversation text is answered from the code
      and recorded in plan.md ("Exhaustion is the only spent-plan signal"). Patterns were **not**
      widened: no SuperGrok headless capture exists. Test scaffolding in
      `agent-rate-limits.test.ts` (`GROK_SUBSCRIPTION_EXHAUSTION_CAPTURE`)
      makes a future capture a one-assignment change.
- [x] ServicesPanel device-code sign-in UX (req 11) — verified live: *Add a
      service → xAI* offers **Subscription · API key**, and choosing Subscription
      renders the challenge with URL, code and both models. The surface was
      already generic; what was missing was the catalogue declaring the mode.
- [x] Wire the UI consumers of `reasoningOptionsFor` — the composer picker
      (via `useBoundModelSelection`, derived from the same session and seed the
      model picker beside it reads), the reviewer level menu, and the role
      editor's menu and its harness/model moves. This was flagged as
      staged-but-unconsumed, and it stopped being theoretical the moment grok's
      vocabulary became non-empty: all four would have offered four dead levels
      on a key-billed grok selection.
- [x] One subscription-mode dogfood turn with the billing route verified
      through the scrub/shaping path — the Phase 10 item key mode cannot cover.
      Done 2026-08-19, on a session-worker image carrying the planning#444 fix
      (the blocker this item used to name — see the Phase 10 item): one turn on
      `xai/sub` `grok-4.6`, attributed to `xai:sub` with `includedTurns: 1` and
      `meteredCostUsd: 0`; the adapter logged `subscription login on disk — env
      credentials scrubbed` with `XAI_API_KEY` present in the environment; and
      the CLI's own session store records `reasoning_effort: "xhigh"` for the
      turn.
- [ ] **Open, and deliberately not built here**: whether grok needs an
      orchestrator-owned proactive refresher (the docs/153 / docs/154 shape).
      The token lives six hours, so whether the CLI's refresh ROTATES the
      refresh token — the property that makes an N-session stampede destructive
      — cannot be observed without waiting for an expiry. `grok models` is the
      obvious tier-1 probe, mirroring `codex login status`.
- [ ] **Open, waiting on a live capture** (planning#453): the verbatim
      SuperGrok *subscription* exhaustion string on the headless `-p` wire,
      and which channel it arrives on. Fill
      `GROK_SUBSCRIPTION_EXHAUSTION_CAPTURE` in `agent-rate-limits.test.ts`
      and widen the matcher against that exact text. Do not paste TUI copy
      from `strings` on the grok binary. How to obtain the string (wait for
      a natural hit vs. deliberately exhaust the plan) is a human decision.
