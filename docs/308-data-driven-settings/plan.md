---
issue: planning#580
title: Data-driven settings UI — design
description: How the dialogs render and write from the declarations: two optional declaration fields, a shared scalar reader and writer, a control table by value kind, and a component name for everything else.
---

# Data-driven settings UI — design

Implements [requirements.md](requirements.md). The per-setting walk this design
rests on is [inventory.md](inventory.md); it is cited below as `P1`…`P15`.

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
attribute makes into a property the code has (req 1, req 12).

**This applies to generated rows.** A panel has operations a value writer has no
shape for — add, remove, reorder, sign in, test — so it keeps the writer it has
today. Requirement 3 asks that a component share the same *declaration* and the
same *destination*, not that every write go through one browser function.

## 1. What the declaration gains

`section?: string` and `component?: string`. Both optional; `inventory.md`
lists the six fields that looked necessary and were not (req 5).

## 2. One writer, for the scalars

`saveSetting(key, value)` resolves the store from the declaration:

| `store.kind` | What the writer does |
|---|---|
| `credential-store`, `system-prompt-file`, `git-config` | `PUT /api/settings` with `{ [wire]: value }` |
| `browser` | write `localStorageKey`, then update the value record |
| `own-route` | the declared method and path (P2 — that field is prose today and has to become an address) |

It generalises what `src/client/components/Settings/declared-setting.ts` already
solved for booleans (P6): optimistic write, per-field sequencing, and rollback to
the last value the **server** confirmed rather than to the value the failed
request asked for. Explicit-commit rows do not need it and do not get it.

**Commit mode is derived for generated rows** (P5): `text` commits on a button,
everything else on change. That is not a universal rule about settings — an SSH
port saves with its form, a failover cutoff commits on blur — and those live in
panels, which are unaffected.

**A generated row's writer awaits the response and does nothing else** (P3).
Server-side follow-ups already live in `SAVE_HOOKS`; client-side ones that exist
today, such as `setTtsProvider` repicking the voice, belong to the components
that own them.

## 3. One reader

A generic `Record<SettingKey, unknown>` in the settings store, hydrated from the
settings payload by `wire` and from `localStorage` by `localStorageKey` (req 9 —
the storage keys do not move, so a value saved before the change is read after
it). `useSetting(key)` returns `{ value, set }`.

**The named selectors stay** (P1). The 51 places in `src/client` that read
per-setting fields keep reading them; the fields become a thin view over the
record. They are a compatible read path, not a registration step, so no setting
needs one and nothing forces a migration.

## 4. The renderer

`<DeclaredSettings tab="advanced" />` walks `ALL_SETTINGS` for that tab, groups
by `section` in declaration order, and renders one control per declaration:

| Value kind | Control |
|---|---|
| `bool` | toggle |
| `enumOf` | select, or a segmented picker for a short static set |
| `numeric` | number input, with the declared unit |
| `text` | input; textarea when the store is `system-prompt-file` |
| `gitIdentity` | the name-and-email pair |
| `modelSelection` | the model picker |
| a declaration naming a `component` | that component |

Label and description come from the declaration, as they already do. Validation
messages come from the value type's `validate()`, which already returns the
`Rendered` text the agent is shown, so a control stops carrying its own bounds
and placeholders (P8).

**Content that is not a setting stays hand-placed and needs no schema** (P12). A
tab file is still a React component; it puts `<DeclaredSettings/>` and the update
panel or the enforcement warning where it wants them. A tab may pin an individual
section around that chrome; any section it does not pin renders in declaration
order, so **adding a setting never needs a JSX edit** (req 1).

## 5. Components

```ts
component: "services-panel"
```

A registry maps the name to a React component, which receives the declaration and
the current value. Custom is presentation; the declaration and the destination
are the same ones every row uses (req 3).

Nine panels own the 34 addressed fields between them (P11). Four small components
cover six declarations: the memory budget (P4), the webhook pair (P9), the TTS
choices (P7), and the repository colour picker. Two addressed declarations render
normally because Project Settings is already open for exactly one repository —
`project.allowAgentMerge` as a row, `project.colorIndex` as that picker (req 10).

## Slices

Each is one pull request, and each ships visible UI rather than scaffolding.

1. **The spine, delivered on Advanced.** The value record, `useSetting` /
   `saveSetting` for credential-store and browser scalars, the control table,
   `section`, and the Advanced tab generated whole — its six server toggles, its
   three browser toggles, and the memory-budget component. The update panel stays
   hand-placed.
2. **Instructions, Git, Network.** The textarea convention and the instruction
   conflict state (P14), the git identity control, and `own-route` writes (P2).
3. **Voice.** The remaining browser values, the TTS choices component (P7), the
   webhook pair (P9), and the webhook becoming always visible (P13).
4. **Integrations.** The two credential rows (P10), and `autoCreatePr` becoming
   always visible (P13).
5. **Panels.** Register the nine as components and bind them to their
   declarations; they keep their own writers and operations.
6. **Project Settings** (req 10) — the second dialog, its repo-scoped write, the
   colour picker and the secrets panel.
7. **Cleanup.** Delete `settings-coverage.test.tsx` and the `data-setting`
   attribute (req 12, P15).

Slices 2–4 are independent of each other. Slice 7 must be last: it is the only
one that removes a guard, and it may only run once nothing hand-writes a row.

## Key files

| File | Role |
|---|---|
| `src/server/shared/settings-catalogue/types.ts` | the declaration; gains `section` and `component` |
| `src/client/components/Settings/declared-setting.ts` | today's boolean reader and writer — generalised into `useSetting` / `saveSetting` |
| `src/client/components/Settings/declared.tsx` | today's declared controls — becomes the control table |
| `src/client/components/Settings/setting-binding.ts` | `data-setting`; deleted in slice 7 |
| `src/client/components/Settings/settings-coverage.test.tsx` | the walk; deleted in slice 7 |
| `src/client/stores/settings-store.ts` | gains the value record; the named fields become views over it |
| `src/client/utils/local-storage.ts` | loses its 13 accessor pairs for settings |
| `src/server/shared/settings-catalogue/tabs.ts` | tab labels today; section metadata if it does not live in the declaration |

## What stays exactly as it is

The agent's half (req 8). `emits`, `propose`, the projection, the refusal
reasons, `LIVE_DETAILS`, the proposal card and `shipit settings` are untouched —
this feature is client-side, and the declaration it reads is the same one it
reads now. The **stored-shape** maps (`MCP_SERVER_FIELD_SETTINGS` and its
siblings) also stay: they catch a stored field nobody declared, which is the
opposite direction from the walk being deleted, and they are compile errors
rather than tests (P15).
