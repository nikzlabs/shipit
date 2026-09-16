---
title: Every setting, and what its declaration becomes
description: The inventory behind docs/308 — all 77 declarations, which of them a generated control can render, and every problem and dependency found in the walk.
---

# Every setting, and what its declaration becomes

This is `docs/308-data-driven-settings` requirement 7: before the dialog changes,
every setting is written down — what it is today, what its declaration becomes,
and what it drags with it. Read `requirements.md` in this folder first.

Counted from `src/server/shared/settings-catalogue/` on 2026-09-16: **77
declarations**, of which 37 carry an `address` (they describe one item of a
collection, not one value).

## The shape of the answer

| Outcome | Declarations | What it means |
|---|---|---|
| **Generated row** | 28 | A control the renderer produces from the value type. Nothing hand-written. |
| **Generated credential row** | 3 | Write-only: shows configured or not, replace, remove. One is a connect flow. |
| **Small custom component** | 4 | A pair or a picker: the git identity, the voice webhook, the model selection. |
| **Panel component** | 9 | A collection editor with its own operations. |
| **Inside a panel** | 33 | Item fields and per-item settings the panel repeats. |

So **31 of 77 settings stop being hand-written entirely**, 9 panels keep custom
UI and own 33 item fields between them, and 4 small components remain. Every one
of them — generated, panel or component — reads its words from its declaration
and writes through the declaration's store.

## Four kinds of control, not two

The split is not "standard or bespoke". It is:

1. **A value row.** One declaration, one value, one control. Toggle, choice,
   number, text.
2. **A credential row.** A value the browser may never read back. It shows
   whether it is configured, and offers replace or remove. 12 declarations emit
   `configuredOnly`; 3 stand alone and the rest sit inside panels. VS Code has no
   equivalent, because VS Code has no secrets — this one is ours to design.
3. **A panel.** A collection with operations: add, remove, reorder, test, sign
   in. 9 of these.
4. **A repeated field.** A declaration the panel renders once per item, addressed
   by a credential id, a provider and account, a service and billing mode, an SSH
   host or a repository.

## What the declaration gains

Four fields and one option source. Nothing else was needed to cover all 77.

```ts
defineSetting({
  key: "advanced.autoFixCi",
  tab: "advanced",
  section: "Automation",        // NEW — the heading this row sits under
  order: 30,                    // NEW — where in that section
  scope: "global",
  label: "Auto-fix CI when checks fail",
  description: "…",
  type: bool({ default: false }),
  store: { kind: "credential-store", field: "autoFixCi" },
  wire: "autoFixCi",
  emits: plain(),
  propose: { kind: "yes" },
})
```

A setting that needs its own UI names it, and nothing else changes:

```ts
  render: { kind: "component", component: "services-panel" },   // NEW
```

An enum whose options are not static names where they come from:

```ts
  type: enumOf({ default: "", options: { source: "tts-voices" } }),   // NEW
```

And a long text box says so, as VS Code's `editPresentation` does:

```ts
  presentation: "multiline",   // NEW
```

**What is deliberately NOT a field.** When a row saves — immediately on click, or
on a Save button — follows from the value kind: text commits explicitly,
everything else commits immediately. That matches every row in the dialog today
except the memory budget (P4). Conditional visibility is not a field either,
because requirement 4 removed the need for it.

## Every setting

### Global scalars — `global-settings.ts` (16)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `advanced.enableSubAgents` | advanced | bool | credential store `enableSubAgents` | value | **generated row** |
| `advanced.liveSteering` | advanced | bool | credential store `liveSteering` | value | **generated row** |
| `advanced.autoFixCi` | advanced | bool | credential store `autoFixCi` | value | **generated row** |
| `advanced.sessionStatusCard` | advanced | bool | credential store `sessionStatusCard` | value | **generated row** |
| `advanced.autoResolveConflicts` | advanced | bool | credential store `autoResolveConflicts` | value | **generated row** |
| `advanced.autoResetMergedBranch` | advanced | bool | credential store `autoResetMergedBranch` | value | **generated row** |
| `advanced.memoryBudgetMb` | advanced | numeric | credential store `memoryBudgetMb` | value | **generated row** |
| `advanced.releaseChannel` | advanced | enumOf | own route `POST /api/updates/channel` | value | **generated row** |
| `integrations.autoCreatePr` | integrations | bool | credential store `autoCreatePr` | value | **generated row** |
| `git.identity` | git | gitIdentity | git config | value | composite component |
| `instructions.userInstructions` | instructions | text | prompt file `standard` | value | **generated row** |
| `instructions.opsInstructions` | instructions | text | prompt file `ops` | value | **generated row** |
| `instructions.agentInstructionsEnabled` | instructions | bool | credential store `agentSystemInstructionsEnabled` | value | **generated row** |
| `voice.deliveryMode` | voice | enumOf | credential store `voiceDeliveryMode` | value | **generated row** |
| `services.nonTurnModel` | services | modelSelection | credential store `nonTurnModel` | value | model picker component |
| `network.egressContained` | network | bool | own route `PUT /api/egress/settings` | value | **generated row** |

