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
collections**. The browser's 14 declarations share **13 storage keys**.

## The shape of the answer

| Outcome | Declarations | What it means |
|---|---|---|
| **Generated row** | 23 | A control the renderer produces from the value kind. Nothing hand-written. |
| **Small component** | 11 | Eight components: the memory budget, the webhook pair, the TTS choices, hands-free, the repository colour, the two pasted-token credentials, and the background-work model. |
| **Panel** | 9 | A collection editor with its own operations. |
| **Repeated by a panel** | 34 | Item fields and per-item settings, addressed by a credential, an account, a host, a server or a repository. |

So **23 of 77 settings stop being hand-written entirely**, 8 components cover 11
more, and 9 panels own the remaining 34 between them. Every one of them —
generated, component or panel — reads its words from its declaration and writes
to the declaration's store.

*Two settings moved between the first two rows as the slices built them, and for
the same reason each time: what the renderer can produce from the value kind is
narrower than it looked. The **credential rows** went in slice 5 (`plan.md` →
Slices → 5) and **`services.nonTurnModel`** in slice 6b, because `modelSelection`
declares no options and so has nothing a generic picker could offer. What changed
is the counts above and the kind below, never the declaration, the destination or
what the user gets.*

## Four kinds of control, not two

1. **A value row.** One declaration, one value, one control chosen by value kind:
   toggle, choice, text, git identity. *A number and a model selection were on
   this list until slices 2 and 6b found that each one's only generated consumer
   needs its own component.*
2. **A credential row.** A token the browser pastes in, replaces and removes.
   Only two stand alone; the rest of the credentials are addressed and live in
   panels. *Slice 5: a credential row is a **component**, not a control kind —
   the write's answer is used, removing is a second address, and what it shows
   is the connection rather than the value.*
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

**Two optional fields, and one store shape that becomes machine-readable.**
Walking all 77 settings, then reviewing that walk twice, removed four more fields
that looked necessary.

| Change | Why it exists | Used by |
|---|---|---|
| `section` | Larger tabs have headed groups — Advanced's automation and notifications, Voice's input and playback | rows on the larger tabs; omitted elsewhere |
| `component` | A setting that needs its own UI (req 3) | 9 panels, 8 components |
| `own-route` gains `method`, `path` and `bodyField` | A single-value setting with a route of its own cannot be written from prose (P2) | 5 declarations |
| `own-route` gains `writeOnly` | A credential the path stores and never answers has no read to pair with the write, so nothing hydrates it and the record must not hold it (slice 5) | 2 declarations |

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

// A setting with a route of its own: an address, not a sentence.
  store: { kind: "own-route", method: "POST",
           path: "/api/updates/channel", bodyField: "channel" },
