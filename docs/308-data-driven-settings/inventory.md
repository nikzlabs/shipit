---
title: Every setting, and what its declaration becomes
description: The inventory behind docs/308 — all 77 declarations, which of them a generated control can render, and every problem and dependency found in the walk.
---

# Every setting, and what its declaration becomes

This is `docs/308-data-driven-settings` requirement 7: before the dialog changes,
every setting is written down — what it is today, what its declaration becomes,
and what it drags with it. Read `requirements.md` in this folder first.

Counted from `src/server/shared/settings-catalogue/` on 2026-09-16: **77
declarations**, of which **39 carry an `address`** (they describe one item of a
collection rather than one value), **14 emit `configuredOnly`**, and **9 are
collections**.

## The shape of the answer

| Outcome | Declarations | What it means |
|---|---|---|
| **Generated row** | 26 | A control the renderer produces from the value kind. Nothing hand-written. |
| **Generated credential row** | 2 | A token the user pastes and can disconnect: Linear, and GitHub's personal access token. |
| **Small component** | 6 | Four components: the memory budget, the webhook pair, the TTS choices, the repository colour. |
| **Panel** | 9 | A collection editor with its own operations. |
| **Repeated by a panel** | 34 | Item fields and per-item settings, addressed by a credential, an account, a host, a server or a repository. |

So **28 of 77 settings stop being hand-written entirely**, 4 small components
cover 6 more, and 9 panels own the remaining 34 between them. Every one of them —
generated, component or panel — reads its words from its declaration and writes
to the declaration's store.

## Four kinds of control, not two

1. **A value row.** One declaration, one value, one control chosen by value kind:
   toggle, choice, number, text, git identity, model selection.
2. **A credential row.** A token the browser pastes in and can remove. Only two
   stand alone; the rest of the credentials are addressed and live in panels.
3. **A panel.** A collection with operations — add, remove, reorder, test, sign
   in. Nine of these.
4. **A repeated field.** A declaration a panel renders once per item, addressed
   by a credential id, a provider and account, a service and billing mode, an SSH
   host, an MCP server or a repository.

**`configuredOnly` is not a control kind.** It is the **agent's** projection —
what `shipit settings` may emit. The browser is a different reader and often has
the value: it shows the saved webhook URL back to the user. So a credential row
is chosen from what the *dialog* can show, never from `emits`.

## What the declaration gains

**Two optional fields.** Walking all 77 settings, then reviewing that walk for
subtraction, removed four more that looked necessary.

| Field | Why it exists | Used by |
|---|---|---|
| `section` | Larger tabs have headed groups — Advanced's automation and notifications, Voice's input and playback | rows on the larger tabs; omitted elsewhere |
| `component` | A setting that needs its own UI (req 3) | 9 panels, 4 components |

```ts
// A row: nothing new at all.
defineSetting({
  key: "advanced.autoFixCi",
  tab: "advanced",
  section: "Automation",        // NEW, optional
  scope: "global",
  label: "Auto-fix CI when checks fail",
  description: "…",
  type: bool({ default: false }),
  store: { kind: "credential-store", field: "autoFixCi" },
  wire: "autoFixCi",
  emits: plain(),
  propose: { kind: "yes" },
})

// A panel or a small component: one string.
  component: "services-panel",   // NEW, optional
```

**Six things deliberately NOT added, each because a real setting stopped needing
it:**

