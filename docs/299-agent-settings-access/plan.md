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

Both go through **one registry** of setting descriptors, so a setting cannot be
readable under one name and proposable under another, and cannot be proposed with
a value the apply path will refuse.

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
- **Per-session settings.** Sandbox capabilities are set from the sandbox banner
  and per-session egress from the egress prompt card; neither is in a dialog.

## The registry

`src/server/orchestrator/services/settings-registry.ts`. One descriptor per
setting:

```ts
interface SettingDescriptor {
  key: string;                 // stable dotted id: "advanced.enableSubAgents"
  control: ControlRef;         // the dialog control it mirrors
  tab: SettingsTab;
  label: string;               // the dialog's own wording, reused verbatim
  help: string;                // one line, the dialog's own help text
  scope: "global" | "project" | "browser";
  kind: "boolean" | "enum" | "number" | "text" | "collection";
  emits: Projection;           // the ONLY output this setting may ever produce
  read?(ctx): SettingValue;    // absent for scope "browser"
  propose:
    | { kind: "no"; reason: ProposeRefusal }
    | { kind: "yes";
        validate(ctx, v): Result;
        dependents?(ctx, v): DependentChange[];  // computed values, not names
        apply(ctx, v): Promise<ApplyOutcome> };
  format(value): string;
}
```

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

### Dependents carry values, not names

Some setters move more than the key they are named for, and **conditionally**:
changing the TTS provider re-picks the voice and the speed only when the current
ones are incompatible with the new provider (`stores/settings-store.ts:508`). A
name list cannot express that, so `dependents()` returns computed before/after
values, the card shows them, and they are **recomputed at apply time** — if a
dependent's baseline moved since the card was written, the card is stale. Without
that, a user who changed their voice after the card was posted would approve a
change whose displayed effect no longer matches.

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

So the route bodies are extracted into shared apply functions that the HTTP
routes and the card both call, and a **settings broadcast is added** so an
applied change reaches every viewer. The broadcast is new work, not an inherited
guarantee.

**The shared layer also serializes per setting key.** A card claim stops two
clicks on one card; it does nothing about a second card or the dialog itself
writing the same setting, and the underlying writes yield — `writeGlobalSystemPrompt`
is an async file write (`global-system-prompt.ts:21`). Read, validate and write
therefore run inside a per-key async lock held by the shared layer, which is the
only place every writer passes through. Without the extraction there is no such
place, which is the second reason to do it.

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

### The coverage guard measures controls, and test IDs are not enough

A guard over `GlobalSettings` (`services/types.ts:25`) would not work: that
interface carries derived status that is not a setting, and misses controls that
are — the repo colour picker (`ProjectSettings.tsx:138`) and a role's standing
instructions (`Settings/roles/RoleEditor.tsx:229`) are both settings and neither
is in it.

The guard compares against an explicit **control manifest**: every interactive
control in either dialog, each mapped to a descriptor key or to a
`not-a-setting` exclusion with a reason.

Discovery cannot be "collect the `data-testid`s", because a new control need not
have one — the MCP env/header editor has none at all
(`McpServerSettings/KvEditor.tsx`). The manifest is therefore built from a
render-and-walk test: render each tab and enumerate its interactive elements
(`input`, `select`, `button`, `[role=switch]`, `textarea`), keyed by accessible
name where no test id exists. An element that appears and is in neither the
descriptor map nor the exclusion list fails the test. Adding test ids to the
untagged controls is part of this work, so the keys stay stable.

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

1. **Load the proposal from persisted state**, never from the decision message,
   which supplies only a card id and an action.
2. **Claim it, atomically and without yielding.** One operation conditionally
   flips the persisted phase `pending` → `applying` **and** synchronizes the
   card held in `runner.recordedCards`, before any `await`. Both halves are
   required: a database-only claim is undone when the next turn snapshot rebuilds
   in-progress rows from the recorded cards (`chat-history.ts` →
   `replaceInProgress`), after which a second click claims it again. This claim
   cannot be expressed through `persistCardTransition`, which runs its `patchDb`
   callback **only** when the card is not in flight
   (`chat-card-persistence.ts:176`–`183`) — exactly the case that needs it.
