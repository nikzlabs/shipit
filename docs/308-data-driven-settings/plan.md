---
issue: planning#580
title: Data-driven settings UI — design
description: How the dialogs render and write from the declarations: four new declaration fields, one reader, one writer, and a component registry for the panels.
---

# Data-driven settings UI — design

Implements [requirements.md](requirements.md). The per-setting walk this design
rests on is [inventory.md](inventory.md); it is cited below as `P1`…`P15`.

## The shape

Three layers, and the middle one is the point.

```
declaration  ──▶  renderer  ──▶  writer
(catalogue)       (by value      (by store kind,
                   kind)          keyed on the setting)
```

A control receives a `SettingKey` and nothing else. It never names a stored
field, never builds a payload, never chooses a route. That is VS Code's
`updateValue(key, value, target)`, and it is what turns
`docs/299-agent-settings-access` req 7 from an assertion a `data-setting`
attribute makes into a property the code has (req 1, req 12).

## 1. What the declaration gains

Four fields and one option source — the whole list, from walking all 77
settings (req 5).

| Field | Why it exists | Used by |
|---|---|---|
| `section` | Our tabs have headed groups; VS Code has a flat list | every row |
| `order` | Placement within a section (req 11) | every row |
| `render: { kind: "component", component }` | A setting that needs its own UI (req 3) | 9 panels, 4 components |
| `presentation: "multiline"` | VS Code's `editPresentation` | 2 instruction boxes |
| `enumOf({ options: { source } })` | 4 enums whose options are not static (P7) | voices, harnesses, effort levels |

**Not added, and why:** conditional visibility (req 4 removed the need — only the
webhook pair was conditional, P13); a commit-mode field (derivable from the value
kind, P5); a composite field type (two cases, both better as components, P9).

**One addition the inventory argued against and the plan takes anyway:**
`numeric` gains a display unit. `advanced.memoryBudgetMb` stores MB and the
dialog shows GB (P4). Dropping the conversion would be a visible change to the
user that this feature has no reason to make, so the declaration carries it —
one field, one setting, and requirement 5 is satisfied because a real setting
needs it.

## 2. One writer

`saveSetting(key, value)` resolves the store from the declaration:

| `store.kind` | What the writer does |
|---|---|
| `credential-store`, `system-prompt-file`, `git-config` | `PUT /api/settings` with `{ [wire]: value }` |
| `browser` | write `localStorageKey`, then update the value record |
| `own-route` | the declared method and path (P2 — today that field is prose and has to become an address) |
| `bespoke` | the panel's own write, reached through this same entry point |

It keeps what `src/client/components/Settings/declared-setting.ts` already
solved for booleans (P6): optimistic write, per-field sequencing, and rollback to
the last value the **server** confirmed rather than to the value the failed
request asked for. Explicit-commit rows do not need it and do not get it.

**Commit mode is derived, not declared** (P5): `text` commits on a button,
everything else commits on change. That reproduces every row in the dialog today
except the memory budget, which becomes an immediate save with rollback.

**Side effects stay on the server** (P3). A save that retires resident agents or
makes a status card stale already runs in the declaration's `after` hook. The
client writer awaits the response and does nothing else, so no effect exists in
two places.

## 3. One reader

A generic `Record<SettingKey, unknown>` in the settings store, hydrated from the
`PUT /api/settings` payload by `wire` and from `localStorage` by
`localStorageKey` (req 9 — the storage keys do not move, so a value saved before
the change is read after it).

`useSetting(key)` returns `{ value, set }` for every value kind.

**The named selectors stay at first** (P1). About 72 places in `src/client` read
per-setting fields off the store — `ttsSpeed` 11, `notifyOnFinish` 8,
`keybindings` 8, `sttProvider` 7. They become a thin read layer over the record,
so the first change touches one file instead of seventy. They are deleted in the
last slice.

## 4. The renderer