| Rejected | Why it is not needed |
|---|---|
| Conditional visibility | Requirement 4 removed it. Two rows are conditional today (P13) |
| `order` | Declaration order is the order. No setting needs a rank independent of it, and requirement 11 accepts what that produces |
| `presentation: "multiline"` | Its only consumers are the two instruction boxes, and both are the only `system-prompt-file` settings. That store *is* the signal |
| An enum option source | Its only generated consumers were `voice.ttsVoice` and `voice.ttsSpeed`, which depend on `voice.ttsProvider`. One small component covers all three. The other dynamic enums are already inside custom editors |
| A numeric display unit | Its only consumer is the memory budget, which stores MB, shows GB, has an explicit Save and a saved state — a small component, not a field on the type |
| A commit-mode field | Derived from the value kind for generated rows. Components keep whatever they do now (P5) |

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
| `advanced.memoryBudgetMb` | advanced | numeric | credential store `memoryBudgetMb` | value | memory-budget component |
| `advanced.releaseChannel` | advanced | enumOf | own route `POST /api/updates/channel` | value | **generated row** |
| `integrations.autoCreatePr` | integrations | bool | credential store `autoCreatePr` | value | **generated row** |
| `git.identity` | git | gitIdentity | git config | value | **generated row** |
| `instructions.userInstructions` | instructions | text | prompt file `standard` | value | **generated row** |
| `instructions.opsInstructions` | instructions | text | prompt file `ops` | value | **generated row** |
| `instructions.agentInstructionsEnabled` | instructions | bool | credential store `agentSystemInstructionsEnabled` | value | **generated row** |
| `voice.deliveryMode` | voice | enumOf | credential store `voiceDeliveryMode` | value | **generated row** |
| `services.nonTurnModel` | services | modelSelection | credential store `nonTurnModel` | value | **generated row** |
| `network.egressContained` | network | bool | own route `PUT /api/egress/settings` | value | **generated row** |

### Browser values — `browser-settings.ts` (14)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `keyboard.keybindings` | keyboard | collection | localStorage `shipit-keybindings` | named only | **panel** |
| `keyboard.keybindings[].chord` | keyboard | text | localStorage `shipit-keybindings` | named only | repeated by its panel |
| `voice.inputEnabled` | voice | bool | localStorage `shipit-voice-input-enabled` | named only | **generated row** |
| `voice.sttProvider` | voice | enumOf | localStorage `shipit-stt-provider` | named only | **generated row** |
| `voice.cleanupEnabled` | voice | bool | localStorage `shipit-voice-cleanup-enabled` | named only | **generated row** |
| `voice.language` | voice | enumOf | localStorage `shipit-voice-language` | named only | **generated row** |
| `voice.playbackEnabled` | voice | bool | localStorage `shipit-voice-playback-enabled` | named only | **generated row** |
| `voice.ttsProvider` | voice | enumOf | localStorage `shipit-tts-provider` | named only | **generated row** |
| `voice.ttsVoice` | voice | text | localStorage `shipit-tts-voice` | named only | tts-choices component |
| `voice.ttsSpeed` | voice | numeric | localStorage `shipit-tts-speed` | named only | tts-choices component |
| `voice.handsFree` | voice | bool | localStorage `shipit-voice-hands-free` | named only | **generated row** |
| `advanced.compactConversation` | advanced | bool | localStorage `shipit-compact-conversation` | named only | **generated row** |
| `advanced.notifyOnFinish` | advanced | bool | localStorage `shipit-notify-on-finish` | named only | **generated row** |
| `advanced.soundOnFinish` | advanced | bool | localStorage `shipit-sound-on-finish` | named only | **generated row** |

### Voice credentials — `voice-settings.ts` (3)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `voice.providerKey` | voice | text | panel | configured? | repeated by its panel |
| `voice.webhook.url` | voice | text | panel | configured? | webhook-pair component |
| `voice.webhook.token` | voice | text | panel | configured? | webhook-pair component |

### Network — `network-settings.ts` (2)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `network.egress.hosts` | network | collection | panel | derived | **panel** |
| `network.egress.hosts[].host` | network | text | panel | derived | repeated by its panel |

### Project — `project-settings.ts` (5)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `project.allowAgentMerge` | project-deployments | bool | panel | value | **generated row** |
| `project.secrets` | project-secrets | collection | panel | derived | **panel** |
| `project.secrets[].name` | project-secrets | text | panel | value | repeated by its panel |
| `project.secrets[].value` | project-secrets | text | panel | configured? | repeated by its panel |
| `project.colorIndex` | project-appearance | numeric | panel | value | colour-picker component |

