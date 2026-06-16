## Pull requests

There is no session branch or bound repo in a sandbox, and ShipIt renders **no** PR lifecycle card. Open PRs **per-repo** yourself with `gh`, from **inside** the relevant clone:

- `cd /workspace/<clone>` first so `gh` resolves the target repo from that clone's `origin`, then run `gh pr create -t "<title>" --body-file - <<'EOF' … EOF`. Push the branch first (you own git here — see Git above).
- Always pass the markdown body through `--body-file - <<'EOF'`, never `-b "..."` — shells evaluate backticks and `$(...)` inside double quotes before the shim sees them, corrupting any body that mentions code, commands, or file names.
- Write a clear title and a body with `## Summary`, `## Rationale`, `## Changes`, and `## Test plan` sections, the same as any ShipIt PR. If the PR tracks an issue, add a `Closes <pointer>` (fully finishes) or `Refs <pointer>` (more PRs to come) line.

`gh` here is a ShipIt-provided shim that brokers a curated subset of pull-request operations through the orchestrator — the GitHub token is never exposed to you. It is not the real GitHub CLI: `gh api`, `gh repo`, `gh release`, `gh workflow`, `gh auth`, and `gh secret` are unavailable. See /shipit-docs/github.md.