# 016 — ShipIt vs Claude Code App: Comparison & Guardrails

Reference document comparing ShipIt's capabilities against the Claude Code App. Individual features have their own docs — this is kept for the comparison table and architectural guardrails.

## Feature Comparison

| Capability | ShipIt | Claude Code App | Status |
|---|---|---|---|
| Agentic engine (Claude CLI) | Yes | Yes | Parity |
| Live preview | Yes (Vite + port scan) | No built-in preview | ShipIt ahead |
| Session isolation | Per-directory git repos | Git worktrees / VMs | Different approaches |
| Visual diff review | Inline diff in chat only | Dedicated diff viewer | Gap |
| Git auto-commit | Yes (after each turn) | Yes (per worktree) | Parity |
| Git rollback | Yes (hard reset) | N/A (branch-based) | Different models |
| Conversation threading | Yes (checkpoints + forks) | N/A (session-based) | ShipIt ahead |
| Deployment | Yes (Vercel, Cloudflare) | Via CI/CD or manual | ShipIt ahead |
| Usage tracking | Yes (per-turn cost) | Account-level billing | ShipIt ahead |
| Templates | Yes (7 scaffolds) | N/A | ShipIt ahead |
| Permission model | None (trusts CLI) | 3 modes (normal/auto/plan) | Gap |
| PR creation + merge | Planned (doc 019, 027) | Yes | In progress |
| Auto-push | Planned (doc 027) | N/A | In progress |
| GitHub import | Planned (doc 027) | Yes | In progress |
| Prompt queuing | No | Yes | Gap |
| Interrupt/redirect | No | Yes | Gap |
| Cloud/remote execution | No | Yes (Anthropic VMs) | Out of scope |
| Connectors (Slack, Linear) | No | Yes (desktop only) | Out of scope |
| Session sharing | No | Yes (link sharing) | Deferred |
| Plugin ecosystem | No | Yes (marketplace) | Deferred |

## What ShipIt Should NOT Copy

1. **VM/Container isolation model**: ShipIt's value is running locally with direct filesystem access. The container model exists for cloud infrastructure. ShipIt should not add containerization.

2. **Skip-permissions by default**: The Claude Code App runs `--dangerously-skip-permissions` because the VM is the sandbox. ShipIt runs on the user's machine — permission modes are the right approach instead.

3. **Scoped credentials / proxy architecture**: Solves a cloud-specific problem (isolating credentials in shared infra). ShipIt runs single-tenant; credentials are already scoped.

4. **iOS/mobile companion**: Out of scope for a web IDE.

## What ShipIt Already Does Better

1. **Live preview**: Vite integration + port scanning + error injection is more advanced than the Claude Code App.
2. **Conversation threading**: Checkpoints + forks with git state preservation is a differentiator.
3. **Deployment**: One-click deploy to Vercel/Cloudflare from the IDE.
4. **Templates**: Project scaffolding removes the blank-page problem.
5. **Usage tracking**: Per-turn cost visibility is granular and useful.

## Key Architectural Principle

ShipIt is a **development environment**, not just a Claude harness. The Claude Code App wraps the CLI with review/collaboration chrome. ShipIt wraps it with an entire IDE (preview, file tree, terminal, deployment). Integration should enhance ShipIt's IDE nature rather than copying the harness's collaboration chrome.

The highest-value integrations make the IDE loop tighter: diff review (understand changes faster), interruption (course-correct faster), plan mode (explore before committing), prompt queuing (maintain flow).

## Related Feature Docs

- **019** — PR creation
- **027** — GitHub import, auto-push, PR status bar + merge