### Model providers — `services-settings.ts` (9)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `services.credentials` | services | collection | panel | derived | **panel** |
| `services.accountSelectionMode` | services | enumOf | panel | value | repeated by its panel |
| `services.failoverCutoff.session` | services | numeric | panel | value | repeated by its panel |
| `services.failoverCutoff.weekly` | services | numeric | panel | value | repeated by its panel |
| `services.credentials[].label` | services | text | panel | value | repeated by its panel |
| `services.credentials[].secret` | services | text | panel | configured? | repeated by its panel |
| `services.providerAccounts[].connection` | services | text | panel | configured? | repeated by its panel |
| `services.providerAccounts[].label` | services | text | panel | value | repeated by its panel |
| `services.providerAccounts` | services | collection | panel | derived | **panel** |

### Roles and reviewers — `roles-settings.ts` (10)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `roles` | roles | collection | panel | derived | **panel** |
| `roles[].name` | roles | text | panel | value | repeated by its panel |
| `roles[].model` | roles | modelSelection | panel | value | repeated by its panel |
| `roles[].harness` | roles | text | panel | value | repeated by its panel |
| `roles[].reasoningEffort` | roles | text | panel | value | repeated by its panel |
| `roles[].description` | roles | text | panel | value | repeated by its panel |
| `roles[].prompt` | roles | text | panel | value | repeated by its panel |
| `reviewers` | roles | collection | panel | derived | **panel** |
| `reviewers[].model` | roles | modelSelection | panel | value | repeated by its panel |
| `reviewers[].reasoningEffort` | roles | text | panel | value | repeated by its panel |

### Integrations — `integrations-settings.ts` (18)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `mcp.servers` | integrations | collection | panel | derived | **panel** |
| `mcp.servers[].name` | integrations | text | panel | value | repeated by its panel |
| `mcp.servers[].type` | integrations | enumOf | panel | value | repeated by its panel |
| `mcp.servers[].enabled` | integrations | bool | panel | value | repeated by its panel |
| `mcp.servers[].command` | integrations | text | panel | configured? | repeated by its panel |
| `mcp.servers[].args` | integrations | secretBag | panel | configured? | repeated by its panel |
| `mcp.servers[].npmPackage` | integrations | text | panel | configured? | repeated by its panel |
| `mcp.servers[].url` | integrations | text | panel | derived | repeated by its panel |
| `mcp.servers[].env` | integrations | secretBag | panel | configured? | repeated by its panel |
| `mcp.servers[].headers` | integrations | secretBag | panel | configured? | repeated by its panel |
| `mcp.oauthProvider` | integrations | text | panel | configured? | repeated by its panel |
| `integrations.github.connection` | integrations | text | panel | configured? | **credential row** |
| `integrations.sshHosts` | integrations | collection | panel | derived | **panel** |
| `integrations.sshHosts[].label` | integrations | text | panel | value | repeated by its panel |
| `integrations.sshHosts[].address` | integrations | text | panel | derived | repeated by its panel |
| `integrations.sshHosts[].user` | integrations | text | panel | derived | repeated by its panel |
| `integrations.sshHosts[].port` | integrations | numeric | panel | value | repeated by its panel |
| `integrations.linear.credential` | integrations | text | panel | configured? | **credential row** |

## Problems and dependencies

Numbered so the plan and review can cite them.

**P1 — The client store is the second registration.**
`src/client/stores/settings-store.ts` (758 lines) holds a named field *and* a
setter per setting; `src/client/utils/local-storage.ts` holds an accessor pair
per browser storage key — **13 keys for 14 declarations**, because
`keyboard.keybindings[].chord` shares its parent's key. **51 places in
`src/client`** read those named fields, excluding the store, the accessors and
the coverage test that is being deleted.
*Resolution:* the named selectors become a thin read layer over a generic
`Record<SettingKey, unknown>` and **stay that way**. They are a compatible view,
not a registration step, so nothing forces a migration of the 51 sites.

