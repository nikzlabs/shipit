---
issue: planning#580
title: Data-driven settings UI — design
description: How the dialogs render and write from the declarations: two optional declaration fields, a machine-readable route store, a shared scalar reader and writer, and a control table by value kind.
---

# Data-driven settings UI — design

Implements [requirements.md](requirements.md). The per-setting walk this design
rests on is [inventory.md](inventory.md); it is cited below as `P1`…`P19`.

## The shape

```
declaration  ──▶  renderer  ──▶  writer
(catalogue)       (control by     (by store kind,
                   value kind)     keyed on the setting)
```

A generated control receives a `SettingKey` and nothing else. It never names a
stored field, never builds a payload, never chooses a route. That is VS Code's
`updateValue(key, value, target)`, and it is what turns
`docs/299-agent-settings-access` req 7 from an assertion a `data-setting`
attribute makes into a property the code has (req 1).

**This applies to generated rows.** A panel has operations a value writer has no
shape for — add, remove, reorder, sign in, test — so it keeps the writer it has
today. Requirement 3 asks that a component share the same *declaration* and the
same *destination*, not that every write go through one browser function.

## 1. What the declaration gains

`section?: string`, `component?: string`, and an `own-route` store that carries a
**method, a path and a body field** instead of a sentence (P2). `inventory.md`
lists the five fields that looked necessary and were not (req 5).

## 2. One writer, for the scalars

`saveSetting(key, value)` resolves the store from the declaration:

| `store.kind` | What the writer does |
|---|---|
| `credential-store`, `system-prompt-file`, `git-config` | `PUT /api/settings` with `{ [wire]: value }` |
| `browser` | encode for `localStorage`, write `localStorageKey`, update the value record (P17) — and a kind the codec cannot spell is **not** a generated row at all, because a control that changes on screen and stores nothing is worse than one that is not there |
| `own-route` | `method` `path` with `{ [bodyField]: value }` |

**`own-route` is why five settings can be rows at all** (P2). The two that use it
today post different body shapes and carry no `wire`. Three more are single
values a panel happens to write — `project.allowAgentMerge`,
`integrations.github.connection`, `integrations.linear.credential` — and are
re-declared `own-route` rather than `bespoke`, which is what makes them generated
rows.

**The path and the field are the READ as well** (slice 2). The store carries
three facts and no fourth: the read is a `GET` of the same `path`, answering
under the same `bodyField`. `GET /api/egress/settings` already did; the release
channel had no reader at all, so slice 2 added `GET /api/updates/channel` rather
than a fourth field naming somewhere else to look. A later own-route setting owes
its path a GET — that is the contract, and it is what keeps the whole of req 1
inside the declaration for a setting the settings payload does not carry.

It generalises what `src/client/components/Settings/declared-setting.ts` already
solved for booleans (P6): optimistic write, per-field sequencing, and rollback to
the last value the **server** confirmed rather than to the value the failed
request asked for. Explicit-commit rows do not need it and do not get it.

**Commit mode is derived for generated rows** (P5): `text` commits on a button,
everything else on change. That is not a universal rule about settings — an SSH
port saves with its form, a failover cutoff commits on blur — and those live in
panels, which are unaffected.

**An explicit commit is a tab's, not a control's** (slice 3). The catalogue's own
`instructions.commit` exclusion says one Save stores both instruction boxes in a
single write, so the button cannot belong to either declaration — and requirement
3 forbids a custom control from changing where a value goes, which a per-row Save
would have done. So the edit lives in a **draft record** beside the value record
(`useSettingDraft`), and `<DeclaredCommit tab="…"/>` in the tab's footer commits
every edited row on that tab through `commitSettings`, which sends one
`PUT /api/settings` carrying each declaration's `wire`. The button names a tab
and never a setting, so a third box added to the Instructions tab is committed by
it with no edit anywhere. `git.identity` is the same button on another tab.

Three consequences the design had not stated. **The record moves only after the
server answers, and it takes the value the server ECHOED** — the writers trim, so
what was sent is not always what is stored. **A refused write keeps the draft**,
because that is the user's unsaved typing and the toast is the only thing they
have left. And **what may be committed comes from the value type's `validate()`**
(P8), so the 50,000-character bound the tab used to carry in JSX is gone and the
keyboard path cannot enforce a different limit from the button.

