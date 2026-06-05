---
title: Repo trust gate — defer repo-controlled code until first-clone consent
description: A per-remote trust-on-first-use boundary so that cloning a repository never auto-runs its agent.install or compose command:/build: until the user explicitly trusts it once.
---

# Repo trust gate

## Why this is its own doc

`docs/172-agent-containment` is a broad threat-model + audit. It records this problem as
**Gap 3** and names the fix in one paragraph, then says "individual mitigations should be
triaged into the tracker as separate work items." This doc is that work item: the focused
design for the trust boundary. 172 stays the reference for *why* containment matters; this
is the *how* for one mitigation.

## The problem: opening a repo == running its code

Cloning a fresh repo today runs attacker-controlled shell **before the user has vetted
anything** — no prompt, no consent. There are two automatic execution paths, and this is
the part worth getting right:

1. **`agent.install`** — `readAgentConfig()` at session creation
   (`session-container.ts`, per 172's audit) → `runInstall()` fired immediately
   (`service-manager-setup.ts`) → executed in-container via `POST /install`
   (`session-worker.ts`). This runs arbitrary shell from the cloned `shipit.yaml`.
2. **Compose services** — `x-shipit-preview: auto` services start automatically; their
   `command:` / `build:` are attacker-controlled shell too (`compose-generator.ts`,
   `service-manager.ts`).

A search for a trust prompt finds none — "trust" appears only in code comments. This is
exactly the "pre-trust code execution" vulnerability Anthropic's *How we contain Claude*
calls out (project settings/hooks executed before any trust prompt). The accepted fix in
that class of tool — VS Code **Workspace Trust**, git's **`safe.directory`** — is to
defer all repo-controlled config execution until an explicit, one-time acceptance.

### Why "enable previews first" is the wrong scope

The natural first framing is "make the user enable previews before they run." That closes
path 2 but leaves path 1 wide open: `agent.install` still runs on clone, so a malicious
repo still gets shell. The trust boundary has to sit **above both paths**, not inside the
preview subsystem. The unit of trust is the **repo (remote)**, and the thing being gated
is "any repo-declared command that ShipIt would auto-execute." Previews are one consumer
of that gate, not the gate itself.

## Proposed design: per-remote trust-on-first-use (TOFU)

A repo is in one of two states:

| State | Clone & browse files | Render diffs | Agent chat | `agent.install` | Auto previews |
|------|:--:|:--:|:--:|:--:|:--:|
| **Untrusted** (default on first clone) | ✅ | ✅ | see open question | ⛔ deferred | ⛔ deferred |
| **Trusted** (after one-click accept) | ✅ | ✅ | ✅ | ✅ | ✅ |

Key properties:

- **Trust is per remote, cached, one-time.** Keyed by the normalized remote URL
  (`parseGitHubRemote()` / the same normalization `RepoStore` uses). Accepting once trusts
  that remote for all future sessions cloned from it — no approval fatigue. This is the
  TOFU model: the *first* clone of a given remote prompts; subsequent ones inherit the
  decision.
- **ShipIt-created repos are trusted by construction.** A repo scaffolded from a ShipIt
  template (`templates*.ts`) has no attacker-authored config, so it is marked trusted at
  creation and never prompts.
- **Untrusted ≠ broken.** The clone still happens, the file tree renders, diffs render,
  history is browsable. Nothing that *executes repo-authored commands* runs. This mirrors
  VS Code Restricted Mode: you can read everything; you just can't run the project's code
  until you trust it.
- **Deferred, not dropped.** On acceptance, the previously-skipped `agent.install` runs and
  auto-preview services start — the normal session-startup path, just unblocked. The user
  gets the full experience the instant they consent.

### UI (inline, per `CLAUDE.md` §1–§2)

The consent surfaces **inside ShipIt** as an inline card/banner on first open of an
untrusted remote — not a modal that bounces to a settings page, not a link-out. Copy is
the standard download-from-the-internet warning: "This repository can run setup commands
and services on your machine. Run them?" with **Trust this repository** / **Keep
restricted**. This is a one-time security *consent*, not a shell-shaped action button
(§5) — the agent still operates the box; the user is granting the box permission to run
foreign code once. The decision persists, so it does not recur per session.

## Open questions / decisions to make

1. **Does the agent process itself run while untrusted?** **Decided: yes (option a).**
   The agent chats normally while a repo is untrusted; only auto-execution
   (`agent.install` + compose) is gated. Rationale: cloning a repo is already an intent
   signal — the user looked at it and wants to edit/ship it, so a "you must trust before
   you can even chat" gate adds friction without matching the user's mental model. What
   *does* exceed expectation is the box silently running the repo's setup scripts, so that
   is the line the gate draws. The residual risk (a poisoned `CLAUDE.md`/README
   prompt-injecting the agent on the first message — Gap 1/2) is owned by the
   injection-hardening + egress work in `docs/176` and 172, not by this gate; the two
   compose rather than substitute. The rejected stronger tier (run the agent restricted,
   or not at all, until trust) is recorded under Rejected alternatives.
2. **Sessions with no remote** (purely local, no `remoteUrl`). No remote to key trust on.
   Likely trusted by construction (the user authored it locally) — confirm against the
   `disk-janitor` "skip sessions without a remoteUrl" precedent.
3. **Where the decision lives.** A trusted-remotes set on `RepoStore` (it already persists
   per-remote metadata) vs. a dedicated store. Lean `RepoStore`.
4. **Re-prompt triggers.** Does changing a repo's remote, or a force-push that rewrites
   `shipit.yaml`, invalidate trust? TOFU normally trusts the remote identity, not the
   content; note this as a known limitation rather than chasing content hashing in v1.

## Relationship to adjacent work

- **`docs/172-agent-containment` Gap 3** — parent threat model; this doc is its mitigation.
  Gaps 1/2 (credential exfil via injection) and Gap 4 (read-only mounts) are complementary,
  not substitutes: the trust gate stops *auto* execution; egress/credential isolation stops
  *exfiltration* once code does run. Defense in depth — neither alone is sufficient.
- **`docs/176-issue-content-injection-hardening`** — same "untrusted content reaches the
  agent" family; the trust gate covers the repo-clone vector, 176 covers the issue-text
  vector.
- **Resource caps (`MAX_SESSION_MEMORY_MB` et al.)** — explicitly *out of scope*. Those are
  a noisy-neighbor / fair-share control that only matters in a multi-tenant deployment,
  which ShipIt does not have yet (today: local or a single-owner VPS). They are unrelated
  to the trust boundary and can keep their current single-tenant-friendly defaults until a
  hosted offering exists. This doc is about *whether foreign code runs at all*, not *how
  much RAM it may use*.

## Key files (touchpoints, per 172's audit — verify line numbers before editing)

- `src/server/orchestrator/session-container.ts` — `readAgentConfig()` at session creation.
- `src/server/orchestrator/service-manager-setup.ts` — `runInstall()` trigger (gate here).
- `src/server/session/session-worker.ts` — `POST /install` in-container execution.
- `src/server/orchestrator/compose-generator.ts`, `service-manager.ts` — compose
  `command:`/`build:` startup (gate auto-preview here).
- `src/server/orchestrator/repo-store.ts` — likely home for the trusted-remotes set.
- `src/server/orchestrator/git-utils.ts` — `parseGitHubRemote()` for the trust key.
- `src/server/orchestrator/templates*.ts` — mark template-created repos trusted by construction.
- Client: an inline trust card in the session/preview view + a WS/HTTP accept action.

## Rejected alternatives

- **Gate only previews.** Leaves `agent.install` as an open RCE on clone. Rejected — see
  "Why 'enable previews first' is the wrong scope."
- **A single global "allow untrusted repos" toggle.** All-or-nothing; one careless flip
  re-opens the hole for every future clone. Per-remote TOFU is the standard for a reason.
- **Per-session prompt (not per-remote).** Re-prompts every session for a repo you already
  trust — approval fatigue, which trains users to click through. Cache per remote.
- **Lock the agent down until trust (option b above).** Blocking chat on an untrusted repo
  fights the user's intent: they already chose to clone it to work on it, so "you can't
  even talk to the agent yet" is friction without a matching expectation. The thing that
  genuinely surprises a user is foreign *setup code* running on their box — that's what the
  gate stops. Rejected in favor of option (a).
- **Content hashing of `shipit.yaml` to auto-revoke on change.** More than v1 needs; TOFU
  trusts the remote identity. Note as a future hardening, not a blocker.
