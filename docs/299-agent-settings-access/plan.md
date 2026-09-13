---
issue: planning#537
title: Agent access to ShipIt settings — design
description: One setting registry behind a read command and a one-change proposal card, so the agent can see every setting and ask for a change the user applies with one click.
---

# Agent access to ShipIt settings — design

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

A first draft of this design was reviewed and substantially cut. What the review
removed and corrected is recorded at the end, under
[What the review changed](#what-the-review-changed), so a later reader does not
reintroduce it.

## What this builds

Two things, and nothing else:

- **A read command.** `shipit settings list` / `shipit settings get <key>` gives
  the agent the current value of every setting the Settings dialog shows
  (req 1, req 5), with secret material reduced to "configured" or "not
  configured" (req 2).
- **A proposal card.** `shipit settings propose` posts an inline card naming
  **one** change — this setting, from this value, to that value, for this reason
  — and the setting moves only when the user clicks Apply (req 4).

Both go through **one registry** of setting descriptors. The registry is the
design: a single list that the read command, the card and the apply path all
consume, so a setting cannot be readable under one name and proposable under
another, and cannot be proposed with a value the apply path will refuse.

## Non-goals

Recorded so a later reader does not re-derive them as gaps:

- **No deep link into a control.** A `shipit-settings://` pointer that opens the
  dialog at the right row was offered and not chosen.
- **No direct write, and no Undo-after-the-fact** (req 4). There is therefore no
  tier table and no argument about which side a setting falls on.
- **No master switch** (req 6). The click is the entire gate.
- **No multi-change card.** One card carries one change — see
  [One change per card](#one-change-per-card).
- **No server-side view of browser-local values** — see
  [Browser-local settings](#browser-local-settings).
- **Per-session sandbox capabilities** are set from the sandbox banner, not the
  dialog, so they stay with docs/279-mutable-sandbox-capabilities.

## The registry

`src/server/orchestrator/services/settings-registry.ts`. One descriptor per
setting:

```ts
interface SettingDescriptor {
  key: string;                 // stable dotted id: "advanced.enableSubAgents"
  control: string;             // the dialog control it mirrors, by data-testid
  tab: SettingsTab;
  label: string;               // the dialog's own wording, reused verbatim
  help: string;                // one line, the dialog's own help text
  scope: "global" | "project" | "browser";
  kind: "boolean" | "enum" | "number" | "text" | "collection";
  project: SettingProjection;  // the ONLY fields this setting may ever emit
  read?(ctx): SettingValue;    // absent for scope "browser"
  propose:
    | { kind: "no"; reason: ProposeRefusal }   // read-only, secret, external flow
    | { kind: "yes"; validate(v): Result; apply(ctx, v): Promise<ApplyOutcome>;
        alsoChanges?: string[] };              // keys this apply moves as well
  format(value): string;       // one line, for the CLI and the card
}
```

Five properties are deliberate, and four of them are corrections from the
review.

### 1. Output is an allowlist, not a redaction

`project` names the exact fields a setting may emit — in `list`, in `get`, in the
card's `from`/`to`, and in an error message. Anything not named is dropped
before it leaves the registry.

This replaces a first-draft rule that hid a value when the descriptor was
*marked* secret. That rule cannot hold, because credential material lives inside
collections nobody would mark secret: an MCP server entry accepts arbitrary
string-valued `env` and `headers` and an arbitrary URL
(`services/mcp.ts:49`, `:63`), so "the MCP servers list" is a plain-looking
setting that can carry a token in three different places. An allowlist is safe
when a *new* credential-bearing field appears, which a deny-list is not (req 2).

Guard tests: every descriptor has a non-empty projection; no projection names a
credential-shaped key (`token`, `key`, `secret`, `password`, `authorization`,
`env`, `headers`); a fixture MCP entry carrying a token in each of the three
places emits none of them.

### 2. `propose: { kind: "no" }` is a first-class answer

Not everything the dialog shows can be changed by a click, and the registry says
which and why rather than failing at apply time:

- `read_only` — the dialog displays it but does not edit it. ShipIt's built-in
  agent instructions are shown, expandable, and not editable
  (`tabs/InstructionsTab.tsx:82`).
- `secret` — the value is credential material the agent does not have and must
  not carry.
- `external_flow` — completing it needs an OAuth or device-code flow the user
  performs on the provider's own site. That is a §3 exception in CLAUDE.md's
  principles, and no service call can turn it into a one-click connection. The
  agent says so rather than proposing a change that cannot land.

These are what req 5 means by "still named, with the reason it cannot be
reached".

### 3. `alsoChanges` makes the card honest

Some setters move more than the key they are named for: changing the TTS
provider also resets the selected voice and speed
(`stores/settings-store.ts:508`). A card that named only the provider would not
be the exact change req 4 promises. A descriptor whose apply has dependents
declares them, and the card shows them under the primary change. A guard test
asserts each declared dependent is itself a registered key.

### 4. Apply calls a shared function, not the underlying store

The first draft claimed that calling "the same service the dialog calls" would
inherit the dialog's side effects. That is false, and the review proved it on
the two paths this feature most needs:

- **Egress.** `EgressAllowlistStore.addHost` writes one SQLite row and nothing
  else (`egress-allowlist-store.ts:29`). Unsuppressing a built-in default, the
  `egress_settings` SSE broadcast and the live `reloadEgress` — including its
  fail-closed 503 — all live in the HTTP route
  (`api-routes-egress.ts:168`–`185`). An apply that called `addHost` would
  persist a host and leave running containers unchanged.
- **Global settings.** `saveGlobalSettings` invokes optional callbacks its
  caller supplies (`services/settings.ts:363`, supplied at
  `api-routes-bootstrap.ts:133`) and **broadcasts nothing**. The dialog gets away
  with that because each toggle updates its own browser store before issuing the
  PUT (`tabs/AdvancedTab.tsx:124`). A card-applied change has no such optimistic
  writer, so **every open browser would keep showing the old value**.

So this feature extracts the route bodies into shared apply functions that both
the HTTP route and the card call, and **adds a settings broadcast** so an applied
change reaches every open viewer. The broadcast is new work, not an inherited
guarantee; it is listed in the checklist as its own item.

### 5. The coverage guard measures the dialog, not a server type

The first draft proposed walking `GlobalSettings` (`services/types.ts:25`) and
claimed that made an unregistered setting a red build. It does not: that
interface carries derived status fields that are not settings, and misses
controls that are. Two were missed in the first inventory — the per-repo colour
picker (`ProjectSettings.tsx:138`) and a role's standing instructions
(`Settings/roles/RoleEditor.tsx:229`).

The guard instead compares against an explicit **control manifest**: every
interactive control rendered inside the settings dialogs, identified by the
`data-testid` the components already carry, each mapped to a descriptor key or
to an explicit `not-a-setting` exclusion with a reason. Adding a control to a tab
without touching the manifest fails the test by name.

### Collections

`roles`, `egress.hosts`, `mcp.servers`, `skills.installed`, `credentialRoutes`
and `secrets` (names only) are `kind: "collection"` with **domain-specific item
operations** — "add an egress host", "set a role's model" — rather than a
general bracket-expression language. Whole-list replacement is not offered:
adding one host must not be expressible as a way to drop the others.

## Scope inventory

Every dialog tab, and what the registry can do with it. The third column is the
honest answer req 5 asks for where a setting cannot be reached.

| Tab | Settings | Read | Propose |
|---|---|---|---|
| Services | credential routing order, account selection mode, failover cutoffs, non-turn model pin, installed harnesses | yes | yes |
| Services | provider API keys | configured / not | no — `secret` |
| Services | provider accounts | connected / not | no — `external_flow` |
| Roles | role list: harness, model, effort, description, standing instructions | yes | yes |
| Roles | the reserved `reviewer` role's parameters | yes | no — `read_only`; its params must stay `auto` (`services/role-settings.ts:113`). The editable controls are the **reviewer slots** (`first`, `second`), which are separate settings |
| Integrations | MCP servers, tracker connections, connected services | names and connection state only | adding or editing a server yes; its credential fields no — `secret`. An OAuth connection is `external_flow` |
| Git | git identity name and email | yes | yes |
| Instructions | your instructions (global system prompt), agent instructions enabled | yes | yes |
| Instructions | ShipIt's built-in agent instructions | yes | no — `read_only` |
| Skills | installed skills, marketplaces | yes | yes |
| Keyboard | keybindings | browser-local | apply in the browser you click from |
| Voice | delivery mode, webhook configured | yes | mode yes; webhook URL `secret` |
| Voice | dictation, playback, TTS provider, voice, speed, hands-free | browser-local | apply in the browser you click from; TTS provider declares `alsoChanges` |
| Network | egress on/off, global allowlist, per-session hosts, enforcement state | yes | yes |
| Advanced | memory budget, live steering, auto-create-PR, auto-resolve conflicts, auto-fix CI, auto-reset merged branch, sub-agents, update channel | yes | yes |
| Advanced | compact conversation, browser notification, sound | browser-local | apply in the browser you click from |
| Project · Secrets | secret names | names only | no — `secret`; the agent does not have the value |
| Project · Deployments | automatic deployment config, agent-merge permission | yes | yes |
| Project · Deployments | deploy provider tokens | configured / not | no — `secret` |
| Project · Appearance | repository colour | yes | yes |

Both dialogs are in scope — the global one and the per-repository **Project
Settings** (`ProjectSettings.tsx`), whose three tabs are the last four rows.
Project-scope settings are addressed per repository, so a descriptor with
`scope: "project"` takes a repo URL from the session's own binding rather than
from the agent, and reads as unavailable in a session with no bound repository.

### Browser-local settings

A real part of the dialog is stored in the browser's `localStorage`, not on the
server (`stores/settings-store.ts:396` and its neighbours): compact conversation,
notifications, sound, keybindings and most of the Voice tab. The orchestrator has
never held these values.

**The server does not read them.** A first draft had each viewer report a
snapshot over the WebSocket; the review's answer to "would anyone notice if this
were removed" was that it should go, and it is right — with two browsers open,
"this browser" has no defined meaning on the server, so the snapshot would answer
a question the agent did not ask. `list` reports
`unknown (browser-local; set in the browser)`, which is exactly the honest
limitation req 5 provides for.

**Apply still works, in the browser you click from.** The card's own client
handler reads the current local value at click time, checks it against the
card's `from`, and calls the store setter. The card says so in as many words:
*applies to this browser*. A browser-scope card never mixes with a server-scope
one, because a card carries one change.

## Reading

```
shipit settings list [--tab network] [--json]
shipit settings get advanced.enableSubAgents
```

`list` prints key, label, tab and the formatted current value, and for anything
not proposable, the refusal reason. Where a setting is the cause of something
being unavailable, the read result carries the explanation the existing views
already compute — a role's `RoleUnavailableReason`, a reviewer slot's
`pin_unavailable`, egress enforcement state — so the agent says *why*, not only
*what* (req 3).

Every field in the output comes from the descriptor's projection, so `--json`
cannot carry a credential (above).

## Proposing

```
shipit settings propose advanced.enableSubAgents=true \
  --reason "The review you asked for needs sub-agents on." [--json]
```

### One change per card

A first draft let one card carry several changes, arguing that it stopped the
user applying half of a coherent ask. The review pointed out that the same draft
then specified per-change partial-failure outcomes, which surrenders exactly
that guarantee — and that a mixed browser/server card cannot be atomic at all,
since one half runs in a tab that can close. The batch bought a click and cost
the card its meaning.

So: **one card, one change** (plus any `alsoChanges` the descriptor declares).
Two settings means two cards and two clicks. Nothing about the design forecloses
batching later, and it should only come back with real atomicity.

### Validated when proposed, and again when applied

At propose time the key must exist, the setting must be proposable, and the value
must satisfy the descriptor — an invalid proposal is refused with the reason
before any card is posted, so the agent corrects it in the same turn.

Validation **runs again at apply time**, because a card outlives its turn and the
world moves: a role's model can leave the catalogue or its harness become
uninstalled, which the role validators check against live state
(`services/roles.ts:102`, `:128`). Value equality alone would let a card apply a
selection that no longer resolves.

### `--reason` is untrusted text

Flattened to one line and length-capped before it enters the card, as bug-report
titles are (`services/bug-report.ts:72`). The card renders it as **attributed**
text — the agent's words, shown as the agent's words — while the setting name,
the `from` and the `to` come from the registry and the server's own read. That
separation is what stops a reason string from describing a different change than
the one the button applies.

### Applying

A `settings_proposal_decision` WebSocket message (`apply` | `dismiss`), handled
in a new `ws-handlers/settings-proposal-handlers.ts`.

The egress prompt card (`ws-handlers/egress-handlers.ts`) is the closest existing
machinery and the right place to look — but it is **not** a template to copy. It
takes the host from the client's message and mutates without loading a pending
proposal or claiming it, which is safe there because the whole decision is one
idempotent host add. It is not safe here.

The order is:

1. **Load the proposal from persisted state**, never from the decision message.
   The message supplies a card id and an action; every value applied comes from
   the stored card.
2. **Claim it synchronously** — a conditional SQLite update from `pending` to
   `applying` that returns the number of rows changed. A second viewer's click,
   or a Dismiss racing an Apply, changes zero rows and is answered
   "already resolved". Claiming before the first `await` is what makes two
   viewers safe; a read-then-apply leaves a window that both clicks pass through.
3. **Re-read and compare-and-set.** The current value must still equal the card's
   `from`, and the descriptor must still validate the target. Otherwise the card
   resolves `stale` and nothing is applied. The check is against state, never an
   observed transition, so it behaves correctly for a viewer that was not
   connected when the value changed.
4. **Apply** through the shared function, then **write the terminal phase**.

Phases: `pending` → `applying` → `applied` | `dismissed` | `stale` | `refused` |
`failed` | `unknown`.

Two of those exist because of failure modes the first draft did not answer:

- **`unknown`.** If the orchestrator stops between the mutation and the terminal
  write, the card is found in `applying` on restart. It is shown as *outcome
  unknown — check the setting*, and is **never** retried automatically, because
  the side effect may already have run.
- **`failed` distinguishes saved from effective.** Adding an egress host can
  persist and then fail its live refresh closed, which the route reports as a
  503 with the allowlist already saved (`api-routes-egress.ts:175`). The outcome
  records configuration-saved-but-not-live rather than flattening it to
  "failed", which would tell the user the opposite of what happened.

The decision message is **browser-only**. It is not exposed to session
containers: the orchestrator's authorization boundary is the container guard's
`containerAccessible` opt-in plus caller-session comparison
(`api-container-guard.ts:175`–`190`), not the relay URL builder the first draft
cited. The agent proposes over the relay; only a browser resolves.

### Telling the agent what the user decided

An `agentNotified` flag on the persisted card and a
`consumeUnreportedSettingsOutcomes` beside `consumeUnreportedBugOutcomes`
(`chat-history.ts:519`); the notice joins the same `agentPrefix` chain in
`ws-handlers/agent-execution.ts:414` and `dispatched-turn.ts:212`. Wording
follows `buildBugOutcomeNotice`: an applied change is stated as fact, a dismissed
one is marked *do not re-propose unless asked*.

This is **at-most-once attempted** delivery, not a guarantee. The outcome is
marked consumed while the prompt is assembled, so a turn that then fails to spawn
loses the notice — the existing bug-report path has the same property and
documents it (`dispatched-turn.ts:209`). The agent must therefore re-read the
setting rather than trust that it was told; the docs say so.

## Persistence

The card is transcript content, so it takes the full recipe from CLAUDE.md and
`docs/188-persist-transcript-cards`: a typed `PersistedMessage.settingsProposal`
field, a column plus `toRow`/`fromRow` and a `database.ts` migration,
rehydration in `loadSessionHistory`, registration in `CARD_MESSAGE_FIELDS`
(`visual-elements.ts`) and in `TRANSCRIPT_SCOPED_MESSAGES`
(`client/hooks/message-handlers/index.ts`), an extension of
`EVERY_OPTIONAL_FIELD_MESSAGE`, and history round-trip plus
no-duplicate-on-replay tests.

Emission goes through **`emitChatCard`** (`chat-card-persistence.ts:128`), never
a bare `emitMessage`: a `shipit settings propose` issued from a backgrounded
`shipit agent run` can land after the turn ends, and `emitChatCard` is what
decides between riding the in-progress turn and appending a final row.
`persistCardTransition` (`:171`) writes each phase to the recorded card as well
as the live one. Neither helper provides a lock or a transaction spanning the
setting write and the card transition — the claim in step 2 above is this
design's own, not something inherited.

## Trust boundary

- **Secrets are unreachable by construction** — the projection allowlist, not a
  policy anyone has to remember.
- **Ingested text cannot change a setting.** A repository file, a web page or a
  tool result can at most cause the agent to *propose*; the click is required and
  is the whole gate (req 4). This is why the flat every-write-needs-a-click
  posture beats a tier split.
- **The agent cannot resolve its own proposal**, per the container guard above.
- **No extra gate for sandbox sessions.** A sandbox may read and propose like any
  other session: the card lands in that session's own transcript and the click is
  the user's. A refusal here would restrict nothing an untrusted workload could
  otherwise do.

## Agent-facing docs

New `src/server/shipit-docs/settings.md`: the two commands, the projection rule,
the card, the one-change rule, and the instruction to **re-read** a setting
rather than assume an outcome notice arrived. Then the places that currently send
the user to a control are rewritten to read first and propose: `agent.md:22` and
`:367`, `issues.md:257`, `compose.md:624`, `android.md:253`, `github.md:263`,
`environment.md:241`, `skills.md`.

One consequence to state there: when the agent posts a proposal card it must
**not** also write a `[needs you]` line for the same change — CLAUDE.md's
"Responding in chat" rule already says the list never repeats an affordance
ShipIt's own UI puts in front of the user.

## Key files

New:

- `services/settings-registry.ts` — descriptors, projections, read, validate.
- `services/settings-apply.ts` — the shared apply functions extracted from the
  egress and global-settings routes, plus the new settings broadcast.
- `services/settings-proposal.ts` — card compile, claim, compare-and-set,
  outcome notice.
- `ws-handlers/settings-proposal-handlers.ts` — the decision message.
- `session/agent-shim/shipit-settings.ts` — `list`, `get`, `propose`.
- `client/hooks/message-handlers/settings-proposal-card.ts` and the card
  component under `MessageList/cards/`.
- `shipit-docs/settings.md`.

Changed: `api-routes-egress.ts` and `api-routes-bootstrap.ts` (call the extracted
apply functions), `session/agent-ops-routes.ts` (relay), the session-scoped
settings endpoints plus their `containerAccessible` config,
`agent-shim/shipit.ts` (dispatch and help), the WS message types,
`chat-history.ts` and `database.ts`, `agent-execution.ts` and
`dispatched-turn.ts`, `visual-elements.ts` and the client message-handler index.

## Testing

Beyond the persistence round-trip tests the recipe requires:

- **Control manifest coverage** — every settings control maps to a descriptor or
  a reasoned exclusion. Red build names the control.
- **Projection safety** — no projection names a credential-shaped key; an MCP
  fixture carrying a token in `env`, `headers` and the URL emits none of them, in
  text and JSON output and in a card's `from`.
- **Claim-before-apply** — two concurrent decisions on one card produce exactly
  one apply. Remove the conditional update and this test must fail on its own.
- **Stale and revalidation** — a card whose `from` moved applies nothing; a card
  whose target stopped validating resolves `refused`. Each guard deleted singly
  must go red, which means the fixture has to actually move the value between
  propose and apply.
- **Saved-but-not-live** — an egress apply whose reload fails closed reports
  configuration saved, not `failed`.
- **Broadcast** — an applied global change reaches a second connected viewer.
- **Outcome notice consumed once**, and the docs' re-read instruction exercised.
- **Shim** — argument parsing and propose-time refusal messages.

## Risks

- **The registry is a hand-maintained mirror of the dialog.** The control
  manifest guard is what keeps it honest; without it this design rots within two
  features. Write the guard first.
- **Extracting the route bodies touches shipped paths.** The egress route and the
  global-settings route both get their behaviour moved into shared functions. That
  is the correct fix and it is not free — their existing tests are the safety net,
  so run them before and after rather than only the new ones.
- **Collections are where the work is.** If the build runs long, ship
  proposal support for scalars plus `network.egress.hosts` first. Descriptors for
  every setting still ship — req 5 is about being able to *see* and be told about
  every setting, so deferring a collection's **writes** is acceptable and omitting
  its **descriptor** is not.

## What the review changed

A design review ran against the first draft with the brief "for each element,
would anyone notice if it were removed?". It cut two things and corrected six.

Removed: the per-viewer browser-local snapshot channel, and multi-change cards.

Corrected: the claim that calling an underlying store inherits the route's side
effects (false for egress and for global settings, which broadcasts nothing);
the coverage guard's target (`GlobalSettings` is not the dialog); secret safety
by deny-list (credentials live inside plain-looking collections); the
`roles[reviewer].model` example (the reserved role's params must stay `auto` —
reviewer *slots* are the editable setting); the cited authorization boundary
(the container guard, not the relay URL builder); and the strength of the
outcome-notice guarantee (at-most-once attempted, not delivered).

Added in response: the `applying` claim step and the `unknown` phase, apply-time
revalidation, `alsoChanges` disclosure, `propose: { kind: "no" }` with reasons,
and the settings broadcast.
