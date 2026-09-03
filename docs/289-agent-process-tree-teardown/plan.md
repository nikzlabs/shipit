---
issue: planning#509
title: Agent process-tree teardown
description: Killing an agent CLI takes its whole descendant tree with it, so an MCP-spawned browser cannot outlive the turn.
---

# Agent process-tree teardown

Implements [requirements.md](./requirements.md).

## The defect

Every ShipIt-initiated kill of an agent CLI signalled `proc.pid` and nothing else. An agent CLI is the root of a tree — MCP servers below it, and below those whatever *they* spawn — so a CLI that exits without tearing its own children down leaves them running, reparented to the container's pid 1, until the container dies.

Observed on the production host on 2026-09-03. Session `8165d8e0` (Codex) opened one Playwright MCP browser at 16:46:22 UTC and drove it over an animated 3D model page in the preview. The turn ended ~17:00; the adapter SIGTERMed the app-server and the MCP server died with it. The Chromium tree survived ~19 more minutes with its renderer burning about half a core (software rendering of the animation), doing nothing for anybody.

The trigger is inside the CLI's own MCP teardown: in that same container, at the same uid, on the same page, none of SIGTERM / SIGKILL / stdin-close on the MCP server, a group SIGTERM, or a direct SIGTERM to Chromium could reproduce it — each removed the whole browser tree within 10s. So this doc does not fix the cause. It makes the outcome ShipIt's guarantee instead of the CLI's (req 2).

## Mechanism: a `/proc` walk, not a process-group kill

The obvious mechanism — spawn the CLI `detached` (i.e. `setsid`) and signal the group with `process.kill(-pid, sig)` — is simpler and does not work here. `playwright-core`'s `launchProcess` spawns **every** browser with `detached: process.platform !== "win32"`, on purpose, so that it can kill the browser's group itself. A Chromium started by `@playwright/mcp` is therefore a session leader in a group of its own, unreachable from the CLI's group. It is the exact process that leaked.

A parent-chain walk does reach it, because at the instant we signal, the browser is still a descendant of the MCP server, which is still a descendant of the CLI. Hence the ordering rule the helper is built around: **snapshot the descendants BEFORE the first signal.** Once the CLI dies its grandchildren are orphaned onto pid 1 and no walk can find them again.

`killProcessTree(child, signal, { label, graceMs })` in `src/server/shared/kill-child.ts`:

1. snapshot descendants of `child.pid` by scanning `/proc` for `ppid` chains;
2. signal the root through `killChild` — so the caller's existing semantics are untouched;
3. signal each snapshotted descendant with the same signal;
4. after `graceMs` (5s), SIGKILL whatever from the roster — the root included — is still alive. The timer is `unref`'d so a pending sweep never holds the worker's event loop open.

The sweep re-walks from **every roster member still alive**, not from the root. The root is usually the first to go, so a root-only re-walk finds nothing exactly when it matters: a survivor below it — an MCP server that ignored the SIGTERM — is free to spawn during the grace, and that late child is in no snapshot and reachable from no dead root. It is the original leak one level down, and an independent review reproduced it against the first version of this helper. Each re-walk root is identity-checked first, because the pids a walk *discovers* carry the walk's own identity: a bad root would launder a stranger's children into the roster where the per-pid check can no longer catch them.

Zombies are skipped throughout: a zombie holds no CPU, cannot be signalled, and (its children having been reparented the moment it exited) hides nothing below it.

### Not signalling a bystander

Moving a signal off the `ChildProcess` object and onto a raw `process.kill(pid)` sharpens the hazard `killChild` exists to prevent — no fake intercepts it, no libuv bookkeeping bounds it. Two guards:

- **the tree is walked only when `/proc` says the root's parent is us.** A pid that is not our own child is not a tree we may tear down; a fabricated pid (adapter tests carry `4242`, `12345`) is exactly that, and gets its signal through `killChild` alone. The sweep's re-walk re-checks the same thing, so a root pid recycled during the grace cannot make us enumerate a stranger's children;
- **every delayed signal re-checks `starttime`** (field 22 of `/proc/<pid>/stat`), so a pid reaped and recycled during the grace is skipped rather than shot.

**The residual window, stated exactly.** The check reads `/proc/<pid>/stat` and then calls `kill(2)`; those are two syscalls, not one, so a target that exits, is reaped, and has its pid handed to a new process *between them* would still receive the signal. Closing that completely needs a handle-based API — `pidfd_open` + `pidfd_send_signal` — which Node exposes no binding for, so the guarantee here is a narrowing rather than an elimination: the dangerous interval drops from the 5-second grace (where recycling is entirely plausible) to the microseconds between two adjacent syscalls, during which the kernel would have to allocate its way around the whole pid space (`pid_max`, 32768 or 4194304) to land on that one number. Worth knowing before anyone reads req 5 as absolute; not worth native code today.

### What did NOT change

SIGINT-first paths (`ClaudeProcess.interrupt`, the OpenCode and Grok interrupts) still send a plain `killChild(proc, "SIGINT")` to the CLI alone, so it can flush a turn its descendants may still be feeding. They reach the tree teardown through their own existing escalation to `kill()` (req 3). `shared/sub-agent-run.ts` is untouched — it calls `agent.kill()`, which is now tree-wide (req 4).

## Where it applies

Every ShipIt-initiated termination of an agent CLI:

| Adapter | Path |
|---|---|
| Claude | `ClaudeProcess.kill`, `StreamingClaudeProcess.kill` (dispose, interrupt escalation, sub-agent cap) |
| Codex | `CodexAdapter.kill` — runs at the end of **every** turn (one app-server per turn) |
| OpenCode | `kill`, the post-final-step stop-kill, the post-error kill, the stall deadline, the interrupt escalation, and the transient compaction server |
| Grok | `kill`, the post-result kill, the interrupt escalation |

## What this does not cover

The guarantee is scoped to **ShipIt-initiated** kills, because the walk needs the CLI to still be alive when the snapshot is taken. A CLI that exits **on its own** — the Claude one-shot path finishes its turn on stdin EOF and exits without ShipIt signalling it — leaves nothing for a `ppid` walk to find: by the time `close` fires, any survivor has already been reparented to pid 1. Covering that would mean either a periodic snapshot or killing the CLI at `result` rather than letting it exit, and the second changes turn settlement (exit code, `done` ordering, `sub-agent-run`'s non-zero-exit rule) for every one-shot turn. Neither is worth it on today's evidence: the observed leak was on a ShipIt-initiated kill, and the resident streaming process — what an interactive Claude session actually runs — is always killed by ShipIt.

## Relationship to container init

Giving session containers an init process (`Init: true`) reaps orphans that are already dead. It does not kill live ones — a 19-minute Chromium is not a zombie. The two changes are halves of the same problem and neither substitutes for the other.

## Key files

- `src/server/shared/kill-child.ts` — `killProcessTree`, `collectDescendants`, and the `killChild` primitive they build on
- `src/server/shared/kill-child.test.ts` — the tree guards, including the ownership boundary
- `src/server/session/agents/{claude/process,codex/adapter,opencode/adapter,opencode/compaction,grok/adapter}.ts` — the call sites
- `src/server/session/agents/playwright-mcp.ts` — the built-in MCP server whose browser this exists for
