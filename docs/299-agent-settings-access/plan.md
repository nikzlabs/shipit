---
issue: planning#537
title: Agent access to ShipIt settings — design
description: One declaration per setting, behind a two-step read and a one-change proposal card the user applies with a click.
---

# Agent access to ShipIt settings — design

Implements [requirements.md](./requirements.md), cited as `(req N)`. The argument
history — what nine review rounds cut and corrected — is on planning#537, not
here.

## What this builds

- **A read.** `shipit settings list` indexes every setting the two settings
  dialogs show; `shipit settings get <key>` details one (req 1, req 3, req 5).
- **A proposal card.** `shipit settings propose` posts one change; the setting
  moves only when the user clicks Apply (req 4).
- **A notice.** A resolved card reaches the agent on a later turn (req 8).

None of these is a second description of ShipIt's settings. All are generated
from **one declaration per setting**, which is also where the dialog gets its
label and help text (req 7).

## Non-goals

- No deep link into a control, no direct agent write, no master switch — all
  decided in `requirements.md`.
- No multi-change card. Its only claimed benefit is that the user cannot apply
  half a coherent ask, and per-change failure gives that away anyway.
- No server-side view of browser-local values, and no browser-local writes.
- No polling. The agent never waits on a card.
- No dependent-change mechanism. The one candidate, TTS provider re-picking voice
  and speed (`stores/settings-store.ts:508`), is `browser_local` and unproposable.
  An in-scope setting that turns out to have dependents gets
  `unsafe_to_display`.
- Per-session settings. They have their own dialog
  (`SessionSidebar/SessionSettingsDialog.tsx`), which is not one of the two req 5
  names.

## Settings are declared once

A setting today is spread over six or seven places: a `CredentialStore`
getter/setter with its default inline (`credential-store.ts:653`), a
`GlobalSettings` field (`services/types.ts:25`), a branch of the
`if (x !== undefined)` chain in `saveGlobalSettings` (`services/settings.ts:244`),
a route body field (`api-routes-bootstrap.ts:120`), a client store field and
setter, and JSX carrying the label and help text. Nothing ties them together — so
a hand-maintained mirror for the agent would be an eighth place, and would drift.

```ts
defineSetting({
  key: "advanced.enableSubAgents",
  tab: "advanced",
  scope: "global",                          // global | project | browser
  label: "Multi-agent sessions",            // the dialog renders these two
  description: "Let the agent start child sessions and consult other agents.",
  type: bool({ default: true }),            // type, default, validation
  store: credentialStoreKey("enableSubAgents"),
  emits: plain(),                           // what may leave the server
  propose: { kind: "yes" },
})
```

Derived from it, not written again:

| Derived | Consequence |
|---|---|
| the **stored half** of `GlobalSettings` | an undeclared setting has no field |
| the `PUT /api/settings` body type and validation | an undeclared setting cannot be saved |
| `CredentialStore` read/write | no duplicated default or validation; a named accessor may remain as a thin delegate |
| the dialog's standard controls | the user and the agent read the same words |
| `shipit settings list` / `get` | **the agent sees a new setting the day it is declared** |

The last row is req 7, holding structurally rather than by a guard test: the
agent's view is a projection of the table the server persists from.

`GlobalSettings` **splits** rather than deriving whole — it also carries computed
status (`canRunTurns`, the agent list, resolved reviewer and role views) which is
not a declaration. The stored half derives; the computed half stays
hand-assembled beside it. The wire shape is unchanged.

### Bespoke panels declare per field

The role editor, credential routing, the MCP panel and the secrets table keep
their own components, but **a declaration is per field, not per panel** — and
each field renders the declaration's **description**, not only its label. A
bespoke panel that shows a label and writes its own help text beside it is the
drift req 7 forbids, in the one place the coverage walk's copy comparison has
nothing to compare: the MCP form's suffixes ("(space-separated)") and the routing
band's tooltips were both authored twice, and the agent read the copy the user
could not see. Both now render `settingCopy`, and the band's one licence is to
swap the collective noun the card shows (docs/252 req 19) and edit nothing else. One
entry for `mcp.servers` would let a developer add a field, bind it to that entry,
pass every test, and ship a field with no description, no projection rule and no
refusal reason. So each editable field is its own declaration
(`mcp.servers[].command`, `…[].url`, `…[].env`) and a field with no declaration
has nothing to bind to.

### The residual guard

Derivation cannot stop someone hand-writing a control that was never declared, so
one backstop test renders each tab, enumerates its interactive elements
(`input`, `select`, `button`, `[role=switch]`, `textarea`) and fails on any that
is neither a declaration nor a reasoned `not-a-setting` exclusion.

Match on the declaration binding, falling back to accessible name — **not** on
`data-testid`, which identifies a control without proving it shares the
declaration's description and policy (and the MCP env/header editor has none at
all). The walk must render conditional and nested forms: the MCP stdio and HTTP
variants, a populated credential row, an expanded role editor.

The binding is the `data-setting` attribute `bindSetting(key)` produces, and its
key is typed as `SettingKey`, so a control nobody declared has nothing it can
name. Three further checks live in the same walk, because a guard that only
counted controls would pass through every defect it is most likely to meet.
**A box that edits a value may not bind a collection** — a collection's declared
controls are its operations, which are buttons, so binding a new field to
`mcp.servers` is the per-panel loophole rebuilt and it fails. **The rendered
label and description are compared against the declaration's**, so a control
that writes its own words fails. And **the declarations the walk actually
reached are compared against the whole registry**, so a pane that renders
nothing cannot pass for coverage.