**A draft is never dropped for looking unchanged, and that is what makes it safe.**
The first cut treated a draft equal to what it started from as no draft at all,
so that typing back to the original re-adopted an outside change. Two ways to
lose a keystroke followed, both found by review and both reproduced: a dropped
draft left its **seed** behind, so the next edit after an outside change was
compared against a value nobody was looking at and vanished; and an edit made
*during* a save that happened to equal the pre-save value was dropped in favour
of the value the save stored. So a draft now lives from the first keystroke until
the write that carries it lands, or until the dialog closes — a box that was
typed in always shows what was typed. Settling is one store action: a draft still
holding what was sent is done and goes, one typed in since stays with its **seed
advanced to what is now stored**, because that write was the user's own and not
the outside change the seed exists to detect.

**Two commits of one setting must not overlap**, and the button is what stops
them: it is disabled while its write is in flight. `commitSettings` has no
sequencing of its own — out-of-order responses would leave the record on the
older value with the server holding the newer, after the `settings_changed`
refresh that would have corrected it had already run — and it needs none while it
has one caller that cannot produce them.

**A tab that has an explicit-commit row must place a `DeclaredCommit`**, and
nothing checks that it does: moving a `system-prompt-file` row to a tab without
one would render a textarea nobody can save. Both tabs that have one place it
today; a later slice that moves such a row owes the check.

**A generated row's writer awaits the response and does nothing else** (P3).
A setting whose write has a client-side effect is not a generated row: hands-free
must arm audio inside the click gesture, and the TTS provider repairs the voice
and speed. Both are components.

## 3. One reader

A generic `Record<SettingKey, unknown>` in the settings store, hydrated from the
settings payload by `wire`, from `localStorage` by `localStorageKey`, and from
its own route for the `own-route` settings. `useSetting(key)` returns
`{ value, set }`.

**Hydration walks the declarations, and that is what finishes req 1** (slice 2,
`src/client/stores/setting-hydration.ts`). Slice 1 left a row that saved
correctly and came back as its default after a reload, because the three places
that apply a settings payload — `App.tsx`, `session-data.ts`,
`message-handlers/global-settings.ts` — each named the settings they knew about.
They now call `hydrateSettingValues(payload)`, which walks `GENERATED_SETTINGS`
and reads each row from its own `wire`; `applyGlobalSettings` additionally calls
`refreshOwnRouteSettings()`, which reads the rows the payload does not carry from
their declared paths. Both run wherever global settings land — so also on the
`settings_changed` broadcast, which is what keeps a row the agent changed
current.

**A read in flight is discarded when the value moves under it.** These reads
take as long as a request, and a save writes the record the moment it is made —
so a read that began first and answered second would put the old value back
under a control the user has just changed, after the `settings_changed` refresh
that would have corrected it had already run. The record's value before and
after the read is the whole test.

So **for a tab in `GENERATED_TABS`, adding a row is one edit in one place**:
declaration in, row rendered, value written, value read back. The seven
per-setting hydration lines and the six store setters that existed only to carry
them are gone. What a later slice still owes req 1 is each tab's *entry* into
`GENERATED_TABS` — a setting on an unconverted tab is still read through its
named field, written by that field's own setter (P18).

**Keeping the storage key is necessary and not sufficient** (req 9, P17).
`localStorage` holds strings and JSON, and `bool.read` returns its default for
anything that is not a real boolean — so a reader that hands stored text straight
to `type.read()` silently resets every browser boolean. The browser store
therefore gets a **codec per value kind**, the three legacy keybinding keys keep
their fallback, and the slice that moves a value ships fixtures written in
today's on-disk format.

**The named selectors stay** (P1). The 51 lines in `src/client` that read
per-setting fields keep reading them; the fields become a thin view over the
record. They are a compatible read path, not a registration step, so nothing
forces a migration.

## 4. The renderer

`<DeclaredSettings tab="advanced" />` walks the tab's declarations, groups by
`section` in declaration order, and renders one control per declaration:

| Value kind | Control |
|---|---|
| `bool` | toggle |
| `enumOf` | select, or a segmented picker for a short static set — slice 2 built the picker, which is what its one enum wanted; the select arrives with slice 4's voice enums, whose option sets are long or produced by the install |
| `numeric` | number input, with the declared unit |
| `text` | textarea when the store is `system-prompt-file`; a `text` row over any other store has no control yet, so it is **not generated at all** (slice 3) |
| `gitIdentity` | the name-and-email pair |
| `modelSelection` | the model picker |
| `text` whose dialog value is write-only | credential row: configured or not, replace, remove |
| a declaration naming a `component` | that component, rendered **once** however many declarations name it |

**What the walk skips**: any declaration carrying an `address`, because a panel
owns it and renders it per item (P11). `voice.providerKey` is addressed and has
no collection declaration — its owner is the Voice tab's provider-key list, which
is a component, so the walk must not treat it as a standalone row.