`<DeclaredTab tab="advanced" />` walks `ALL_SETTINGS` for that tab, groups by
`section`, sorts by `order`, and renders one control per declaration:

| Value kind | Control |
|---|---|
| `bool` | toggle |
| `enumOf` | select, or a segmented picker for a short static set |
| `numeric` | number input, with the declared unit |
| `text` | input, or textarea when `presentation` says so |
| anything with `emits: configuredOnly` | credential row: configured or not, replace, remove (P10) |
| a declaration naming a component | that component |

Label and description come from the declaration, as they already do. Validation
messages come from the value type's `validate()`, which already returns the
`Rendered` text the agent is shown — the control stops carrying its own bounds
and placeholders (P8).

A section may also hold a **declared non-setting component** (P12) — the update
panel, the egress enforcement warning, the Linear team picker. Without this the
tabs that mix settings and chrome cannot be generated at all.

## 5. Custom components

```ts
render: { kind: "component", component: "services-panel" }
```

A registry maps the name to a React component, which receives
`{ declaration, value, save }`. Custom is presentation; the plumbing is the same
one every row uses (req 3).

The 9 panels own the 33 addressed item fields between them (P11). Two addressed
declarations are the exception and render as ordinary rows —
`project.allowAgentMerge` and `project.colorIndex` are addressed by repository,
and Project Settings is already open for exactly one (req 10).

## Slices

Each is one pull request.

1. **The spine.** The four declaration fields, the registry, `useSetting` /
   `saveSetting` for credential-store scalars. Convert the Advanced tab's nine
   toggles and the memory budget. Named selectors untouched.
2. **Browser values.** Generic `localStorage` read and write; convert all 14
   (P1 stays deferred).
3. **Sections and order.** Generate Advanced, Instructions, Git and Network
   whole, including the non-setting components (P12). This is where rows move
   (req 11).
4. **Voice.** Dynamic enum sources (P7), credential rows (P10), the webhook pair
   component (P9), and the webhook becoming always visible (P13).
5. **Panels.** Register the nine as components and narrow their props to
   `{ declaration, value, save }`.
6. **Project Settings** (req 10) — the second dialog and its repo-scoped write.
7. **The cleanup.** Delete `settings-coverage.test.tsx` and the `data-setting`
   attribute (req 12, P15), drop the named selectors, and move the ~72 call
   sites (P1).

Slices 1–3 are independent of 4–6. Slice 7 must be last: it is the only one that
removes a guard, and it may only run once nothing hand-writes a row.

## Key files

| File | Role |
|---|---|
| `src/server/shared/settings-catalogue/types.ts` | the declaration; gains the four fields |
| `src/server/shared/settings-catalogue/value-types.ts` | `enumOf` option source, `numeric` display unit |
| `src/client/components/Settings/declared-setting.ts` | today's boolean reader/writer — generalised into `useSetting` / `saveSetting` |
| `src/client/components/Settings/declared.tsx` | today's declared controls — becomes the control table |
| `src/client/components/Settings/setting-binding.ts` | `data-setting`; deleted in slice 7 |
| `src/client/components/Settings/settings-coverage.test.tsx` | the walk; deleted in slice 7 |
| `src/client/stores/settings-store.ts` | gains the value record; loses the named fields in slice 7 |
| `src/client/utils/local-storage.ts` | loses its 14 accessor pairs |
| `src/server/shared/settings-catalogue/tabs.ts` | tab labels today; section metadata if it does not live in the declaration |

## What stays exactly as it is

The agent's half (req 8). `emits`, `propose`, the projection, the refusal
reasons, the proposal card and `shipit settings` are untouched — this feature is
client-side, and the declaration it reads is the same one it reads now. The
**stored-shape** maps (`MCP_SERVER_FIELD_SETTINGS` and its siblings) also stay:
they catch a stored field nobody declared, which is the opposite direction from
the walk being deleted, and they are compile errors rather than tests (P15).
