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
4. The agent's only write path is a proposal. It posts a card that names the
   exact change, and the setting does not move until the user clicks. This holds
   for every setting: there is no class of setting the agent may change on its
   own, however small or reversible the change is.
5. Every setting the Settings dialog shows is in scope, not only the ones that
   block the agent. A setting the dialog shows but this feature cannot reach is
   still named, with the reason it cannot be reached.
6. The capability has no master switch. It is always available, and the click on
   the proposal is what governs it.

## Open questions

- (none)

## Resolved questions

- 2026-09-13 — *Which capabilities does this cover beyond reading?* The user
  chose **reading** plus a **proposal card the user applies with one click**.
  Two candidates were offered and not chosen: a clickable pointer that opens
  Settings at the exact control, and the agent applying a change itself with an
  Undo. Both are non-goals — a pointer is not a substitute for the card, and
  nothing is applied without a click. → requirement 4.
- 2026-09-13 — *What is the write posture, and does it differ per setting?*
  "Every write needs a click", chosen over a tier split that would have applied
  harmless preferences directly. One rule, no tier table to maintain, and the
  defence against a repository file or web page steering a settings change is
  uniform. → requirement 4.
- 2026-09-13 — *Does the user get a master switch, and what is its default?*
  No master switch. The per-change click is the whole gate, and the Settings
  dialog gains no control for this feature. → requirement 6.
- 2026-09-13 — *Which settings are in scope for a first version?* Every setting
  in the dialog, chosen over the smaller "only what blocks the agent" list. The
  agent must be able to answer a question about any setting the user names, not
  only the ones it trips over itself. → requirement 5.
- 2026-09-13 — *Per-session settings too, or global only?* Answered by the scope
  choice above: the dialog is the boundary. Per-session sandbox capabilities are
  set from the sandbox banner rather than the dialog, so they are out of scope
  here; the egress allowlist is in the dialog's Network tab, so it is in.
- 2026-09-13 — *What replaces the `[needs you]` prose line?* Withdrawn, not a
  decision for the user: `CLAUDE.md` → "Responding in chat" already rules that
  the list never repeats an affordance ShipIt's own UI puts in front of the
  user. An applied-with-one-click card is such an affordance, so the card
  replaces the prose line wherever the agent can propose, and prose remains only
  where it cannot — a secret value the user has to type.
