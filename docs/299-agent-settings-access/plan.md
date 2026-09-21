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
| a declared global boolean's **save wiring** | the optimistic write, the `PUT` payload, the rollback and the toast, from `wire` and `label` (`Settings/declared-setting.ts`) — including the overlap rule, since a toggle is one click and two of them overlap the moment the user changes their mind: a failed save reverts to the value the **server** last accepted, and only from the newest request, because reverting each save to the opposite of its own requested value leaves the browser showing what nobody holds |
| `shipit settings list` / `get` | **the agent sees a new setting the day it is declared** |

The last row is req 7, holding structurally rather than by a guard test: the
agent's view is a projection of the table the server persists from.

**What is DERIVED and what is only DETECTED, said plainly.** Req 7's second
sentence — no way to ship a setting the agent cannot see — is carried partly by
derivation and partly by a guard that names the omission, and the two are not
the same guarantee.

| | Holds because |
|---|---|
| the payload, its validation and the store accessor | derived from the declaration |
| `shipit settings list` / `get` | derived: the read projects the registry |
| a global boolean's control **and its save** | derived: `<DeclaredToggle settingKey="…" />` is the whole of it |
| the **browser store field** a global boolean lives in | detected — it is hand-written and read across the app, so a declaration whose `wire` field or `set<Wire>` setter is missing drops out of `DeclaredBooleanKey`, and binding a control to it without supplying the two props is a compile error naming the setting |
| a **reader** for a setting a panel of its own owns | detected — a reader is per-owner code and cannot be generated; `BespokeSettingKey` makes a missing one a missing property |
| a **stored field** nobody declared | detected — `MCP_SERVER_FIELD_SETTINGS`, `ROLE_FIELD_SETTINGS` / `ROLE_PARAMS_FIELD_SETTINGS` |
| a **control** nobody declared, or one naming another tab's declaration | was detected by the coverage walk. Since docs/308 slice 8 it is **impossible** for a generated row and **unchecked** for a panel's own controls — see *The residual guard* |
| a control bound to a **different field's declaration on its own tab** | neither, and never was. No guard reading the DOM could decide it |

A bespoke panel's fields — the role editor, the MCP form, the credential rows —
are the part that derives least: each needs its declaration, its reader and its
operation. That is the shape of the code, not an oversight, and the guards above
are what stop a step being skipped silently.

`GlobalSettings` **splits** rather than deriving whole — it also carries computed
status (`canRunTurns`, the agent list, resolved reviewer and role views) which is
not a declaration. The stored half derives; the computed half stays
hand-assembled beside it. The wire shape is unchanged.

### Bespoke panels declare per field

The role editor, credential routing, the MCP panel and the secrets table keep
their own components, but **a declaration is per field, not per panel** — and
each field renders the declaration's **description**, not only its label. A
bespoke panel that shows a label and writes its own help text beside it is the
drift req 7 forbids, and since docs/308 slice 8 nothing checks a panel's copy at
all: the MCP form's suffixes ("(space-separated)") and the routing
band's tooltips were both authored twice, and the agent read the copy the user
could not see. Both now render `settingCopy`, and the band's one licence is to
swap the collective noun the card shows (docs/252 req 19) and edit nothing else. One
entry for `mcp.servers` would let a developer add a field, bind it to that entry,
pass every test, and ship a field with no description, no projection rule and no
refusal reason. So each editable field is its own declaration
(`mcp.servers[].command`, `…[].url`, `…[].env`) and a field with no declaration
has nothing to bind to.

### The residual guard

> **Deleted, and deliberately not replaced.**
> `docs/308-data-driven-settings` req 12 removed this walk and the `data-setting`
> attributes it read, once every row in both dialogs was *generated* from the
> declarations: a generated row takes its words from the declaration and exists
> because the declaration exists, so a control nobody declared has nowhere to be.
> What that gives up is bounded and was accepted on the corrected facts — nothing
> now checks that a PANEL's copy matches its declaration, or that a
> panel-owned declaration still has a control. The stored-shape maps
> (`MCP_SERVER_FIELD_SETTINGS` and its siblings) are unaffected: they run in the
> opposite direction and are compile errors rather than tests.
> **The rest of this section describes the guard as it was**, and is kept as the
> record of what it proved.

Derivation cannot stop someone hand-writing a control that was never declared, so
one backstop test renders each tab, enumerates its interactive elements and fails
on any that is neither a declaration nor a reasoned `not-a-setting` exclusion.

**The element list is widened past the handful the dialogs use today.** It was
`input`, `select`, `button`, `textarea`, `[role=switch]` and the two menu-item
roles that carry a value — so a `contenteditable` box or a hand-rolled
`[role=checkbox]` was a control no rule could fail on, whatever it bound. Every
value-carrying ARIA role is now named beside the tags, and `contenteditable`
counts on any value but an explicit `false`. It remains an **enumeration**, so a
gap in it is still a silent pass rather than a visible one; that is the reason to
keep it ahead of the shapes in use rather than level with them.

Match on the declaration binding, falling back to accessible name — **not** on
`data-testid`, which identifies a control without proving it shares the
declaration's description and policy (and the MCP env/header editor has none at
all).

**The forms are not listed; they are crawled.** The walk used to open the nested
and conditional ones by name — the MCP stdio and HTTP variants, a populated
credential row, an expanded role editor — and a list of forms is a list somebody
maintains: the SSH add-a-destination form was never on it, so its four boxes were
controls no test could fail on, and three of them turned out to write stored
values (address, user, port) that no declaration described. The walk now presses
every trigger in scope and walks whatever appears in the document as a result,
inside the pane or in a portal beside it; what one press discloses is itself in
scope, so a form inside a form is reached with nothing naming either.

**A toggle is a trigger too.** Switches and checkboxes were left out of the
crawl's triggers on the reasoning that the walk already accounts for the toggle —
true of the toggle, and not of the field it GATES. Voice delivery renders its
webhook boxes only once delivery is external, and the fixture had to seed that
state by hand for them to be on screen at all; a gate nobody thought to seed was
a form the crawl could not open. Flipping one is as safe as pressing *Reset
Everything* already is: a write either leaves through `fetch`, which the fixture
rejects, or lands in the test's own `localStorage`. Neither outlives the test.

One gate this does not reach, stated rather than implied. A **declared** global
toggle saves optimistically and **rolls back** when the write fails
(`saveDeclaredBoolean`), and the fixture makes every write fail — so a field
gated behind one can be gone again before the crawl looks, since the walk runs
after `userEvent.click()` resolves. No gate in either dialog is of that shape
today: the ones that exist are browser-store values, which never call `fetch` and
so never roll back. Closing it means a fixture that answers settings writes
`{ ok: true }`, which is a change to what every press in both dialogs does — not
one to make for a shape no panel has.

Three bounds are stated in the test rather than hidden. Scope is the pane and
what the pane disclosed, never the whole document, so pressing the dialog's own
Close cannot end the crawl with nothing to report. A press that moves the dialog
to another **tab** is navigation rather than disclosure — the Voice tab links to
Keyboard — so the tab is started again and the crawl resumes. And a disclosure
behind something other than a press or a choice is not reached: typing, a drag, a
hover. Nothing in either dialog works that way today.

An exclusion may also cover a **region**: a container whose every control is that
one exclusion, named by `data-testid`. It exists for a surface whose controls the
INSTALL produces rather than anyone writing them — the supported-models dialog
renders one filter per (service, billing mode, harness) the catalogue holds, so a
name list there would be a copy of the catalogue that rots on the next entry. The
crawl does not press inside a region either, since the exclusion's claim is that
there is nothing in it to find; that claim is what review reads.

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

Two things the walk cannot decide are stated there rather than implied: a bespoke
panel's visible wording is a review matter unless the panel marks it, and a
`wholeTab` or `region` exemption is a claim `exclusions.ts` makes in prose. The
list of declarations the walk cannot reach is now **empty** — the add-a-provider
wizard was on it, described as "a flow rather than a pane", which was a statement
about the old boundary and not about the control.

**A control may only bind a declaration from its own tab.** A binding is an
attribute, so the walk's first question was only whether the named declaration
*exists* — and a new field in the role editor could name `advanced.liveSteering`,
pass every test, and reach the agent carrying a description for a setting that
saves something else. A declaration names its own tab, which is what makes the
mismatch decidable from the DOM.

**And a third, which the type system decides instead.** The walk reads rendered
DOM, so it can establish that a control names *a* declaration and never that the
declaration is the one whose property the handler saves — a box bound to
`mcp.servers[].command` while writing something else passes it. The stored shape
can say what the DOM cannot: `MCP_SERVER_FIELD_SETTINGS` is keyed by
`keyof McpServerConfig`, and `ROLE_FIELD_SETTINGS` /
`ROLE_PARAMS_FIELD_SETTINGS` by `keyof AgentRole` and `keyof RolePinnedParams`,
so a field added to a persisted type is a compile error until it is declared or
explained as not a setting. **The declaration it may name is derived from the
field's own name** — `mcp.servers[].${F}`, `roles[].${F}`, not any existing key —
because "mapped to something that exists" is the same pass the DOM walk gives,
and it is the loophole being closed. The two guards run in opposite directions:
the walk finds a control nobody declared, the map finds a stored field nobody
declared.

A role has two escapes from that derivation. The model tuple is one declared
operation, not three settings, so `serviceId`, `billingMode` and `modelId` are
`partOf: "roles[].model"`; `harnessId` is declared under what the user picks
(`roles[].harness`). **`partOf`'s target is an enumerated allowlist of those two
declarations, not any key in the roles family**: admitting the family left the
loophole open one step along, since a new field could name
`partOf: "roles[].description"` and a control bound to that same declaration
passes the DOM walk, so the field would ship undeclared exactly as before. Both
entries are aggregates rather than fields, and `fieldsDeclaredIn` names the one
nested map as a literal for the same reason — pointing at nothing must not
account for a field.