### Browser values — `browser-settings.ts` (14)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `keyboard.keybindings` | keyboard | collection | localStorage `shipit-keybindings` | named only | **panel component** |
| `keyboard.keybindings[].chord` | keyboard | text | localStorage `shipit-keybindings` | named only | inside its panel |
| `voice.inputEnabled` | voice | bool | localStorage `shipit-voice-input-enabled` | named only | **generated row** |
| `voice.sttProvider` | voice | enumOf | localStorage `shipit-stt-provider` | named only | **generated row** |
| `voice.cleanupEnabled` | voice | bool | localStorage `shipit-voice-cleanup-enabled` | named only | **generated row** |
| `voice.language` | voice | enumOf | localStorage `shipit-voice-language` | named only | **generated row** |
| `voice.playbackEnabled` | voice | bool | localStorage `shipit-voice-playback-enabled` | named only | **generated row** |
| `voice.ttsProvider` | voice | enumOf | localStorage `shipit-tts-provider` | named only | **generated row** |
| `voice.ttsVoice` | voice | text | localStorage `shipit-tts-voice` | named only | **generated row** |
| `voice.ttsSpeed` | voice | numeric | localStorage `shipit-tts-speed` | named only | **generated row** |
| `voice.handsFree` | voice | bool | localStorage `shipit-voice-hands-free` | named only | **generated row** |
| `advanced.compactConversation` | advanced | bool | localStorage `shipit-compact-conversation` | named only | **generated row** |
| `advanced.notifyOnFinish` | advanced | bool | localStorage `shipit-notify-on-finish` | named only | **generated row** |
| `advanced.soundOnFinish` | advanced | bool | localStorage `shipit-sound-on-finish` | named only | **generated row** |

### Voice credentials — `voice-settings.ts` (3)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `voice.providerKey` | voice | text | panel | configured? | repeated per item, inside its panel |
| `voice.webhook.url` | voice | text | panel | configured? | credential pair component |
| `voice.webhook.token` | voice | text | panel | configured? | credential pair component |

### Network — `network-settings.ts` (2)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `network.egress.hosts` | network | collection | panel | derived | **panel component** |
| `network.egress.hosts[].host` | network | text | panel | derived | inside its panel |

### Project — `project-settings.ts` (5)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `project.allowAgentMerge` | project-deployments | bool | panel | value | **generated row**, repo-scoped |
| `project.secrets` | project-secrets | collection | panel | derived | **panel component** |
| `project.secrets[].name` | project-secrets | text | panel | value | inside its panel |
| `project.secrets[].value` | project-secrets | text | panel | configured? | inside its panel |
| `project.colorIndex` | project-appearance | numeric | panel | value | **generated row**, repo-scoped |

### Model providers — `services-settings.ts` (9)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `services.credentials` | services | collection | panel | derived | **panel component** |
| `services.accountSelectionMode` | services | enumOf | panel | value | repeated per item, inside its panel |
| `services.failoverCutoff.session` | services | numeric | panel | value | repeated per item, inside its panel |
| `services.failoverCutoff.weekly` | services | numeric | panel | value | repeated per item, inside its panel |
| `services.credentials[].label` | services | text | panel | value | inside its panel |
| `services.credentials[].secret` | services | text | panel | configured? | inside its panel |
| `services.providerAccounts[].connection` | services | text | panel | configured? | inside its panel |
| `services.providerAccounts[].label` | services | text | panel | value | inside its panel |
| `services.providerAccounts` | services | collection | panel | derived | **panel component** |

### Roles and reviewers — `roles-settings.ts` (10)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `roles` | roles | collection | panel | derived | **panel component** |
| `roles[].name` | roles | text | panel | value | inside its panel |
| `roles[].model` | roles | modelSelection | panel | value | inside its panel |
| `roles[].harness` | roles | text | panel | value | inside its panel |
| `roles[].reasoningEffort` | roles | text | panel | value | inside its panel |
| `roles[].description` | roles | text | panel | value | inside its panel |
| `roles[].prompt` | roles | text | panel | value | inside its panel |
| `reviewers` | roles | collection | panel | derived | **panel component** |
| `reviewers[].model` | roles | modelSelection | panel | value | inside its panel |
| `reviewers[].reasoningEffort` | roles | text | panel | value | inside its panel |