**P2 — `store.route` and `store.ownedBy` are prose, not addresses.** An
`own-route` store carries `"POST /api/updates/channel"` as a human-readable
string. A generic writer needs a method and a path. Two settings use `own-route`
(`advanced.releaseChannel`, `network.egressContained`), so this is a small change
or those two keep their own writers.

**P3 — Some writes have a follow-up, and the follow-ups have owners already.**
Server-side ones live in `SAVE_HOOKS` (`src/server/orchestrator/services/settings.ts:307`),
**not** in the declarations. Client-side ones exist too and are not going away:
`setTtsProvider` repicks the voice and the speed, and enabling hands-free arms
audio playback (`src/client/stores/settings-store.ts:535`). So the rule is narrow:
**a generated row's writer awaits the response and does nothing else.** It is not
a claim that no setting has a client-side effect.

**P4 — One setting is stored in one unit and shown in another.**
`advanced.memoryBudgetMb` stores MB and the dialog shows GB, with an explicit
Save and a "saved" state. Neither a new field on `numeric` nor a convention keyed
on `unit: "MB"` is worth it for one setting: it becomes a small component and
keeps behaving exactly as it does now.

**P5 — Commit mode is derivable for generated rows, and only for those.** Toggles
and choices save on click; text saves on a button. That covers every generated
row. It is **not** a universal rule — an SSH port saves with its form, and a
failover cutoff commits on blur — but those live in panels, which keep their own
behaviour.

**P6 — Optimistic write with rollback exists only for booleans.**
`src/client/components/Settings/declared-setting.ts` already does the hard part:
per-field sequencing, and rollback to the last value the **server** confirmed
rather than to the value the failed request asked for. Generalising it must keep
that, and must not apply it to explicit-commit rows, which do not need it.

**P7 — Four enums are declared as `text` because their options are dynamic.**
`voice.ttsVoice`, `roles[].harness`, `roles[].reasoningEffort` and
`reviewers[].reasoningEffort`. Three of the four are already inside custom
editors whose choices depend on the draft being edited, so they need nothing.
Only the voice needs a control, and it shares one with the speed and the provider
(the TTS choices component). **The agent already reads the live options for all
of them** — `LIVE_DETAILS` (`src/server/orchestrator/services/settings-read.ts:821`)
covers `voice.ttsVoice`, `voice.ttsSpeed`, `roles[].harness`, both reasoning
efforts and both model selections — so there is no agent-side benefit to claim
here.

**P8 — Validation already exists and is already the agent's message.** The value
type's `validate(raw, noun)` returns a `Rendered` refusal. A generated control
shows that message rather than inventing a second phrasing, and number inputs
stop carrying their own bounds in JSX.

**P9 — Two values are composites.** `git.identity` is a name and an email, and
the value kind can carry a control for it. The voice webhook is a URL and a token
saved together with one button, so it is a component.

**P10 — The credentials are not one shape.** Of the 14 `configuredOnly`
declarations, `integrations.github.connection` is a **personal access token
form** (`src/client/components/GitHubTokenForm.tsx`), not an OAuth flow;
`integrations.linear.credential` is the same shape; `mcp.oauthProvider` and
`voice.providerKey` are addressed and repeat per provider; the rest sit inside
panels with sign-in and replace operations. Only the first two are generated
rows.

**P11 — 39 declarations are addressed and cannot be placed by the renderer.**
They break down as **34 item fields**, **3 addressed collections**
(`services.credentials`, `services.providerAccounts`, `project.secrets`) and
**2 repository scalars**. The two repository scalars are the exception that
renders normally: `project.allowAgentMerge` becomes a row and
`project.colorIndex` a swatch picker, because Project Settings is already open
for exactly one repository (req 10).

