---
title: Release from ShipIt — cut a software release for any repo from chat
description: Generalize ShipIt's own release automation into a chat-initiated, agent-driven flow that cuts a versioned release for any open repo and renders the result as an inline release lifecycle card.
---

# Release from ShipIt

## Problem

ShipIt already releases *itself* through a hand-built pipeline that lives only in
this repo: a maintainer manually bumps `package.json`, commits, tags `vX.Y.Z`,
and pushes; `.github/workflows/release.yml` then gates on `check` + `test`,
fast-forwards `stable`, and runs `gh release create --generate-notes` (see
`RELEASING.md`, `.github/workflows/release.yml`, `.github/release.yml`, and
`docs/162-release-channels/plan.md`). That machinery is invisible to a ShipIt
*user* working on *their own* repo. If they want to cut a release of the project
they are building in ShipIt, they have to leave — open a terminal, run
`npm version`, push a tag, then open GitHub's releases page to write notes and
watch CI. Every one of those steps is a tab outside ShipIt, which is exactly the
failure mode the product principles forbid (CLAUDE.md §1–§2).

We want releasing to be a first-class thing you do **inside ShipIt, by talking to
the agent**, for the current repo *and any other repo the user has open* — not a
project-specific maintainer ritual.

## Goals

- A user can say "cut a 0.3.0 release" (or "release a patch", "tag an rc") in
  chat and the **agent** performs the mechanical release steps: determine the
  next version, bump the version source, commit, create an annotated tag, push.
- The published result — chosen version, gate/CI status, the tag, the GitHub
  Release with its grouped notes, and downstream deploy status — renders
  **inline** as a **release lifecycle card**, modeled on the PR lifecycle card
  (`pr-status-poller.ts`, `src/client/stores/pr-store.ts`). No bounce to GitHub's
  releases page on the happy path.
- Works for an arbitrary repo, not just ShipIt: **zero-config** for the common
  case (a Node repo with `package.json` and a tag-triggered release workflow),
  with an optional `release:` block in `shipit.yaml` for everything else and
  graceful, agent-guided setup when detection is ambiguous.
- Agent-agnostic: identical behavior under the Claude and Codex backends.
- Releasing is treated as outward-facing and effectively irreversible — the flow
  is **confirmation-gated** and idempotent.

## Non-goals

- **Not** a generic CI system. ShipIt does not run the user's build/test matrix;
  it triggers the repo's *own* CI (via the pushed tag) or, for the brokered path,
  calls the GitHub Releases API. Gating quality is the repo's CI's job.
- **Not** Android / mobile artifact builds. Those are tracked separately in Linear
  TRACKER-66 and are explicitly out of scope here. The Android wrapper
  (`android/`, `docs/116-android-webview-app/`) has its own manual Gradle build.
- **Not** a package-registry publisher (npm publish, crates.io, Docker push) in v1.
  Those are downstream of "a release exists" and can be added later as repo CI
  steps the tag already triggers.
- **Not** a replacement for ShipIt's own self-update channel model
  (`docs/162-release-channels/plan.md`). Channel promotion for *arbitrary* repos
  is a later phase, not the MVP.
- **Not** changing the `gh` shim's blanket block today (see GitHub Release
  Creation below — we recommend the path that needs no shim change for the MVP).

## Product framing — running the §5 checklist

The dangerous version of this feature is a **"Release" button that shells out**
to `npm run release`. That is precisely the category mistake CLAUDE.md §5 warns
against: a shell-shaped affordance (button/palette/hotkey) that runs a command
the agent could run. We explicitly reject it. Walking the
§"Corollary: how to evaluate proposals" checklist:

1. **Does this require the user to open a tab outside ShipIt to be useful?** No —
   and that is the whole point. Status, gates, the tag, the published Release and
   its notes, and deploy status all render in the release lifecycle card (CLAUDE.md
   §1/§2). A "View release on GitHub" link exists only as an overflow escape hatch.
2. **Does it assume GitHub is open in another window?** No. The card fetches and
   renders the Release state inline, the same way the PR card already does for PR
   status and CI checks.
3. **Is the link-out the primary affordance or an escape hatch?** Escape hatch,
   in an overflow menu, behind the inline card (CLAUDE.md §2).