The walk's boundary is the tab **pane** — dialog furniture and the
add-a-provider wizard are outside it, and the test names what that costs. Two
things it cannot decide are stated there rather than implied: a bespoke panel's
visible wording is a review matter unless the panel marks it, and a `wholeTab`
exemption is a claim `exclusions.ts` makes in prose.

**And a third, which the type system decides instead.** The walk reads rendered
DOM, so it can establish that a control names *a* declaration and never that the
declaration is the one whose property the handler saves — a box bound to
`mcp.servers[].command` while writing something else passes it. The stored shape
can say what the DOM cannot: `MCP_SERVER_FIELD_SETTINGS` is keyed by
`keyof McpServerConfig`, so a field added to the persisted type is a compile
error until it is declared or explained as not a setting. **The declaration it
may name is derived from the field's own name** — `mcp.servers[].${F}`, not any
existing key — because "mapped to something that exists" is the same pass the DOM
walk gives, and it is the loophole being closed. The two guards run in opposite
directions: the walk finds a control nobody declared, the map finds a stored
field nobody declared.

`setup` is what the map found — a pre-start command for non-npm stdio servers,
designed in `docs/088-mcp-integration/plan.md:405`, whose type and validator
shipped and whose reader never did. It is **deleted**, not declared: a stored
value with no effect is not a setting the agent should report. docs/088 still
holds the design, and re-adding the field fails the map until it is declared.

**The reader tables are the same kind of derivation.** `BESPOKE_READERS` and
`OWN_ROUTE_READERS` are keyed by `BespokeSettingKey` / `OwnRouteSettingKey`,
computed from the catalogue by store kind, so a declaration with no reader is a
missing property and a reader for a setting nobody declared is an unknown one —
both at compile time. They were two runtime tests, which is the eighth place this
design exists to remove; restating a `tsc` refusal at run time buys nothing.

## What a declaration says to the agent

```ts
  emits: Projection;        // the ONLY output this setting may produce
  propose:
    | { kind: "no"; reason: ProposeRefusal }
    | { kind: "yes";
        validate?(ctx, v): Result;      // beyond what `type` checks
        baseline?(ctx): Revision;       // server-only; see Applying
        apply?(ctx, v): Promise<ApplyOutcome> };  // absent ⇒ derived store write
  format?(value): string;
```

Only `emits` is mandatory. An ordinary boolean or enum is readable and proposable
with no agent-specific code.

### `emits` is an allowlist of derived values

A field-name deny-list cannot work: an MCP server entry takes arbitrary `env`,
`headers`, a URL **and arbitrary `args`** (`services/mcp.ts:49`, `:63`), so
`--token=…` lives in a field called `args`.

**A projection emits only values ShipIt derived, never user-supplied free text.**
An MCP server emits its name, transport, connected state, and its URL's host with
userinfo and query stripped — not args, env, headers or the URL. Where showing
text the user typed is the point (their own instructions, a git identity), the
field is marked `user_text` with a reason, and that mark is what review reads. A
`derived` projection whose function returns the user's words rather than
ShipIt's carries the same reason, on the same grounds: without it, `derived`
claims the output is ShipIt's own.

**A NAME the user typed is emitted only when it is shaped like a name.** Naming a
role, an MCP server or a missing secret is the whole of what the agent has to
tell the user, so these are emitted deliberately — but nothing constrains what
they are made of: `PUT /api/secrets` takes any string as a key and a role name is
checked only for being non-blank and short enough, so
`https://user:token@host/?token=…` is a storable name. An item's **address** is
where it would leave. So the four collections an address is projected through —
`roles`, `mcp.servers`, `project.secrets`, `network.egress.hosts` — apply one
rule between them, the one `hostEntryProjection` and `mcpUrlProjection` already
made: a URL carries a credential in its userinfo and query as a matter of
routine, so an entry wearing that shape is named by nothing and produces no item,
and the read says how many it left out.

**This is not a credential scanner and must not be read as one.** `Bearer ghp_…`
typed into a name box passes it, because nothing separates that from a name
someone meant — and content-matching a field is the deny-list this section opens
by rejecting. Emitting a name is the user's own decision (`requirements.md`,
resolved 2026-09-13), the dialog and every service already show it, and the
`user_name` mark records that a human chose it. The gate's claim is narrower: the
one shape that carries a credential *without* anyone choosing to is not repeated
back.

Guard: a fixture MCP entry carrying a token in `args`, `env`, `headers` and the
URL emits none of them — in text, in `--json`, in a card's `from`, in an error.
And a secret and a role *named* like one emit nothing of it either.

**Reflected input is not this rule's business.** `list --tab` and `get <key>`
echo the caller's own string back when it names nothing, and that string arrives
on the agent's own query — nothing ShipIt persists reaches it, so req 2 ("reading
a setting never exposes secret material") is not engaged. What it is engaged by
is presentation, so the echo is flattened and capped exactly as `--reason` is:
hygiene, not a secret defence.

### Refusals are first-class

- `secret` — credential material the agent does not have.
- `external_flow` — needs an OAuth or device-code flow on the provider's site, a
  §3 exception; no service call makes that one click.
- `browser_local` — the value is in the browser, not on the server.
- `unsafe_to_display` — the card cannot show the operation's full effect, so the
  user cannot approve it by looking. A refusal, not a best-effort.

### Non-boolean values carry their shape