**P12 — Tabs hold content that is not a setting, and it stays hand-placed.** The
update panel, the egress enforcement warning, the instruction conflict notice.
These need **no schema**: a tab file is still a React component that puts the
generated block and the chrome where it wants them. (The Linear team picker is no
longer an example — `src/client/components/SettingsTrackers.tsx` describes it as
a read-only team lookup now.)

**P13 — Two rows become permanently visible, not one.** The voice webhook pair,
hidden unless delivery is external or both
(`src/client/components/Settings/tabs/VoiceTab.tsx:528`), and
`integrations.autoCreatePr`, which sits in the authenticated branch of the GitHub
card (`src/client/components/SettingsIntegrations.tsx:131`) and so disappears
while GitHub is disconnected. Requirement 4 accepts both.

**P14 — The instruction boxes write to files and detect outside edits.** Both
`system-prompt-file` settings carry a conflict notice when the file changed while
the user was editing. That is an explicit-commit row with a conflict state —
either a declared capability, or these two keep a component.

**P15 — The residual guard is deleted (req 12).**
`settings-coverage.test.tsx` (1617 lines) and the `data-setting` attribute exist
to catch a control nobody declared. For generated rows that becomes impossible by
construction. The **stored-shape** maps — `MCP_SERVER_FIELD_SETTINGS` keyed by
`keyof McpServerConfig`, and its siblings for SSH hosts and roles — are
unaffected and stay: they catch a stored field nobody declared, which is the
opposite direction, and they are compile errors rather than tests.

## What we take from VS Code, and what we leave

Read from `code.visualstudio.com/api/references/contribution-points` and
`vscode/src/vs/workbench/contrib/preferences/browser/settingsTree.ts`.

| Their decision | Ours |
|---|---|
| One schema entry per setting: key, type, default, description | **Have it already** — that is what docs/299 built |
| The widget is chosen by value type alone (`getTemplateId`) | **Adopt.** 13 templates cover everything they render |
| One write path: `updateValue(key, value, target)`; the control fires `{key, value, scope}` and never names a field | **Adopt for generated rows.** This is the whole point — it makes docs/299 req 7 a mechanism instead of an assertion |
| `order` places a setting | **Skip.** Declaration order is the order (req 11) |
| `enumDescriptions` / `enumItemLabels` | **Have it already** — declared options carry a label and a description |
| `editPresentation: multilineText` | **Skip.** The `system-prompt-file` store already identifies both consumers |
| What it cannot render, it declines to render, and says *"Edit in settings.json"* | **Adopt the honesty, not the outcome.** A declaration names a component instead. We keep the UI; they drop it |
| A "modified" mark and reset-to-default on every setting | **Later.** Free once rows are data, not required by this feature |
| Search and `@modified` / `@tag:` filters | **Later.** Valuable; nothing depends on it |
| `scope`: application / machine / window / resource | **Have an equivalent** — global / project / browser |
| `deprecationMessage`, which hides a setting unless it is set | **Skip.** No deprecated settings today |
| The JSON Schema validation vocabulary (`pattern`, `minimum`, `format`…) | **Skip.** Typed validators exist and already produce the agent's refusal message |
| A raw `settings.json` the user edits by hand | **Skip.** `shipit settings` is our second surface and it is typed |
| Profiles, settings sync, policy, per-language overrides | **Skip.** No such concepts here |

## What this deletes

- The hand-written row and wiring for 28 settings.
- The per-setting **setter** in `settings-store.ts` and the 13 accessor pairs in
  `local-storage.ts`; the named **readers** stay as a compatible view (P1).
- The bounds and placeholder text that duplicate what the value type already
  validates (P8).
- `settings-coverage.test.tsx` and the `data-setting` attribute (req 12, P15).