```

**Five things deliberately NOT added, each because a real setting stopped needing
it:**

| Rejected | Why it is not needed |
|---|---|
| Conditional visibility | Requirement 4 removed it. Two rows are conditional today (P13) |
| `order` | Declaration order is the order. No setting needs a rank independent of it, and requirement 11 accepts what that produces |
| `presentation: "multiline"` | Its only consumers are the two instruction boxes, and both are the only `system-prompt-file` settings. That store *is* the signal — and in slice 3 it became the **gate**: a `text` row over any other store has no control yet, so it is not generated at all |
| An enum option source | Its only generated consumers were the TTS provider, voice and speed, which depend on each other and share one component. The other dynamic enums are already inside custom editors |
| A numeric display unit | Its only consumer is the memory budget, which stores MB, shows GB, has an explicit Save and a saved state — a component, not a field on the type |

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
| `services.nonTurnModel` | services | modelSelection | credential store `nonTurnModel` | value | `background-work` component |
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
| `voice.ttsProvider` | voice | enumOf | localStorage `shipit-tts-provider` | named only | `voice-tts` component |
| `voice.ttsVoice` | voice | text | localStorage `shipit-tts-voice` | named only | `voice-tts` component |
| `voice.ttsSpeed` | voice | numeric | localStorage `shipit-tts-speed` | named only | `voice-tts` component |
| `voice.handsFree` | voice | bool | localStorage `shipit-voice-hands-free` | named only | `voice-hands-free` component |
| `advanced.compactConversation` | advanced | bool | localStorage `shipit-compact-conversation` | named only | **generated row** |
| `advanced.notifyOnFinish` | advanced | bool | localStorage `shipit-notify-on-finish` | named only | **generated row** |
| `advanced.soundOnFinish` | advanced | bool | localStorage `shipit-sound-on-finish` | named only | **generated row** |

### Voice credentials — `voice-settings.ts` (3)

| Setting | Tab | Type | Stored in | Agent reads | Becomes |
|---|---|---|---|---|---|
| `voice.providerKey` | voice | text | panel | configured? | `voice-provider-keys` component |
| `voice.webhook.url` | voice | text | own route `POST /api/voice/webhook` → `url` | configured? | `voice-webhook` component |
| `voice.webhook.token` | voice | text | own route `POST /api/voice/webhook` → `token` | configured? | `voice-webhook` component |

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
| `integrations.github.connection` | integrations | text | own route `POST /api/github/token` (write-only) | configured? | `github-connection` component |
| `integrations.sshHosts` | integrations | collection | panel | derived | **panel** |
| `integrations.sshHosts[].label` | integrations | text | panel | value | repeated by its panel |
| `integrations.sshHosts[].address` | integrations | text | panel | derived | repeated by its panel |
| `integrations.sshHosts[].user` | integrations | text | panel | derived | repeated by its panel |
| `integrations.sshHosts[].port` | integrations | numeric | panel | value | repeated by its panel |
| `integrations.linear.credential` | integrations | text | own route `POST /api/trackers/linear/token` (write-only) | configured? | `linear-credential` component |

## Problems and dependencies

Numbered so the plan and review can cite them. P1–P16 came from the walk and the
subtraction review; P17–P19 from the pull-request review.

**P1 — The client store is the second registration.**
`src/client/stores/settings-store.ts` (758 lines) holds a named field *and* a
setter per setting; `src/client/utils/local-storage.ts` holds an accessor pair
per browser storage key — 13 keys for 14 declarations, because
`keyboard.keybindings[].chord` shares its parent's key.

The reach, counted as **matching lines**, not files:

```
for n in compactConversation notifyOnFinish soundOnFinish voiceInputEnabled \
         sttProvider cleanupEnabled voiceLanguage voicePlaybackEnabled \
         ttsProvider ttsVoice ttsSpeed voiceHandsFree keybindings; do
  grep -rn "\.$n\b" src/client --include=*.ts --include=*.tsx \
    | grep -vE "stores/settings-store.ts|utils/local-storage.ts|settings-coverage.test.tsx"
