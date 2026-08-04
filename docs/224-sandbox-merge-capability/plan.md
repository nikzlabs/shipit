---
issue: https://github.com/nikzlabs/shipit/issues/1640
title: Gated `gh pr merge` for sandbox sessions
description: Add a brokered `gh pr merge` to the gh shim, unlocked per-sandbox by a "dangerous GitHub operations" sub-grant under GitHub access.
---

# Gated `gh pr merge` (sandbox dangerous-ops grant)

## Why

The `gh` shim brokers a narrow allowlist of pull-request operations but deliberately
omits `merge`. In a **sandbox** session — the "you own git / bring your own repos"
mode — that leaves a dead-end: the agent can take a PR all the way to "CI green" but
can't land it. The only workaround was an `@dependabot squash and merge` comment, which
doesn't generalize to ordinary PRs.

Merge is intentionally classified with `gh release` and CI manipulation as a
**deliberate, outward-facing, effectively-irreversible act**, and it is the verb most
exposed to prompt-injection (untrusted PR content talking the agent into shipping code).
So it must not simply join the open allowlist — it is **gated** and **off by default**.

## Design

A new per-sandbox capability sub-grant, **`dangerousGitHubOps`** (UI: "Allow merging
PRs"), nested under GitHub access. Like the other capabilities it is set
server-authoritatively at sandbox creation and never inferred from workspace files, so an
agent cannot self-elevate.

- **Sandbox-only.** `gh pr merge` is refused in repo-bound / ops sessions — those merge
  from the PR lifecycle card in the ShipIt UI (ShipIt owns their PR lifecycle). The
  shim returns a 403 that points back to the card.
- **Opt-in.** Even in a sandbox the grant defaults off; the user turns on "Allow merging
  PRs" under GitHub access in the sandbox creation dialog. Without it, a 403 explains it
  isn't enabled. Turning GitHub access off clears the sub-grant.

### Guardrails (enforced when the grant is on)

The agent calls `gh pr merge` **mid-turn**, so the PR-status poller's cached check/review
state is unavailable (sandbox PRs aren't tracked by the poller anyway). The guardrails are
therefore enforced inline against the GitHub API in `agentMergePullRequest`:

- **Required checks must be green.** A failing check refuses; a still-running check refuses
  unless `--auto` is passed (which enables GitHub auto-merge / merge-when-green).
- **Branch protection / required reviews** are enforced by GitHub server-side; its
  rejection message is surfaced verbatim — never forced.
- **No admin/force path.** `--admin` is rejected by the shim before it reaches the broker.
- A **draft** PR is refused (mark it ready first).

This keeps the "merge is deliberate" principle while removing the dead-end.

## Flow

```
gh pr merge [<n>] [--squash|--rebase] [--auto]   (agent's bash tool, sandbox)
  → shim handlePrMerge (gh.ts): parse method/auto, reject --admin, resolve PR number
  → POST /agent-ops/pr/:number/merge (agent-ops-routes.ts, worker injects SESSION_ID)
  → POST /api/sessions/:id/pr/:number/merge (api-routes-github.ts)
       · gate: mergeDisposition(session) → 403 not-sandbox / 403 not-granted / allowed
       · resolvePrTarget (repo-aware cwd/--repo) → gitDir + remoteUrl
       · agentMergePullRequest(...) guardrails → githubAuthManager.mergePullRequest
```

The route deliberately does **not** apply the UI merge route's "block while the agent is
running" guard: the agent's own runner is always running mid-turn.

## Key files

- `src/server/shared/types/domain-types/session.ts` — `SessionCapabilities.dangerousGitHubOps`
  (+ default + `normalizeCapabilities`).
- `src/server/orchestrator/pr-target.ts` — `mergeDisposition(session)`: `allowed` /
  `not-sandbox` / `not-granted`.
- `src/server/orchestrator/services/github.ts` — `agentMergePullRequest()`: the guardrails.
- `src/server/orchestrator/api-routes-github.ts` — `POST /api/sessions/:id/pr/:number/merge`
  (containerAccessible), the gate + repo-aware target.
- `src/server/session/agent-ops-routes.ts` — `POST /agent-ops/pr/:number/merge` relay.
- `src/server/session/agent-shim/gh.ts` — `handlePrMerge` + `PR_HANDLERS.merge` + HELP.
- `src/client/components/SandboxDialog.tsx` — nested "Allow merging PRs" `SubToggleRow`.
- `src/server/orchestrator/api-routes-session-crud.ts` — sandbox-create body type.
- `src/server/shipit-docs/github.md` — agent-facing docs (`gh pr merge`, "Merging PRs").

## Tests

- `agent-shim/gh.test.ts` — merge dispatch, method/auto forwarding, `--admin` reject,
  multi-method reject, guardrail-refusal (200 success:false) → non-zero exit, 403 surfacing,
  current-branch fallback carrying cwd/repo.
- `services/github-agent-merge.test.ts` — each guardrail branch (green/none/failure/pending,
  `--auto`, draft, already-merged, GitHub rejection verbatim, 401).
- `pr-target.test.ts` — `mergeDisposition` for repo-bound / ops / granted / not-granted.
- `integration_tests/agent-driven-pr.test.ts` — route gate (403s) + happy-path merge + draft
  refusal end to end.
- `services/sandbox-session.test.ts` — the grant survives the create/normalize round-trip.