4. **Does it give the user a shell-shaped affordance to run a command the agent
   could run?** No. This is the crux. The release is **initiated via chat intent**
   ("cut a 0.3.0 release"); the **agent is the actor** (it runs the bump, the
   commit, the tag, the push, exactly as a human would in the terminal — see
   `RELEASING.md`); ShipIt renders the **result inline**. We add **no** "Release"
   button, no command palette entry, no hotkey that runs a release script. This
   maps onto the existing primitive in CLAUDE.md §5's table: *"Recurring
   user-driven task → ask the agent in chat."*

The one affordance we *do* add is a **confirmation control on the card** ("Confirm
& publish 0.3.0" / "Cancel") — and that is not a shell-shaped affordance. It does
not run a shell command; it answers a question the agent asked, the same way the
existing PR card surfaces confirm/decline interactions. The agent proposes the
release plan; the human confirms the outward-facing, irreversible step. That is
the human-act gate, rendered inline, not a task runner.

> **Corollary applied ("saves a round-trip is not a feature"):** we deliberately
> spend an agent turn to do the bump+tag rather than precompute it behind a
> button. That keeps the chat history complete (the release is a visible turn),
> keeps the agent in the loop, and keeps the user's mental model consistent.

## Generic release model

A release of *any* repo decomposes into the same abstract steps. The table maps
each step onto an existing ShipIt primitive so the design is "assemble existing
parts," not "build new machinery."

| # | Abstract step | Who acts | ShipIt primitive |
|---|---|---|---|
| 1 | Determine next version | Agent (proposes), user (confirms) | Chat intent → agent reads version source; card shows proposed version |
| 2 | Bump version source | Agent | File edit (`package.json` / `Cargo.toml` / `VERSION` / none for tag-only) |
| 3 | Commit the bump | Agent / auto-commit | Existing post-turn auto-commit (`ws-handlers/post-turn.ts`) or explicit `git commit` |
| 4 | Create annotated tag | Agent | `git tag -a vX.Y.Z -m …` in the session container (already allowed; the tag is the canonical artifact) |
| 5 | Push commit + tag | Agent | `git push` + `git push origin vX.Y.Z` (push is brokered, token never on disk — `github.md` "Push semantics") |
| 6 | Produce the GitHub Release with notes | Repo CI **or** orchestrator | **Decision below** — tag-triggered workflow (recommended) or orchestrator-brokered API call |
| 7 | Reflect gate/CI + deploy status | Orchestrator (poller) | New release poller, modeled on `pr-status-poller.ts`; deploy via Deployments API (`docs/084`) |

Steps 1–5 are things the agent can already do today inside the session container
— they are ordinary git operations, and `git push` of a tag works through the
brokering credential helper (`github.md` "Push semantics and credentials"). The
only step the agent **cannot** do today is step 6, because the `gh` shim blocks
`gh release` and `gh api` (`src/server/session/agent-shim/gh.ts:55-60`).

## GitHub Release creation — (a) tag-triggered vs (b) orchestrator-brokered

This is the hard architectural decision. The `gh` shim blocks `gh release …`
("releases are deliberate human acts") and `gh api` ("arbitrary GitHub API access
is out of scope") at dispatch time — `src/server/session/agent-shim/gh.ts:55-60`,
`src/server/shipit-docs/github.md:107-110`. The shim does not shell to real `gh`;
it brokers a fixed allow-list of PR operations through `/agent-ops/*` worker
endpoints. So the agent literally cannot create a Release from inside the
container. We evaluated two ways to resolve this.

### Option (a) — Tag-triggered (the repo's own CI creates the Release)

The agent only pushes an annotated tag. The **repo's own** `release.yml`-style
workflow (triggered `on: push: tags: ['v*']`) does the gating and runs
`gh release create` *with GitHub's own Actions token* — exactly how ShipIt
releases itself today (`.github/workflows/release.yml:73-81`).

- **Pro:** Zero change to the `gh` shim; the "releases are deliberate human acts"
  stance is preserved verbatim — ShipIt never creates a Release, the repo's CI
  does, off a human-confirmed tag. Repo-agnostic *in spirit*. The notes come from
  the repo's `.github/release.yml` grouping, which the repo owner controls.
- **Con:** Requires the repo to **have** such a workflow. A fresh repo won't.
  ShipIt cannot see the published Release without polling GitHub, and there is a
  lag between tag push and the workflow finishing. If the workflow is missing or
  misconfigured, the user gets a tag but no Release, and the card has to surface
  "tag pushed, but no release workflow ran — want me to scaffold one?"

### Option (b) — Orchestrator-brokered (the orchestrator creates the Release)

Add a confirmation-gated `createRelease(owner, repo, tag, name, body, prerelease)`
to `GitHubAuthManager`. The orchestrator already holds the user's token and
already creates PRs, issues, and repos via raw REST `fetch`
(`github-auth-prs.ts`, `github-auth-issues.ts`, `github-auth-repos.ts`,
`github-api.ts:15-46`). A Release is `POST /repos/{owner}/{repo}/releases`,
structurally identical to `createPullRequest()`/`createIssue()`. It slots into a
new `github-auth-releases.ts` + a wrapper in `github-auth.ts` (next to
`createIssue()` at line 333) + a service in `services/github.ts` + a route in
`api-routes-github.ts` mirroring `/api/sessions/:id/pr`. Scope: a `403` is the
gate (same pattern as `github-auth-issues.ts:59-67`); creating a Release needs
classic `repo`/`public_repo` or fine-grained `contents:write`.

- **Pro:** Works for **any** repo immediately — no required workflow, no CI lag,
  the Release appears as soon as the agent confirms. ShipIt controls the notes
  (it can pass `generate_release_notes: true` or its own grouped body). One code
  path regardless of the repo's CI maturity.
- **Con:** It re-opens, for the orchestrator, the exact capability the shim
  deliberately denies the agent. We must argue this is *consistent*, not a
  contradiction: the shim blocks the **agent** from unilaterally publishing a
  Release because that is a human act. The brokered path keeps it a human act —
  it is gated on an explicit confirmation rendered in the card, attributed to the
  user, brokered by the orchestrator that already holds the token. The block was
  about *who initiates* and *with what review*, not "Releases must never be
  created via API." (`gh release create` is, after all, what our own CI already
  runs.) Still, it is a genuinely new outward-facing capability and must be
  treated with the same care as PR creation, plus an explicit confirm step.

### Recommendation

**MVP uses (a) tag-triggered; (b) is a later phase, gated behind explicit
confirmation.** Rationale:

- (a) needs **no shim change and no new orchestrator write-capability** — it is
  pure assembly of things that already exist (agent pushes a tag; repo CI does
  the rest), so it is the smallest correct first step and keeps the "deliberate
  human act" stance untouched.
- (a) is the *honest* generalization of what we built for ShipIt itself: our own
  release is tag-triggered. Teaching ShipIt to drive *that* pattern for any repo
  is the truest generalization of TRACKER-63.
- The cost of (a) — "repo has no release workflow" — is turned into a **feature**:
  the card detects the missing workflow and the agent offers to **scaffold** a
  `release.yml` (see Per-repo config below). That scaffolding is itself a chat-
  driven agent action, fully inside ShipIt.
- (b) is the better long-term answer for repos whose owners don't want a workflow
  at all, and for instant feedback. But it is a new write path to GitHub and
  should land *after* the card, polling, and confirmation model are proven on (a).
  We keep its design ready (`createRelease` slots in cleanly) but don't ship it in
  the MVP.

**Rejected alternative:** unblocking `gh release` in the shim so the agent runs it
directly. Rejected because it deletes the human-act gate entirely — the agent
could publish a Release mid-turn with no confirmation — and because the agent
inside the container has no token (`github.md` "Push semantics"), so it would have
to be brokered through `/agent-ops/*` anyway, which is just option (b) with a worse
seam (no orchestrator-side confirmation surface).

## Release lifecycle card

Model the card on the PR lifecycle card. A **`ReleaseStatusPoller`** (new,
mirroring `pr-status-poller.ts`) is constructed once in `buildApp()`, fed the
same `githubAuthManager`, `sessionManager`, `runnerRegistry`, and `sseBroadcast`
closure, and broadcasts a new `release_status` SSE event consumed by a new
`release-store.ts` (mirroring `pr-store.ts`).

### Card state machine

```
proposed  → user said "cut a release"; agent computed next version + notes preview.
            Card shows: version, bump type, version-source file, notes preview,
            [Confirm & publish] [Cancel].   (No tag exists yet.)
tagging   → confirmed; agent is bumping + committing + tagging + pushing.
gating    → tag pushed; repo CI (option a) is running version-guard/check/test,
            OR orchestrator is about to call createRelease (option b).
published → GitHub Release exists. Card shows tag, grouped notes, prerelease flag.
deploying → downstream deploy (Deployments API) in flight for the tagged commit.
released  → Release published AND (deploy succeeded OR no deploy target).
failed    → gate failed / push rejected / workflow missing / API error.
            Card shows the failing job's surfaced log (reuse getJobLogs()).
```

This deliberately parallels the PR card's
`ready | creating | open | merged | closed | error` phases (`pr-store.ts:21-100`)
so the client rendering and the poller's "diff and broadcast on change" loop are
near-identical.

### Data sources & polling

- **Version + notes preview (proposed):** computed by the agent during the turn
  and emitted as part of the turn, then mirrored into the card. The agent reads
  the version source and the merged-PR history (it can already do this).
- **Gate/CI status (gating):** for option (a), reuse `getCheckStatus()`
  (`github-auth-checks.ts:11`) against the tag's commit SHA — the same call the PR
  card uses for checks. For a missing workflow, detect "tag pushed, no workflow
  run associated" and transition to `failed` with a scaffold offer.
- **Published Release (published):** poll `GET /repos/{owner}/{repo}/releases/tags/{tag}`
  (a new read in `github-auth-releases.ts`) until it appears (option a) or read
  the create response directly (option b). Render `name`, `body` (grouped notes),
  `prerelease`, `html_url`.
- **Deploy status (deploying/released):** reuse the Deployments API surface from
  `docs/084-auto-deploy-on-push/plan.md` — the same `deployments?:
  GitHubDeploymentStatus[]` slot reserved in `github-types.ts:308`, keyed on the
  tagged commit instead of the PR head.

**Polling cadence** mirrors `pr-status-poller.ts`: a single supervisor tick
(`PR_STATUS_POLL_INTERVAL_MS = 15_000`), **fast (15s)** while a release is in
`gating`/`deploying`, **slow (120s)** once `released`. The global poll gate
(viewer attached, or 60s detach grace, or autonomous action in flight) is reused
verbatim. Results stream over the existing `/api/events` SSE channel — **no new
WebSocket** — and a snapshot is sent on connect (the `getAllStatuses()` pattern,
`pr-status-poller.ts`).

### What renders inline

Everything the user would otherwise open GitHub for: the chosen version and bump
type, the gate/CI checks (pass/fail/pending counts with per-check breakdown,
reusing the PR card's `checks` shape), the created tag, the published Release with
its **grouped notes** (Features / Fixes / Docs / Deps / Maintenance — the
`.github/release.yml` grouping), the prerelease badge for `-rc.N`, and the deploy
status. The only link-out is an overflow "View release on GitHub" (CLAUDE.md §2).

## Per-repo configuration & detection

To work for "any repo," ShipIt must learn *how* a given repo releases. We add an
optional `release:` block to `shipit.yaml` with strong auto-detection so the
common case is zero-config.

### Auto-detection (zero-config defaults)

Detection runs in the orchestrator (or the agent during the turn) by inspecting
the workspace, **before** falling back to config:

| Signal detected | Inferred release config |
|---|---|
| `package.json` with a `version` field | version source = `package.json`; tag pattern = `v{version}`; bump via semver |
| `Cargo.toml` `[package] version` | version source = `Cargo.toml`; tag = `v{version}` |
| `pyproject.toml` `project.version` | version source = `pyproject.toml`; tag = `v{version}` |
| A top-level `VERSION` file | version source = `VERSION`; tag = `v{version}` |
| None of the above | **tag-only** scheme: next version inferred from latest `v*` git tag; no file bump |
| `.github/workflows/*.yml` with `on: push: tags` | release mechanism = **tag-triggered** (option a) |
| No such workflow | release mechanism = **needs scaffold** (offer to create `release.yml`) |
| `.github/release.yml` present | notes = label-grouped (GitHub `--generate-notes`) |

These mirror exactly the signals the shipit-config parser does **not** read today —
the parser is purely declarative (`shipit-config.ts:315-345` is YAML-only, no
file probing), so version detection is a **new** concern layered above it, not a
change to the existing parser.

### `release:` block in `shipit.yaml`

A new optional top-level key (added to `KNOWN_TOP_LEVEL_KEYS` in
`shipit-config.ts:101`, with a `ReleaseConfig` on the `ShipitConfig` interface at
`shipit-config.ts:62-77`). Everything is optional; provided values override
detection.

```yaml
release:
  version-source: package.json   # package.json | Cargo.toml | pyproject.toml | VERSION | tag
  tag-pattern: "v{version}"      # how the tag name is derived; {version} is required
  prerelease-pattern: "v{version}-rc.{n}"   # rc lane; {n} auto-increments
  notes: github-generated        # github-generated | changelog:CHANGELOG.md | commits
  gate: "npm test"               # optional local gate the agent runs before tagging
  mechanism: tag-triggered       # tag-triggered (a) | brokered (b, later phase)
  workflow: .github/workflows/release.yml   # path checked for existence / scaffolding
```

### Monorepo / ambiguity → agent-guided setup

When detection is ambiguous (multiple `package.json` files, multiple version
sources, or a monorepo with many publishable packages), ShipIt **does not guess**.
The agent surfaces the ambiguity in chat ("I see three packages with versions —
which one are we releasing, or do you want a coordinated release?") and, on
resolution, offers to **write the `release:` block** so the choice is captured for
next time. This is the graceful-degradation path: ambiguity becomes a short chat
clarification plus a persisted config edit, not a silent wrong tag.

### "Repo has no release workflow → scaffold one"

When `mechanism` resolves to tag-triggered but no workflow exists, the card's
`failed`/`proposed` state offers: *"This repo has no release workflow yet — want
me to add one?"* On yes, the agent scaffolds a `release.yml` (a generalized copy
of this repo's `.github/workflows/release.yml`: tag-triggered, gate jobs, `gh
release create --generate-notes`) plus a `.github/release.yml` label grouping,
opens it as a normal PR (the existing auto-PR flow), and the user merges it. The
scaffold templates live next to the existing project templates
(`templates*.ts`). After merge, the next "cut a release" is fully tag-triggered.

## Safety & confirmation

A published tag and Release are outward-facing and effectively irreversible
(deleting a tag/Release is itself a destructive, visible act). The model:

- **Two-step, human-confirmed.** Step 1: the agent proposes (computes the version,
  shows the notes preview) — the card sits in `proposed`. Step 2: nothing is
  pushed until the user clicks **Confirm & publish** on the card (or says "yes,
  ship it" in chat). The agent must **not** push a tag in the same turn it
  proposes one, by default. This is the human-act gate, rendered inline — and it
  is the affordance we justified against §5 above (it answers a question, it does
  not run a shell command).
- **Idempotency.** Before tagging, the agent checks whether the tag already exists
  (locally and on the remote). If `vX.Y.Z` exists, the flow stops and the card
  shows "already released" with a link to the existing Release rather than
  creating a duplicate. Re-running "cut a 0.3.0 release" is a no-op, not a second
  tag. For option (b), `createRelease` first checks `GET …/releases/tags/{tag}`.
- **Prereleases (`-rc.N`).** The same flow with `prerelease: true` and the
  `prerelease-pattern`. `{n}` auto-increments from the highest existing
  `vX.Y.Z-rc.*` tag, so "cut another rc" produces `-rc.2` without manual
  bookkeeping. Prereleases are flagged on the card and (matching `docs/162`) are
  excluded from the stable channel by downstream consumers, not by the release
  flow itself.
- **Confirmation is required even with auto-PR/auto-push on.** Auto-push debounces
  *branch* pushes (`docs/099`); it must never auto-push a **tag**. Tag push is
  always gated on explicit confirmation. This is an explicit carve-out in
  `ws-handlers/post-turn.ts`'s push logic.
- **Attribution.** The Release (option b) and the tag are attributed to the user's
  GitHub identity (the token the orchestrator holds), consistent with PR creation.

## Agent backends

The flow is agent-agnostic — steps 1–5 are plain git, and the confirmation +
card + polling all live orchestrator-side. The only agent-facing additions:

- **System-prompt instruction block.** A new "How to cut a release" section,
  injected in `renderInstructions()` (`agent-instructions.ts`), describing: read
  the version source, compute the next version, **do not push the tag without
  confirmation**, use `git tag -a`, and that the Release itself is produced by CI
  (option a) or the orchestrator (option b) — the agent never runs `gh release`.
  Because the instruction is uniform, it does **not** need per-agent variants; it
  lives in the shared section, unlike `CLAUDE_PARALLEL_SESSIONS_SECTION` /
  `CODEX_PARALLEL_SESSIONS_SECTION` (`agents/claude/system-prompt.ts`,
  `agents/codex/system-prompt.ts`), which differ per backend.
- **A new `/shipit-docs/release.md`** baked into the session image, describing the
  per-repo release mechanics and the `release:` schema (the agent's reference,
  parallel to `github.md`). Referenced from the platform-docs section of the
  instructions.
- **No new agent tool / shim change for the MVP.** Option (a) needs none. If/when
  option (b) ships, the confirmation is an orchestrator route + card control, not
  a new container-side capability — the shim stays as-is.

## Phasing

**Phase 1 — MVP (tag-triggered, Node repo with an existing workflow).**
Chat "cut a release" → agent reads `package.json`, proposes the next version and
a notes preview → card in `proposed` → user confirms → agent bumps, commits,
tags, pushes → `ReleaseStatusPoller` polls check status + the published Release
→ card renders `published`/`released` with grouped notes inline. Scope: option
(a) only; `package.json` detection only; no `release:` block required.

**Phase 2 — Multi-ecosystem detection + `release:` block.**
Add `Cargo.toml` / `pyproject.toml` / `VERSION` / tag-only detection and the
`shipit.yaml` `release:` schema + parser support. Add the agent-guided
ambiguity/monorepo clarification.

**Phase 3 — Scaffold a release workflow.**
"Repo has no release workflow → offer to scaffold one" — generalized
`release.yml` + `.github/release.yml` templates, opened as a PR via the existing
auto-PR flow.

**Phase 4 — Orchestrator-brokered release (option b).**
`createRelease()` in `github-auth-releases.ts` + service + route, confirmation-
gated, for repos that don't want a workflow or want instant Release creation.

**Phase 5 — Channel promotion for arbitrary repos.**
Generalize the stable/edge fast-forward-pointer model (`docs/162`) so a repo can
define promotion channels — well beyond the MVP, only if demand appears.

## Open questions & risks

- **Brokered-vs-tag consistency.** Does shipping option (b) later contradict the
  "releases are deliberate human acts" stance? We argue no (confirmation-gated,
  user-attributed), but this needs an explicit product sign-off before Phase 4.
- **Token scope friction.** A fine-grained token without `contents:write` will
  `403` on option (b). We detect and surface "reconnect with release scope"
  (the `scopeError` pattern), but it is an extra hop for some users.
- **Tag-pushed-but-no-Release lag (option a).** Between tag push and the workflow
  publishing, the card sits in `gating`. We must not show `failed` prematurely;
  needs a grace window before concluding "no workflow ran."
- **Detached/odd version schemes.** Date-based versions, monorepo independent
  versioning, and non-`v` tag prefixes won't auto-detect cleanly — these fall to
  the `release:` block + agent clarification, but coverage is necessarily partial
  in early phases (and we must `log`/surface what we couldn't detect rather than
  silently picking a wrong scheme).
- **Idempotency races.** Two viewers/sessions confirming the same release
  concurrently — the existing-tag check is the guard, but the poller must
  deduplicate cards per `{repo, tag}`.
- **Where does detection run?** Orchestrator-side (needs workspace file access)
  vs. agent-during-turn (already has it). Leaning agent-during-turn for the
  proposal, orchestrator-side for the card's ongoing polling — to be settled in
  Phase 1.

## Key files (existing — to read before implementing)

- `RELEASING.md`, `scripts/release.ts`, `.github/workflows/release.yml`,
  `.github/release.yml` — the ShipIt-only precedent being generalized.
- `docs/162-release-channels/plan.md` — stable/edge channels, Software Updates
  panel, `release-channel.ts`, `build-id.ts` version resolution.
- `src/server/session/agent-shim/gh.ts:55-60`, `src/server/shipit-docs/github.md:102-118`
  — the `gh release` / `gh api` block and its rationale (the hard constraint).
- `src/server/orchestrator/pr-status-poller.ts`, `src/client/stores/pr-store.ts`,
  `docs/064-pr-lifecycle-flow/plan.md` — the inline-card + poller pattern to model on.
- `src/server/orchestrator/github-auth.ts` (and `-prs.ts`, `-repos.ts`,
  `-checks.ts`, `-issues.ts`), `src/server/orchestrator/services/github.ts`,
  `src/server/orchestrator/api-routes-github.ts`, `github-api.ts` — where a
  brokered `createRelease` slots in (next to `createIssue()`).
- `docs/084-auto-deploy-on-push/plan.md`, `github-types.ts:308` — Deployments API
  surface reused for the card's deploy status.
- `src/server/shared/shipit-config.ts:62-77,101` — where the `release:` block and
  `ReleaseConfig` type are added.
- `src/server/orchestrator/agent-instructions.ts`,
  `agents/claude/system-prompt.ts`, `agents/codex/system-prompt.ts` — where the
  "how to cut a release" instruction block is injected (shared, not per-agent).
- `src/server/orchestrator/templates*.ts` — where the scaffolded `release.yml`
  templates live.