`type` already holds it, so nothing extra is authored: `enum` → options;
`number` → min, max, step, unit; `text` → max length and format;
`modelSelection` → eligible services, models and effort levels, resolved live;
`collection` → operations and patchable field keys.

**None of it is in `list`.** `list` is the index — key, label, one-line
description, tab, scope, current value, availability, and the refusal reason if
any. `get` is the detail. The split is by role, never by size: a threshold would
make the response shape depend on how many models happen to be installed.

Options can go stale between `get` and apply, which apply-time revalidation
handles. The read is an optimization; propose-time validation is the safety net.

## Not everything in a dialog is a setting

Three kinds of thing, one of them declared:

- **Settings** — a stored value with a control. Declared.
- **Derived status** — computed, editable by nobody: egress enforcement state,
  whether turns can run, installed harnesses, update availability.
- **Explanatory copy and actions** — the reserved `reviewer` role's params render
  **no control**, only a paragraph pointing at the two reviewer slots
  (`Settings/roles/RoleEditor.tsx:245`); ShipIt's built-in agent instructions are
  displayed content whose setting is the toggle beside them; *Check for updates*
  and *Update now* run something.

The last two kinds are `not-a-setting` exclusions with that reason. A value
nobody can edit is not a setting the agent is refused — it was never a setting.

## Scope inventory

Both dialogs (`requirements.md`, resolved 2026-09-13): the global **Settings**
dialog and per-repository **Project Settings**.

| Tab | Settings | Read | Propose |
|---|---|---|---|
| Services | credential routing order, account selection mode, failover cutoffs, non-turn model pin | yes | yes |
| Services | provider API keys | configured / not | no — `secret` |
| Services | provider account connection | connected / not | no — `external_flow` |
| Services | a provider account's label, a stored credential's label | yes | yes — renaming needs no OAuth (`Settings/ProviderAccountRows.tsx:761`, `Settings/ServicesPanel.tsx:805`) |
| Roles | per role: harness, model, effort, description, standing instructions | yes | yes |
| Roles | reviewer slots `first` and `second` | yes | yes — these are the settings behind "what the reviewer runs on" |
| Integrations | create a pull request automatically | yes | yes |
| Integrations | MCP servers | derived fields only | narrow patches yes; credential fields `secret` |
| Integrations | the Linear panel | configured / not | no — `secret`; it holds an API token, and the tracker destination is a repository declaration (`SettingsTrackers.tsx:13`) |
| Integrations | connected services | connected / not | no — `external_flow` |
| Git | git identity name and email | yes | yes |
| Instructions | your instructions, agent instructions enabled | yes | yes |
| Keyboard | keybindings | no — `browser_local` | no |
| Voice | delivery mode | yes | yes |
| Voice | webhook, speech and voice provider keys | configured / not | no — `secret` (`Settings/tabs/VoiceTab.tsx:212`) |
| Voice | dictation, STT provider, cleanup, language, playback, TTS provider, voice, speed, hands-free | no — `browser_local` | no |
| Network | egress on/off, the global allowlist | yes | yes |
| Advanced | memory budget, release channel, and the toggles: inject messages mid-turn, auto-fix CI, auto-resolve conflicts, start from latest base after merge, multi-agent sessions | yes | yes |
| Advanced | compact conversation, browser notification, sound | no — `browser_local` | no |
| Project · Deployments | the agent-merge permission | yes | yes |
| Project · Secrets | secret names | names only | no — `secret` |
| Project · Appearance | repository colour | yes | yes |

Five things the dialogs appear to hold and do not, each an exclusion with this
reason. The inventory is the part of this design most likely to be wrong, which
is what the coverage walk is for.

- **Installed harnesses** — *"a statement, not a control"*; harnesses come from
  the image (`Settings/ServicesPanel.tsx:418`).
- **Egress enforcement state** — computed.
- **The Skills tab** — discover-only, no installed list and no uninstall;
  install is repo-targeted and opens a PR in its own session (`SkillsTab.tsx:1`).
- **Per-session egress hosts** — the Network tab deliberately loads the global
  list only (`SettingsEgress.tsx:218`); a session host comes from the egress
  prompt card.
- **Deployment configuration and hosting tokens** — the Deployments tab holds one
  toggle plus copy and outbound links (`ProjectSettings.tsx:76`–`120`).

### Browser-local settings

Part of both dialogs lives in `localStorage` (`stores/settings-store.ts:396`).
These are **named and explained, nothing more**: read and propose both refuse
with `browser_local`, and `list` says *set in the browser; ShipIt's server does
not hold this value* — the honest limitation req 5 provides for.

Two shapes were tried and dropped: per-viewer snapshots give "this browser" no
server-side meaning with two open, and a browser-side apply has no baseline and
would need a grant/acknowledge protocol with a tab that can close, to flip a
preference the user can toggle in one click.

## Reading

```
shipit settings list [--tab network] [--json]
shipit settings get advanced.enableSubAgents
```

Both carry the explanations the existing views compute — a role's
`RoleUnavailableReason`, a slot's `pin_unavailable`, whether egress enforcement is
active — so the agent says *why*, not only *what* (req 3). Derived status is not
declared, but a declared setting's read may carry it as the reason that setting
is not doing what the user expects.

**A setting that cannot be read degrades to an entry, never an error.** With no
bound repository, project entries read *unavailable* and `list` still returns
every global setting.

### An item-addressed setting is read in the same two steps

