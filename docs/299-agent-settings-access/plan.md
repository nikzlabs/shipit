---
issue: planning#537
title: Agent access to ShipIt settings — design
description: One setting registry behind a read command and a one-change proposal card, so the agent can see every setting and ask for a change the user applies with one click.
---

# Agent access to ShipIt settings — design

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

## What this builds

- **A read command.** `shipit settings list` / `shipit settings get <key>` gives
  the agent the current value of every setting both settings dialogs show
  (req 1, req 5), with credential material reduced to "configured" or "not
  configured" (req 2), and with the outcome of any proposal the agent has
  already made against that setting.
- **A proposal card.** `shipit settings propose` posts an inline card naming
  **one** change — this setting, from this value, to that value, for this reason
  — and the setting moves only when the user clicks Apply (req 4).

Neither is a second description of ShipIt's settings. Both are generated from the
**one place a setting is declared** (req 7), which is also where the dialog gets
its label and help text and where the server gets its type, default and
validation. Adding a setting makes it visible to the agent because there is no
separate act of making it visible.

## Non-goals

- **No deep link into a control**, **no direct agent write**, **no master
  switch** — all three were decided in `requirements.md`.
- **No multi-change card.** One card, one change; see
  [One change per card](#one-change-per-card).
- **No server-side view of browser-local values, and no browser-local writes**;
  see [Browser-local settings](#browser-local-settings).
- **No unsolicited outcome delivery to the agent.** The outcome lives in the read
  surface, not in a notification subsystem; see
  [How the agent learns the outcome](#how-the-agent-learns-the-outcome).
- **Per-session settings.** These do have a dialog of their own —
  `SessionSidebar/SessionSettingsDialog.tsx` holds a sandbox's capability grants
  and every other session's network containment override. It is excluded because
  it is not one of the two dialogs req 5's scope answer named, not because it
  does not exist.

## Settings are declared once

Today a single setting is spread over six or seven places: a getter and a setter
on `CredentialStore` with its default inline (`credential-store.ts:653`), a field
on `GlobalSettings` (`services/types.ts:25`), a branch of the `if (x !==
undefined)` chain in `saveGlobalSettings` (`services/settings.ts:244`), a field
in the route's body type (`api-routes-bootstrap.ts:120`), a field and setter on
the client store, and hand-written JSX carrying the label and the help text
(`tabs/AdvancedTab.tsx`). Nothing ties those together. That is why a mirror of
the dialog maintained by hand — which is what an earlier draft of this design
proposed — drifts: it would be an eighth place.

So this feature does not add a mirror. It makes **the declaration the source**,
and derives the rest (req 7).

`src/server/shared/settings-catalogue/`. One `defineSetting` per setting:

```ts
defineSetting({
  key: "advanced.enableSubAgents",
  tab: "advanced",
  scope: "global",
  label: "Multi-agent sessions",           // rendered by the dialog
  description: "Let the agent start child sessions and consult other agents.",
  type: bool({ default: true }),           // type, default and validation
  store: credentialStoreKey("enableSubAgents"),
  emits: plain(),                          // what may leave the server
  propose: { kind: "yes" },
})
```

Five things are then **derived**, not written again:

| Derived | From | Consequence |
|---|---|---|
| `GlobalSettings` | a mapped type over the catalogue | a setting that is not declared has no field |
| the `PUT /api/settings` body type and its validation | the same | an undeclared setting cannot be saved |
| `CredentialStore` read/write | `store` plus `type`'s default | the duplicated defaults and validation go away; a named accessor may stay as a thin delegate where callers read better for it |
| the dialog's standard controls, with their label and help | `label`, `description`, `type` | the user and the agent read the same words |
| `shipit settings list` / `get` | a walk of the catalogue | **the agent sees a new setting the day it is declared** |

The last row is requirement 7, and it holds **structurally**: the agent's view is
a projection of the same table the server persists from, so there is no state in
which a setting exists and the agent cannot see it. No registration step, and no
guard test standing in for one.

This is a net deletion for the settings it covers — the accessor pairs, the
`if`-chain branches and the duplicated body type all collapse into the
declaration — and it is the larger half of this feature's work. See
[Sequencing](#sequencing).

### Where a declaration is not enough

Two kinds of setting do not get a generated control, and they are handled
differently:

- **Bespoke panels** — the role editor, credential routing's drag-ordered list,
  the MCP server panel, the secrets table. These keep their own components, but
  **a declaration is per field, not per panel.** One entry for `mcp.servers`
  would satisfy nothing: a developer could add a field to the MCP form, map its
  control to that entry, pass every test, and leave the new field with no
  description, no projection rule and no refusal reason — requirement 7 broken
  silently. So each editable field inside a bespoke panel is its own declaration
  (`mcp.servers[].command`, `…[].url`, `…[].env`), the component binds **per
  field** for its label, description and validation, and a field with no
  declaration has no control to bind. Conditional fields — the MCP form's stdio
  and HTTP variants — are each declared and each exercised by the residual test.
- **Browser-local settings** — declared with `scope: "browser"`, which carries no
  `store` and no server read. The declaration is what lets the agent name the
  setting and explain that ShipIt's server does not hold it; see
  [Browser-local settings](#browser-local-settings).

### The residual guard

Derivation removes the drift for anything declared. It cannot stop somebody
hand-writing a control that was never declared at all, so one test remains as a
backstop: render each tab, enumerate its interactive elements
(`input`, `select`, `button`, `[role=switch]`, `textarea`), and fail on any that
maps to neither a catalogue entry nor a `not-a-setting` exclusion with a reason.

A control is matched by its **declaration binding** first and its accessible name
otherwise. It is deliberately not matched by `data-testid`: a test id identifies
a control but proves nothing about whether it shares the declaration's
description and field policy, and adding ids across the dialogs to satisfy a
coverage test would be work that buys neither.

The walk must render **conditional and nested** forms, not just each tab's
initial state — the MCP form's stdio and HTTP variants, a populated credential
row, an expanded role editor — because a field that only appears after a choice
is exactly the one that gets missed.

This is a much smaller obligation than a hand-maintained manifest: it catches an
undeclared control, and everything else is impossible rather than merely tested.

### The agent-facing half of a declaration

`emits` and `propose` are the two fields on a declaration that exist for the
agent, and they carry the rules the rest of this document specifies:

```ts
  emits: Projection;           // the ONLY output this setting may ever produce
  propose:
    | { kind: "no"; reason: ProposeRefusal }
    | { kind: "yes";
        validate?(ctx, v): Result;               // beyond what `type` already checks
        baseline?(ctx): Revision;                // server-only; see Applying
        apply?(ctx, v): Promise<ApplyOutcome> }; // absent ⇒ the derived store write
  format?(value): string;                        // absent ⇒ the type's formatter
```

Only `emits` is mandatory, and for an ordinary declared setting it is one word.
Everything else has a default from `type`, so a new boolean or enum is
agent-readable and agent-proposable with no agent-specific code at all. The
fields earn their keep on the settings that are not ordinary — a collection, a
setter with dependents, a value that must not leave the server.

### Output is an allowlist, and free text is never passed through

`emits` names the exact output a setting may produce — in `list`, in `get`, in a
card's `from`/`to`, and in an error message.

A field-name deny-list cannot do this job. Credential material lives inside
collections nobody would mark secret and in fields whose names say nothing: an
MCP server entry takes arbitrary `env`, `headers`, an arbitrary URL **and
arbitrary `args`** (`services/mcp.ts:49`, `:63`), so `--token=…` is a perfectly
ordinary element of a field called `args`.

So the rule is stronger than an allowlist of field names: **a projection emits
only values ShipIt derived, never user-supplied free text.** An MCP server emits
its name, its transport, whether it is connected, and the host of its URL with
userinfo and query stripped — not its args, not its env, not its headers, not its
URL. Where a setting's usefulness genuinely requires showing free text the user
typed (their own instructions, a git identity), the descriptor marks that field
`user_text` with a reason, and that mark is what a reviewer reads.

Guard tests: every descriptor has a non-empty projection; no projection emits a
field not declared; a fixture MCP entry carrying a token in `args`, `env`,
`headers` and the URL emits none of them, in text output, in `--json`, in a
card's `from` and in an error message.

### `propose: { kind: "no" }` is a first-class answer

Not everything a dialog shows can be changed by a click, and the registry says
which and why rather than failing at apply time (req 5):

- `read_only` — displayed but not editable. ShipIt's built-in agent instructions
  are shown and expandable, not edited (`tabs/InstructionsTab.tsx:82`).
- `secret` — credential material the agent does not have and must not carry.
- `external_flow` — needs an OAuth or device-code flow on the provider's own
  site. That is a §3 exception in CLAUDE.md's principles; no service call turns
  it into a one-click connection.
- `browser_local` — the value lives in the browser, not on the server; see below.
- `unsafe_to_display` — an operation whose full effect cannot be shown on the
  card cannot be approved by looking at the card. This is a refusal, not a
  best-effort.

### No dependent-change machinery

An earlier draft carried a `dependents()` mechanism, for setters that move more
than the key they are named for. Its only worked example was the TTS provider
re-picking voice and speed (`stores/settings-store.ts:508`) — and that setting is
`browser_local`, so it is not proposable at all. A mechanism whose sole
justification is an out-of-scope setting does not ship. If an in-scope setting
turns out to have dependents, the honest first answer is
`propose: { kind: "no", reason: "unsafe_to_display" }`, which already exists.

### Apply is a shared function, and it is serialized

Calling the service under a route does **not** inherit the route's behaviour:

- `EgressAllowlistStore.addHost` writes one SQLite row
  (`egress-allowlist-store.ts:29`). Unsuppressing a built-in default, the
  `egress_settings` broadcast and — **for a session-scoped host only** — the live
  `reloadEgress` with its fail-closed 503 all live in the route
  (`api-routes-egress.ts:168`–`185`). A **global** host addition does no live
  reload at all; it takes effect for containers started afterwards.
- `saveGlobalSettings` invokes callbacks its caller supplies
  (`services/settings.ts:363`, supplied at `api-routes-bootstrap.ts:128`) and
  **broadcasts nothing**. The dialog gets away with that because each toggle
  writes its own browser store before issuing the PUT
  (`tabs/AdvancedTab.tsx:124`). A card-applied change has no such optimistic
  writer, so without new work every open browser would keep showing the old
  value.
- MCP routes additionally call `refreshAgentEnvForAllSessions`
  (`api-routes-mcp.ts:129`).
- **Revoking the agent-merge permission cancels pending merge requests and
  broadcasts `repo_list`** (`api-routes-session-repos.ts:266`–`277`). A store
  write alone would leave queued merges armed against a revoked grant.

**The writer inventory is wider than the settings route.** Three writers sit
outside `PUT /api/settings` and each must go through the shared layer, or "every
writer passes through it" is false:

| Writer | Setting it moves |
|---|---|
| `ws-handlers/egress-handlers.ts:30` | adds a host to the **global** allowlist from the egress prompt card |
| `api-routes-updates.ts:19` | the update channel, which the Advanced tab shows |
| `api-routes-session-repos.ts` | agent-merge permission, repository colour |

So the route bodies are extracted into shared apply functions that every writer
calls, and a **settings broadcast is added** so an applied change reaches every
viewer. The broadcast is new work, not an inherited guarantee.

A broadcast alone is not enough for a viewer that was **not connected** when it
fired. Bootstrap runs once per mount (`useConnectionSync.ts:68`) and the
reconnect path hydrates chat history, not settings (`:78`), so a browser that
reconnects after an applied change keeps showing the old value indefinitely. The
reconnect path therefore refetches settings alongside history. An editor left
open with unsaved edits is not silently rewritten under the user — it keeps the
draft and says the underlying value changed.

**The shared layer serializes per setting key — which buys ordering, not conflict
detection.** A card claim stops two clicks on one card; it does nothing about a
second card or the dialog writing the same setting, and the underlying writes
yield (`writeGlobalSystemPrompt` is an async file write,
`global-system-prompt.ts:21`). Read, validate and write therefore run inside a
per-key async lock.

Be precise about what that does **not** fix. The MCP editor captures the whole
server object when it opens and submits a complete configuration
(`McpServerSettings/hooks/useMcpFormState.ts:27`), so a form opened before a card
applies will, on save, write back the value it captured — ordered correctly by
the lock, and still an overwrite. Detecting that needs an expected-revision on
the **dialog's** write, which is a pre-existing last-write-wins hazard this
feature neither introduces nor closes. It is named here so the lock is not read
as solving it.

### Collections are patched, never replaced

`roles`, `egress.hosts`, `mcp.servers`, `skills.installed`, `credentialRoutes`
and `secrets` (names only) are `kind: "collection"` with domain-specific item
operations — "add an egress host", "set a role's model". Three rules:

1. **The agent supplies a narrow patch**, merged server-side with the stored
   item. It never supplies a whole object, because it cannot see the credential
   fields inside one — reconstructing an MCP entry from what the projection shows
   would drop its headers and env, and `updateMcpServer` replaces the supplied
   configuration (`services/mcp.ts:170`).
2. **Whole-list replacement is not offered**, so adding one host cannot be a way
   to drop the others.
3. **An operation whose complete effect cannot be displayed is refused**
   (`unsafe_to_display`), rather than approved on a partial description.

## Scope inventory

Both dialogs are in scope (`requirements.md`, resolved 2026-09-13): the global
**Settings** dialog and the per-repository **Project Settings**
(`ProjectSettings.tsx`).

| Tab | Settings | Read | Propose |
|---|---|---|---|
| Services | credential routing order, account selection mode, failover cutoffs, non-turn model pin, installed harnesses | yes | yes |
| Services | provider API keys | configured / not | no — `secret` |
| Services | provider accounts | connected / not | no — `external_flow` |
| Roles | per role: harness, model, effort, description, standing instructions | yes | yes |
| Roles | the reserved `reviewer` role's parameters | yes | no — `read_only`; they must stay `auto` (`services/role-settings.ts:113`). Its description and standing instructions are editable, and the **reviewer slots** (`first`, `second`) are separate settings |
| Integrations | MCP servers, tracker connections, connected services | derived fields only — name, transport, connected state, URL host | narrow patches yes; credential fields no — `secret`; an OAuth connection `external_flow` |
| Git | git identity name and email | yes | yes |
| Instructions | your instructions, agent instructions enabled | yes | yes |
| Instructions | ShipIt's built-in agent instructions | yes | no — `read_only` |
| Skills | installed skills, marketplaces | yes | yes |
| Keyboard | keybindings | no — `browser_local` | no — `browser_local` |
| Voice | delivery mode | yes | yes |
| Voice | webhook | configured / not | no — `secret` |
| Voice | dictation, playback, TTS provider, voice, speed, hands-free | no — `browser_local` | no — `browser_local` |
| Network | egress on/off, the global allowlist, enforcement state | yes | yes |
| Advanced | memory budget, live steering, auto-create-PR, auto-resolve conflicts, auto-fix CI, auto-reset merged branch, sub-agents, update channel | yes | yes |
| Advanced | compact conversation, browser notification, sound | no — `browser_local` | no — `browser_local` |
| Project · Deployments | the agent-merge permission | yes | yes |
| Project · Secrets | secret names | names only | no — `secret` |
| Project · Appearance | repository colour | yes | yes |

Two things the dialogs do **not** contain, and which are therefore out of scope:

- **Per-session egress hosts.** The Network tab deliberately loads the global
  list only (`SettingsEgress.tsx:218`, whose comment says the effective list must
  exclude per-session entries). A per-session host is granted from the egress
  prompt card, which already exists.
- **Deployment configuration and hosting-platform tokens.** The Deployments tab
  holds exactly one control — the agent-merge toggle — plus explanatory copy and
  outbound links to Vercel, Cloudflare and Netlify
  (`ProjectSettings.tsx:76`–`120`). There is nothing else there to read or set.

**Project scope is frozen into the card.** A `scope: "project"` descriptor
resolves its repository from the session's binding, refuses to read or propose in
a session with none, and **stores the repository it targeted** on the card. Apply
verifies the session still binds that repository, so a card written before a
rebind cannot be applied against a different repo.

### Browser-local settings

Part of both dialogs is stored in the browser's `localStorage`, not on the
server (`stores/settings-store.ts:396` and its neighbours): compact conversation,
notifications, sound, keybindings and most of the Voice tab.

These are **named and explained, and nothing else** — `read: no`,
`propose: { kind: "no", reason: "browser_local" }`. `list` shows the setting,
its tab, and *set in the browser; ShipIt's server does not hold this value*,
which is exactly the honest limitation req 5 provides for.

Two earlier shapes were tried and dropped. Having each viewer report a snapshot
gives "this browser" no meaning on the server when two are open. Letting the card
apply locally has no baseline to compare against — the server has no value to put
in `from` — and needs a grant/acknowledge protocol between the claiming server
and a tab that can close mid-apply, to change a preference the user can toggle
themselves in one click. Neither earns that.

## Reading

```
shipit settings list [--tab network] [--json]
shipit settings get advanced.enableSubAgents
```

`list` prints key, label, tab, the formatted current value, and for anything not
proposable the refusal reason. Where a setting causes something to be
unavailable, the read carries the explanation the existing views already compute
— a role's `RoleUnavailableReason`, a reviewer slot's `pin_unavailable`, egress
enforcement state — so the agent says *why*, not only *what* (req 3).

Reads distinguish **saved** from **effective** where they differ: a global egress
host is saved and applies to containers started afterwards; a change that needs a
session restart says so. Reporting only the stored value would tell the agent a
change is live when it is not.

**A setting that cannot be read degrades to an entry, never to an error.** In a
session with no bound repository the project-scope entries read as *unavailable —
this session has no repository*, and `list` still returns every global setting.
Aborting the command would hide the settings the agent came for because of an
unrelated scope.

## Proposing

```
shipit settings propose advanced.enableSubAgents=true \
  --reason "The review you asked for needs sub-agents on." [--json]
```

The command posts the card and returns its id; it does **not** wait. The user may
click much later, or never.

### One change per card

One card carries one change, plus whatever `dependents()` computes for it. A
multi-change card was considered: its claimed benefit is that the user cannot
apply half a coherent ask, and the moment any change can fail independently that
benefit is gone. Two settings means two cards and two clicks.

### Validated when proposed, and again when applied

At propose time the key must exist, the setting must be proposable, and the value
must validate — an invalid proposal is refused with the reason before a card is
posted, so the agent corrects it in the same turn.

Validation **runs again at apply time**, because a card outlives its turn: a
role's model can leave the catalogue or its harness become uninstalled, which the
role validators check against live state (`services/roles.ts:102`, `:128`).

### `--reason` is untrusted text

Flattened to one line and length-capped, as bug-report titles are
(`services/bug-report.ts:72`), and rendered as **attributed** text — the agent's
words shown as the agent's words. The setting name, the `from`, the `to` and the
dependents come from the registry and the server's own read. That separation is
what stops a reason string from describing a different change than the button
applies. Flattening is presentation hygiene; it is not a secret defence, and the
projection rules are.

### Applying

A `settings_proposal_decision` WebSocket message (`apply` | `dismiss`), in a new
`ws-handlers/settings-proposal-handlers.ts`.

The egress prompt card (`ws-handlers/egress-handlers.ts`) is the nearest existing
machinery but **not** a template: it takes the host from the client's message and
mutates without loading or claiming a pending proposal, which is safe only
because its whole decision is one idempotent host add.

The order is:

1. **Load the proposal from persisted state**, keyed by **owning session plus
   card id**, never from the decision message — which supplies only those two and
   an action.
2. **Claim it, atomically and without yielding.** One operation conditionally
   flips the persisted phase `pending` → `applying` **and** synchronizes the
   card held in `runner.recordedCards`, before any `await`. Both halves are
   required: a database-only claim is undone when the next turn snapshot rebuilds
   in-progress rows from the recorded cards (`chat-history.ts` →
   `replaceInProgress`), after which a second click claims it again. This claim
   cannot be expressed through `persistCardTransition`, which runs its `patchDb`
   callback **only** when the card is not in flight
   (`chat-card-persistence.ts:176`–`183`) — exactly the case that needs it.
3. **Inside the shared layer's per-key lock**: re-read, compare against the
   card's stored **baseline**, and revalidate the target. Any mismatch resolves
   the card `stale` and applies nothing. The check is against state, never an
   observed transition, so it is correct for a viewer that was not connected when
   the value changed.
4. **Apply**, then write the terminal phase.

**The baseline is not the displayed `from`, and conflating them would be a
silent bug.** `from` is what the projection is allowed to show, and projections
deliberately drop things — an MCP entry shows its name, transport and URL host
and not its path, args or env. Two different stored configurations therefore have
the same `from`, so a card whose target changed underneath it in a dropped field
would compare equal and apply anyway. Each declaration supplies `baseline(ctx)`,
a **server-only** revision over the whole stored value, which never leaves the
orchestrator and is what step 3 compares. The user approves what `from` shows;
the server checks what `baseline` covers.

Phases: `pending` → `applying` → `applied` | `dismissed` | `stale` | `refused` |
`failed` | `unknown`.

- **`applied` records saved and effective separately.** An egress host can be
  saved and not yet live; a session-scoped reload can fail closed, which the
  route reports as 503 with the list already written
  (`api-routes-egress.ts:175`). Flattening either to "applied" or to "failed"
  tells the user the opposite of what happened.
- **`unknown`** is the state of a card found in `applying` after a restart. It is
  shown as *outcome unknown — check the setting*, and is never retried
  automatically, because the side effect may already have run. Re-reading the
  configuration cannot prove the runtime effect completed, so the card says what
  is known rather than guessing. **Recovery runs at boot, before the decision
  handler accepts anything**: every interrupted claim is converted to `unknown`
  first, so a card can never be actionable and mid-apply at the same time.

**The apply settles without a runner.** Session and repository context is
captured when the decision arrives, and the apply, the broadcast and the terminal
write belong to the shared layer rather than to a connection. But capturing
context does not reserve the runner: the idle enforcer can dispose one, which
clears its turn state and listeners. Where a step needs the runner — emitting the
card transition to attached viewers — it takes the existing post-turn work lease
(`services/post-turn-hold.ts`), which folds into `agentBusy` and makes a
non-forced `dispose()` decline. Everything else completes whether the runner
survives or not.

**Who can resolve a card.** In container mode a session container cannot reach
the decision path: the boundary is the container guard's `containerAccessible`
opt-in plus caller-session comparison (`api-container-guard.ts:175`–`190`).

In `RUNTIME_MODE=local` that boundary is absent — the guard returns early with no
container manager (`:135`) and the WebSocket origin check passes a handshake with
no Origin (`api-origin-guard.ts:245`) — so a local-mode agent could resolve its
own proposal. It could also simply call `PUT /api/settings` itself, today,
without this feature: local mode's orchestrator API is unauthenticated for any
local process.

That was put to the user rather than decided here, because a design cannot grant
itself an exception to a requirement. The answer (`requirements.md`, resolved
2026-09-13) is that **req 4 is a container-mode guarantee**, and local mode's
absence of one is recorded as a known limitation of local mode rather than
something this feature introduces. Closing it means authenticating the
orchestrator's API against local callers — separate work on a shared surface, and
not a precondition for this.

### How the agent learns the outcome

**From the read surface, not from a notification.** `shipit settings get <key>`
reports any proposal this session has made against that setting and what became
of it. The agent must read a setting before proposing anyway — that is where
`from` comes from — so a dismissal is visible exactly when it matters, and the
docs say not to re-propose a dismissed change unless asked. A separate
history-browsing command is not part of this: no requirement asks for one, and
`get` already answers the question at the moment it is asked.

A notice injected into the next turn's prompt was considered and cut. No
numbered requirement asks for unsolicited delivery; it would add an
`agentNotified` column and two prompt-prefix integrations
(`agent-execution.ts`, `dispatched-turn.ts`); and the existing mechanism it would
copy marks an outcome consumed while the prompt is assembled, so a turn that then
fails to spawn loses it (`chat-history.ts:519`, `dispatched-turn.ts:209`). A
subsystem that is both more machinery and less reliable than a read is not worth
having.

## Persistence

The card is transcript content, so it takes the full recipe from CLAUDE.md and
`docs/188-persist-transcript-cards`: a typed `PersistedMessage.settingsProposal`
field, a column plus `toRow`/`fromRow` and a `database.ts` migration,
rehydration in `loadSessionHistory`, registration in `CARD_MESSAGE_FIELDS`
(`visual-elements.ts`) and in `TRANSCRIPT_SCOPED_MESSAGES`
(`client/hooks/message-handlers/index.ts`), an extension of
`EVERY_OPTIONAL_FIELD_MESSAGE`, and history round-trip plus
no-duplicate-on-replay tests.

Emission goes through **`emitChatCard`** (`chat-card-persistence.ts:110`), never
a bare `emitMessage`: a `shipit settings propose` from a backgrounded
`shipit agent run` can land after the turn ends, and `emitChatCard` decides
between riding the in-progress turn and appending a final row
(`:128`). Phase transitions after the claim use `persistCardTransition` (`:156`);
the claim itself does not, for the reason in step 2 above.

**The apply completes without a viewer.** Session and repository context is
captured when the decision arrives; the apply, the broadcast and the terminal
write are the registry's work, not the connection's. A viewer that disconnects
mid-apply changes nothing — the WebSocket is transport, and CLAUDE.md's rule that
its lifecycle must not drive server behaviour applies here directly.

## Trust boundary

- **The credential fields ShipIt holds are unreachable by construction** —
  derived-output projections, narrow patches, and a refusal where the effect
  cannot be shown. This is not a claim that no secret can ever appear in any
  output: a setting whose value is the user's own prose — their instructions,
  a git identity — is shown because it is theirs, and is marked `user_text` for
  exactly that reason. The guarantee is about fields that hold credentials,
  not about what a user may type into a free-text box.
- **Ingested text cannot change a setting.** A repository file, a web page or a
  tool result can at most cause the agent to *propose*; the click is required and
  is the whole gate (req 4). That is why the flat every-write-needs-a-click
  posture beats a tier split.
- **The card, not the message, is the source of truth** for what gets applied.
- **Local mode is the stated exception** above, not a solved problem.
- **No extra gate for sandbox sessions.** A sandbox may read and propose: the
  card lands in that session's own transcript and the click is the user's.

## Agent-facing docs

New `src/server/shipit-docs/settings.md`: the two commands, the projection rule,
the card, the one-change rule, how to read an outcome, and the saved-versus-
effective distinction. Then the places that currently send the user to a control
are rewritten to read first and propose: `agent.md:22` and `:367`,
`issues.md:257`, `compose.md:624`, `android.md:253`, `github.md:263`,
`environment.md:241`, `skills.md`.

One consequence to state there: when the agent posts a proposal card it must
**not** also write a `[needs you]` line for the same change — CLAUDE.md's
"Responding in chat" rule already says the list never repeats an affordance
ShipIt's own UI puts in front of the user.

## Key files

New: `shared/settings-catalogue/` (the declarations, the `type` constructors with
their defaults and validation, and the derivations of `GlobalSettings`, the route
body and the store accessors);
`services/settings-read.ts` (projection and the catalogue walk behind
`list`/`get`);
`services/settings-apply.ts` (shared apply functions extracted from the egress,
global-settings and MCP routes, the per-key lock, and the new broadcast);
`services/settings-proposal.ts` (card compile, atomic claim, stale check);
`ws-handlers/settings-proposal-handlers.ts`;
`session/agent-shim/shipit-settings.ts`;
`client/hooks/message-handlers/settings-proposal-card.ts` and the card component;
`shipit-docs/settings.md`.

Changed: `credential-store.ts` (per-setting accessors replaced by the derived
read/write); `services/settings.ts` and `services/types.ts` (the `if`-chain and
the hand-written `GlobalSettings` replaced by derivations);
`api-routes-bootstrap.ts` (derived body type); the other writers —
`api-routes-egress.ts`, `api-routes-mcp.ts`, `api-routes-updates.ts`,
`api-routes-session-repos.ts` and `ws-handlers/egress-handlers.ts` — calling the
extracted apply functions; the settings tab components (render label and help
from the declaration; bespoke panels bind per field);
`session/agent-ops-routes.ts` (relay); the session-scoped settings endpoints and
their `containerAccessible` config; `agent-shim/shipit.ts`; the WS message types;
`chat-history.ts` and `database.ts`; `visual-elements.ts` and the client
message-handler index; `useConnectionSync.ts` (refetch settings on reconnect).

## Sequencing

This is two shippable pieces, and the first is the larger one:

1. **The catalogue and its derivations**, plus `shipit settings list` / `get`.
   This is where requirement 7 is satisfied and where the existing duplication
   collapses. It is useful on its own: the agent stops asking for settings that
   are already on, and can explain what is blocking it (req 1, req 3, req 5).
2. **The proposal card** — propose, claim, lock, revalidate, apply, and the
   transcript card (req 4).

Splitting them keeps a large refactor of shipped settings paths out of the same
diff as a new transcript card.

## Testing

Beyond the persistence round-trip tests the recipe requires:

- **Derivation holds** — a setting added to the catalogue and to nothing else is
  readable by `shipit settings get`, carries its description, round-trips through
  the route, and appears in `GlobalSettings`, with no other edit. This is the
  executable form of requirement 7; if it needs a second edit anywhere, the
  derivation is incomplete.
- **Field-level declaration** — a field added to the MCP form and bound to the
  panel's entry rather than its own fails. This is the test that makes
  requirement 7 true for nested fields rather than only top-level ones.
- **Residual control coverage** — render each tab, enumerate interactive
  elements, and fail on any that is neither a declaration nor a reasoned
  exclusion. Must exercise conditional forms: the MCP stdio and HTTP variants, a
  populated credential row, an expanded role editor.
- **Projection safety** — an MCP fixture carrying a token in `args`, `env`,
  `headers` and the URL emits none of them, in text, in `--json`, in a card's
  `from`, and in an error message.
- **Atomic claim** — two concurrent decisions on one card produce exactly one
  apply; and a turn snapshot taken between claim and apply does not restore
  `pending`. Remove either half of the claim and the matching test must fail on
  its own. Also: applying while a different turn is running, with no recorded-card
  entry, and after the runner has been recreated.
- **Baseline, not `from`** — a card whose stored value changed **only in a field
  the projection drops** resolves `stale`. Compare against `from` instead and
  this test goes green with the bug present, which is the point of it.
- **Per-key serialization** — a card apply and a dialog PUT on the same setting
  do not interleave. The test asserts ordering only; it does **not** assert that
  the later write loses, because the lock does not detect a stale full-object
  submit and this feature does not claim to fix that.
- **Saved versus effective** — a global egress add reports saved-not-yet-live.
- **Restart ordering** — a claim interrupted before and after the side effect
  both resolve `unknown`, and recovery converts them before the decision handler
  accepts anything.
- **Settlement without a runner** — an apply completes with no viewer attached,
  and the runner is not disposed underneath a step that needs it.
- **Unbound session** — `list` returns every global setting with the project
  entries marked unavailable, rather than failing.
- **Reconnect** — a viewer that was disconnected when a change applied shows the
  new value after reconnecting.
- **Frozen project target** — a card written against repo A is refused after the
  session rebinds to repo B.
- **Outcome in the read surface** — a dismissed proposal is visible to a later
  `get`.
- **Shim** — argument parsing and propose-time refusal messages.

## Risks

- **Converting the existing settings is the bulk of the work**, and it touches
  shipped paths: the store accessors, `saveGlobalSettings`, the route body, and
  the tab components. The existing settings and route tests are the safety net —
  run them before and after, not only the new ones. The ~15 global scalars are
  mechanical. The bespoke panels are not: field-level declarations mean one entry
  per editable field, and each field's control has to bind to it — more work than
  a single entry per panel, and the reason requirement 7 is true for nested
  fields rather than only top-level ones.
- **Local mode enforces no click gate**, by the resolution above. The card is a
  real gate in container mode and a convention in local mode, so do not write a
  test that asserts local mode refuses an agent-submitted decision — it does not,
  and a test claiming otherwise would be the kind of guarantee this design has
  had to correct three times.
- **A partial conversion weakens requirement 7 silently.** Until `GlobalSettings`
  and the route body are actually derived, an undeclared setting still works and
  the agent still cannot see it. So the derivation lands as one piece for the
  global scope rather than tab by tab, and the derivation test above is what says
  it arrived.
- **Collections are where the remaining work is.** If the build runs long, ship
  proposal support for scalars plus `network.egress.hosts` first. Declarations
  for every setting still ship: req 5 and req 7 are about being able to see and
  be told about every setting, so deferring a collection's **writes** is
  acceptable and omitting its **declaration** is not.
