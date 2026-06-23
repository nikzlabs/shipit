# Starter-prompt suggestions — regular (repo) sessions

A menu of candidate chips for the empty-session launchpad, for you to pick from.
Each is grounded in a capability the README actually advertises, and each is
checked against one bar: **does it teach a ShipIt-specific thing a new user
wouldn't think to ask for, *and* does it work as the very first message in a
session?**

<!-- Scope decisions from review feedback:
     - Sandbox sessions: NO launchpad. Those are power users who know the ropes.
       So this is a single set, shown only on regular repo-backed sessions.
     - Dropped "Open a PR": ShipIt auto-commits and auto-opens PRs, so it's not a
       discovery — it's automatic.
     - Dropped "Write tests": useful, but not ShipIt-specific.
     - Dropped "Deploy to Vercel/Cloudflare": deployment.md says deploys are
       USER-triggered from the UI, not agent-triggered — so it can't be a chat
       prompt at all. -->

## Legend

- ✅ **Recommend** — ShipIt-specific, discoverable, safe as a first message.
- 🤔 **Maybe** — works, but weaker on one axis (less unique, or needs a task first).
- ❌ **Skip** — fails the bar; reason given.

## Candidates

| # | Chip label | Seeded prompt | Why it belongs (and how it's discovered) | README source | Verdict |
|---|---|---|---|---|---|
| 1 | Second opinion from another agent | "Ask Codex for a second opinion — have it review this codebase and flag anything risky or worth refactoring." | Cross-agent review is genuinely unique to ShipIt and almost nobody knows it exists. Runs inline in the same turn. | "Cross-agent second opinions" (Review & ship) | ✅ |
| 2 | What should I work on? | "Show me the open issues for this project and suggest which one to start with." | Surfaces the brokered, tracker-neutral issue access — the agent reads Linear/GitHub issues without tokens ever entering the container. | "Agent issue access", "Inline Issues tab" (Plan & track) | ✅ |
| 3 | Diagram this codebase | "Draw a diagram of how this codebase is structured and how the main pieces fit together." | Teaches the `present` tab — the agent renders a real diagram inline, not just prose. Very non-obvious. | (present tool; not in README feature list) | ✅ |
| 4 | Report a ShipIt bug | "Something in ShipIt isn't working right — help me put together a bug report for the team." | The capability you flagged: file a redacted, consent-gated ShipIt bug from chat. Works at any time. | "bug-report secret redaction" (Security) | ✅ |
| 5 | Review my recent changes | "Review the last few commits on this branch and flag any bugs or risky changes." | Chat-native AI review surfacing findings inline. Slightly overlaps with #1; pick one or frame them differently. | "Chat-native AI review" (Review & ship) | 🤔 |
| 6 | See it running | "Set up a live preview so I can see this app running as we work." | Compose-native preview is a headline feature, but on a repo that already declares Compose it "just runs" — so the prompt only lands for repos without a preview yet. | "Compose-native live preview" (Build) | 🤔 |
| 7 | Try two approaches at once | "I have a change in mind — spin up two parallel sessions trying different approaches so I can compare." | Parallel PR-shaped sessions are distinctive, but this needs the user to have a concrete task in mind, so it's a weaker *first* message. | "Parallel PR-shaped sessions" (Iterate safely) | 🤔 |
| 8 | Explain this project | "Explain what this project does and how the codebase is structured." | The most natural first action in an unfamiliar repo — but it's a generic LLM ability, not ShipIt-specific. Good onboarding, weak on the "ShipIt-specific" axis. | (generic) | 🤔 |
| — | Open a PR | — | ShipIt auto-commits every turn and opens the PR for you — automatic, not a discovery. | "Inline PR lifecycle card" | ❌ |
| — | Write tests for weak spots | — | Useful, but a generic coding ability — nothing ShipIt-specific to discover. | — | ❌ |
| — | Deploy to Vercel / Cloudflare | — | Deploys are triggered by the **user from the UI, not the agent** — so it can't be a chat prompt. | deployment.md (Notes) | ❌ |
| — | Cut a release | — | Real ShipIt capability, but never a *first-message* task — it presupposes shippable work. | release.md | ❌ |

## My recommended set (4)

Lean, all ✅, no overlap, each teaches a distinct ShipIt-specific thing:

1. **Second opinion from another agent** — "Ask Codex for a second opinion — have it review this codebase and flag anything risky or worth refactoring."
2. **What should I work on?** — "Show me the open issues for this project and suggest which one to start with."
3. **Diagram this codebase** — "Draw a diagram of how this codebase is structured and how the main pieces fit together."
4. **Report a ShipIt bug** — "Something in ShipIt isn't working right — help me put together a bug report for the team."

<!-- If you want a 5th, the strongest add is #8 "Explain this project" as a soft
     on-ramp (not ShipIt-unique, but it's the thing people actually type first),
     or #6 "See it running" if you expect many repos to arrive without a preview
     configured. I'd keep it at 4 unless you have a preference. -->

## Open questions for you

- Keep it at **4**, or add a 5th (#8 explain, or #6 preview)?
- For review: keep **#1 (cross-agent / Codex)** only, or also **#5 (same-agent review)**? They overlap.
- Any wording changes to the seeded prompts above?