A key alone does not name one value: `roles[].model` exists once per role,
`mcp.servers[].url` once per server. That changes nothing about the shape of the
read. `list` emits **one entry per declaration and never one per item** — its
length is the catalogue's, whatever number of roles or MCP servers someone
happens to have — and it names the instances that exist. `get` is where the
items themselves are, each with the address a change to it would name and what
it is set to. There is no `--item` selector: the read is two steps, and a third
would not be the same shape for a setting that has one value.

An item's **address goes through the projection door its value does**. An
address is the user's own text for a role, an MCP server, a secret and an
allowlist entry, so it is projected through the collection declaration that owns
the key — `roles`, `mcp.servers`, `project.secrets`, `network.egress.hosts` —
which is where emitting those names was decided and reasoned. An entry that
collection's projection refuses to name, such as a URL pasted into the allowlist
box, is named by nothing and produces no item at all; the read says how many it
left out. Where the address is ShipIt's own — a reviewer slot, a catalogue
service id, a provider id — it needs no projection and has none.

Reading a setting a panel of its own owns needs a reader per owner
(`services/settings-store-readers.ts`), because a `bespoke` declaration names
where its value lives and not how to read one back. A reader returns the stored
value and never a formatted one, so `projectSetting` / `formatSetting` stay the
only door. **A reader never substitutes a default for a value it could not
read** — an absent store, a repository ShipIt has no record of, a read that
threw all degrade to an entry with the reason, because a plausible default is
worse than nothing: the agent states it to the user as fact.

**A reader reads the store the declaration names, which is not always the
obvious one.** An MCP server's environment and headers hold `$secret:`
references and the panel writes one for every key row even where the user left
the value blank (`McpServerSettings/utils/payload.ts:45`), so the config alone
says a name exists and not that the server can start. `configured` there means
every reference resolves, because one that does not stops the server
(`session/mcp-resolve.ts:60`); the count of unresolved ones rides with the item.

### Saved is not effective

"Saved, applies after a restart" is false for a sandbox whose network capability
is off: it is contained, so no restart grants it a global allowlist host — a
false promise in exactly the case the user is unblocking.