### Integrations — `integrations-settings.ts` (18)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `mcp.servers` | integrations | collection | panel | derived | **panel component** |
| `mcp.servers[].name` | integrations | text | panel | value | inside its panel |
| `mcp.servers[].type` | integrations | enumOf | panel | value | inside its panel |
| `mcp.servers[].enabled` | integrations | bool | panel | value | inside its panel |
| `mcp.servers[].command` | integrations | text | panel | configured? | inside its panel |
| `mcp.servers[].args` | integrations | secretBag | panel | configured? | inside its panel |
| `mcp.servers[].npmPackage` | integrations | text | panel | configured? | inside its panel |
| `mcp.servers[].url` | integrations | text | panel | derived | inside its panel |
| `mcp.servers[].env` | integrations | secretBag | panel | configured? | inside its panel |
| `mcp.servers[].headers` | integrations | secretBag | panel | configured? | inside its panel |
| `mcp.oauthProvider` | integrations | text | panel | configured? | connect row (OAuth), per provider |
| `integrations.github.connection` | integrations | text | panel | configured? | connect row (OAuth) |
| `integrations.sshHosts` | integrations | collection | panel | derived | **panel component** |
| `integrations.sshHosts[].label` | integrations | text | panel | value | inside its panel |
| `integrations.sshHosts[].address` | integrations | text | panel | derived | inside its panel |
| `integrations.sshHosts[].user` | integrations | text | panel | derived | inside its panel |
| `integrations.sshHosts[].port` | integrations | numeric | panel | value | inside its panel |
| `integrations.linear.credential` | integrations | text | panel | configured? | **generated credential row** |

## Problems and dependencies

Numbered so the plan and review can cite them.

**P1 — The client store is the second registration, and it has the widest blast
radius.** `src/client/stores/settings-store.ts` (758 lines) holds a named field
*and* a setter per setting; `src/client/utils/local-storage.ts` holds a
`getSavedX` / `saveX` pair per browser value, 14 of them. About **72 places in
`src/client`** read those named fields — `ttsSpeed` 11, `notifyOnFinish` 8,
`keybindings` 8, `sttProvider` 7, and so on. A generic
`Record<SettingKey, unknown>` is the right destination, but moving all 72 call
sites in one change is the largest risk in this feature.
*Recommendation:* make the **writes** generic first and keep the named selectors
as a thin read layer over the record, so the first change touches one file.

**P2 — `store.route` and `store.ownedBy` are prose, not addresses.** An
`own-route` store carries `"POST /api/updates/channel"` as a human-readable
string, and `bespoke` carries a sentence naming its owner. A generic writer needs
a method and a path. Two settings use `own-route`
(`advanced.releaseChannel`, `network.egressContained`), so this is a small change
or those two keep custom writers.

**P3 — Some writes have a follow-up.** Switching the release channel refetches
update status. Other saves retire resident agents or make a persisted status card
stale — and those already run server-side in the declaration's `after` hook. The
generic client writer must await the response and nothing more; it must not grow
after-effects of its own, or the same effect exists in two places.

**P4 — One setting is stored in one unit and shown in another.**
`advanced.memoryBudgetMb` stores MB and the dialog shows GB, with an explicit
Save and a "saved" state. VS Code does not convert units; it shows the stored
number. Either the declaration carries a display unit (one field used by one
setting), or the row shows MB and the description stops promising GB. **This is a
visible change to the user and should be decided, not defaulted.**

**P5 — Commit mode is derivable except for that one setting.** Toggles, choices
and the speed picker save on click. The two instruction boxes save on a button.
The memory budget is the only *number* with an explicit Save. Deriving commit
mode from the value kind needs no new field and preserves today's behaviour
everywhere else; the budget would become an immediate save with rollback.

**P6 — Optimistic write with rollback exists only for booleans.**
`src/client/components/Settings/declared-setting.ts` already does the hard part —
per-field sequencing, and rollback to the last value the **server** confirmed
rather than to the value the failed request asked for. Generalising it must keep
that, and must not apply it to explicit-commit rows, which do not need it.

**P7 — Four enums are declared as `text` because their options are dynamic.**
`voice.ttsVoice` (the voices of the chosen provider), `roles[].harness`,
`roles[].reasoningEffort` and `reviewers[].reasoningEffort`. A declared option
source fixes the control **and** improves the agent's read: `shipit settings get`
would name the valid values instead of reporting free text.

