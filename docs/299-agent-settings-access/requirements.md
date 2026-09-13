---
issue: planning#537
title: Agent access to ShipIt settings
description: The agent can read ShipIt's own settings from inside a session, and act on the ones it is allowed to, instead of telling the user to go and find a control.
---

# Agent access to ShipIt settings

The user's words: *"Work on design for agent access to Shipit settings."*

One sentence, so most of this document is open questions. What follows under
"Requirements" is the part the sentence settles; the part it does not settle is
under `## Open questions` and blocks implementation code.

## Why this exists

ShipIt's settings are the control plane for work the agent does: which reviewer
runs, whether sub-agents may run at all, which hosts a session may reach, which
tracker is connected, how much memory a session gets, which model does non-turn
work. The agent is blocked by these settings regularly and today has exactly one
move — prose:

| Agent-facing doc | What the agent must tell the user today |
|---|---|
| `agent.md:22` | "the role you need does not exist — the user creates it in Settings" |
| `agent.md:367` | the feature "only works when the user has enabled Settings → …" |
| `issues.md:257` | "the command fails telling you to connect it in Settings first" |
| `compose.md:624` | "Add required package or API hosts through Settings → Network" |
| `android.md:253` | "tell the user to add the host to the session's egress allowlist" |
| `github.md:263` | "turn on *Allow agents to merge their own pull requests*" |
| `environment.md:241` | the memory budget lives in Settings → Advanced |

Three costs follow. The agent **cannot see** whether the setting is already on,
so it asks for changes that are already made and cannot explain a failure it is
actually looking at ("no reviewer could run" — because of what?). The user then
**hunts** for the control across ten settings tabs. And a change the user just
asked for in chat — "use the other model for reviews from now on" — still has to
be hand-operated, which sits badly with §5: chat is the input surface and the
agent is the actor.

## Requirements

1. From inside a session, the agent can read ShipIt's current settings itself,
   without asking the user to read a value out and paste it back.
2. Reading a setting never exposes secret material. For anything holding a
   credential — API keys, tokens, secret values, provider accounts — the agent
   learns only whether it is configured, never the value.
3. When a ShipIt setting is what blocks the work, the agent can tell the user
   which setting it is, what it is currently set to, and what it has to become —
   instead of a generic "change it in Settings".

## Open questions

- **Which capabilities does this cover beyond reading?** Candidates, each of
  which is a separate build: (a) read only; (b) the agent writes a clickable
  pointer that opens Settings at the exact control, reusing the `shipit-preview:`
  / `shipit-present:` link machinery from docs/258-chat-links; (c) the agent
  proposes a specific change as an inline card the user applies in one click,
  like the bug-report and release-proposal cards; (d) the agent applies the
  change itself and the card is the record, with Undo, like `shipit issue create`.
- **What is the write posture, and does it differ per setting?** A flat
  "everything is proposed, the user clicks" is one answer. A tier split is
  another: reversible preferences with no spend and no security consequence
  (auto-create-PR, live steering, voice delivery) written directly, while
  anything touching money, blast radius or the security boundary (egress hosts
  and containment, memory budget, agent-merge permission, model and billing
  routing, enabling sub-agents) is proposed and never applied without a click.
  Note that repository files, web pages and tool output are untrusted input; a
  human click is the only thing that stops ingested text from steering a
  settings change.
- **Does the user get a master switch for this, and what is its default?**
  Off / propose-only / on. Related: most settings are global, so an agent in one
  session changing one affects every other session and every future one.
- **Which settings are in scope for a first version?** Everything in the
  Settings dialog, or only the ones the agent demonstrably hits — sub-agents,
  roles and reviewer, egress hosts, trackers, skills, memory budget, agent-merge?
- **Per-session settings too, or global only?** Sandbox capabilities and the
  egress allowlist are per-session (docs/279-mutable-sandbox-capabilities,
  docs/285-network-mode-at-session-creation) and already emit a settings-change
  card; global settings have no such card.
- **What replaces the `[needs you]` prose line?** If the agent can point or
  propose, is prose still written alongside, or does the card become the only
  form so the instruction is never duplicated?

## Resolved questions

- (none yet)
