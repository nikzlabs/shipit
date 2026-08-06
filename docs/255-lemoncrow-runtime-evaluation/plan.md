---
issue: roadmap#SHI-330
title: LemonCrow runtime integration evaluation
description: What LemonCrow is, the three shapes it could take inside a ShipIt session, and the ShipIt invariants each one breaks.
---

# LemonCrow runtime integration evaluation

Evaluates [`requirements.md`](./requirements.md). **Recommendation: do not integrate
the tool-replacement mode. Spike option A (MCP-only, opt-in) behind a measurement
gate, and reject if it does not clear it.**

## What LemonCrow is

[lemoncrow-lab/lemoncrow](https://github.com/lemoncrow-lab/lemoncrow) — Python
3.12–3.13, installed via `uv`, "faster runtime for coding agents". Created
2026-05-01; ~51 stars at time of writing.

It is a **local context-engineering layer that sits beneath a coding-agent CLI**.
Its core is "LemonGraph", a tree-sitter symbol index over the repository (the
README claims 28k+ symbols/repo). On top of that index it publishes five tools
and, on Claude Code, **hides the equivalent built-ins**:

| LemonCrow tool | Replaces | Claim |
|---|---|---|
| `code_search` | Grep / Glob | ranked symbol retrieval instead of text match |
| `read` | Read | outline or exact line range instead of the whole file |
| `edit` | Edit | verified cross-file edit in one call |
| `bash` | Bash | caps and structures noisy output |
| `web_fetch` | WebFetch | HTML stripped to Markdown |

Distribution is `curl … install.sh | bash` from GitHub releases into
`~/.local/bin`, with state in `~/.lemoncrow` (SQLite by default, Postgres
optional). `lc init` runs **per repository** and writes workspace-local config:
`.lemoncrow/settings.json`, `.claude/settings.local.json`, `.claude/agents/`,
`.claude/skills/`. `lc mcp serve` exposes the same five tools over MCP to any
client. Anonymous telemetry is **on by default** (`DO_NOT_TRACK=1`,
`LEMONCROW_TELEMETRY=off`, or `lc telemetry remote off` to disable). The
developer install additionally registers a background service controller under
systemd/launchd.

Two flags on the project itself, independent of the technical fit:

- **License is ambiguous.** The README says Apache-2.0; GitHub's own metadata
  resolves the repo license to `NOASSERTION`, the repo carries a CLA, and the
  README says a separate `lemoncrow.pro` engine is planned. That is an open-core
  shape, and the open half's license needs to be pinned down before ShipIt bakes
  it into an image it ships.
- **It is three months old.** Nothing disqualifying, but it argues for the
  opt-in shape over the baked-in one.

## What it collides with in ShipIt

These are verified against this repo, not inferred from the docs.

**1. Hiding `Bash` disarms the branch-block guard.** `docker/agent-hooks/block-branch-ops.mjs:70`
is `if (payload?.tool_name !== "Bash") process.exit(0);` — a `PreToolUse` hook
matched on the literal `Bash` tool name (`docker/agent-hooks/managed-settings.json`).
Route shell through `mcp__lemoncrow__bash` and the hook never fires: the guard
that keeps the agent from `git checkout -b`, `git reset --hard`, and stranding
work off the session branch (docs/130, docs/239) silently becomes a no-op. This
is the single hardest blocker, and it is a security regression, not a UX one.

**2. Hiding the file tools breaks the transcript UI.** `src/client/components/message-tools.tsx`
keys rendering on literal tool names — `tool.name === "Edit"` (:80) and `"Write"`
(:98) drive the inline diff card, `"Bash"` (:229, :578) drives the command card,
and `Read`/`Grep` have named icons and labels (:325–326). MCP-named replacements
fall through to the generic tool card: no inline diff, no command output card. §2
of the product principles is that ShipIt renders things inline; this trades that
away for token savings.

**3. `lc init` writes into the git clone, which ShipIt commits.** ShipIt's
post-turn commit stages everything (`git add -A`). Keeping ShipIt's own state out
of the clone for exactly this reason is a standing invariant —
`src/server/session/session-dir-factory.ts:34` ("so the post-turn `git add -A` can
never stage them into the user's clone", docs/246-shipit-state-out-of-clone).
`.lemoncrow/` and a rewritten `.claude/settings.local.json` would land in the
user's repository and their PR. Solvable (relocate the state, ignore the paths),
but it has to be solved deliberately.

**4. Settings precedence is unverified.** ShipIt always passes
`--settings /etc/shipit/managed-settings.json` (`src/server/session/agents/claude/process.ts:377`,
:642) and an explicit `--allowedTools` list naming every built-in (`AUTO_TOOLS`,
:316/:613). Whether a workspace `.claude/settings.local.json` written by `lc init`
merges with, overrides, or is overridden by those is a CLI behaviour nobody here
has tested. Any plan that depends on ShipIt's settings winning must verify it at
the source first, not inherit it.

**5. The index has nowhere durable to live.** Containers are destroyed on idle
and `/workspace` is re-cloned; `~/.lemoncrow` under `HOME=/home/shipit` does not
survive. Re-indexing 28k symbols on every container start is a cold-start tax on
every session. The mounts that do survive are `/persist`
(`container-lifecycle.ts:301`) and the shared `/dep-cache` (:355) — an index cache
would need one of them, keyed per repo+commit.

**6. The background service controller does not apply.** systemd/launchd startup
is meaningless here; anything long-running has to be a declared Compose service
or an `agent.install` step, never a runtime-started daemon.

**Not a problem:** the runtime is already present — `uv` is baked into the
session-worker image, as are `python3`/`python3-venv` and a C toolchain. Egress
also already permits the install: `.github.com`, `.githubusercontent.com`,
`.pypi.org`, and `.pythonhosted.org` are on `EGRESS_DEFAULT_ALLOWLIST`
(`src/server/orchestrator/egress-allowlist.ts`). Telemetry, conversely, fails
closed by default — `lemoncrow.com` is not allowlisted — which is the behaviour
we want, but it should be turned off explicitly rather than relied on to be
firewalled.

## Integration options

### A. User-configurable MCP server (opt-in, additive) — recommended spike

Register LemonCrow through the MCP-server surface ShipIt already has
(`src/server/orchestrator/services/mcp.ts`; stdio configs already carry
`npmPackage` and `setup` fields, and `withUserMcp` appends `mcp__<name>__*` to
`--allowedTools`). The agent gains `code_search`/`read` as *extra* tools; nothing
is hidden.

- Collisions 1 and 2 do not arise — built-ins keep working, hooks keep firing, diffs keep rendering.
- Collision 3 is contained: only `lc mcp serve` runs, not the `lc init` config wizard, so run it with its state pointed at `/persist`.
- Effort: small. Mostly a settings-docs and index-cache question.
- Ceiling: also small. Additive tools capture the retrieval win and none of the output-compaction win, so the headline numbers do not transfer.

### B. Baked into the session-worker image, tool replacement on

Install a pinned, checksummed release in `docker/Dockerfile.session-worker.*`
under the existing CLI version strategy (docs/141: lockfile-pinned,
integrity-verified, Renovate cooldown), and let it hide the built-ins.

- Requires re-implementing the branch-block guard against LemonCrow's `bash` tool, and re-pointing the transcript renderer at the new tool names — i.e. ShipIt takes on maintenance of a coupling to a third-party tool surface with no compatibility contract.
- Requires resolving the license question first, since the image is shipped.
- Effort: large, and the ongoing cost is the part that matters.

### C. Index-only, no agent-facing tools

Run `lc init` as a cache-warming step and expose nothing to the agent; use the
graph for ShipIt's own features (symbol search in the file tree, richer PR review
context).

- Avoids every collision above, because the agent surface is untouched.
- Also forgoes the entire stated benefit. Only worth it if the *graph*, not the
  token savings, is what we want — and then it is a build-vs-buy question about
  tree-sitter indexing, not about LemonCrow.

## Recommendation

Option A, gated on a measurement, and only after the license question is
answered. The gate should be falsifiable before any product work:

> On a fixed set of ~10 representative ShipIt turns replayed with and without the
> LemonCrow MCP server enabled, total input tokens per turn must drop by ≥15% with
> no regression in turn success. If it does not clear that, reject and close.

Option B should not be attempted at all unless option A clears the gate *and*
someone is willing to own collisions 1 and 2 permanently. The token savings buy
nothing if the mechanism that keeps the agent on its own branch stops running.

## Key files (ShipIt side)

- `docker/agent-hooks/block-branch-ops.mjs`, `docker/agent-hooks/managed-settings.json` — the `Bash`-keyed guard and the managed settings passed via `--settings`.
- `src/server/session/agents/claude/process.ts` — `AUTO_TOOLS`, `withUserMcp`, `--settings`.
- `src/server/orchestrator/services/mcp.ts`, `src/server/session/mcp-config-controller.ts` — the existing user-MCP surface (option A's seam).
- `src/client/components/message-tools.tsx` — tool-name-keyed transcript rendering.
- `src/server/orchestrator/egress-allowlist.ts` — default allowlist (install path open, telemetry closed).
- `src/server/orchestrator/container-lifecycle.ts` — `/persist` and `/dep-cache` mounts (index cache).