**One declaration is held by one control** — the arithmetic of that same rule,
where the DOM can see it. One declaration describes one field, so a second box
holding a setting's value means one of the two saves something else, and the
agent has no declaration for whatever that is. This is what catches the shape a
same-tab check cannot: a new browser preference writing a `localStorage` key of
its own while binding a boolean already declared on that tab. The setting it
borrowed still renders a control of its own, so the pair is visible.

What is counted is a **value**, not a control. Three exemptions, each stated
where the rule is. An **item** declaration is one field per row, so a list of
them is many controls binding one declaration honestly. A **composite** value —
the git identity, a secret bag, a model tuple — is several boxes by construction.
And a **segmented choice** counts once: `bindSettingOption(key, value)` writes
`data-setting-option`, and the **container** — `role="group"` or
`role="radiogroup"`, which a picker ought to carry anyway — is the choice.

**That last one is counted, not granted, and the difference is the whole rule.**
Written first as an exemption — any control carrying the attribute dropped out of
the count — it let a new box join an existing declaration by writing one word,
which is the loophole it was added to close. Three further checks make the
attribute a claim the walk tests rather than a password. An option must be
**selectable**: a box is typed into, so it is a field of its own however it is
labelled, and appending one to a real picker's container is the nearest thing to
a plausible mistake here. The options of one choice must be **distinct**, asked
per group rather than per declaration, because two rows of a collection each
render a picker over the same values honestly. And where the declaration offers a
set they must be **from it**.

The container carries the grouping because the immediate parent cannot: options
wrapped one to a `span` would read as one choice each — a false failure — and two
pickers rendered through fragments into one parent would merge. An option outside
any container falls through to being its own value, which fails the count rather
than passing it. Native ARIA radios take the same rule, and it is what tells two
of them apart: `RepoColorPicker` renders a `role="radiogroup"` of unnamed
`role="radio"` buttons, so grouping on a `name` that is not there collapsed every
such picker on a tab into one.

What stays undecidable, and is stated rather than implied. A role-editor box
bound to a *different role field's* declaration: the DOM cannot see which
property the handler saves, and the stored map cannot see the DOM — the same gap
for any collection item, since two rows are not distinguishable in rendered DOM.
A control claiming a declaration whose own control cannot be on screen at the
same time — the MCP form renders a command or a URL and never both, so there is
nothing to count twice. And a control that saves the declared field to the wrong
store, which belongs to the store and not to a walk over the dialog.

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

**That mark is a required argument, not an option.** It was optional, so two
projections claimed ShipIt's authorship by omission: `integrations.sshHosts`
emitted a destination's label and `network.egress.hosts[].host` an allowlist
entry, both the user's own text and both unmarked. `derived()` now takes the
origin as its third argument — `{ userText }` or `{ shipItComputed }`, each with
the reason — so the question cannot be skipped, only answered. Neither output
changed; what changed is that the declaration says whose text it is.

**A NAME the user typed is emitted only when it is shaped like a name.** Naming a
role, an MCP server or a missing secret is the whole of what the agent has to
tell the user, so these are emitted deliberately — but nothing constrains what
they are made of: `PUT /api/secrets` takes any string as a key and a role name is
checked only for being non-blank and short enough, so
`https://user:token@host/?token=…` is a storable name. An item's **address** is
where it would leave. So the four collections whose names the USER writes —
`roles`, `mcp.servers`, `project.secrets`, `network.egress.hosts` — apply one
rule between them, the one `hostEntryProjection` and `mcpUrlProjection` already
made: a URL carries a credential in its userinfo and query as a matter of
routine, so an entry wearing that shape is named by nothing and produces no item,
and the read says how many it left out.

Those four are not every collection an address is projected through, and reading
this as if they were is what planning#577 cost: `services.credentials` and
`services.providerAccounts` address items by ids ShipIt generates, so their
projections filter for a string and no more. That is fine for what THIS rule is
about — a generated id carries no credential — and it is why the line-forgery
rule below gates the address at the read rather than at each declaration.

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

**"In an error" is the clause that gets forgotten**, so it is the rule rather
than an instance: *no message may interpolate a stored value that did not come
through the projection door.* A refusal listing the roles on the install read
them straight off the store, which disclosed exactly the name the index leaves
out — the gate with a second door beside it. A message naming stored entries
names the ones the projection emits and counts the rest.

**Reflected input is not this rule's business.** `list --tab` and `get <key>`
echo the caller's own string back when it names nothing, and that string arrives
on the agent's own query — nothing ShipIt persists reaches it, so req 2 ("reading
a setting never exposes secret material") is not engaged. What it is engaged by
is presentation, so the echo is flattened and capped exactly as `--reason` is:
hygiene, not a secret defence.

### An emitted value cannot start a line