3. **Inside the shared layer's per-key lock**: re-read the current value, compare
   it with the card's `from`, recompute dependents, revalidate the target. Any
   mismatch resolves the card `stale` and applies nothing. The check is against
   state, never an observed transition, so it is correct for a viewer that was
   not connected when the value changed.
4. **Apply**, then write the terminal phase.

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
  is known rather than guessing.

**Who can resolve a card.** In container mode a session container cannot reach
the decision path: the boundary is the container guard's `containerAccessible`
opt-in plus caller-session comparison (`api-container-guard.ts:175`–`190`). That
boundary is **conditional, and this design does not strengthen it**: the guard
returns early when there is no container manager (`:135`), and the WebSocket
origin check passes a handshake that sends no Origin at all
(`api-origin-guard.ts:240`). So in `RUNTIME_MODE=local` — the dogfood instance,
where the agent is a local process — nothing here prevents an agent from
resolving its own proposal. That is the same trust position local mode already
has for every other privileged route, and it is stated rather than claimed away.

### How the agent learns the outcome

**From the read surface, not from a notification.** `shipit settings get <key>`
reports any proposal this session has made against that setting and what became
of it, and `shipit settings proposals` lists them. The agent must read a setting
before proposing anyway — that is where `from` comes from — so a dismissal is
visible exactly when it matters, and the docs say not to re-propose a dismissed
change unless asked.

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

- **Credential material is unreachable by construction** — derived-output
  projections, narrow patches, and a refusal where the effect cannot be shown.
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

New: `services/settings-registry.ts` (descriptors, projections, read, validate);
`services/settings-apply.ts` (shared apply functions extracted from the egress,
global-settings and MCP routes, the per-key lock, and the new broadcast);
`services/settings-proposal.ts` (card compile, atomic claim, stale check);
`ws-handlers/settings-proposal-handlers.ts`;
`session/agent-shim/shipit-settings.ts`;
`client/hooks/message-handlers/settings-proposal-card.ts` and the card component;
`shipit-docs/settings.md`.

Changed: `api-routes-egress.ts`, `api-routes-bootstrap.ts`, `api-routes-mcp.ts`
(call the extracted functions); `session/agent-ops-routes.ts` (relay); the
session-scoped settings endpoints and their `containerAccessible` config;
`agent-shim/shipit.ts`; the WS message types; `chat-history.ts` and
`database.ts`; `visual-elements.ts` and the client message-handler index; test
ids added to the untagged settings controls.

## Testing

Beyond the persistence round-trip tests the recipe requires:

- **Control coverage** — render each tab, enumerate interactive elements, and
  fail on any that is neither a descriptor nor a reasoned exclusion. This must
  catch a control with no test id.
- **Projection safety** — an MCP fixture carrying a token in `args`, `env`,
  `headers` and the URL emits none of them, in text, in `--json`, in a card's
  `from`, and in an error message.
- **Atomic claim** — two concurrent decisions on one card produce exactly one
  apply; and a turn snapshot taken between claim and apply does not restore
  `pending`. Remove either half of the claim and the matching test must fail on
  its own.
- **Per-key serialization** — a card apply and a dialog PUT on the same setting
  do not interleave; the later write does not silently win over a stale read.
- **Stale and revalidation** — a moved `from`, or a moved dependent baseline,
  applies nothing. The fixture must actually move the value between propose and
  apply, or the guard is not live.
- **Saved versus effective** — a global egress add reports saved-not-yet-live; a
  session reload failing closed reports saved-not-effective, not `failed`.
- **Frozen project target** — a card written against repo A is refused after the
  session rebinds to repo B.
- **Broadcast** — an applied global change reaches a second connected viewer.
- **Outcome in the read surface** — a dismissed proposal is visible to a later
  `get`.
- **Shim** — argument parsing and propose-time refusal messages.

## Risks

- **The registry is a hand-maintained mirror of two dialogs.** The control
  coverage guard is what keeps it honest; without it this design rots within two
  features. Write the guard first.
- **Extracting the route bodies touches shipped paths** — egress, global settings
  and MCP all move their behaviour into shared functions. Their existing tests
  are the safety net; run them before and after, not only the new ones.
- **Collections are where the work is.** If the build runs long, ship proposal
  support for scalars plus `network.egress.hosts` first. Descriptors for every
  setting still ship: req 5 is about being able to see and be told about every
  setting, so deferring a collection's **writes** is acceptable and omitting its
  **descriptor** is not.
