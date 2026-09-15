---
issue: planning#537
title: Agent access to ShipIt settings
description: The agent can read ShipIt's own settings from inside a session, and act on the ones it is allowed to, instead of telling the user to go and find a control.
---

# Agent access to ShipIt settings

The user's words: *"Work on design for agent access to Shipit settings."*

The feature began with that one sentence, so nearly everything here was raised as
an open question and answered by the user. The receipts are at the bottom, dated;
nothing is open now.

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
   without asking the user to read a value out and paste it back. It reads in two
   steps — an index of every setting it may see, then the detail of one — and
   that shape is the same whatever the setting is.
2. Reading a setting never exposes secret material. For anything holding a
   credential — API keys, tokens, secret values, provider accounts — the agent
   learns only whether it is configured, never the value.
3. When a ShipIt setting is what blocks the work, the agent can tell the user
   which setting it is, what it is currently set to, and what it has to become —
   instead of a generic "change it in Settings".
4. The agent's only write path is a proposal. It posts a card that names the
   exact change, and the setting does not move until the user clicks. Naming the
   exact change is a claim about what the user can check, not about how a value
   is printed: a long value is shown as what it does to the text rather than as
   one piece (req 9). This holds
   for every setting: there is no class of setting the agent may change on its
   own, however small or reversible the change is. The guarantee is about
   container mode; in `RUNTIME_MODE=local` no click gate is enforceable for this
   or for any existing settings route, which is recorded below as a known
   limitation of local mode rather than as an exception this feature invented.
5. Every setting shown by the global **Settings** dialog and by the
   per-repository **Project Settings** dialog is in scope, not only the ones that
   block the agent. A setting either dialog shows but this feature cannot reach
   is still named, with the reason it cannot be reached. Where ShipIt already
   gates the underlying resource per session, a read answers for what **this
   session** holds rather than for everything the dialog lists; the grant is the
   boundary and the read honours it, which the receipt below records for SSH
   destinations.
6. The capability has no master switch. It is always available, and the click on
   the proposal is what governs it.
7. Adding a new setting to ShipIt makes it available to the agent
   automatically, carrying its description. There is no second step that
   registers a setting for the agent, and no way to ship a setting the agent
   cannot see. The description the agent reads is the same one the user reads in
   the dialog.
8. When the user applies or dismisses a proposal, the agent is told at the start
   of its next turn. It does not have to work out for itself that something
   changed, and it does not remind the user about a change they have already
   dealt with. The next turn means the next turn that can read a prompt, and
   three kinds are not one. A **compaction** turn is excluded, which the user
   decided and the receipt below records. A **harness command delivered
   verbatim** has no place to carry the notice at all. And a turn the **CLI wakes
   itself for** is one ShipIt composed no prompt for, so there is no place there
   either. The last two are recorded below as known limitations. In all three the
   outcome waits for the turn after rather than being lost.
9. A setting whose value is prose — the user's own instructions, an ops session's
   instructions, a role's standing instructions — is proposable like any other
   setting, and not only in principle. The card **says a change is proposed and
   how big it is**; the change itself is read in a dialog the card opens, and the
   user can read it in full before they click. A value too
   long for anyone to check that way is still refused rather than shown in part,
   and the agent is told where that line is before it writes a value, not after.

## Open questions

- (none)

## Known limitations

- **`RUNTIME_MODE=local` enforces no click gate, and this feature does not
  change that.** A local-mode agent is an ordinary local process on an
  unauthenticated API: it can already write settings directly, with no card and
  no click, and could do so before this feature existed. Closing it means
  authenticating the orchestrator's API against local callers, which is separate
  work on a shared surface. The user accepted this on 2026-09-13 (receipt below);
  `plan.md` → *Who can resolve a card* carries the mechanics.
- **A harness command delivered verbatim carries no outcome notice, and nothing
  can make it.** When the prompt is a native harness command (docs/297,
  `ridesTurnAsCommand`), the CLI reads it as its own command only when the prompt
  is *exactly* the command — so there is no prefix slot for a notice, or for any
  of the other things ShipIt prefixes. This is structural rather than a choice,
  and the user was not asked about it: there was nothing to decide. The
  at-least-once carry covers it — the outcome stays pending and reaches the agent
  on the following turn.