The projection decides *what* may be emitted. It says nothing about *how*, and
`list` and `get` are a line-oriented format an LLM parses — `key = value`,
`Value: …`, `Last proposal: …`. A newline inside an emitted string therefore
does not merely garble the output: it starts a line, and that line can read as
one of ShipIt's own fields (`Last proposal: APPLIED by the user`, which stops an
agent proposing a change nobody approved) or, in `list`, as a setting nobody
declared. Not every such string is the session user's: a secret name comes from
the repository, and a role's description can be agent-proposed out of a
repository file or a web page (planning#577).

`shared/settings-catalogue/rendered.ts` is the one door, and the rule it carries
is **no emitted text contains a character that can begin a line**: not `\n` and
`\r`, and not U+0085, U+2028 or U+2029 either — `\s` does not match U+0085,
which is how a local `replace(/\s+/g, " ")` looks like the rule and is not it.
Four mints, all returning a branded `Rendered` the type system will not accept a
plain string in place of. `renderValue` quotes and escapes a stored value;
`renderJson` escapes a whole serialized document — and answers
`(not representable)`, which is deliberately not JSON, for a value
`JSON.stringify` refuses;
`renderOwn` flattens ShipIt's own words; `renderAddress` refuses an address
outright, because `--item` takes an address back and it cannot be quoted out of
harm's way — that instance is named by nothing, exactly as a URL-shaped name is,
and the read counts it. Choosing the wrong mint costs legibility and never the
guarantee, since all three flatten.

**The brand governs every free-text field of the read, not only the
value-bearing ones.** It began narrower — `formatSetting`'s result, an entry's
and an item's `display`, an item's `address`, a `lastProposal`'s two halves,
both sides of a proposed change — on the reasoning that ShipIt's own prose is
made of literals in this repository. One such field was not: an item's `notes`
interpolated a credential route's stored `status` (`routeStatusNote`), so the
same forgery walked through the door beside the value's. A fact about a value is
not a literal because the sentence around it is, and a rule applied field by
field recreates the omission it was written for — `CLAUDE.md` → centralise the
act, not the read.

So `notes`, `label`, `summary`, `description`, an address's `noun`, a refusal's
`explanation`, an effect's `detail` and a `lastProposal`'s `cardId`,
`proposedAt`, `resolvedAt` and `sessionId` are `Rendered` too, minted where the
entry is built. The last four look like ShipIt's own — it writes an id and an
ISO timestamp — but they come back from SQLite with a cast, so the line's
guarantee is the read's rather than the writer's.

What stays plain: the union-typed fields (`phase`, `operation`, `state`,
`unreadableReason`), because the agent switches on them and each renderer
flattens where it turns one into text; `key`, a catalogue constant and the
address a caller passes back; and `value`, `shape` and `live`, the
machine-readable half — `value` is never printed, `display` being the line that
carries it, and the other two are serialized through `renderJson`.

**The escape covers a character of two code units.** The deny-set is matched
with the `u` flag, so one match can be one code point of two UTF-16 units — the
tag block and U+1BCA0 are format characters — and escaping the lead surrogate
alone left the trail one behind as a lone surrogate. On the text path that is a
garbled character; on `--json` it silently changed the value a reader parses,
which is the one thing that escape promises not to do.

**The rule reaches the surfaces beside the read.** The next-turn notice composes
one bullet from three persisted pieces — the setting key, the card's recorded
effect state, and a phase this build may not know — and it is rendered whole
rather than piece by piece, which is the shape of the `notes` defect one surface
over. The two role errors flatten `checked.message` for the same reason: it
names the role's stored harness, service, billing mode, model and level.

**The rule is a type assertion rather than a habit.**
`settings-read.test.ts` holds a compile-time guard (`PlainStringFields`) over
each view: a new string-typed field fails `npm run typecheck` until it is
minted. The allow-list grants four names — `key`, `value`, `shape`, `live` —
and each is a decision argued at the renderer rather than a claim about what
TypeScript prevents, since nothing stops `String(x)` printing an `unknown`. The
store readers mint at their own constructor (`unreadable()`), so a reader added
later cannot supply a raw reason.

The guard **looks through arrays, nested objects and union members**, and took
three passes to get there. The first tested each direct property, so
`notes: string[]` — the very regression it exists to prevent — passed it; the
second tested a union whole, so `string | null` passed; the third walked `{}`
for a dangerous key and found none, though `{}` accepts any string there is. A
guard that cannot fail on the defect it was written for is worse than none,
because it is read as coverage. Its remaining edge is a template-literal type,
which no mint produces and nothing here declares — recorded rather than claimed
away.

**`--json` is part of the boundary, not an escape from it.** `JSON.stringify`
escapes the C0 controls and stops, so a stored value carrying U+2028 put a real
line break in the agent's stdout while `display`, beside it in the same
document, was correctly escaped. The three `--json` paths serialize through
`renderJson`, which escapes the three survivors in the JSON spelling of the same
character — so what a reader parses is unchanged and only the bytes on the line
differ.

**A proposal's own metadata is stored text too.** `summarize` copied `cardId`,
`createdAt`, `resolvedAt` and `sessionId` from SQLite into the `Last proposal:`
line unrendered, and `proposalPhaseHeadline` echoed an unrecognised phase raw —
so a malformed row forged a SECOND `Last proposal:` line, which is the field an
agent reads to decide whether the user has already dealt with a change. All four
are `Rendered` now and the headline flattens its fallback. `phase` and
`operation` stay their unions, because the agent switches on them; each renderer
flattens where it turns one into text.

**The shim re-mints everything and re-QUOTES nothing.** The wire is `Rendered`,
so quoting a value again there would quote what is already quoted — but the
brand does not survive the hop, so every line is minted with `renderLine`, which
keeps such text byte-for-byte. What the shim composes itself is the `--item`
echo — flattened with `renderOwn`, that address being the argument THIS call
supplied rather than anything the read rendered — and the two JSON blobs in
`get`, which go through `renderJson`: `JSON.stringify` escapes the C0 controls
and leaves U+2028, U+2029 and U+0085 as themselves.

**"Trust what the read sent" was the hole, and the boundary is now structural.**
Three fixes for this one class each guarded the path in front of them and left
the next one open: stored VALUES (planning#577), then item NOTES, then the
MESSAGES a service composes — a refusal, a `ServiceError`, validator output —
which `checkRolePinnedParams` built from a role's stored harness id and the
settings preflight handed out unchanged (planning#537). Each fix was a mint at a
known path; the next path was not known yet. So the property established instead
is **anything the settings shim prints is `Rendered`**, carried by two things
that need nobody's memory:

- **The types demand a mint at each hand-off.** `SettingsOperation.preflight`,
  `RoleParamsCheck.message` and `ValidationResult.message` are `Rendered`, so a
  service that builds a plain string cannot return it as a refusal. A
  `ServiceError` caught and turned INTO a refusal is minted where that happens,
  which is the one place such a message becomes output.
- **The printer takes `Rendered`, and there is no second way out.** A brand does
  not survive HTTP — the shim receives plain JSON — so `settings-out.ts`
  re-mints, with `renderLine`, which keeps already-rendered text byte-for-byte.
  What makes it complete is that `shipit-settings.ts` is handed a `SettingsDeps`
  with **no `ShimIO` on it at all**: no `stdout`, no `fail`, no `success` in
  scope. Two `@ts-expect-error` assertions in `settings-out.test.ts` fail the
  build if either half is widened.

**What that does not close, stated rather than implied.** The types stop a
message nobody minted from being printed. They do not stop a caller deciding, at
the point of composition, that an ingested message's own newlines are the
output's line structure: `out.lines(message.split("\n").map(renderLine))`
compiles and every element of it is honestly `Rendered`. One rule therefore
remains the author's — **never derive output structure from text this process
did not compose** — and `serverErrorLines` exists so that nobody has to make
that call for a relay error: it renders the server's message whole and adds only
ShipIt's own status note as a second line.

**The mints are not interchangeable, and that is not only about legibility.**
`renderOwn` collapses runs of space, which is right for ShipIt's own prose and
wrong the moment a sentence embeds an already-rendered value: it reaches inside
the quotes, so a refusal about a label stored as `"Team  Account"` reported
`"Team Account"` — a value the user never set. `renderLine` is the mint for
composing around one, `renderValue` for putting one into a sentence, and
`renderOwn` only for text that is ShipIt's own the whole way through.

**The same enumeration exists outside the settings surface.** A role name is
arbitrary user text, and three agent-facing messages list stored names: a
settings operation's refusal, `shipit agent run --role` on an unknown name
(`services/roles.ts`), and `shipit session create --role`
(`services/session-role.ts`). The first had the projection and the other two
joined every stored name verbatim, so `namesForMessage` moved into
`settings-catalogue/projection.ts` beside the projection it is made of, and all
three call it. It projects each name, emits it through `renderAddress` and
reports the rest as a count.

**Every string is quoted, with no exception.** A predicate for "plain enough to
leave bare" is one more thing to get wrong and getting it wrong is a hole rather
than a blemish; quoting uniformly also gives the reader an unambiguous grammar,
and it is what separates a stored value reading `not set` from ShipIt saying the
setting is not set — or an empty string from `empty`, which stays ShipIt's word
for an empty list. `--json` is unaffected in kind, since it always escaped, and
`display` means the same thing on both paths because it is the same string.

The rule reaches the **next-turn notice** too, which had the same `\s+` gap in
its own flattening: its one agent-supplied field, the instance address, now goes
through `renderOwn` before `asQuotedData` puts it inside the quoted region.

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

**A setting with a fixed option set is declared as an `enum`, whichever control
renders it.** A choice written as a list in the dialog's own component and as
`text` on the declaration is a setting whose options `get` cannot report, which
req 1 does not allow for — so the declaration holds the list and the control
renders from it (`DeclaredSelect` takes an explicit `options` only where the
choices are values the install produces, such as a provider's voices).

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
| Integrations | SSH destinations: the name, and per destination its address, user and port | the ones THIS session is granted, never the registry (req 5's closing clause) | no, for two different reasons — the address and the user decide which account on which machine must hold the public line, which is the user's act somewhere ShipIt cannot reach (`external_flow`); the name and the port need no act outside ShipIt and are refused because a card cannot show what the change does (`unsafe_to_display`) |
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
reason. The inventory is the part of this design most likely to be wrong; the
coverage walk is what checked it, until docs/308 slice 8 deleted the walk.

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

### A read is scoped where ShipIt already gates the resource

Req 5's closing clause, and today it has one instance: **SSH destinations**. The
read answers with the destinations this session is granted
(`settings-store-readers.ts` → `sessionSshHosts`, over the shipped
`grantedSshHosts`), not with the registry.

This is a fix to shipped behaviour rather than a new policy, and the decision was
already written down elsewhere: `api-container-guard.ts` hard-denies
`/api/ssh-hosts` to every container because *"a container has no business editing
destinations or reading the list"*, while `/api/sessions/:id/settings` is
container-accessible — so on `main` a session granted nothing can name every
destination the user has registered, through the settings door. Scoping makes
that door agree with the one beside it: `listSshIdentities` already returns
label, user and address for the granted hosts and nothing about the rest.

Two consequences are deliberate. A session with no grant gets an **empty,
readable** answer — it has none, which is not ShipIt failing to read — and the
reason rides the collection's own description, which every `list` carries. And no
count of what was left out: *"4 more destinations"* is the same enumeration one
step weaker. For a **granted** destination the read adds no exposure at all,
because ShipIt already writes that destination's address, user and port into the
session's own `~/.ssh/config` and `shipit-docs/ssh.md` tells the agent to read it.

### Browser-local settings

Part of both dialogs lives in `localStorage` (`stores/settings-store.ts:396`).
The **value** is what is refused: read and propose both answer `browser_local`,
and `list` says *set in the browser; ShipIt's server does not hold this value* —
the honest limitation req 5 provides for.

**Its OPTIONS are not refused.** `browser_local` explains withholding the current
selection and says nothing about what the setting can be set to, which is the
half req 1 asks `get` for and req 3 needs the agent able to name. So a
browser-local setting carries its option set like any other: a static one on the
declaration — `voice.language` is an `enum` of the dozen languages the Voice tab
offers, and the tab renders that list rather than writing its own — and one that
has to be resolved on this install as a `live` detail, which is therefore
resolved for an entry whose VALUE is unreadable and not only for one that reads.
`voice.ttsVoice` and `voice.ttsSpeed` are that case: the voices and the offered
speeds differ per TTS provider, and the declaration holds one pair of speed
bounds for every provider. Nothing new can leak by resolving it — every live
detail is a function of `deps` and never of the entry's value.

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

**An address the read emits must resolve back to the item it came from**, or the
agent follows an address the read just advertised into a different item or into
nothing. So a projection that produces an address may not normalize its input
unless the store on the other side normalizes identically. `userNameProjection`
does not: a role and a secret are looked up exactly (`getRole` reads
`roles[name]`; a secret is a record key) and neither write path normalizes what
it stores, so a padded `" helper "` beside `"helper"` would otherwise emit one
address twice and resolve to the wrong role. It therefore emits the stored string
**verbatim**, and a name that cannot be emitted as itself joins the ones the gate
already drops — no item, counted in the read's "not listed" note.
`hostEntryProjection` may normalize, and does, because `EgressAllowlistStore`
puts every entry through `normalizeHost` on the way in AND on the way to a
match.

**That second arrangement needs the normalizer to be idempotent, and it was
not.** `normalizeHost` stripped one trailing dot, so `a.test..` stored as
`a.test.`, the read normalized the stored row again and advertised `a.test`, and
removing that address matched no row. It strips every trailing dot now — and
because nothing migrates a row an older build already wrote, `removeHost` matches
on the NORMALIZED row rather than on the stored string, so the advertised address
names its own row either way. Rows that normalize alike are the same host, so
removing all of them is right.

**A host reaches the list from five places and a removal reaches two of them**,
which is why removing one is decided by reading the resulting state rather than
by what the store returned. Three things follow, and all three were defects.

`applyEgressHostRemove` branched on `isBuiltinDefault(host)` FIRST, so a host
that was both a shipped default and an explicit global row only had the default
suppressed; the row stayed effective, the read advertised it again as
`user-global`, and every further removal reported success while changing nothing.
It now does **both** — delete the row, and suppress the default when there is one.

`buildEffectiveAllowlist` deduplicated first-source-wins, so a host the operator's
environment or a configured MCP server ALSO supplies inherited the built-in pass's
`removable: true`. An entry is now removable only when **every** source supplying
it is, and the entry names the source that pins it — which is what the Network
tab's remove button and the proposal's `removableRefusal` both read.
`.github.com` beside `SESSION_EGRESS_ALLOWLIST=.github.com` is the worked case.

And the card's own words are **membership, not reachability**: entries are
patterns, so taking `api.github.com` off leaves the shipped `.github.com`
matching it. The removal's wording is `on the list` → `off the list`, which is
what the write delivers; the applied detail names the entry that still covers the
host. An `add` keeps reachability wording, because there the claim comes true.

And the outcome is now read off the **resulting membership**, in two steps. The
named entry still on the list is `failed`, naming the source that keeps it there.
The entry gone but the host still *matched* by another — entries are patterns, so
removing `api.github.com` changes nothing about the shipped `.github.com` — is
`applied` with a detail naming the entry that still matches it, because the write
did exactly what the card said and a bare "Applied" would read as the host being
off the list altogether. That detail is membership too: whether a session reaches
the host is the **effect**'s question, and a card renders both lines rather than
letting the outcome's hide the session's — a sandbox with network off would
otherwise lose the half the user is unblocking. The read-back sees every source, which is why
`EgressApplyDeps` carries a **required** `credentialStore` key: the proposal's
preflight refuses an MCP-supplied host before writing, and `DELETE
/api/egress/hosts` does not, so the writer has to see one too. A session's list
has one source and needs no read-back, and a repeat removal of a host that is
genuinely off stays idempotent, since the end state is what the card claims.

Reading a setting a panel of its own owns needs a reader per owner
(`services/settings-store-readers.ts`), because a `bespoke` declaration names
where its value lives and not how to read one back. A reader returns the stored
value and never a formatted one, so `projectSetting` / `formatSetting` stay the
only door. **A reader never substitutes a default for a value it could not
read** — an absent store, a repository ShipIt has no record of, a read that
threw all degrade to an entry with the reason, because a plausible default is
worse than nothing: the agent states it to the user as fact.

**That rule binds the PAYLOAD readers too, and three of them used to break it
because they were written for display.** Each returned one answer for "not
configured" and for "ShipIt could not tell", so an existing file ShipIt could not
open read as a configured *absence*: an `EACCES` on the instructions file read as
**empty instructions**, an unreadable `.gitconfig` read as **no git identity**
(`git config --global <key>` exits 1 for both an unset key and a config it cannot
open, so the exit status alone cannot separate them — unset has an empty stderr,
an unreadable config warns on it, and a malformed one exits 128), and an
unreadable release-channel file read as **`edge`**, which is a real channel an
install tracking `stable` would then be told it is on. Each reader now returns an
outcome — `readGlobalSystemPrompt`, `readGitIdentity`, `readChannelOutcome` — and
`readStoredGlobalSettings` answers `{ values, unreadable }`, naming the wires whose
own reader could not tell so `readValue` reports exactly those as `read_failed`.
The failure is per declaration, never per call: one unreadable file must not cost
the agent every other setting's value. A caller that has to act either way keeps a
total form beside the outcome — `globalSystemPromptForTurn` (a turn still runs,
carrying no instructions), `getGitIdentity` (the container's commit identity) and
`readChannel` (the updater) — and the honest one is the default, so a new caller
that forgets gets an outcome rather than a lie.

A half-set git identity keeps both halves for the same reason. Collapsing it to
"none" made the agent report a name that is set as unset, and made
`settings-baseline` hash every half-set state alike — so changing the name under
an unset email read as no change at all and let an older card overwrite it. It
also gave an unset identity no revision, which left a card proposing one
permanently `stale`.

**A reader reads the store the declaration names, which is not always the
obvious one.** An MCP server's arguments, environment and headers hold `$secret:`
references and the panel writes one for every key row even where the user left
the value blank (`McpServerSettings/utils/payload.ts:45`), so the config alone
says a name exists and not that the server can start. `configured` there means
every reference resolves, because one that does not omits the server from the
turn entirely (`session/mcp-resolve.ts:41`); the count of unresolved ones rides
with the item.

**The list of fields is the resolver's, not the ones that look secret.**
`resolveMcpServer` substitutes a stdio server's `args` and `env` and an HTTP
one's `headers` (`session/mcp-resolve.ts:30`, `:31`, `:37`) — a provider's token
is routinely passed as an argument, which is why `mcp.servers[].args` is a
`secretBag` in the first place, and sending `args` through the plain
configured-only projection made the read answer `{configured: true}` about a
server the runtime refuses to start. `command`, `url` and `npmPackage` are NOT
substituted, so a reference written into one of them is literal text and blocks
nothing. That the two layers agree on one configuration is pinned across the
layer boundary in `integration_tests/agent-settings-access.test.ts`, because the
orchestrator may not import `session/` and neither side's own unit test can hold
both answers.

**A reference ShipIt does not store is not a blocker it may report.** The check
answers for the two shapes the MCP panel writes and ShipIt keeps the value of —
`mcp__<server>__…` and an OAuth `$platform:` source — so the state req 3 exists
for, a key row the user left blank, stays a definite answer. Every other
reference resolves in the worker out of an environment the orchestrator cannot
see: the pushed set is a Compose secrets snapshot this read has no handle on, and
the worker AUGMENTS its `process.env` rather than replacing it, so the
container's own variables resolve too. Calling such a reference missing states a
blocker the server does not have, so the read says it cannot tell instead.

**Even the definite answer is a judgement, not a guarantee**, and the code says
so rather than claiming a prefix nobody else may use: project secrets merge over
account values reserving no prefix (`service-secrets-resolver.ts:179`), so a
project secret named `mcp__demo__TOKEN` would resolve while this read calls it
blank. What makes answering right anyway is which case is real — the panel writes
that name for every key row, blank or not.

The uncertainty leans to `configured`, because of the two ways to be wrong about
an unknown, that is the one that does not send the user to set something already
set. And the two counts are independent: a field can carry a blank key row AND a
reference to the session's environment, which are two different things wrong with
it, so both notes are emitted rather than whichever branch ran first.

No wider environment fixes this, which is why the read stops claiming one.
Widening to the account env fixes `$secret:OPENAI_API_KEY` and then reports a
stale non-MCP `agentEnv` key as configured where the real pushed snapshot omits
it.

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

**Containment is resolved against what is RUNNING, on both probes.** The
allowlist probe read it off `resolveEgress` alone, which answers for the next
start — so a session whose global containment was switched off mid-life was told
*its network access does not depend on the allowlist* while its container was
still contained and still enforcing the list. That is req 3's exact failure: the
surface that exists to explain a blocker describing a state that is not the one
blocking. It now branches on `egressContainedAtStart` the way the containment
probe does, so all four combinations of (started contained? × next-start
contained?) are reported for what they are, and a container rediscovered after a
ShipIt restart — which has no recorded boot policy — says it cannot tell rather
than guessing from the current setting.

**The session's network capability is two questions, and the two probes answer
different ones.** `userHostsExcluded` also comes from `resolveEgress`, and
revoking a sandbox's network capability saves *without* rebuilding the container
(`services/session-settings.ts` → `updateSandboxCapabilities`, which emits a
`pendingRestart` card). So the stored capability describes the next start while
the container the user is asking about is still running under the one it took.
Each probe now reads whichever of the two its own question is about.

**What is in force is read from the container's own record, not from the
session's stored capabilities.** `SessionContainer.egressUserHostsExcluded` is
written from the egress config that was actually applied, at the two moments a
container's egress is configured: creation (`container-lifecycle.ts`, beside
`egressContainedAtStart`) and `reloadEgress` (`session-container.ts`). The stored
capabilities are wrong for this twice over — `app-lifecycle.ts` snapshots them
*before* creation resolves egress, and a reload re-applies the current policy to
a *running* container, so a session host add after a capability grant puts it
back under the ordinary allowlist with no restart at all.

**It is true only where a sealing policy was really installed**, which is three
conditions and not one. At creation: enforcement on AND the container contained —
with `SESSION_EGRESS_ENFORCE=0` nothing is applied, so recording the resolved
value would describe a policy that does not exist. At a reload: the container's
own boot containment known-true, because a reload launches the resolver and proxy
but the redirect that routes traffic through them is installed at creation — so
sidecars on a container that started open, or on a rediscovered one whose
containment ShipIt cannot tell, change nothing, and recording a sealing there
would call a container that reaches everything sealed. And the record is
**invalidated for the duration of a reload**: `reloadEgressSidecars` replaces the
resolver and then the proxy, so a throw part-way leaves the container enforcing
neither policy whole, and a definite value through that window is a confident
wrong answer. Undefined therefore means unknown throughout — a rediscovered
container, a failed replacement, or a reload with no firewall to act through.

- **Which setting DECIDES containment is the STORED capability.**
  `sandboxLifelineEgressConfig` intercepts a network-off sandbox at every
  resolution, so the global setting is irrelevant to it now and at every future
  start — that answer does not wait for a restart and must not be re-sourced.
  What it cannot answer is what the running container is doing, so the
  running-container answer is computed once and **carried** by the capability
  branch and the per-session-override branch rather than dropped by them. A
  sandbox whose capability was revoked mid-life is told both: the global setting
  will never apply to it, *and* its container started open and stays open until
  it is restarted.
- **Whether the ALLOWLIST is shutting the session out is the RUNNING container's
  applied policy; whether a change to the list can ever reach it is the stored
  capability.** A global host add reloads nothing live
  (`services/settings-apply.ts` → `applyEgressHostAdd` returns early for the
  global scope), so a change reaches this session only through its next start —
  which the stored capability decides. But "your network capability excludes it
  from the allowlist" describes the session *now*, and for a container
  configured before the revoke it is false: it is still enforcing the list it
  took, or still open. Both halves are now said in the one detail, and the state
  stays `excluded` because the forward answer is what the state means.
- **The grant direction is the mirror image and is reported as its own case.** A
  container running under the capability switched off is sealed to ShipIt's
  lifeline hosts whatever the list says, so granting the capability leaves the
  list adding nothing to it until it restarts: `restart-dependent` where the next
  start is contained, `excluded` where the next start is open. Not "nothing
  contains the session" — that container *is* contained; it is its next start
  that is not.
- **A container ShipIt has no record for gets no history invented for it.** An
  unknown record is not "not excluded": a rediscovered container may have been
  sealed for its whole life, so saying the capability "has been switched off
  since" would assert a change that never happened. The probe says it cannot tell
  what the container is enforcing, and states the stored capability's effect on
  the next start without claiming a transition.
- **A sealed container is not told the list is empty to it.** The lifeline base
  is a subset of the shipped allowlist defaults (`.anthropic.com`, `.openai.com`
  and the rest), so "no host on this list is reachable" is false — those hosts
  are on the list and are reachable. The claim is that the list *adds* nothing
  beyond the lifeline and any granted SSH destination, which is the part the user
  can act on.

**Still unaddressed: the probes do not know whether DNS control is deployed.**
With it off, a contained container enforces only the fixed Tier A policy, so no
allowlist entry can be made effective at all and "the allowlist applies from its
next start" overstates what a restart buys. `egress-host-reach.ts` takes that
distinction (`dnsControlDeployed`) and these probes do not; it predates this work
and applies to every branch, shipped ones included.

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

### A prose value is shown as a change to the text

`from → to` chips work for a boolean, a model id, a host. They do not work for
the user's own instructions, and nothing realistic ever will: no prose value fits
the 200 characters a chip shows, so `instructions.userInstructions` declared
`maxLength: 50_000`, read as fully proposable, and refused every proposal anyone
would actually make. Req 9 is the user's answer to that — *"but I want this
instructions to be proposable"*.

The refusal underneath is right and is not overturned: a change the user cannot
check by looking is not offered as one click. What was wrong is that the card had
only one way to show a value, in one piece.

**So a third shape replaces the two chips** whenever either side is longer than a
chip shows (`CARD_VALUE_MAX`, still 200): **the card says a change is proposed
and how big it is, and the change itself is read in a dialog the card opens.**
Two sizes, a `+n −n`, and a *Review the change* control — that is the whole of
what a prose change occupies in the scrollback.

The dialog holds a **full-context** diff — every line of both versions, unchanged
lines included — so it is not a summary that elides part of what is being
written; the whole before and the whole after are there, marked with what
changed.

**The split is the user's, and the reason is where a transcript's room goes.** An
earlier build put the diff inline in the card, height-capped. It worked, and it
spent several screens of the conversation on pages of the user's own text that
they were about to read once and never again — so the summary stays in the
scrollback and the reading happens somewhere it can have the room. Two
consequences fall out rather than needing to be designed: the card's height no
longer depends on the value at all, so nothing can push Apply and Dismiss out of
view; and a card the user scrolls past later costs one line.

**"Longer than a chip shows" is measured over the RENDERED text**, which is the
same measure `requireShowable` refuses on: a value is quoted and its line breaks
escaped on the way out (planning#577), so a chip runs out of room on prose that
the raw measure would call short enough. Deciding on the raw length would refuse
a 150-character instructions rewrite for having newlines in it — req 9's own
failure, one notch smaller. The two measures meeting here is also what leaves the
chip refusal reachable only for a value that is not prose; the git identity, two
`text({ maxLength: 200 })` fields inside one JSON object, is the case that still
reaches it and the one its guard uses.

The diff's own lines are the **raw** value and not `Rendered`. They reach the
browser as their own elements rather than as one line of the agent's text output,
so escaping there would show the user something other than their instructions —
and the display-integrity refusal below is what covers that path instead.

**Computed on the server at propose time, and snapshotted** exactly as `from` and
`to` are. A diff is an assertion about the change, so it is ShipIt's to make:
computing it in the browser would let two viewers on different client builds see
two accounts of one approval, and would leave the refusal below deciding on
numbers the card does not render.

**`from` and `to` do not carry the prose.** For a long change they are ShipIt's
own one-line summary — `412 characters` → `358 characters` — which is what every
existing consumer of them actually wants: the collapsed line in the scrollback,
the `lastProposal` the read reports, the line `shipit settings propose` prints
back. The text is in the diff, once, instead of in three places at 10 KB each.

**The bound is two numbers, and past either the card still refuses.**
`CARD_TEXT_MAX` is 10,000 characters a side: roughly 1,500 words, past which the
click stops being an approval and becomes a rubber stamp, which is the thing the
refusal exists to prevent. It is deliberately **lower than the declared
`maxLength` of 50,000**, and that is not an inconsistency to reconcile — a user
typing 50,000 characters of their own instructions into the dialog is not
performing the same act as approving 50,000 characters somebody else wrote, so
the two limits answer different questions and are allowed to differ.

`CARD_TEXT_LINES_MAX` is 1,000 lines between the two versions, and it exists
because the character bound does not bound the card: a diff line costs far more
than the character it carries, so 10,000 single-character lines a side is a
300 KB transcript row and 20,000 rendered rows. It is a reviewability bound too —
nobody checks a thousand lines before clicking — and prose at `CARD_TEXT_MAX`
comes to a couple of hundred.

**Which side is over decides what the agent is told.** "Propose a smaller edit"
is useless advice about the value the user already has, so a `current` side past
the bound says instead that this setting has to be edited by hand.

**`alsoChanges` sides keep the 200-character cap.** A side change is a supporting
line under the main one and has no diff of its own; the three operations that
have them (`roles[].model`, `roles[].harness`, `reviewers[].model`) write a
harness id and a reasoning level. Long text arriving there is a declaration that
has outgrown the card, not something to render.

**The agent is told where the line is before it writes a value — BOTH lines.**
`get` on a proposable text setting reports `proposeMaxLength` where the declared
`maxLength` is wider than the card, and `proposeMaxLines` where the declaration
allows enough characters to reach the line bound (a side of N characters is at
most N + 1 lines, so the two sides can only pass 1,000 once 2N + 2 does). Both
renderers print both, and the line one says out loud that it is COMBINED —
current plus proposed, added together — because that is the half an agent gets
wrong: 600 one-character lines replaced by 601 is 1,201 lines and ~1,200
characters a side, refused by a bound the read used to enforce without
disclosing. A bound enforced and not disclosed is req 9 half met, and it leaves
the agent to find the line by being refused, which is the dead end req 9 exists
to remove.

**And the value reaches the command through a file, not through argv.**
`shipit settings propose <key> --value-file -` takes the prose on stdin, the same
shape as `gh pr create --body-file -` and `shipit issue comment --body-file -`.
`key=value` still works and is still right for a scalar; multi-line prose
squeezed into one shell word is not a surface the feature should depend on.

#### What replaces flattening, for a value that cannot be flattened

`--reason` is untrusted text and its defence is to flatten it to one line, cap it
and render it attributed. A proposed value cannot be flattened — the newlines are
the content — and it is agent-authored in the same sense. The *class* is not new
(`roles[].description` and a git name are agent-supplied text today); the volume
is, and a long agent-authored block inside an approval card is a good place to
put text shaped like ShipIt's own words. The equivalent is four rules:

- **The card's own words stay the registry's.** Label, description, breadcrumb,
  the character and line counts and the `+n −n` are ShipIt's, and the diff is the
  only region carrying anyone else's text. That the diff is in a dialog helps
  here and is not relied on: a surface the user opened deliberately, with a title
  ShipIt wrote, is harder to mistake for chrome than a block inside the card.
- **The diff renders as plain text, never as markdown.** A heading, a link or a
  rule rendered out of the proposed value is exactly how it stops reading as
  content.
- **The counts come from the server, and they are on the CARD.** A change the
  user has not opened yet is still described by its real size — padding a value
  with blank lines cannot make *Review the change* look cheaper to skip than it
  is.
- **Every changed line says so in words, not only in colour.** The `+`/`−` glyph
  is decorative, so a screen reader would otherwise hear both halves of a
  replaced line with nothing saying which one Apply writes.
- **A value whose rendering differs from its content is refused** — which is
  `unsafe_to_display` applied to the characters rather than to the length.
  Bidirectional overrides and isolates (`U+202A`–`U+202E`, `U+2066`–`U+2069`)
  reorder displayed text without changing what is stored; and the rest is
  Unicode's own `Default_Ignorable_Code_Point` — what a renderer is meant to show
  as nothing — plus the C0/C1 controls other than tab, carriage return and
  newline. The **property** rather than a hand-listed range, because the
  hand-listed one missed the soft hyphen, the combining grapheme joiner, the
  Arabic letter mark and the tag block. Variation selectors are subtracted from
  it: they are ignorable by that definition and are how an ordinary emoji is
  written. A card that displays something other than what Apply writes fails the
  one test this refusal is. Both sides are checked, because the card displays
  both, and the refusal names the side rather than quoting it.

**And the card must not show a change the WRITER discards.** The instructions
writer trims and stores one trailing newline; `boundedText` trims role prose. A
diff built from the untrimmed value showed a leading blank line or a second
trailing newline that Apply then dropped — the card asserting a change nobody
made. The fix is on the declaration, where it can be seen: `text({ trim: true })`
wherever the writer trims, so the type's own validation produces the value that
will be stored. The rule is that a declaration describes what is stored, not what
was typed.

**An applied prose card says what the edit did.** `settingIs` resolves the
operation's outcome from the card's `to`, which for a prose card is a character
count — "Your Instructions is 305 characters", true and saying nothing about what
was just approved. `appliedOutcome` substitutes `changed (+n −n)` when a
`textChange` is present. It lives on the server beside the other outcomes rather
than in the component, because the resolved line is ShipIt's account of what
happened and the client renders `outcome` in preference to anything of its own.

This is **not a scanner** and is not a second defence against a secret in a
value: `emits` is that, and a `user_text` setting is the user's own prose shown
because it is theirs. The claim is narrow — what the card shows is what the
button writes.

[`mockup.html`](./mockup.html) shows the card: pending, the long-text state, all
eight terminal states, and the saved-versus-effective case, in both themes.

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

**Shown means shown, and a sentence is not the values.** The re-derivation is
real — a model the role's harness cannot speak moves the harness, and a level the
new selection does not offer is dropped — so a card carrying `from`/`to` for the
model alone asks the user to approve two changes it never displayed. The
declaration's own description saying that fields are re-derived is not a
substitute: the user approves what the card shows. So an operation declares
`alsoChanges` — the rest of what its one write touches, each entry labelled by
the neighbouring declaration and valued through the same `projectSetting` /
`formatSetting` door as `from` and `to` — and the card renders them under the
main change. Three operations have them today, and they are the three that re-derive:
`roles[].model` (harness and level), `roles[].harness` (level), and
`reviewers[].model`, whose writer SUBSTITUTES the slot's default level rather
than refusing one (`services/reviewer-settings.ts` → `resolveReviewerPinPatch`).

They are **re-derived at apply time and compared with the card**, not replayed
from it. The derivation reads live state the baseline does not cover — which
harnesses are installed, which levels a selection offers — so a card written when
the role kept its own harness can, hours later, be a card that would move it. A
difference is `refused`, not applied: the baseline protects the stored value, and
this protects what the user was shown.

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

**A VALUE the projection drops fails that test too**, and propose refuses it
before the card exists. `userNameProjection` names no URL back, so renaming a
role to `https://user:token@host/` would have shown `deep-dive → not set` while
the write stored the URL and deleted the old name. The check is over the
declaration's own projection rather than over one setting's shape, so it covers
any emitter that drops a value; and like `hostPreflight` it does not quote the
value back, because what was typed can carry a credential and the refusal reaches
the transcript as tool output.

**The patch has to be narrow in the WRITE, not only on the card.** Reading the
stored object and handing it back to a whole-object writer looks like the same
thing and is not: `updateMcpServer` reconciles the server's stored secrets
against the config it is given (`services/mcp.ts` → `reconcileSecrets`), so the
`enabled` toggle passing the stored server through it deleted every secret the
configuration does not `$secret:`-reference — a card proposing one boolean
destroying a credential it never named. So a narrow operation gets a narrow
writer: `setMcpServerEnabled` / `applyMcpServerEnabled` write the one field.
Every other collection operation was checked against this shape and already
patches (a role write carries the stored object's every field, a reviewer pin
leaves the other slot, a failover cutoff merges per window).

### What a card can apply today

A declaration says a setting MAY be proposed; `services/settings-operations.ts`
says what changing it means, and the two are separate because a field-level
declaration is for discovery and is not the mutation unit. Every declared payload
scalar is proposable through one generic operation, so a setting declared
tomorrow is proposable the same day (req 7). Named operations cover the release
channel, egress containment and one allowlist entry, the two project settings, an
MCP server's `enabled` flag, a role's name, description, standing instructions,
model, harness and level, both reviewer slots, the credential and
provider-account labels, and the per-mode routing settings.

The rest is declared, readable and **refused at propose time by name**: creating
or deleting a role, an MCP server or a credential. That refusal is deliberately
not one of the catalogue's four reasons — those describe settings nobody can
propose at all, and this one says the read works and the write has not been built.

**A declaration may not advertise a proposal with nowhere to go.**
`propose.allowed: true` reaches the agent from the read surface, so a declaration
carrying it with no operation anywhere is a promise only attempting the change
reveals as empty — which is how `services.credentials[].label` and
`roles[].name` shipped. Two things close it. Each of those now has an operation:
a label is a narrow write with a narrow writer (`applyCredentialLabel`,
`applyProviderAccountLabel`), deliberately without `propagateCredentialChange`,
because that call refreshes auth, agent environments and resident CLIs on the
strength of credential MATERIAL and a label is a string in a list — and a
**baseline reader** each, without which the operation is registered and
unreachable, since `requireBaseline` refuses a proposal whose stored value it
cannot revision. And a
**collection aggregate** — `roles`, `mcp.servers`, `network.egress.hosts` — keeps
its promise through its entry fields rather than an operation of its own, since a
card never replaces a whole list; propose names them (`proposableFieldsOf`) and
refuses by pointing at them. `settings-operations.test.ts` fails the build for any
declaration that has neither.

Two vocabularies meet at a provider account and are **not** the same: the read
addresses one by the SERVICE it belongs to (`anthropic:acct_…`) and
`renameProviderAccount` takes the HARNESS whose sign-in owns that service, so the
operation converts. And a label's declared limit is wider than what its writers
store, so the preflight holds them to `MAX_CREDENTIAL_LABEL_LENGTH` — a card that
could only ever resolve `refused` is not a change the user makes with one click.
The same rule sends a **rename** through the role validator every other role edit
runs: `planRoleWrites` validates the whole role on every write, so a role pinned
to a retired model cannot be renamed and the card says so instead of the click.

One consequence for `domains()`: it now takes the validated value as well as the
target and the deps, because renaming a role writes the stored object under the
new name as well as the old one's, and the lock has to hold both before either is
read. Validation moved just outside the lock to make that possible — it is pure,
so it never needed one.

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

Two consequences for a **multi-write** operation, both found by a later
conformance review of this same rule (planning#537). A pair of writes that can
half-land has no honest outcome to report, so a global allowlist removal — the
explicit rows, plus the suppression of a matching shipped default — is one SQLite
transaction (`EgressAllowlistStore.removeGlobalHost`); ungrouped, a suppression
that threw left the row deleted and reported `failed`, which says ShipIt verified
nothing changed. `removeHost` is grouped for the same reason one layer down:
rows that normalize alike are one host, and deleting them one by one could leave
the host half off the list. And an operation whose writes landed while its
*intent* did not is `partial`, never `failed`: removing a host a configured MCP
server also supplies deletes the user's own row and leaves the host listed, and
only a removal that wrote nothing at all may claim the list never moved.

The same rule reaches past the outcome to what a write *does*. A save hook
(`SAVE_HOOKS`) runs only for a value the store kept: a `failed` write is verified
to hold the old value, and the hooks act on the new one — retiring idle resident
agents, marking stored status cards stale, refreshing PR snapshots. Running them
past a rolled-back write changed runtime and persisted state for a save the same
response reported as refused. `uncertain` and `partial` still run them, because
the value may be stored and a hook skipped for a stored value leaves the feature
asleep.

A write followed by a **read** needs the same separation, and a throw is what
collapses it. `applyReleaseChannel` writes the channel and then checks for
updates; re-raising the check's own 503 made the card report a change that was
stored as `refused`, and told the agent the same thing on its next turn. The
check's error is therefore **returned** beside an `applied` outcome that says
what could not be confirmed, and the route that answers with an update status is
what raises it.

### And "applied" has to mean what the card showed

A writer reporting `applied` says the write landed, not that it landed as the
card displayed it. Those came apart three times: `advanced.memoryBudgetMb`
showed `4096 → 0` over a write that *removes* the field, clearing
`services.nonTurnModel` showed "not set" over a save hook that seeds a
replacement selection in the same call, and clearing a role's reasoning level
showed `""` over params that store no level at all. Requirement 4 is about what
the user can check before clicking, so a card the store then contradicts is the
requirement failing.

Three defences, prospective first, because a card corrected after the click is
already a card someone approved wrongly. **A declaration is where each of the
first two lives**, which is the point: the normalisation is stated once, beside
the setting, rather than patched into whichever path noticed it.

1. **A declared type answers with the value the store will hold**
   (`value-types.ts`): `read(serialize(v))` is `v` for anything `validate`
   accepts. `text`'s `trim` already worked this way; `unsetBelow` now does, so a
   budget of `0` validates to `null` and the card says "not set".
   `store-round-trip.test.ts` holds it over the whole registry — which catches
   the class where **serialising drops the value**, and not a writer that
   normalises on its own, since the codec cannot see one.
2. **A declared type also says what the WRITER stores**, which is the half the
   codec contract above cannot reach: `serialize` never runs for a bespoke
   store, so nothing in the round trip can see `pinned()` dropping a role's
   empty reasoning level. `text`'s `emptyIsUnset` is where that is declared, and
   `validate` answers `null` — so a card clearing the level says "not set"
   rather than `""`. Deliberately opt-in: an instructions box stores the empty
   string it was cleared to, and reporting *that* as "not set" is the same lie
   reversed. The first draft of this put the normalisation in the declaration's
   PROJECTION instead, which was wrong twice over — it made a stored level
   nothing offers read as "not set" while it was still stored and unclearable,
   and it collapsed a genuine `alsoChanges` deletion into "not set → not set",
   hiding a write the card was meant to show.
3. **A change that cannot be shown truthfully is refused**, which is the rule
   `hostPreflight` and `requireEmittable` already apply. Clearing the
   background-model pin joins them: `seedNonTurnModel` runs from the save hook
   AND from every build of the settings payload, so "not set" is not a state
   that setting can be left in while a model is eligible. The seeded model is
   not named back either — what the seed picks at apply time is not what it
   picks now.

Then the backstop. **The store has the last word**: after an `applied` write the
apply reads the setting back through the agent's own read surface — the same
read that already answers `effect`, so no second round trip — and compares it
with what the card promised. A disagreement resolves the card `partial` naming
both values, rather than `applied`. This is what covers a save hook, whose side
effects nothing before the write can see.

It verifies **everything the card displayed**, not only the field the card is
named for: each `alsoChanges` entry carries its declaration key and is read back
at the same address, because a write that lands its own field while keeping a
neighbour is exactly the shape a check of the named field alone cannot see.

What it compares is chosen so that it cannot invent a defect, and **failing to
observe a value is never treated as one** — every branch that cannot compare
answers "no mismatch":

- Only a `set`. A membership card displays ShipIt's own wording rather than a
  value, and those writers already answer from the resulting membership.
- A **prose** card is compared against the approved TEXT, not against the card's
  `to` — which is ShipIt's summary of the prose, so comparing displays would
  pass any rewrite of the same length.
- An **item the read no longer lists** says nothing. An instance leaves the read
  for reasons that have nothing to do with the write: a rename retires the name
  the card was addressed by, and a service/mode setting stops being listed the
  moment its last credential goes (`settings-store-readers.ts` → `modePairs`).
  Both are writes that landed.

**Known gap, wider than this feature.** `saveGlobalSettings` ends by building
the settings payload, and that build seeds the background-model pin — so
applying *any* global setting can pin one that no card named. The click is not
what causes it (every read of the payload does, including opening the dialog),
and closing it means deciding when a pin is seeded at all, which is
background-work behaviour rather than proposal behaviour. Tracked as
planning#578 rather than fixed alongside the three above.

## How the agent learns the outcome

`shipit settings get <key>` carries `lastProposal`, and the agent reads before
proposing anyway. **It is rendered in the plain output, not only in `--json`** —
the notice below deliberately carries no values and sends the agent here, so a
phase visible only to the flag the agent does not pass would leave `get` unable
to answer the one question the notice asked it. The phase's headline and its
one-sentence instruction come from `shared/settings-proposal-guidance.ts`, which
the notice reads too: two surfaces reporting a phase must not word it
differently.

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
| `partial` | says what did not land — a half of a multi-part write, or a value the store did not keep — and proposes the rest |
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
the `exhausted` check and the failover decision, and under three conditions —
the result is not a refusal, it `resultIsTheAgentsOwn` (neither `event.error` nor
`status === "error"` — a conservative filter, since an error result can follow
partial work, not proof the prompt never ran), and it **answers this prompt**.

`wasSuperseded` is a fourth, and the one exception to that framing: a superseded
turn settles `interrupted` with its work discarded, but its listeners are still
attached, so the old process emitting a result for a prompt that genuinely IS its
own would spend the receipt on a turn nobody reads — and the successor, which
carries the same notice, would have none left to settle. Failover and the quota
retry deliberately do **not** set the flag: those re-dispatch the same prompt on a
new executor, which records its own submission and acknowledges that.

### Which turn a result answers

**Recorded as each turn begins, not inferred from the result.** `agent_result`
carries no identity — no prompt id, no turn id, nothing that survives the round
trip — and on a resident process the CLI starts turns ShipIt composed no prompt
for. So the executor (`turn-executor.ts`) keeps a lifecycle for its own prompt:

**`ownTurn`** — `"unsubmitted"` → `"queued"` or `"running"` → `"ended"`. This
executor's prompt has exactly one turn, which is why this is a lifecycle and not
a set of flags. Only `"running"` — this prompt IS the turn the CLI is in —
answers a result.

**`"queued"` is the honest answer to a question the harness does not make
answerable**, and it is the whole of the design's humility. A prompt submitted
behind a turn the CLI had already started cannot be told apart from that turn
afterwards: the turn's end, the prompt's own output, a background task
notifying, a further turn the CLI begins — every one of them looks the same from
here. So a queued prompt **never acknowledges**. The receipt stays live and the
notice rides the next dispatched turn, whose executor starts clear. Only the CLI
replaying the prompt back moves it out of `"queued"`.

Three rounds of independent review each named the ordering the previous guess
traded against — a later wake spending a receipt two turns behind it, a queued
prompt's own output being counted against it, an adopted turn's result answering
a prompt it never read. That is the evidence that this is **undecidable rather
than unhandled**, and guessing either way had a shipped failure: read the signals
as the CLI's and a prompt the agent read perfectly well could never acknowledge,
so the notice repeated on every turn; read them as the prompt's and a turn that
never saw it spent the receipt.

**Three signals move the prompt, ordered by how much they prove.** The CLI
replaying the prompt (below) is the strongest and always acts. A result is next.
The worker's answer to the submission is the weakest — it says only that the
prompt was accepted — so it acts **only** from `"unsubmitted"`, and even then
puts the prompt in `"queued"` rather than `"running"` if a turn of the CLI's was
already in flight **or** a result passed while the answer itself was in flight.
The worker's HTTP reply and the CLI's events travel separately, so a confirmation
can land after the result it confirms; letting it claim the running turn there
would hand the receipt to whatever the CLI does next.

Which turn a result ends is also taken **before** the handler yields to an
in-flight re-arm. The CLI keeps emitting across that yield, and a replay landing
inside it would otherwise hand an earlier result the turn that replay started.

A turn the CLI began is the two events `beginRearm` already answers to —
`agent_self_wake` and a top-level `agent_assistant` on a harness that
`startsOwnTurns`. `noteCliStartedTurn` records either, and it matters only until
the prompt is submitted, which is the only moment the record is read. It is not
read at all on a process this prompt spawned: that process exists for this prompt
alone, so no other turn can be running on it, and its first output can beat the
proxied submission's confirmation.

**This replaces two state flags that the same defect defeated in opposite
directions, which is why it is a record of turns rather than a third flag.**
`promptSubmitted` said the prompt had been sent, and `servingCliStartedTurn()`
said the executor was serving an adopted turn right now:

- A wake **after** a failed dispatched turn re-arms the executor
  (`rearmForCliStartedTurn`), which keeps `input.noticeDeliveries` — the receipts
  of the prompt it was built for. The adopted turn's successful result met every
  condition. The adoption flag closed it; the failed turn's own result ending
  `ownTurn` closes it now, and the flag is no longer read here.
- A wake landing **inside** a reusing dispatch's `await prepareAgentEnv` finds
  `streamingPostTurnFired` false, so `beginRearm` returns without setting that
  flag — correctly, since this executor has produced no result to re-arm past. By
  the time the woken turn's result arrives the prompt has been submitted and
  nothing is being adopted, so both flags read exactly as they do for a turn that
  ran the prompt. No flag describing "what is happening now" can see this one.

**Where an identity does survive the round trip, it is used.**
`agent_user_replay` is the CLI echoing back a user message it has read
(`isReplay` on Claude, synthesized by Codex — docs/140). A replay of this
prompt's **exact text** means the CLI read it inside the turn now running, so the
prompt becomes `"running"` whatever it was before; the text match is what stops a
live steer the user typed from standing in for it. That is what keeps the common
case whole: a prompt steered into a turn the CLI had already woken for is
absorbed by it, and the single result that ends that turn acknowledges the notice
instead of withholding one the agent read.

It is a weaker signal than `requeueUndeliveredSteers` looks like it makes it, and
the difference was found in review. That mechanism covers messages registered
through `recordSteeredMessage` — a user's steer — and the executor's own prompt
is submitted directly, so it is not one of them; the requeue also requires that
no assistant group appeared after the steer. So the replay is read here as
positive evidence when it arrives, and its absence is read as *nothing*, which is
why the fallback is the `"queued"` rule above rather than a claim about delivery.


`submissionSettled()` is what makes leaving `"unsubmitted"` mean the prompt was
*accepted*, and it took two review rounds to get right. The executor's listeners
go live before its `await prepareAgentEnv`, so on a resident process a result can
land in that gap and preparation can then fail with the prompt never sent.
Returning from the submission is not enough either: `ProxyAgentProcess.run` /
`.sendUserMessage` post to the session worker and return before the answer
(`proxy-agent-process.ts`), so a result in *that* window would be written off
against a prompt the worker went on to reject. So the proxy exposes
`submissionSettled()` and the executor waits for it; a synchronous submission has
none and is landed when the call returns.

Sequencing after the failover decision is what puts the acknowledgement past
ShipIt's credential-failure classification (`quotaRetryInProgress`): a retry
re-dispatches the same prompt carrying the same receipt, so only the attempt that
actually ran acknowledges. Every other path — a crash, an interruption, the
all-refused report, a turn that never spawned — simply never calls it.

### The same lifecycle, read the other way: putting a take back (planning#609)

Req 8 made the settings outcome a **read plus a receipt** so a turn that never
reached an agent would keep it. The rest of the prefix was not converted, and
three of its entries are one-shot **takes** performed at composition, spent before
the prompt is submitted: the pending agent notice
(`sessionManager.consumePendingAgentNotice`), the pre-turn reset prefix
(`applyPreTurnReset`), and a role's standing brief
(`takeRoleStandingInstructions`, marked by `setOriginRoleName`, which nothing
cleared). A turn ending before submission destroyed all three — and ShipIt's own
error for that case says *"send this message again"*, so the user walked straight
back into the hole. The worst of them is the reset prefix: the branch has already
moved, so the resend's `applyPreTurnReset` finds nothing to reset and no later
turn regenerates it.

`PromptRepark` (`turn-settlement.ts`) is the mirror of `NoticeDelivery`, and it
reads the **same** `ownTurn` lifecycle: `"unsubmitted"` is the state no
submission ever left, so the takes were read by nobody.
`TurnInput.promptReparks` carries them, and `settleTurn` runs them. Both
composition sites build the list — the interactive one
(`ws-handlers/agent-execution.ts`) had no repark at all, and
`dispatched-turn.ts`'s `reparkNoticeIfUndelivered` latched "delivered" one line
*before* `executeAgentTurn`, so it covered only a failure in the pre-executor
setup. That latch stays where it is; past it the executor owns the question,
because it is the only thing that knows whether the prompt was submitted.

Settlement is the right moment for the same reason it is the wrong moment for a
delivery: every retry path stands this executor's terminal sequence down before
re-entering with the same reparks, so a settled turn is one no successor will
submit. A proxied submission landing after settlement is the one inexact case,
and it reparks a take the agent did read — at-least-once, the safe direction
here, since both stores it writes to hold prose the agent reads twice rather than
state it corrupts.

Two scopes are deliberate. Only a reset that **moved** the branch reparks; a skip
is re-evaluated every turn and needs no help. And the notice is `append`ed rather
than `set`, because a notice recorded *while* the failed turn ran describes a
later branch move that must not be overwritten by the older one.

Out of scope, both by earlier decision: the bug-outcome notice is at-most-once
(docs/164), and the dependency-gap prefix is not a take — the gap persists until
an install succeeds, so it rides the next turn correctly.

Guards: `integration_tests/turn-prefix-repark.test.ts` (the interactive site,
end to end), `dispatched-turn-pre-turn-reset.test.ts` (the executor window on the
dispatched site), `pre-turn-reset-hook.test.ts` and `services/session-role.test.ts`.

**The notice carries no values, and that is a trust decision rather than
brevity.** `from`/`to` are formatted values and a `user_text` projection keeps
what the user or the agent supplied; `outcome` and `outcomeDetail` can
incorporate a value, an address or a raw exception message
(`settings-decision.ts` → `getErrorMessage`). Interpolating any of them would put
text that entered as somebody else's into a line the agent reads as ShipIt's —
so a *dismissed* proposal would replay its own proposed instructions into the
next prompt, laundered through the platform's voice. The notice states the
setting, the instance, the phase and what to do, and the read is the authority
for everything else. The one field ShipIt did not author is the instance
address, which stays because a notice that cannot say *which* role or server says
nothing useful; it is quoted, and the closing line tells the agent it is data.

**An automatic turn carries the notice too.** Req 8 says *the next turn* and
names no kind, so a CI fix, a conflict resolution, a rebase follow-up, a
credential remediation and a wake all carry it, exactly as a message the user
typed does. An earlier version excluded every system turn at both call sites on
the grounds that a settings notice inside a conflict-resolution prompt could only
distract — which made the outcome wait for an ordinary turn that may be hours
away and may never come, and that is a restriction the requirement's wording
does not carry.

Three turn kinds are left out, and none is a judgement about settings:

- **Compaction** carries no agent prefix at all. The pending-agent notice, the
  bug outcome and the dependency gap are all excluded there already, because its
  prompt is an instruction to summarise and its result replaces the context a
  notice would have been read in.
- **A verbatim command** (`ridesTurnAsCommand`, docs/297) is delivered as the
  user typed it, because the harness reads it as its own command only when the
  prompt is exactly the command. There is no prefix slot to put a notice in.
- **A turn the CLI wakes itself for** is one ShipIt did not compose. Background
  work finishing wakes a resident CLI; the wake arrives as `agent_self_wake`
  (`agents/claude/adapter.ts` maps `system/task_notification` to it),
  `ws-handlers/agent-listeners.ts` adopts the turn and `turn-executor.ts` re-arms
  its post-turn flow — all of it *after* the CLI has resumed. ShipIt observes
  that turn rather than writing its prompt, so both prefix chains above are
  bypassed by construction. Live steering (`agent.sendUserMessage`) is the only
  channel into a resident CLI and is not one here: it lands mid-turn, it is gated
  on the user's live-steering setting, Antigravity, OpenCode and Grok drop it,
  and it sets `turnLive`, resets the context accounting and makes the worker
  `beginTurn()` (`session/agent-controller.ts`) — perturbing the bookkeeping the
  adoption path reads. Delivering after the wake would also race the CLI's own
  model call with nothing to order against.

In all three, the outcome is left pending and rides the next turn — the same
at-least-once carry that covers a turn which never ran.

**For the woken turn that took two fixes, because the earlier reasoning was
wrong twice.** It first ran: the wake path prepares no notice of its own, the
re-arm reuses the finished turn's receipt, and *that receipt has already been
acknowledged*, so a wake cannot spend one. The middle step holds only when the
dispatched turn succeeded — a turn that failed with a non-auth, non-quota error
result is acknowledged by none of the conditions above and leaves its receipt
live. The second reasoning was that excluding an adopted turn closed it. It
closed one ordering: the other puts the wake *before* the prompt is submitted, so
nothing is being adopted when the woken turn's result arrives. Both are closed
now by attributing a result to the turn it ends rather than by describing the
executor's current state — *Which turn a result answers*, above — and the
limitation is what the code does.

**And it has guards, one per ordering.** An early attempt at one stayed green
against a broken implementation and was dropped as worse than a recorded gap — it
asserted straight after emitting the wake, and the re-arm completes later with
nothing to synchronise on. What that needed was an observable, not an exception.
In `integration_tests/settings-outcome-notice.test.ts`: the wake-after-failure
ordering waits for the adopted turn's own post-turn commit (a second `autoCommit`
call) before asking whether the outcome is still pending; the
wake-inside-preparation ordering parks the dispatch in `prepareAgentEnv`, wakes
the CLI there, releases the prompt and proves no result of that process settles
the receipt; a third does the same through the assistant signal rather than the
wake; a fourth holds it through a queued prompt's own turn, background task and
all. Four hold the terminal and ordering rules review found missing — a later
wake cannot settle a prompt absorbed into a failed turn, a submission
confirmation landing after a result can neither claim the running turn nor unseat
a prompt the CLI has taken, a replay after the turn ended cannot re-open it, and
a turn beginning inside the re-arm yield cannot answer an earlier result. Three
hold the other direction: a replayed prompt IS acknowledged by the turn that
absorbed it, a prompt the CLI takes is still acknowledged when its confirmation
arrives late, and a freshly spawned process whose output beats its submission
confirmation still acknowledges. One more holds the replay's text match, so
another message's echo cannot stand in for this prompt's.

Every condition in the model was reverted singly and fails at least one of these;
two lines that survived that sweep were deleted as dead rather than left
unguarded. The sweep is also how the blind assertions were found: `waitForTurn`
with a predicate that is already true returns before `flushTurn` runs even once,
so several negative assertions were reading state the result handler had not
reached. They flush explicitly now (`settleHandlers`), or wait on the adopted
turn's own post-turn commit where one follows.

**What the three review rounds actually established is where the line of
decidability is**, and each round moved a guess across it rather than adding a
rule. `ownTurn` left standing past the turn it described; a confirmation
reviving a finished prompt; attribution read after a yield the CLI kept emitting
across; a queued prompt's own output counted against it. The first three are
genuine ordering bugs and are fixed. The fourth is not a bug with a right
answer — it is the undecidable case, and the design now says so instead of
picking a side. The synchronisation matters as much: an acknowledgement decided
behind an awaited re-arm is not visible to an assertion that flushes one tick,
and two of these guards passed against a broken implementation until they waited
on the woken turn's own post-turn commit instead.

**`agentNotified` is a column on the private proposal row, not a card field** —
it is ShipIt's bookkeeping about a delivery, and nothing a viewer reads.

**A notice is delayed by a turn wherever ShipIt sees the turn boundary, and one
transport race is left where it does not.** Three shapes, named rather than
claimed away.

**The `"queued"` case is a repeat, not a loss.** A prompt submitted while the CLI
had a turn of its own in flight acknowledges nothing unless the CLI replays it,
so the outcome waits for the next dispatched turn, whose executor starts clear.
Reaching it needs a wake or top-level output inside that dispatch's
`prepareAgentEnv` window. A prompt whose own result beats its proxied submission
confirmation lands in the same state by the other clause, which is rarer still —
the worker answers `/agent/start` before the CLI has produced anything, so a
whole turn would have to complete inside that window.

**The confirmation race is a loss, and it is the one the model cannot see.** The
worker's HTTP reply and the CLI's SSE events travel separately. If a wake is in
transit when the submission is confirmed, the prompt becomes `"running"` — the
wake that would have queued it arrives afterwards, and by then nothing may read
it, because after submission a wake is indistinguishable from a background task
notifying inside the prompt's own turn. The woken turn's result then answers the
prompt, and if the prompt's own turn later fails the notice is gone. Demoting on
a late wake would close it and cost far more: background tasks notify mid-turn
routinely, so every such turn would stop acknowledging and the notice would
repeat on each one. The race needs the SSE frame to lose to a request made after
it, and the dispatched turn to fail afterwards.

All of it is strictly better than what it replaced, which **lost** the notice on a
far commoner shape — any dispatched turn that failed after a wake — and none of
it is closable without an identity on `agent_result`, which no harness supplies.

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
derivations, `exclusions.ts`, and `rendered.ts` — the one door a value leaves by
on its way to a line of the agent's output);
`shared/settings-proposal-guidance.ts` (the phase
table the read and the notice share);
`client/components/Settings/setting-copy.ts`
(`settingCopy`, `settingOptions` — `setting-binding.ts` until docs/308 slice 8
deleted the bindings), `declared.tsx` (the standard controls) and
`declared-setting.ts` (a declared setting's read and write);
`services/settings-store-readers.ts` (a reader per owner, for the settings a
panel of its own stores); `services/settings-read.ts` and
`api-routes-settings-agent.ts` (the two
session-scoped, container-accessible reads `GET /api/sessions/:id/settings` and
`…/settings/detail?key=`); `services/settings-apply.ts` (the shared writers and
the broadcast), `services/settings-conflict-domain.ts` (the lock) and
`services/settings-baseline.ts` (the per-declaration revision);
`shared/settings-catalogue/apply-outcome.ts` (the four outcomes);
`services/settings-text-change.ts` (the full-context line diff a long prose
change is shown as, its counts, and the display-integrity check);
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
`services/mcp.ts` (the narrow `setMcpServerEnabled`), `services/settings.ts`, `services/settings-derivation.ts`, `services/types.ts`,
`api-routes-bootstrap.ts`, `api-routes-egress.ts`, `api-routes-mcp.ts`,
`api-routes-updates.ts`, `api-routes-session-repos.ts`,
`ws-handlers/egress-handlers.ts`, `turn-settlement.ts` (`NoticeDelivery`, and its
mirror `PromptRepark`), `turn-executor.ts` (`noticeDeliveries`, acknowledged from
the `agent_result` handler; `promptReparks`, run from `settleTurn`),
`dispatched-turn.ts`, `ws-handlers/agent-execution.ts`,
`pre-turn-reset-hook.ts` and `services/session-role.ts` (each take hands back a
repark), `sessions.ts` (`clearOriginRoleName`), `session-runner.ts`,
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
- **Line forgery** — a stored value carrying `\n` followed by a plausible field
  produces no such line. Once end to end — the store, the real read, the real
  shim — because the defect only exists where those meet and each part looks
  correct alone; and once over EVERY string the read emits, so the next field to
  carry a value is not the one nobody thought to check.
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
- **A prose change is proposable** — several hundred characters of
  `instructions.userInstructions`, the case req 9 came from, produces a card, and
  the card summarises it and its dialog carries the whole before and the whole
  after. At
  `CARD_TEXT_MAX + 1` and at `CARD_TEXT_LINES_MAX + 1` the refusal still happens,
  naming the bound rather than the chip's 200.
- **The click writes what the diff showed** — a propose-then-apply round trip
  comparing the stored file against the diff's own added lines. The propose test
  alone cannot see the writer's trim, which is how that defect got in.
- **Display integrity** — a proposed value carrying a bidi override or an
  invisible formatting character is refused before a card exists, and so is one
  whose *current* value carries one; an emoji written with a variation selector
  is not.
- **An unchanged line BETWEEN two changes stays context** — the assertion the
  LCS has to earn, since prefix/suffix trimming supplies every other one.

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
