---
issue: https://linear.app/shipit-ai/issue/SHI-279
title: Keep ShipIt's generated state out of the user's repository
description: ShipIt writes its own runtime artifacts into each session's git clone, where the post-turn auto-commit stages them into the user's repo.
---

# Requirements — ShipIt's generated state stays out of the session clone

## Context

Every session's clone is mounted at `/workspace`, and ShipIt writes its own
generated artifacts into `<clone>/.shipit/`. Verified in a live session
container: `.shipit/.install-done` and `.shipit/compose.override.yml` sit at the
repo root. They are invisible in the ShipIt repo only because ShipIt's own
`.gitignore` happens to contain `.shipit`; in a repo without that line, the
post-turn `git add -A` (`GitManager.autoCommit`) stages them.

This is the same class as the `.shipit-worker-uid` leak (PR #1904) — ShipIt
runtime state living where a `git add -A` can see it — but a different vector,
and unlike that one it affects **every** repo edited inside ShipIt, not just
this one.

Nothing in a clone's `.shipit/` is user-authored: the per-repo config a human
writes is `shipit.yaml` at the repo root, and the system prompt
(`.shipit/system-prompt.md`) is a *global* setting stored at the orchestrator's
workspace root, one level above every clone — not in a repo.

## Requirements

1. Nothing ShipIt generates for its own operation is written inside a session's
   git clone. A user who never asks for it never finds a ShipIt file in their
   working tree, their `git status`, or their commit history.

2. This holds for a repo that has no ShipIt-specific `.gitignore` entry, and
   without ShipIt editing the user's `.gitignore` (or any other tracked file) to
   make it hold.

3. It covers every artifact ShipIt currently writes there:
   - `.shipit/compose.override.yml` — the generated compose merge file
   - `.shipit/.install-done` — the install-skip marker
   - `.shipit/ci-logs/` — fetched CI failure logs
   - `.shipit/.env.agent` — the agent container's env file, **plaintext secrets**

4. Secrets ShipIt manages are never written inside the clone, so they can never
   be staged for commit, and are never the reason a user's turn fails to commit.

5. Existing behavior is preserved exactly: services start the same way, the
   install-skip decision produces the same outcomes (including the overlay
   pre-stamp and the invalidate-on-HEAD-change path), and CI-fix still reads its
   logs.

6. Sessions that already have these files in their clone stop having them —
   an upgraded ShipIt cleans up what earlier versions left behind, rather than
   only changing where new files go.

7. A future artifact written into a session clone by mistake is caught
   mechanically, not by review. (`.shipit/` inside a clone becomes a bug with no
   carve-outs, which is what makes this checkable.)

## Open questions

- **Req 6 — how far should cleanup go?** ShipIt can remove these files from a
  session's working tree on the next boot, but it cannot un-commit them from
  repos where they were already committed and pushed. Options: (a) sweep the
  working tree only, and say nothing about already-committed copies;
  (b) sweep, and have the agent surface a one-time note in affected sessions so
  the user can decide whether to remove them from history themselves.
  Recommendation: (a) — (b) spends a turn on something the user may not care
  about, and the files are inert once ShipIt stops writing them.

- **Req 4 — is `.env.agent` in scope for this change or its own?** It carries
  secrets and is read on the container-create path, so moving it touches session
  startup rather than just service startup. It can ship here, or as a follow-up
  once the cheaper three have landed. Recommendation: ship it here — it is the
  requirement with actual security weight, and splitting it leaves the stated
  guarantee (req 4) unmet in the interim.

## Resolved questions

- **2026-08-03 — Scope: which artifacts must leave the clone?** Asked whether to
  move only the compose override, the override plus the install marker, or
  everything ShipIt generates. Answer: **everything ShipIt generates**. Recorded
  as req 3.
