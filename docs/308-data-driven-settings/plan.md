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
| `browser` | encode for `localStorage`, write `localStorageKey`, update the value record (P17) |
| `own-route` | `method` `path` with `{ [bodyField]: value }` |

**`own-route` is why five settings can be rows at all** (P2). The two that use it
today post different body shapes and carry no `wire`. Three more are single
values a panel happens to write — `project.allowAgentMerge`,
`integrations.github.connection`, `integrations.linear.credential` — and are
re-declared `own-route` rather than `bespoke`, which is what makes them generated
rows.

It generalises what `src/client/components/Settings/declared-setting.ts` already
solved for booleans (P6): optimistic write, per-field sequencing, and rollback to
the last value the **server** confirmed rather than to the value the failed
request asked for. Explicit-commit rows do not need it and do not get it.

**Commit mode is derived for generated rows** (P5): `text` commits on a button,
everything else on change. That is not a universal rule about settings — an SSH
port saves with its form, a failover cutoff commits on blur — and those live in
panels, which are unaffected.

**A generated row's writer awaits the response and does nothing else** (P3).
A setting whose write has a client-side effect is not a generated row: hands-free
must arm audio inside the click gesture, and the TTS provider repairs the voice
and speed. Both are components.

## 3. One reader

A generic `Record<SettingKey, unknown>` in the settings store, hydrated from the
settings payload by `wire`, from `localStorage` by `localStorageKey`, and from
its own route for the `own-route` settings. `useSetting(key)` returns
`{ value, set }`.

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
| `enumOf` | select, or a segmented picker for a short static set |
| `numeric` | number input, with the declared unit |
| `text` | input; textarea when the store is `system-prompt-file` |
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

A registry maps the name to a React component, which receives the declaration and
the current value. Custom is presentation; the declaration and the destination
are the same ones every row uses (req 3).

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
3. **Instructions and Git.** The textarea rule and the instruction conflict state
   (P14), and the git identity control.
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

Until a slice moves a value's hydration, the old setter keeps writing into the
value record, because `src/client/hooks/message-handlers/global-settings.ts`
still writes the named fields (P18). Slice 1 made that rule explicit rather than
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
| `src/client/components/Settings/declared.tsx` | today's declared controls — becomes the control table |
| `src/client/components/Settings/DeclaredSettings.tsx` | the renderer: the control table, the section grouping, `notes` |
| `src/client/stores/setting-values.ts` | which settings the record holds, the browser codec (P17), the named fields each one mirrors (P1) |
| `src/client/components/Settings/setting-binding.ts` | `data-setting`; deleted in slice 8 |
| `src/client/components/Settings/settings-coverage.test.tsx` | the walk; deleted in slice 8 (P15) |
| `src/client/stores/settings-store.ts` | gains the value record; the named fields become views over it |
| `src/client/hooks/message-handlers/global-settings.ts` | hydrates the named fields today; must reach the record (P18) |
| `src/client/utils/local-storage.ts` | loses its 13 accessor pairs for settings; keeps the legacy keybinding fallback (P17) |

## What stays exactly as it is

The agent's half (req 8). `emits`, `propose`, the projection, the refusal
reasons, `LIVE_DETAILS`, the proposal card and `shipit settings` are untouched —
this feature is client-side, and the declaration it reads is the same one it
reads now. The **stored-shape** maps (`MCP_SERVER_FIELD_SETTINGS` and its
siblings) also stay: they catch a stored field nobody declared, which is the
opposite direction from the walk, and they are compile errors rather than tests
(P15).