Label and description come from the declaration. Validation messages come from
the value type's `validate()`, which already returns the `Rendered` text the
agent is shown, so a control stops carrying its own bounds and placeholders (P8).

**Content that is not a setting stays hand-placed and needs no schema** (P12). A
tab file is still a React component; it puts `<DeclaredSettings/>` and the update
panel or the enforcement warning where it wants them.

Slice 1 found one shape that needs more than "around the block": prose that
belongs to a **section** rather than to any one declaration — Advanced's *"Saved
for this browser…"* under Conversation, and the sentence explaining what a
notification is for. The renderer therefore takes a `notes` map keyed by section
name, and the tab supplies it. That stays P12 rather than a declaration field:
the words are in the tab file, and the first of them says in the code today that
it is deliberately **not** part of the setting's description, because it is about
the browser rather than about what the setting does and the agent has no use for
it.

## 5. Components

```ts
component: "services-panel"
```

A registry maps the name to a React component
(`src/client/components/Settings/components/registry.ts`, slice 2), which
receives the setting's **key** and resolves its own value through `useSetting` —
one prop rather than two, and the same hook every generated control uses, so
there is no second way for a component to read or write. Custom is presentation;
the declaration and the destination are the same ones every row uses (req 3).

A declaration naming a component is a generated row whatever its value kind: what
the control table has no control for is exactly what a component is for. The
memory budget is the first, and it is why the Advanced tab's number row is a row
at all (P4).

Nine panels own the 34 addressed fields between them (P11) — one of which,
`keyboard.keybindings`, has a fixed item set rather than a user-created one and
is still a component, for the four reasons P16 gives. Five small components cover
eight declarations: the memory budget (P4), the webhook pair (P9), the TTS
provider, voice and speed together (P3, P7), hands-free (P3), and the repository
colour picker.

## Slices

Each is one pull request. **A slice names the declarations it generates and the
ones it leaves hand-written** (P18) — it never converts a whole tab and hopes the
rest follows, because a control whose support has not landed either duplicates an
existing one or renders a row that cannot save.

1. **The spine, on Advanced's toggles.** The value record with its browser codec
   (P17), `useSetting` / `saveSetting` for `credential-store` and `browser`
   scalars, the control table for `bool`, `section`. Generates the six server
   toggles and three browser toggles on Advanced. Explicitly left alone: the
   memory budget, the release channel, and the update panel around them.
2. **Routes and the rest of Advanced.** The `own-route` store shape (P2), then
   the release channel — including removing the duplicate control from the update
   panel — the memory-budget component (P4), and `network.egressContained`.
   Shipped with two things the design had not settled. **The release channel got
   a `section`, and moved to the front of the catalogue's Advanced block**: its
   own row is useless three sections away from the Check-for-Updates button that
   acts on it, so the update panel became the Software Updates section's `note`
   and the channel renders beneath it (req 11 — order comes from the
   declaration, and this is what moving the declaration is for). **The
   enforcement warning on the Network tab now reads the setting's value rather
   than the egress store's copy of it**: the two agree, and reading one of them
   is what stops them disagreeing for the round trip after a change. What slice 2
   gave up with the hand-written channel control: it can no longer be disabled
   while an update applies, and a failed switch reports through the shared toast
   instead of the panel's own error line.

   **One route had to change, because a shared writer reads a status code
   literally.** `POST /api/updates/channel` stored the channel and then answered
   the *update check's* error — 503 — on the reasoning that its caller wanted an
   update status. Its caller is now the shared writer, which reads any non-2xx as
   "the write did not land" and rolls the control back: the user would have been
   shown the old channel with the new one stored (docs/299 req 4). It answers 200
   once the write has landed, with `checkError` carrying why there is no status.
   **The update panel re-checks when the channel moves**, which is what keeps the
   changelog and the downgrade warning beside the choice that produced them now
   that the write's own answer is not read; and it keeps an answer only while the
   selection has not moved since it asked, because both orderings happen.