done | wc -l        # 51 on 2026-09-16
```

*Resolution:* the named selectors become a thin read layer over a generic
`Record<SettingKey, unknown>` and **stay that way**. They are a compatible view,
not a registration step, so nothing forces a migration of those 51 lines.

**P2 — `store.route` and `store.ownedBy` are prose, and a method with a path is
still not enough.** The two `own-route` settings post *different body shapes*:
`{ channel }` to `/api/updates/channel`
(`src/client/components/Settings/tabs/AdvancedTab.tsx:220`) and
`{ globalEnabled }` to `/api/egress/settings`
(`src/client/stores/egress-store.ts:129`). Neither declaration carries a `wire`,
so a payload-shaped reader cannot hydrate them either. The store therefore
carries a **method, a path and a body field**, and the reader takes the value
from the same field. Three more settings that a panel writes today are single
values behind a route of their own — `project.allowAgentMerge`,
`integrations.github.connection`, `integrations.linear.credential` — and are
re-declared `own-route` for the same reason, which is what makes them generated
rows rather than panel content.

**P3 — Some writes have a follow-up, and two of them are not the server's.**
Server-side follow-ups live in `SAVE_HOOKS`
(`src/server/orchestrator/services/settings.ts:307`), **not** in the
declarations. Two client-side ones are load-bearing and cannot move:
`voice.handsFree` calls `armAutoplay()` inside the click handler
(`src/client/components/Settings/tabs/VoiceTab.tsx:524`) — the browser only
unlocks audio inside the gesture, so a generated toggle that saves and returns
would leave playback silent — and `setTtsProvider` repairs an incompatible voice
and speed (`src/client/stores/settings-store.ts:535`). **Both are components for
that reason**, and the rule that remains is narrow: a generated row's writer
awaits the response and does nothing else.

**P4 — One setting is stored in one unit and shown in another.**
`advanced.memoryBudgetMb` stores MB and the dialog shows GB, with an explicit
Save and a "saved" state. Neither a new field on `numeric` nor a convention keyed
on `unit: "MB"` is worth it for one setting: it becomes a component and keeps
behaving exactly as it does now.

**P5 — Commit mode is derivable for generated rows, and only for those.** Toggles
and choices save on click; text saves on a button. That covers every generated
row. It is **not** a universal rule — an SSH port saves with its form, and a
failover cutoff commits on blur — but those live in panels, which keep their own
behaviour.

*Slice 6b checked the cutoff at the code rather than inheriting the claim:* both
`services.failoverCutoff.*` declarations are addressed and belong to the
credentials panel, which holds a draft per field and writes it on blur or on
Enter, plus a flush at unmount. Registering the panel moved none of that.

**P6 — Optimistic write with rollback exists only for booleans.**
`src/client/components/Settings/declared-setting.ts` already does the hard part:
per-field sequencing, and rollback to the last value the **server** confirmed
rather than to the value the failed request asked for. Generalising it must keep
that, and must not apply it to explicit-commit rows, which do not need it.

**P7 — Four enums are declared as `text` because their options are dynamic.**
`voice.ttsVoice`, `roles[].harness`, `roles[].reasoningEffort` and
`reviewers[].reasoningEffort`. Three of the four are already inside custom
editors whose choices depend on the draft being edited, so they need nothing.
The voice shares a component with the provider and the speed it depends on.
**The agent already reads the live options for all of them** — `LIVE_DETAILS`
(`src/server/orchestrator/services/settings-read.ts:821`) — so there is no
agent-side benefit to claim here.

*Slice 6b re-checked the three role enums before registering their editors, and
it still holds:* `roles[].harness` and `roles[].reasoningEffort` are inside
`roles/RoleEditor.tsx`, whose lists are re-derived from the draft's model on every
change, and `reviewers[].reasoningEffort` is inside `tabs/ReviewerSection.tsx`,
whose list is the levels the slot's RESOLVED selection honours rather than the
harness's vocabulary. None of the three could be offered by a control that knows
only the key.

**P8 — Validation already exists and is already the agent's message.** The value
type's `validate(raw, noun)` returns a `Rendered` refusal. A generated control
shows that message rather than inventing a second phrasing, and number inputs
stop carrying their own bounds in JSX.

**P9 — Two values are composites.** `git.identity` is a name and an email, and
the value kind can carry a control for it. The voice webhook is a URL and a token
saved together with one button, so it is a component.

*Slice 3 confirmed the first half at the code:* `gitIdentity` is a control-table
entry, two boxes over one declaration, and it needed nothing the kind does not
already carry — the coverage walk's one-control rule already exempts composite
kinds for exactly this shape, and its Save is the tab's rather than the row's.

*Slice 4 settled the second half.* The webhook is a component, and what it cost
was **an address and a grouping**: both declarations carry the same `own-route`
`path` and `method` and differ only in `bodyField`, and `commitSettings` sends
one request per destination rather than one per setting. So the component's Save
names two keys and no path — the whole of requirement 3 — and the shared-component
dedup slice 2 deleted came back, because two renders of one credential would be
two Saves. The read follows the same address: one GET per path, a field per
setting, and nothing answers the token.

**P10 — The credentials are not one shape.** Of the 14 `configuredOnly`
declarations, `integrations.github.connection` is a **personal access token
form** (`src/client/components/GitHubTokenForm.tsx`) and
`integrations.linear.credential` is the same shape; those two become rows once
their route is declared (P2).

*Slice 5 built both, and they are **components**.* Each keeps the declared
address — `own-route`, plus `writeOnly` because the path stores the token and
answers no GET — so neither names a path or a body field. What a generated
control could not have carried: the write's ANSWER is the card (the account, the
teams a token reaches, the reason a refusal was refused), removing is a second
address, and being configured is not the value. A generic credential control
would have needed adapters and extra metadata for two consumers, which
requirement 5 refuses. `mcp.oauthProvider` and
`voice.providerKey` are addressed and repeat per provider; the rest sit inside
panels with sign-in and replace operations.

**P11 — 39 declarations are addressed, and one of them has no collection.**
They break down as **34 item fields**, **3 addressed collections**
(`services.credentials`, `services.providerAccounts`, `project.secrets`) and
**2 repository scalars**. The two repository scalars render normally because
Project Settings is already open for exactly one repository:
`project.allowAgentMerge` as a row and `project.colorIndex` as a swatch picker
(req 10). **`voice.providerKey` is addressed by a speech provider but belongs to
no collection declaration** — the Voice tab repeats it over the providers that
need a key (`src/client/components/Settings/tabs/VoiceTab.tsx:304`). Its owner is
that list, which is a component; the renderer must not treat it as a standalone
row.

*Slice 6b:* the Model-providers tab is that shape five times over. All five of
`services.credentials`, `services.accountSelectionMode`, the two
`services.failoverCutoff.*` and `services.providerAccounts` are addressed and
belong to no collection, so each names the panel and four are deduplicated
against the first; the item fields beneath them name nothing, because their
collection places it.

*Slice 4:* naming a component is exactly how an addressed declaration says that.
The renderer skips an addressed declaration **that names no component**, and the
key list keeps its own writer as a panel does — the write is addressed and
carries a second body field, which no value writer has a shape for. It is a row
without being in the value record: nothing would ever hydrate a per-provider key,
and the reader prefers the record to the named field.

**P12 — Tabs hold content that is not a setting, and it stays hand-placed.** The
update panel, the egress enforcement warning, the built-in agent instructions and
the CLAUDE.md sentence beside them. These need **no schema**: a tab file is still
a React component that puts the generated block and the chrome where it wants
them. (The Linear team picker is no longer an example —
`src/client/components/SettingsTrackers.tsx` describes it as a read-only team
lookup now. Nor is the instruction conflict notice: slice 3 found it belongs to
the row rather than to the tab — see P14.)

*Slice 3 found one limit:* a `note` renders at the **top** of its section, so
chrome that belongs *under* a row — the View-instructions disclosure under the
toggle that enables it — is placed after the whole block instead, and the row it
belongs to has to be last. That is why the built-in-instructions toggle is at the
bottom of the Instructions tab. A second prop for chrome under a section was not
worth one user.

**P13 — Two rows become permanently visible, not one.** The voice webhook pair,
hidden unless delivery is external or both
(`src/client/components/Settings/tabs/VoiceTab.tsx:528`), and
`integrations.autoCreatePr`, which sits in the authenticated branch of the GitHub
card (`src/client/components/SettingsIntegrations.tsx:131`) and so disappears
while GitHub is disconnected. Requirement 4 accepts both.

*Slice 4 made the first permanent.* The pair renders whatever the delivery mode
is, which is the honest order: the webhook has to be configured before either
mode that uses it does anything. *Slice 5 made the second permanent.* `integrations.autoCreatePr` renders whether
or not GitHub is connected. What that branch also held was the connected card's
own chrome — the account name and Disconnect — which genuinely needs a
connection; nothing else lived there.

**P14 — The instruction boxes write to files and detect outside edits.** Both
`system-prompt-file` settings carry a conflict notice when the file changed while
the user was editing. That is an explicit-commit row with a conflict state —
either a declared capability, or these two keep a component.

*Resolved in slice 3: neither.* The notice is a property of **being an
explicit-commit row**, not of these two settings. Such a row holds a draft and
the stored value it started from, and comparing the two against what is stored
now answers the whole question: an untouched box adopts a value that moved
underneath it, an edited one keeps the draft and says the stored value moved. So
it is derived, like the commit mode itself (P5). A declaration field would have
had exactly one user, which requirement 5 refuses; a component would have made
custom presentation out of something that is not presentation. The same code
covers the git identity, which nobody had listed as needing it.

**P15 — The coverage walk proves three things, and generation replaces one.**
`settings-coverage.test.tsx` (1617 lines) asserts that **no control is
undeclared**, that **the dialog's copy is the declaration's copy**
(`data-setting-label` / `data-setting-description`, compared against the
declaration), and that **no declaration is unreachable** — `UNREACHED` at
`:1512` names the exceptions, and `:1614` asserts the set exactly. Generating the
rows makes the first impossible **for rows**, and the nine panels still hold
hand-written controls. It does nothing about the other two.

**The walk is deleted anyway, and the loss is bounded** (req 12, decided
2026-09-16 on these corrected facts). A generated row takes its words from the
declaration and exists because the declaration exists, so for a row neither copy
drift nor an unreachable declaration is possible. What goes unchecked is the
**42 declarations owned by the nine panels and five components**: nothing will
prove that their copy matches the declaration, or that a declaration a panel
stopped rendering still has a control. The **stored-shape** maps
(`MCP_SERVER_FIELD_SETTINGS` and its siblings) are unaffected and stay: they
catch a stored field nobody declared, which is the opposite direction, and they
are compile errors rather than tests.

**P16 — One collection's items are fixed, and it is still a component.**
`keyboard.keybindings` is the only collection whose items the user does not
create: they are 13 command definitions in `src/client/keybindings/registry.ts`,
four of them not editable, and the stored value is a sparse override map over
their defaults. Its declaration says so already —
`collection({ operations: ["set", "reset"] })`. It is the closest thing in the
dialog to a list the renderer could generate, and it does not, for four reasons:
each row's label, group and default live in that second registry rather than in
the catalogue; the control is a key-chord capture, not a value kind; validation
differs per row (some commands require a second modifier); and conflict detection
compares every editable binding against every other, which a row rendered alone
cannot do. What changes is the write — `setKeybinding` and `resetKeybinding` name
`shipit-keybindings` themselves today and will resolve it from the declaration
(req 3).

**P17 — `localStorage` holds strings and JSON, and the value types do not read
them.** `bool.read` returns its default for anything that is not a real boolean
(`src/server/shared/settings-catalogue/value-types.ts:38`), so
`voice.inputEnabled.type.read("true")` is `false` — a generic reader that hands
raw stored text to `type.read()` would silently reset every browser boolean to
its default. The keybindings collection is stored as a JSON override object and
`getSavedKeybindings` also falls back to **three legacy keys**
(`src/client/utils/local-storage.ts:490`). So requirement 9 needs a **codec per
value kind for the browser store**, plus that legacy fallback kept, plus fixtures
written in today's on-disk formats. Keeping the storage key is necessary and not
sufficient.

*Slice 4 added three kinds and found a second half to the problem.* A choice and
a line of text are stored as themselves, so the codec hands the raw string to the
value type's own `read`; a speed is stored as `String(value)` and has to be
parsed first, because `numeric.read` answers its default for a string. Going
*through* `read` rather than past it is what the accessors it replaces did not
do: `getSavedString` returned any stored text, so a provider the catalogue no
longer offers reached a `<select>` with no such option and rendered blank, and
the speed accessor accepted any number above zero, including one outside the
declared range. A collection is still a kind the codec cannot spell, which is
what keeps the keybindings on the reader they have (P16).

**P18 — The slices need coexistence rules, not just an order.** A tab converted
to a generated block while some of its controls are not yet supported will
either duplicate them or render a row that cannot save:
`advanced.releaseChannel` needs P2's route support and is also already rendered
inside the update panel; Network and Integrations reach panels whose registration
comes later. Each slice therefore names the declarations it generates and the
ones it explicitly leaves hand-written, rather than generating a whole tab. The
old setters must also keep writing into the value record until the hydration
handlers move — `src/client/hooks/message-handlers/global-settings.ts` writes
them today.

**P19 — Two requirements state a preference rather than something observable.**
Requirement 5 ("the simplest mechanism") and requirement 6 ("where VS Code's
answer makes sense") cannot be checked mechanically. They are honest statements
of what the user asked for, and the way they are assessed is this document: a
field is admissible when a named setting needs it, and the VS Code table below
records each decision taken and skipped. That is the acceptance criterion.

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

- The hand-written row and wiring for 26 settings.
- The per-setting **setter** in `settings-store.ts` and the 13 accessor pairs in
  `local-storage.ts`; the named **readers** stay as a compatible view (P1).
- The bounds and placeholder text that duplicate what the value type already
  validates (P8).
- `settings-coverage.test.tsx` and the `data-setting` attribute — subject to the
  reopened requirement 12 (P15).