- **A turn the CLI wakes itself for carries no outcome notice either, and nothing
  can make it.** Background work finishing wakes a resident CLI, which starts a
  turn ShipIt composed no prompt for: the wake reaches ShipIt as an event the CLI
  emits (`agent_self_wake`), *after* the CLI has already resumed. ShipIt observes
  that turn rather than composing it, so there is no prefix slot and no moment
  before it to put one in. This is the ShipIt-dispatched wake's opposite, and not
  the one the 2026-09-14 receipt below lists among the automatic turns that do
  carry the notice. Structural rather than a choice, like the verbatim command
  above.

  Live steering is the only channel into a resident CLI, and it is not a delivery
  path here for four separate reasons: it lands **mid-turn**, which is not the
  start of a turn; it is gated on a setting the user may have switched off; three
  of the five harnesses drop it outright; and it perturbs the very turn
  bookkeeping the adoption path reads.

  The at-least-once carry covers it, and covers it exactly: the receipt binds to
  the **dispatched** turn, so a woken turn cannot spend one, and the outcome
  reaches the agent on the next dispatched turn. Delayed by one turn, never
  dropped.

## Resolved questions

- 2026-09-15 — *Where does a long change get read — inline on the card, or
  somewhere the card opens?* The first build put the whole diff in the transcript,
  in a height-capped scroll region. The user: **"let's make the card just say that
  there is a change, for a case of a long values. And the full diff should be
  shown in a dialog."** So the card carries the summary ShipIt authored — the two
  sizes and the `+n −n` — and a control that opens the change; a prose value never
  occupies the scrollback. → requirement 9's second sentence.