3. **Instructions and Git.** The textarea rule and the instruction conflict state
   (P14), and the git identity control.

   **P14 is decided, and it is neither of the two shapes the design offered.**
   The conflict notice is not a declared capability and does not need a component:
   it falls out of **being an explicit-commit row**. Such a row has a draft and a
   seed, and comparing the two against the stored value answers both halves — an
   untouched box adopts a value that moved underneath it, an edited one keeps the
   draft and says so. A declaration field would have had exactly one user, which
   requirement 5 refuses; a component would have been custom presentation for
   something that is not presentation at all.

   **And the instruction boxes are NOT the first shared component** — the dedup
   slice 2 deleted stays deleted, and the webhook pair in slice 4 still decides
   it. They are two ordinary `text` rows; what makes their Save one write is that
   the Save belongs to the tab. That also gave the control table its `text` entry,
   which a shared component would have left with no user at all.

   Knowingly given up, all of it on the Instructions tab: **Save no longer closes
   the dialog** (it says "Saved", as the git identity and the memory budget
   already did; Cancel and the close button still close it), the two boxes **lost
   their placeholders** (per-setting copy a generated control cannot hold — the
   declared description carries the same guidance), and **switching to the tab no
   longer focuses the first box** (it was a `ref` the dialog passed into the
   hand-written textarea). The built-in-instructions toggle moved to the bottom of
   the tab, because the disclosure that belongs under it is chrome and a `note`
   renders above a section (req 11).

   One more thing the slice found: **the git identity had two write paths**, the
   declared `PUT /api/settings` and `POST /api/settings/git-identity`. The dialog
   now uses the declared one, and the route keeps its other callers.

   Gained rather than given up: an unsaved git edit now survives a tab switch,
   because the draft outlives the control that holds it.
4. **Voice.** The remaining browser values, the TTS component (P3, P7), the
   hands-free component (P3), the provider-key list (P11), the webhook pair (P9),
   and the webhook becoming always visible (P13).
5. **Integrations.** The two credential rows over their declared routes (P2, P10)
   and `autoCreatePr` becoming always visible (P13).
6. **Panels.** Register the nine as components and bind them to their
   declarations; they keep their own writers and operations.
7. **Project Settings** (req 10) — the second dialog, its repo-scoped write, the
   colour picker and the secrets panel.
8. **Cleanup.** Delete `settings-coverage.test.tsx` and the `data-setting`
   attribute (req 12). The walk proves three things and generation replaces one;
   the other two are given up knowingly, and the loss is bounded to the 42
   declarations the panels and components own (P15).

Until a tab joins `GENERATED_TABS`, its values are read through their named store
fields and written by those fields' own setters (P18) — hydration walks the
declarations for the rows the record holds, and reaches nothing else. Slice 1 made that rule explicit rather than
a convention: `GENERATED_TABS` in `src/client/stores/setting-values.ts` names the
tabs whose rows are generated, and so exactly which settings the record holds. A
tab joins that list in the slice that moves its hydration, and a setting the
record does not hold is still read through its named field — which is what keeps
`integrations.autoCreatePr` and `instructions.agentInstructionsEnabled` working
on the same reader while their tabs wait for slices 5 and 3.

## Key files

| File | Role |
|---|---|
| `src/server/shared/settings-catalogue/types.ts` | the declaration; gains `section`, `component`, and the `own-route` address |
| `src/client/components/Settings/declared-setting.ts` | today's boolean reader and writer — generalised into `useSetting` / `saveSetting` |
| `src/client/components/Settings/declared.tsx` | the low-level controls a generated one is built from |
| `src/client/components/Settings/declared-controls.tsx` | the control table: what each value kind gets |
| `src/client/components/Settings/DeclaredSettings.tsx` | the renderer: the section grouping, `notes`, the component lookup |
| `src/client/components/Settings/DeclaredCommit.tsx` | a tab's Save: every edited row on it, in one write |
| `src/client/stores/setting-values.ts` | which settings the record holds, the browser codec (P17), the named fields each one mirrors (P1), where an own-route row is written and read (P2) |
| `src/client/stores/setting-hydration.ts` | the payload read and the own-route read, both walking the declarations |
| `src/client/components/Settings/components/registry.ts` | the components a declaration may name |
| `src/client/components/Settings/tabs/UpdatePanel.tsx` | the Software Updates chrome, placed as that section's note (P12) |
| `src/client/components/Settings/setting-binding.ts` | `data-setting`; deleted in slice 8 |
| `src/client/components/Settings/settings-coverage.test.tsx` | the walk; deleted in slice 8 (P15) |
| `src/client/stores/settings-store.ts` | gains the value record and the draft record; the named fields become views over the first |
| `src/client/utils/local-storage.ts` | loses its 13 accessor pairs for settings; keeps the legacy keybinding fallback (P17) |

## What stays exactly as it is

The agent's half (req 8). `emits`, `propose`, the projection, the refusal
reasons, `LIVE_DETAILS`, the proposal card and `shipit settings` are untouched —
this feature is client-side, and the declaration it reads is the same one it
reads now. The **stored-shape** maps (`MCP_SERVER_FIELD_SETTINGS` and its
siblings) also stay: they catch a stored field nobody declared, which is the
opposite direction from the walk, and they are compile errors rather than tests
(P15).