**P8 — Validation already exists and is already the agent's message.** The value
type's `validate(raw, noun)` returns a `Rendered` refusal. A generated control
must show that message rather than invent a second phrasing, and number inputs
must stop carrying their own bounds in JSX.

**P9 — Two values are composites.** `git.identity` is a name and an email;
the voice webhook is a URL and a token saved together with one button. Two cases
do not justify a composite field type. Both stay small components bound to their
declarations.

**P10 — Credentials are not text boxes.** Of the 12 `configuredOnly`
declarations, some are a password field with *"leave blank to keep"*, two are an
OAuth connect flow (`integrations.github.connection`, `mcp.oauthProvider`), and
the rest are per-item inside panels. The standalone ones need one credential row
design; connect flows need a button, not an input.

**P11 — 37 declarations are addressed and cannot be placed by the renderer.**
They belong to an item: a credential, a provider account, a service and billing
mode, an SSH host, an MCP server, a repository. The owning panel repeats them.
Two are the exception and become ordinary rows —`project.allowAgentMerge` and
`project.colorIndex` are addressed by repository, and the Project Settings dialog
is already open for exactly one.

**P12 — Tabs hold content that is not a setting.** The update panel, the egress
enforcement warning, the Linear team picker, the *"these instructions changed
somewhere else"* notice. A generated section must be able to hold a declared
non-setting component, or those tabs cannot be generated at all.

**P13 — The webhook rows become permanently visible.** Requirement 4 accepts
this. Saving a webhook while delivery is inline stores a value that does nothing
until the mode changes. This is the only visibility change in the whole dialog.

**P14 — The instruction boxes write to files and detect outside edits.** Both
`system-prompt-file` settings carry a conflict notice when the file changed while
the user was editing. That is an explicit-commit row with a conflict state —
either a declared capability, or these two keep a component.

**P15 — The residual guard changes purpose.** `settings-coverage.test.tsx`
(1617 lines) and the `data-setting` attribute exist to catch a control nobody
declared. For generated rows that becomes impossible by construction; for panels
it stays meaningful. `requirements.md` carries the open question of whether the
walk is deleted or narrowed. The **stored-shape** maps —
`MCP_SERVER_FIELD_SETTINGS` keyed by `keyof McpServerConfig`, and its siblings
for SSH hosts and roles — are unaffected and should stay: they are compile
errors, they run in the opposite direction, and they cost nothing.

## What we take from VS Code, and what we leave

Read from `code.visualstudio.com/api/references/contribution-points` and
`vscode/src/vs/workbench/contrib/preferences/browser/settingsTree.ts`.

| Their decision | Ours |
|---|---|
| One schema entry per setting: key, type, default, description | **Have it already** — that is what docs/299 built |
| The widget is chosen by value type alone (`getTemplateId`) | **Adopt.** 13 templates cover everything they render |
| One write path: `updateValue(key, value, target)`; the control fires `{key, value, scope}` and never names a field | **Adopt.** This is the whole point — it makes docs/299 req 7 a mechanism instead of an assertion |
| `order` places a setting | **Adopt as `section` + `order`.** Our tabs have headed sections; theirs is a flat list |
| `enumDescriptions` / `enumItemLabels` | **Have it already** — declared options carry a label and a description |
| `editPresentation: multilineText` | **Adopt** for the two instruction boxes |
| What it cannot render, it declines to render, and says *"Edit in settings.json"* | **Adopt the honesty, not the outcome.** A declaration names a component instead. We keep the UI; they drop it |
| A "modified" mark and reset-to-default on every setting | **Later.** Free once rows are data, not required by this feature |
| Search and `@modified` / `@tag:` filters | **Later.** Valuable; nothing depends on it |
| `scope`: application / machine / window / resource | **Have an equivalent** — global / project / browser |
| `deprecationMessage`, which hides a setting unless it is set | **Skip.** No deprecated settings today |
| The JSON Schema validation vocabulary (`pattern`, `minimum`, `format`…) | **Skip.** Typed validators exist and already produce the agent's refusal message |
| A raw `settings.json` the user edits by hand | **Skip.** `shipit settings` is our second surface and it is typed |
| Profiles, settings sync, policy, per-language overrides | **Skip.** No such concepts here |

## What this deletes

- The per-setting field and setter in `settings-store.ts`, and the 14
  `getSavedX` / `saveX` pairs in `local-storage.ts` (P1).
- The hand-written row and wiring for 31 settings.
- The bounds and placeholder text that duplicate what the value type already
  validates (P8).
- If the open question is answered that way: the 1617-line coverage walk and the
  `data-setting` attribute (P15).