- 2026-09-15 — *A prose setting declares a 50,000-character limit and reads as
  fully proposable, but no realistic prose value fits the 200 characters a
  proposal card will show — so it is proposable in principle and unproposable in
  practice. Which half gives?* The user, on being shown an agent refused while
  proposing a better version of their own instructions: **"but I want this
  instructions to be proposable"**. So the card learns to show a long change, and
  the principle underneath the refusal is untouched — an operation whose full
  effect the card cannot show is still refused. The option not chosen was to
  state the smaller limit honestly in the read and leave prose settings
  hand-edited: it would have made the surface truthful and left in place exactly
  the dead end this feature exists to remove. Background and both options:
  [planning#576](https://github.com/nikzlabs/shipit-planning/issues/576). →
  requirement 9, and requirement 4's clause about what "the exact change" claims.
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
- 2026-09-13 — *How does the agent find out that the user resolved a card?* The
  user: *"we need to send the signal that I clicked something on the card, in the
  next turn. Similar to the bug reports. Otherwise the agent will remind the
  user, not realizing that it needs to check the status."* An earlier draft cut
  that notice on the grounds that no requirement asked for it and that the read
  surface already carried the outcome — but a read only helps an agent that
  thinks to read, and nothing was prompting it to. → requirement 8. Requirement 8
  says the agent *is* told, so an outcome that fails to reach a turn is carried to
  the next one rather than dropped; `plan.md` carries how.
- 2026-09-13 — *Does the settings list carry each setting's option set, or only
  the large ones?* The user: *"every option should be fetched. I.e. when reading,
  the agent gets only the available settings, then they can fetch more details
  about the particular setting, then they propose a change."* So the read surface
  is **list → get → propose**, with the same shape for a two-member enum and a
  hundred-model selection. An earlier draft put small option sets in the list and
  fetched only large ones, which made the response shape depend on how many
  models happen to be installed. Descriptions stay in the list, because
  requirement 7 says a setting reaches the agent carrying its description.
- 2026-09-13 — *How does requirement 4 read in local mode, where the click gate
  cannot be enforced?* **Container mode, with the gap documented.** The user
  chose this over two alternatives: authenticating the local-mode API first as
  prerequisite work, and shipping only the read path until the question settled.
  The reasoning that carried it is that the gap is pre-existing and wider than
  this feature — a local-mode agent can already write settings directly — so
  making this feature wait would not close it and would not reduce it. →
  requirement 4's mode clause, and the known limitation above.
- 2026-09-13 — *How does a setting reach the agent?* The user: *"the design
  should make the settings to be defined in a way so new settings automatically
  could be available to the agent, with descriptions."* This replaces the
  design's hand-maintained mirror of the dialog, whose own risk section admitted
  it rots. → requirement 7.
- 2026-09-13 — *Which dialog does req 5 mean?* ShipIt has two: the global
  **Settings** dialog with ten tabs, and the per-repository **Project Settings**
  dialog. The answer is **both**. Project Settings holds two of the things
  agent-facing docs currently tell the agent to ask the user for by hand — the
  Secrets panel (`shipit-docs/secrets.md`) and the "Allow agents to merge their
  own pull requests" permission (`shipit-docs/github.md:263`) — so leaving it
  out would keep the dead end this feature exists to remove. Secret *values*
  remain unreadable and unproposable under requirement 2 either way.
- 2026-09-13 — *Per-session settings too, or global only?* Answered by the scope
  choice above: the two named dialogs are the boundary. Per-session settings have
  a dialog of their own (`SessionSidebar/SessionSettingsDialog.tsx`, holding
  sandbox capability grants and the network containment override) and it is not
  one of the two, so they are out of scope. The global egress allowlist is in the
  Network tab, so it is in.
- 2026-09-13 — *What replaces the `[needs you]` prose line?* Withdrawn, not a
  decision for the user: `CLAUDE.md` → "Responding in chat" already rules that
  the list never repeats an affordance ShipIt's own UI puts in front of the
  user. An applied-with-one-click card is such an affordance, so the card
  replaces the prose line wherever the agent can propose, and prose remains only
  where it cannot — a secret value the user has to type.
- 2026-09-14 — *Requirement 8 says "the next turn" and names no kind of turn. Does
  a compaction turn carry the outcome notice?* The user: **exclude compaction.**
  Every other turn carries it, automatic ones included — a CI fix, a conflict
  resolution, a rebase follow-up, a credential remediation, a wake. The
  constraint this carries is that "the next turn" means the next turn that can
  read a prompt, and compaction is not one. → requirement 8's closing clause.

  Three things carried the answer, and they are the reasoning rather than a
  preference for consistency. A compaction turn's prompt is an instruction to
  summarise and its result **replaces the context** a notice would have been read
  in, so consuming an outcome there risks the agent that does the user's actual
  work never seeing it — which is the precise failure requirement 8 exists to
  prevent. ShipIt already suppresses every prefix on a compaction turn: the
  pending-agent notice, the bug-report outcome and the dependency gap, all
  verified at `dispatched-turn.ts` rather than taken from a summary. And nothing
  is lost — the outcome stays pending and rides the following turn, so the agent
  is told one turn later, and only when the next turn happens to be a compaction.

  An earlier draft excluded **every** automatic turn on the grounds that a
  settings notice inside a conflict-resolution prompt could only distract. That
  was a restriction the requirement's wording did not carry, and it made an
  outcome wait for an ordinary turn that may be hours away and may never come.
- 2026-09-15 — *An agent can read SSH destinations from the settings surface.
  Should it see every registered destination, or only the ones granted to its
  session?* The user: **scope to granted destinations.** → requirement 5's
  closing clause.

  The constraint this carries is that a setting's per-session availability may be
  narrower than the dialog's, where ShipIt already gates the underlying resource
  per session. The grant is the boundary, and the settings read honours it rather
  than adding a second gate of its own.

  Three facts decided it rather than a preference. `/api/ssh-hosts` is hard-denied
  to every container because *"a container has no business editing destinations or
  reading the list"* (`api-container-guard.ts`); the settings read crossed that
  decision through a container-accessible route, so on `main` a session granted
  nothing can name every destination the user has registered; and
  `listSshIdentities` already returns label, user and address for the granted
  hosts. Scoping makes the settings door agree with the door beside it instead of
  inventing a policy. For a granted destination it takes nothing away either —
  ShipIt already writes that destination's address, user and port into the
  session's own `~/.ssh/config`.

  A per-session read-approval gate was considered and **not** chosen: it would
  reverse requirement 6's "no master switch", which the user decided on
  2026-09-13, and the grant boundary already answers the concern.