Effectiveness is **computed**, not inferred from whether a reload ran.
`egressHostReach` already resolves a host against containment, resolved config and
DNS-control deployment, and the route returns it as `reach`
(`api-routes-egress.ts:110`–`119`). Four answers: **live**;
**restart-dependent**; **excluded for this session**, with the reason (here, the
session's network capability is what must change); **uncertain**.

**An install that cannot enforce containment is not an install where containment
is irrelevant.** The enforcement status has three values and only one of them
means nothing is decided: `disabled` (`SESSION_EGRESS_ENFORCE=0`) installs no
firewall, so the setting really does change nothing. `no-sidecar` is enforcement
ON with no sidecar image, and `container-lifecycle.ts:747` **throws rather than
start a contained session** — so the setting is not irrelevant, it is what is
blocking the container, and req 3 is precisely the requirement that the read say
so. `detail` therefore carries either why a value is not live **or** what its
being live costs.

**The refusal is a suffix on every branch, never a branch of its own.** It
answers a different question from the rest of the probe: those say what is true
of the session now — a container's start-time topology, a per-session override, a
capability it cannot change — and the refusal says what its next start does. Both
are true at once, and returning early on the refusal silently drops the other
answer: a sandbox read would stop at "your network capability must change" when
granting it still leaves global containment on, and a container already running
when the sidecar image went away would be told it cannot run. That container
keeps the firewall and the allowlist it started with;
`container-lifecycle.ts:747` governs creation, not an existing container.

**And a `live` detail has to survive the CLI.** `shipit settings list` marks only
the settings that are *not* live, and `get` printed "In effect: yes" and dropped
the detail — so the refusal reached `--json` and nothing else, which is the half
of the output the agent actually reads. A `live` entry carries a detail in
exactly one case and it is this one, so both renderers print it.

The same four apply to any setting whose stored value and live effect can differ,
and the gap is not only egress: `setChannel` writes the channel then calls
`checkForUpdates`, which can throw after the write lands
(`services/updates.ts:255`), and an MCP change calls
`refreshAgentEnvForAllSessions`, which returns `void` and only logs per-session
failures (`session-agent-env.ts:186`) — so an apply cannot know every session
refreshed.

## Proposing

```
shipit settings propose advanced.enableSubAgents=true \
  --reason "The review you asked for runs as a separate agent."
```

Posts the card, returns its id, does not wait. One card carries **one** change.

**The server takes the snapshot.** `propose` reads the current value itself and
captures the displayed `from` and the private baseline in one read. The agent's
earlier `get` informs what it proposes and sees the last outcome; it is not in
the correctness chain. Carrying `from` from that earlier read would let a value
that moved in between give the card a `from` the baseline never saw.

**Validated twice.** At propose time the key must exist, be proposable, and the
value must validate — refused with the reason before any card is posted. Again at
apply time, because a card outlives its turn and a model can leave the catalogue
or a harness be uninstalled (`services/roles.ts:102`, `:128`). One qualification:
role saves validate with purpose `"save"`, which deliberately skips credential
eligibility so *"disconnected roles must remain editable"*
(`services/role-settings.ts:142`) — so a proposal does not refuse a role whose
credential was removed; it saves and reports the role as not currently runnable.

**`--reason` is untrusted.** Flattened to one line and capped, as bug-report
titles are (`services/bug-report.ts:72`), and rendered as attributed text. The
setting name, `from` and `to` come from the registry and the server's own read —
that separation is what stops a reason describing a different change than the
button applies. Flattening is presentation hygiene, not a secret defence; the
projections are that.

[`mockup.html`](./mockup.html) shows the card: pending, all eight terminal
states, and the saved-versus-effective case, in both themes.

## Applying

A `settings_proposal_decision` WebSocket message, in a new
`ws-handlers/settings-proposal-handlers.ts`. The egress prompt card
(`ws-handlers/egress-handlers.ts`) is the nearest existing machinery but not a
template: it mutates from the client's message without loading or claiming a
proposal, safe only because its decision is one idempotent host add.

**Dismiss is its own short path**: load, then one atomic `pending → dismissed`.
No lock, no re-read, no revalidation — declining cannot become stale and cannot
fail *validation*, whatever the setting is now. Its durable write can still fail,
like any other.

Apply:

1. **Load from persisted state**, keyed by owning session plus card id. The
   message supplies only those and an action.
2. **Claim atomically, without yielding** — one operation that conditionally
   flips the persisted phase `pending → applying` **and** syncs the card in
   `runner.recordedCards`. A database-only claim is undone when the next turn
   snapshot rebuilds in-progress rows (`chat-history.ts` → `replaceInProgress`),
   after which a second click claims it again.
3. **Inside the conflict-domain lock**: re-read, compare the stored **baseline**,
   revalidate. Any mismatch resolves `stale` and applies nothing. The comparison
   is against state, never an observed transition.
4. **Apply**, then write the terminal phase.

**The baseline is not the displayed `from`.** Projections drop fields, so two
stored configurations can share a `from` — a target that changed only in a
dropped field would compare equal and apply anyway. `baseline(ctx)` is a
server-only revision over the whole stored value.

Phases:

- `pending` → `dismissed`
- `pending` → `applying` → `applied` | `partial` | `uncertain` | `stale` |
  `refused` | `failed` | `unknown`

`unknown` is a card found in `applying` after a restart. Boot recovery converts
those **before the decision handler accepts anything**, so a card is never
actionable and mid-apply at once, and it is never retried — the side effect may
already have run.

**Who can resolve.** In container mode the container guard's
`containerAccessible` opt-in plus caller-session comparison keeps a session
container out (`api-container-guard.ts:175`–`190`). In `RUNTIME_MODE=local` there is no such
boundary — the guard returns early with no container manager (`:135`) and the
WebSocket origin check passes a handshake sending no Origin
(`api-origin-guard.ts:245`). `requirements.md` → Known limitations records why
that is accepted and pre-existing.

### The target, and the lock

A declaration key is not enough. `project.allowAgentMerge` exists once per
repository; `mcp.servers[].enabled` once per server. Every proposal carries a
**target**: the key plus a concrete address — repository, item id, or nothing.
The target is the card's subject, the `lastProposal` lookup, and the apply. A
project target is **frozen** when the card is written, and apply verifies the
session still binds that repository.

The **lock is coarser than the target**. A role's model tuple, an edit to that
role's effort, and the dialog saving the whole role all write one stored role, so
they take that role's **conflict domain** — the stored object an operation
writes. Every writer of that object takes it, including whole-object dialog
saves.

The lock is **re-entrant for the domains a caller already holds**, and that is
what makes step 3 possible: a decision holds the target's domains across its
baseline re-read and the `settings-apply.ts` operation that writes it, and that
operation takes the same domains. Checking outside the lock would leave the gap a
dialog save lands in. A nested call naming a domain its caller does **not** hold
is refused by name rather than left to deadlock against an opposite-ordered pair.

Serialization buys ordering, not conflict detection. The MCP editor captures the
whole server object when it opens (`McpServerSettings/hooks/useMcpFormState.ts:27`),
so a form opened before a card applies overwrites it in correct order. That is
pre-existing last-write-wins, named here so the lock is not read as fixing it.

### The unit of a change is the declared operation

Field-level declarations are for **discovery**. They are not the mutation unit:
picking a role's model rewrites service, billing mode and model id together and
re-derives harness and effort (`Settings/roles/RoleEditor.tsx:93`), so field-by-
field proposals would require invalid intermediate states. The declared operation
is the tuple, shown as one change and validated as one.

### Collections are patched, never replaced

`roles`, `egress.hosts`, `mcp.servers`, `credentialRoutes`, provider accounts and
`secrets` (names only) use domain-specific item operations.

1. The agent supplies a **narrow patch**, merged server-side. It never supplies a
   whole object — it cannot see the credential fields inside one, and
   `updateMcpServer` replaces what it is given (`services/mcp.ts:170`).
2. Whole-list replacement is not offered.
3. An operation whose full effect cannot be displayed is refused.

Worked pair: *disable the server named `notion`* is allowed — one boolean the
card shows in full. *Change its URL* is refused — the projection shows only the
host, so the card would either display less than it changes or echo a path the
agent may not read back. The test is not size; it is whether the card can show
all of it.

### What a card can apply today

A declaration says a setting MAY be proposed; `services/settings-operations.ts`
says what changing it means, and the two are separate because a field-level
declaration is for discovery and is not the mutation unit. Every declared payload
scalar is proposable through one generic operation, so a setting declared
tomorrow is proposable the same day (req 7). Named operations cover the release
channel, egress containment and one allowlist entry, the two project settings, an
MCP server's `enabled` flag, a role's description, standing instructions, model,
harness and level, both reviewer slots, and the per-mode routing settings.

The rest is declared, readable and **refused at propose time by name**: creating
or deleting a role, an MCP server or a credential, and the credential and
provider-account labels. That refusal is deliberately not one of the catalogue's
four reasons — those describe settings nobody can propose at all, and this one
says the read works and the write has not been built.

## Apply goes through a shared layer

Calling the service under a route does **not** inherit the route's behaviour:

- `EgressAllowlistStore.addHost` writes one row (`egress-allowlist-store.ts:29`).
  Unsuppressing a built-in default, the broadcast and — for a **session** host
  only — the live `reloadEgress` with its fail-closed 503 live in the route
  (`api-routes-egress.ts:168`–`185`). A global addition does no live reload.
- `saveGlobalSettings` invokes caller-supplied callbacks
  (`services/settings.ts:363`, supplied at `api-routes-bootstrap.ts:128`) and
  **broadcasts nothing** — the dialog gets away with it because each toggle
  writes its own browser store before the PUT (`tabs/AdvancedTab.tsx:124`).
- MCP routes call `refreshAgentEnvForAllSessions` (`api-routes-mcp.ts:129`).
- Revoking agent-merge cancels pending merge requests and broadcasts `repo_list`
  (`api-routes-session-repos.ts:266`–`277`).

**Every writer goes through the shared layer**, and there are more than the
settings route:

| Writer | Setting |
|---|---|
| `ws-handlers/egress-handlers.ts:30` | global allowlist host, from the egress card |
| `api-routes-updates.ts:19` | release channel |
| `api-routes-session-repos.ts` | agent-merge permission, repository colour |
| `api-routes-bootstrap.ts:92` | git identity |
| `:265` / `:331` | credential routing order / provider-account order |
| `:226` / `:309` | a credential's label / a provider account's label |

A **settings broadcast is added** — new work, not inherited. A broadcast does not
reach a viewer that was away, and refreshing beside chat-history hydration is not
enough: that path needs an active session (`useConnectionSync.ts:78`) and the
dialog can be open on the home screen, while the global SSE `onopen` only resets
its retry counter (`useServerEvents.ts:734`). The refetch hangs off **the global
connection's recovery**. An editor with unsaved edits keeps its draft and says the
underlying value changed.

### "Saved" has to mean saved

`CredentialStore.save()` catches its disk-write failure, logs, and returns `void`
(`credential-store.ts:255`) — so an apply would report *saved* for a value that
disappears at restart. The store already knows better in one place:
`stampHarnessOnboardingCompleted` rolls the in-memory value back on failure,
*"memory-only completion would vanish at restart"* (`:268`). This feature
generalises that contract per declaration.

Three shipped writers need it:

| Writer | Today |
|---|---|
| `CredentialStore.save()` | logs, returns `void`, value survives in memory |
| `writeGlobalSystemPrompt` | swallows the `unlink` error when clearing instructions, so "cleared" can be false (`global-system-prompt.ts:25`) |
| `setGitIdentity` | two `git config` calls; the name can land and the email throw (`git-config.ts:212`) |

So three outcomes, not two: **`failed`** means verified nothing changed, and only
a writer that can prove rollback may claim it; **partial** means some of a
multi-write operation landed; **uncertain** means the writer cannot say. This is
the first item of the apply extraction — every other guarantee is worthless if
"applied" can be false.

## How the agent learns the outcome

`shipit settings get <key>` carries `lastProposal`, and the agent reads before
proposing anyway:

```json
"lastProposal": { "cardId": "set-7f3a", "phase": "dismissed",
                  "from": false, "proposed": true,
                  "proposedAt": "…", "resolvedAt": "…", "sessionId": "…" }
```

| `phase` | The agent |
|---|---|
| `pending` | does nothing — a card is in front of the user |
| `applying` | does nothing — the next read tells it how this ended |
| `dismissed` | does not re-propose *that value* unless asked |
| `applied` | does nothing; `value` reflects it |
| `stale` / `refused` | may propose again, from the current value |
| `partial` | says which half landed and proposes the rest |
| `failed` | may propose again, saying the last attempt failed |
| `uncertain` / `unknown` | reads the value and says the outcome was not verified |

It is the last proposal **for the target, from any session** — what the user did
about a setting is a fact about the setting. It is one record, deliberately: a
dismissal followed by another session's proposal leaves only the latter, so this
is not a durable veto and is not claimed as one.

A **pending card does not block** a second proposal; reporting it is enough. A
card nothing expires would otherwise become an indefinite veto from a session the
user has forgotten, and the conflict is already handled — a card whose baseline no
longer matches resolves `stale`.

### And a notice on the next turn

The read only helps an agent that thinks to read (req 8). So a resolved card also
prefixes the agent's next turn: `services/settings-outcome-notice.ts` joins the
same `agentPrefix` chain the bug-report notice does
(`ws-handlers/agent-execution.ts`, `dispatched-turn.ts`), outcomes batch into one
notice, and it never starts a turn of its own.

**Delivery is at-least-once, deliberately** — and that is the one thing NOT
copied from the bug-report machinery, which marks an outcome told *before*
delivery (`chat-history.ts` → `consumeUnreportedBugOutcomes`) and so loses one
for good when the turn then fails to spawn. Acceptable for a convenience; not for
a requirement that says the agent *is* told. No layer here proves the agent read
a prompt either: the turn-start broadcast precedes submission, the proxy's
submission methods return before their worker request completes
(`proxy-agent-process.ts:77`, `:91`), and a worker HTTP success can still be
followed by a failed spawn or dead stdin.

So the read and the acknowledgement are two calls, not one.
`prepareSettingsOutcomeNotice` reads the session's resolved-but-untold cards
**without marking any**, and hands back a `NoticeDelivery`
(`turn-settlement.ts`) whose `delivered()` the executor calls.

**The signal is positive, and it is not a verdict over `TurnOutcome`.** Two
shipped shapes rule that out, both found in review:

- A quota refusal on a route that **cannot fail over** — `stopsOnFailure` is
  `billingMode === "key"` (`credential-failure-policy.ts`) — arrives as an
  ordinary `agent_result` and falls through to normal teardown, so the turn
  settles **`completed`** with nothing having run. Neither "produced output" nor
  `agent_result.status === "success"` is the test either: the CLI reports its own
  limit as final text on a `success` result, which
  `detectHardExhaustionInTurnText` is there to catch.
- A **resident streaming** turn settles no turn at all: the streaming
  `agent_result` branch runs its post-turn work and never calls `finishTurn`,
  because the CLI stays alive and emits no `done` — and the next reuse discards
  that executor's listeners (`dispatched-turn.ts`), so a receipt waiting on
  settlement is lost for good and the notice repeats on every turn forever.

So `delivered()` is called from **one place**: the `agent_result` handler, after
the `exhausted` check and the failover decision, and only for a result that is
neither exhausted nor an error (`event.error` or `status === "error"`). That is
what puts the acknowledgement after ShipIt's credential-failure classification
and failover retry (`quotaRetryInProgress`) — a retry re-dispatches the same
prompt, carrying the same receipt, so only the attempt that actually ran
acknowledges. Every other path — a crash, an interruption, the all-refused
report, a turn that never spawned — simply never calls it.

**`agentNotified` is a column on the private proposal row, not a card field** —
it is ShipIt's bookkeeping about a delivery, and nothing a viewer reads.

Duplicates remain possible by design: a turn that ran and was interrupted, and a
turn queued behind one that has not yet acknowledged, both carry the notice
again. That is the safe direction: a duplicate costs a line of prompt; a lost one
is the failure req 8 exists to prevent. **The notice prompts; `lastProposal`
decides** — so its closing line sends the agent to the read rather than inviting
it to trust that it was told once.

## Persistence

The card is transcript content, so it takes the recipe from CLAUDE.md and
`docs/188-persist-transcript-cards`: a typed
`PersistedMessage.settingsProposal`, a column plus `toRow`/`fromRow` and a
migration, rehydration in `loadSessionHistory`, registration in
`CARD_MESSAGE_FIELDS` and `TRANSCRIPT_SCOPED_MESSAGES`, an extension of
`EVERY_OPTIONAL_FIELD_MESSAGE`, and round-trip plus no-duplicate-on-replay tests.

Emission goes through **`emitChatCard`** (`chat-card-persistence.ts:110`), never
a bare `emitMessage` — a propose from a backgrounded `shipit agent run` can land
after the turn ends, and it decides between riding the turn and appending a final
row (`:128`).

**One transition contract, and it is not `persistCardTransition`.** Every phase
change — claim, dismiss, terminal — goes through one function of this
feature's own: write the durable row unconditionally, then, only if a runner
exists, sync the recorded card and emit. `persistCardTransition` requires a
runner (`:156`) and runs its database callback **only** when it did not patch an
in-flight card (`:174`), so a card could end durable-but-unsynchronized or the
reverse. It may serve the runner-present half; it cannot be the contract.

**The private baseline is not a card field.** Transcript projection returns a
message's fields unless something strips them
(`transcript-projection.ts:358`), so a baseline on the card would reach every
viewer and every replay. It lives in a separate proposal row keyed by card id.

**Settlement does not need a runner.** A card may be clicked hours after its
turn. The post-turn lease is not a substitute — `POST_TURN_HOLD_MAX_MS` is 120 s
(`post-turn-hold.ts:1`).

## Trust boundary

- **Credential fields are unreachable by construction** — derived-output
  projections, narrow patches, refusal where the effect cannot be shown. Not a
  claim that no secret can appear anywhere: a `user_text` setting is the user's
  own prose, shown because it is theirs.
- **Ingested text cannot change a setting.** A repository file, a web page or a
  tool result can at most make the agent *propose*; the click is the gate (req 4).
- **The card, not the message, is the source of truth** for what is applied.
- **No extra gate for sandbox sessions** — the card lands in that session's
  transcript and the click is the user's.

## Agent-facing docs

New `src/server/shipit-docs/settings.md`: the commands, the projection rule, the
one-change rule, reading before proposing, saved versus effective, and the phase
table above. Then rewrite the places that send the user to a control — `agent.md:22`
and `:367`, `issues.md:257`, `compose.md:624`, `android.md:253`,
`github.md:263`, `environment.md:241`, `skills.md`.

State there that a proposal card replaces the `[needs you]` line for that change:
CLAUDE.md's "Responding in chat" rule already says the list never repeats an
affordance ShipIt's own UI puts in front of the user.

## Key files

New: `shared/settings-catalogue/` (declarations, `type` constructors, the
derivations, `exclusions.ts`); `client/components/Settings/setting-binding.ts`
(`bindSetting`, `settingCopy`) and `declared.tsx` (the standard controls);
`client/components/Settings/settings-coverage.test.tsx` (the residual guard);
`services/settings-store-readers.ts` (a reader per owner, for the settings a
panel of its own stores); `services/settings-read.ts` and
`api-routes-settings-agent.ts` (the two
session-scoped, container-accessible reads `GET /api/sessions/:id/settings` and
`…/settings/detail?key=`); `services/settings-apply.ts` (the shared writers and
the broadcast), `services/settings-conflict-domain.ts` (the lock) and
`services/settings-baseline.ts` (the per-declaration revision);
`shared/settings-catalogue/apply-outcome.ts` (the four outcomes);
`settings-proposal-store.ts` (the private proposal row: target, operation,
proposed value, baseline, phase); `services/settings-proposal.ts` (the card as a
transcript object: post, claim, transition); `services/settings-propose.ts` (the
propose path and its refusals); `services/settings-operations.ts` (what an Apply
button runs, per declared operation); `services/settings-decision.ts` (claim,
lock, baseline, apply, and the boot pass that resolves an interrupted one);
`services/settings-proposal-deps.ts` (one assembly both callers share);
`services/settings-outcome-notice.ts` (the next-turn notice and its deferred
receipt); `ws-handlers/settings-proposal-handlers.ts`;
`shared/settings-catalogue/tabs.ts` (the tab labels the dialog and a card's
breadcrumb share);
`session/agent-shim/shipit-settings.ts`; the client card handler and component;
`shipit-docs/settings.md`.

Changed: `credential-store.ts`, `global-system-prompt.ts`, `git-config.ts`,
`services/settings.ts`, `services/settings-derivation.ts`, `services/types.ts`,
`api-routes-bootstrap.ts`, `api-routes-egress.ts`, `api-routes-mcp.ts`,
`api-routes-updates.ts`, `api-routes-session-repos.ts`,
`ws-handlers/egress-handlers.ts`, `turn-settlement.ts` (`NoticeDelivery`),
`turn-executor.ts` (`noticeDeliveries`, acknowledged from the `agent_result`
handler), `dispatched-turn.ts`, `session-runner.ts`,
`runner-registry-factory.ts`, `bootstrap-managers.ts`,
`client/utils/session-data.ts`
(`refreshGlobalSettings`), the settings tab components and the bespoke
panels they host (`ServicesPanel`, `CredentialRouting`, `ProviderAccountRows`,
`RoleEditor`, `ReviewerSection`, `McpServerSettings/*`, `SettingsEgress`,
`SettingsTrackers`, `GitHubTokenForm`, `KeybindingSettings`, `SecretsTab`,
`DeclaredSecretRow`, `AgentPermissions`, `RepoColorPicker`), `pickers/Picker`
and `ServiceSelector` and `ui/overflow-menu` (each takes the binding through to
its trigger), `session/agent-ops-routes.ts`, `agent-shim/shipit.ts`, the WS
message types, `chat-history.ts`, `database.ts`, `visual-elements.ts`, the
client message-handler index, `useServerEvents.ts`.

## Sequencing

1. **The catalogue, its derivations, and `list` / `get`.** Where req 7 is
   satisfied and the existing duplication collapses; useful alone (req 1, 3, 5).
2. **The proposal card** — propose, claim, lock, revalidate, apply, transcript
   card, notice (req 4, 8).

Splitting keeps a refactor of shipped settings paths out of the same diff as a
new transcript card.

## Testing

Beyond the persistence round-trip tests:

- **Derivation** — a setting added to the catalogue and nowhere else is readable,
  described, route-round-tripped and typed, with no other edit. This is req 7
  executable; a second edit anywhere means the derivation is incomplete.
- **Field-level declaration** — a new MCP form field bound to the panel's entry
  rather than its own fails.
- **Residual coverage** — including conditional and nested forms, and a control
  with no test id.
- **Projection safety** — the MCP token fixture, in every output path.
- **Atomic claim** — two concurrent decisions produce one apply; a turn snapshot
  between claim and apply does not restore `pending`; applying during a different
  turn, with no recorded-card entry, and after the runner was recreated. Removing
  either half of the claim must fail its test alone.
- **Baseline, not `from`** — a target that changed only in a projection-dropped
  field resolves `stale`. Comparing `from` instead must make this test green with
  the bug present.
- **Conflict-domain serialization** — a card apply, a dialog PUT and an edit to a
  neighbouring field of the same object do not interleave.
- **Write truthfulness** — a failed disk write reports `failed` and the value is
  rolled back; a git-identity half-failure reports `partial`.
- **Saved versus effective** — a global egress add reports restart-dependent for
  an ordinary session and **excluded for this session** for a contained sandbox.
- **Restart** — interrupted claims resolve `unknown` on both sides of the write,
  converted before decisions are accepted.
- **Notice** — consumed once; a turn where every account refuses for quota
  acknowledges nothing and a later runnable turn still receives the outcome.
- **Unbound session** — `list` returns every global setting; project `get` and
  `propose` refuse.
- **Reconnect** — a viewer away when a change applied shows the new value.
- **Frozen project target** — a card for repo A is refused after a rebind.

## Risks

- **Converting the existing settings is the bulk of the work** and touches
  shipped paths. The existing settings, egress, MCP, updates and repo route tests
  are the safety net — run them before and after. The global scalars are
  mechanical; the bespoke panels are not, since field-level declarations mean one
  entry per editable field.
- **A partial conversion weakens req 7 silently.** Until `GlobalSettings` and the
  route body actually derive, an undeclared setting still works and the agent
  still cannot see it. The derivation lands as one piece for the global scope.
- **Collections are the remaining work.** If the build runs long, ship scalars
  plus `network.egress.hosts` first. Declarations for every setting still ship —
  req 5 and req 7 are about seeing and being told, so deferring a collection's
  **writes** is acceptable and omitting its **declaration** is not.
- **Local mode enforces no click gate.** The card is a real gate in container mode
  and a convention in local mode; do not write a test asserting otherwise.
