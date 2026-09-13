---
issue: planning#537
title: Agent access to ShipIt settings — design
description: One setting registry behind a read command and a proposal card, so the agent can see every setting and ask for a change the user applies with one click.
---

# Agent access to ShipIt settings — design

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

## What this builds

Two things, and nothing else:

- **A read command.** `shipit settings list` / `shipit settings get <key>` gives
  the agent the current value of every setting the Settings dialog shows
  (req 1, req 5), with secret material reduced to "configured" or "not
  configured" (req 2).
- **A proposal card.** `shipit settings propose` posts an inline card naming the
  exact change — this setting, from this value, to that value, for this reason —
  and the setting moves only when the user clicks Apply (req 4).

Both go through **one registry** of setting descriptors. The registry is the
design: a single list that the read command, the card and the apply path all
consume, so a setting cannot be readable but unproposable, or proposable under a
name the card cannot label.

## Non-goals

Recorded so a later reader does not re-derive them as gaps:

- **No deep link into a control.** A `shipit-settings://` pointer that opens the
  dialog at the right row was offered and not chosen. The card carries the
  change; it does not carry navigation.
- **No direct write, and no Undo-after-the-fact.** The agent never applies a
  settings change, not even a reversible one (req 4). There is therefore no
  tier table, and no argument about which side a setting falls on.
- **No master switch** (req 6). The click is the entire gate.
- **Per-session sandbox capabilities** are set from the sandbox banner, not the
  dialog, so they stay with docs/279-mutable-sandbox-capabilities.

## Interpretation to confirm

Req 5 says "every setting the Settings dialog shows". ShipIt has a **second**
settings dialog — **Project Settings** (`ProjectSettings.tsx`), per repository,
holding the Secrets panel and the "Allow agents to merge their own pull
requests" permission. Those are precisely two of the things agent-facing docs
tell the agent to ask the user for (`shipit-docs/secrets.md`,
`shipit-docs/github.md:263`), so this design covers them as a second registry
scope rather than carving them out. Say so if the intent was the global dialog
only — it removes a scope from the registry and changes nothing else.

## The registry

`src/server/orchestrator/services/settings-registry.ts`. One descriptor per
setting:

```ts
interface SettingDescriptor {
  key: string;                 // stable dotted id: "advanced.enableSubAgents"
  tab: SettingsTab;            // the tab the user sees it on
  label: string;               // the dialog's own wording, reused verbatim
  help: string;                // one line, the dialog's own help text
  scope: "global" | "project" | "browser";
  kind: "boolean" | "enum" | "number" | "text" | "collection";
  sensitivity: "plain" | "secret";
  read?(ctx): SettingValue;    // absent for scope "browser" — see below
  apply?(ctx, value): void;    // absent for sensitivity "secret"
  format(value): string;       // one line, for the CLI and the card
}
```

Three properties follow from having one list rather than three:

1. **A setting the dialog shows and the registry omits is a red build.** A guard
   test walks `GlobalSettings` (`services/types.ts:25`), the egress store, the
   role and reviewer views and the project-settings payload, and asserts every
   field has a descriptor. This is the `CARD_MESSAGE_FIELDS` pattern: the cost of
   adding a setting later is a failing test that names the missing key, not a
   silent hole in what the agent can see.
2. **Secret handling is structural, not remembered.** `sensitivity: "secret"`
   has no `apply`, and the read path emits `configured: true|false` with no
   `value` field at all. A second guard test asserts no secret descriptor can
   produce a `value`, so req 2 cannot be broken by a careless new entry.
3. **The card labels itself.** `label` + `help` + `format` come from the
   descriptor, so the card shows the user the same words the dialog shows,
   rather than the agent's paraphrase of them.

**Collections.** `roles`, `egress.hosts`, `mcp.servers`, `skills.installed`,
`credentialRoutes` and `secrets` (names only) are `kind: "collection"` with item
operations — `add`, `remove`, `update` — addressed as `roles[reviewer].model`,
`network.egress.hosts[+registry.npmjs.org]`. Without item addressing, "add one
host to the allowlist" would have to be proposed as a whole-list replacement,
which is both unreadable on the card and a way to drop a host by accident.

**Applying never opens a second path.** Each `apply` calls the same service the
dialog calls — `saveGlobalSettings`, `egressAllowlistStore.addHost`,
`applyRoleWrites` — so the SSE broadcasts and the side effects that hang off
them (`prStatusPoller.broadcastAllSnapshots()` on `autoFixCi`, the container
egress reload on a new host) are the existing ones. A settings write that
bypassed them would be a second source of truth for the client.

## Scope inventory

Every dialog tab, and what the registry can do with it. The third column is the
honest answer req 5 asks for when a setting cannot be fully reached.

| Tab | Settings | Read | Propose |
|---|---|---|---|
| Services | credential routing order, account selection mode, failover cutoffs, non-turn model pin, installed harnesses | yes | yes |
| Services | provider API keys, provider accounts | configured / not | no — secret |
| Roles | role list (harness, model, effort, description), reviewer slots and pins | yes | yes |
| Integrations | connected services, MCP servers, tracker connections | yes, names and connection state | yes for connection-shaped changes; the credential itself is secret |
| Git | git identity name and email | yes | yes |
| Instructions | global system prompt, agent system instructions + enabled | yes | yes |
| Skills | installed skills, marketplaces | yes | yes |
| Keyboard | keybindings | browser-local | apply in the client |
| Voice | delivery mode, webhook configured | yes | yes (webhook URL is secret) |
| Voice | dictation, playback, TTS voice and speed, hands-free | browser-local | apply in the client |
| Network | egress on/off, global allowlist, per-session hosts, enforcement state | yes | yes |
| Advanced | memory budget, live steering, auto-create-PR, auto-resolve conflicts, auto-fix CI, auto-reset merged branch, sub-agents, update channel | yes | yes |
| Advanced | compact conversation, browser notification, sound | browser-local | apply in the client |
| Project Settings | secrets (names), agent-merge permission | names / yes | agent-merge yes; secret values no |

### Browser-local settings

A real part of the dialog is stored in the browser's `localStorage`, not on the
server (`settings-store.ts:396` and its neighbours): compact conversation,
notifications, sound, keybindings and most of the Voice tab. The orchestrator
has never held these values, so "read the setting" has no server-side answer.

The design keeps req 5 whole without inventing server persistence for them:

- **Read** — the client sends a `settings_local_snapshot` over the per-session
  WebSocket on connect and on change. The orchestrator holds it **in memory,
  per viewer, as non-authoritative reported data**, and the read command labels
  it as such: `compact conversation: on (this browser)`. With no viewer
  connected the value is `unknown (browser-local; no viewer connected)`. Nothing
  server-side reads this cache to decide anything, so it does not violate the
  rule that WebSocket lifecycle must not drive server behaviour — a missing
  snapshot degrades the answer and changes nothing else.
- **Apply** — a browser-scope change is executed by the card's own client
  handler calling the store setter, because that is where the value lives.

**Cut line.** If the snapshot channel turns out to cost more than a handful of
lines, drop the read half: keep the descriptor, report `unknown (browser-local)`
and keep the client-side apply. The agent still names the setting (req 3).

## Reading

```
shipit settings list [--tab network] [--json]
shipit settings get advanced.enableSubAgents
```

`list` prints key, label, tab and the formatted current value. Where a setting
is the reason something is unavailable, the descriptor's read result carries the
explanation the existing views already compute — a role's
`RoleUnavailableReason`, egress enforcement state — so the agent can say *why*
rather than only *what* (req 3).

`--json` is the machine form. It never contains a secret value, by construction
(above).

## Proposing

```
shipit settings propose \
  --set advanced.enableSubAgents=true \
  --set 'roles[reviewer].model=claude-opus-5' \
  --reason "The review you asked for needs sub-agents on and a reviewer role that resolves." \
  [--json]
```

**One card carries several changes**, applied as a set by one click. A coherent
ask is often two settings (enable the capability *and* configure the thing it
needs), and splitting it across two cards makes the user apply half a change.

**Validated at propose time.** Every key must exist in the registry and every
value must satisfy its descriptor — an enum takes only its own members, a number
its own range. An invalid proposal is rejected with the reason, before any card
is posted, so the agent corrects it in the same turn instead of the user seeing
a card that cannot apply.

**The card records `from` as read at propose time**, per change, alongside `to`.
Both are formatted through the descriptor.

**`--reason` is agent-authored untrusted text.** It is flattened to a single line
and length-capped before it enters the card, exactly as bug-report titles are
(`services/bug-report.ts:72`), so it cannot add lines to a card that otherwise
speaks for ShipIt.

### Applying

A `settings_proposal_decision` WebSocket message (`apply` | `dismiss`), handled
the way `handleEgressDecision` (`ws-handlers/egress-handlers.ts`) handles the
egress prompt card — which is the nearest thing ShipIt already has to this
feature: an agent-triggered card offering a specific settings change that the
user clicks.

**Re-read before applying.** For each change, read the current value and compare
it with the card's `from`. If any has moved, the card resolves `stale` and
**nothing** is applied. The comparison is against state, not against an observed
transition, so a card applied an hour later behaves correctly for a viewer that
was not connected when the value changed. This matters because a card outlives
its turn: the user may apply it long after the agent that proposed it is gone.

Phases: `pending` → `applied` | `dismissed` | `stale` | `failed`. `applied` and
`failed` carry a per-change outcome list, so a card whose second change failed
does not report as if none applied. `persistCardTransition` writes the phase to
the recorded card as well as the live one, so turn finalization cannot restore
`pending`.

### Telling the agent what the user decided

Mirrors the bug-report outcome path exactly: an `agentNotified` flag on the
persisted card, a `consumeUnreportedSettingsOutcomes` beside
`consumeUnreportedBugOutcomes` (`chat-history.ts:519`), and the notice joins the
same `agentPrefix` chain in `ws-handlers/agent-execution.ts:414` and
`dispatched-turn.ts:212`. The wording follows `buildBugOutcomeNotice`: applied
changes are stated as fact, and a dismissed change is marked *do not re-propose
unless asked*.

## Persistence

The card is transcript content, so it takes the full recipe from CLAUDE.md and
`docs/188-persist-transcript-cards`: a typed `PersistedMessage.settingsProposal`
field, a column plus `toRow`/`fromRow` and a `database.ts` migration,
rehydration in `loadSessionHistory`, registration in `CARD_MESSAGE_FIELDS`
(`visual-elements.ts`) and in `TRANSCRIPT_SCOPED_MESSAGES`
(`client/hooks/message-handlers/index.ts`), an extension of
`EVERY_OPTIONAL_FIELD_MESSAGE`, and history round-trip plus
no-duplicate-on-replay tests.

Emission goes through **`emitChatCard`** (`chat-card-persistence.ts`), never a
bare `emitMessage`: a `shipit settings propose` issued from a backgrounded
`shipit agent run` can land after the turn ends, and `emitChatCard` is what
decides between riding the in-progress turn and appending a final row.

## Trust boundary

- **The agent cannot address another session.** The worker injects the session
  id into every relayed call (`session/orchestrator-client.ts:55`); the agent
  supplies none. The orchestrator owns authorization, as it does for every other
  agent-ops route.
- **Secrets are unreachable by construction**, not by policy: no `apply`, no
  `value`, and a guard test for each.
- **Ingested text cannot change a setting.** A repository file, a web page or a
  tool result can at most cause the agent to *propose*; the user's click is
  required and is the whole gate (req 4). This is the reason the flat
  every-write-needs-a-click posture was chosen over a tier split.
- **No extra gate for sandbox sessions.** A sandbox may read and propose like
  any other session: the proposal lands in that session's own transcript and the
  click is the user's. Adding a refusal here would restrict nothing an untrusted
  workload could otherwise do.

## Agent-facing docs

New `src/server/shipit-docs/settings.md` covering the two commands, the secret
rule and the card. Then the places that currently tell the agent to send the
user to a control are rewritten to read the setting first and propose the
change: `agent.md:22` and `:367`, `issues.md:257`, `compose.md:624`,
`android.md:253`, `github.md:263`, `environment.md:241`, `skills.md`.

One consequence to state there: when the agent posts a proposal card, it must
**not** also write a `[needs you]` line for the same change. CLAUDE.md's
"Responding in chat" rule already says the list never repeats an affordance
ShipIt's own UI puts in front of the user, and a one-click card is one.

## Key files

New:

- `src/server/orchestrator/services/settings-registry.ts` — descriptors, read,
  validate, apply.
- `src/server/orchestrator/services/settings-proposal.ts` — card compile,
  staleness re-read, outcome notice.
- `src/server/orchestrator/ws-handlers/settings-proposal-handlers.ts` — the
  decision message.
- `src/server/session/agent-shim/shipit-settings.ts` — `list`, `get`, `propose`.
- `src/client/hooks/message-handlers/settings-proposal-card.ts`, plus the card
  component under `MessageList/cards/`.
- `src/server/shipit-docs/settings.md`.

Changed:

- `src/server/session/agent-ops-routes.ts` — relay `/settings*`.
- `src/server/orchestrator/api-routes-agent.ts` (or a sibling) — the
  session-scoped settings endpoints the relay targets.
- `src/server/session/agent-shim/shipit.ts` — subcommand dispatch and help.
- `src/server/shared/types/ws-server-messages/cards.ts`,
  `ws-client-messages.ts` — card and decision messages.
- `src/server/orchestrator/chat-history.ts`, `src/server/shared/database.ts` —
  persistence and the outcome consume.
- `src/server/orchestrator/ws-handlers/agent-execution.ts`,
  `dispatched-turn.ts` — the outcome notice in the agent prefix.
- `src/client/components/visual-elements.ts`,
  `src/client/hooks/message-handlers/index.ts` — card registration and
  transcript scoping.

## Testing

Beyond the persistence round-trip tests the recipe requires:

- **Registry coverage** — every field of `GlobalSettings` and every dialog
  surface has a descriptor. Red build names the missing key.
- **Secret non-exposure** — no `sensitivity: "secret"` descriptor yields a
  `value`, in either the text or the `--json` output.
- **Stale apply** — a card whose `from` no longer matches applies nothing and
  resolves `stale`. Delete the re-read and this test must go red on its own; the
  fixture has to change the setting between propose and apply for the guarded
  path to be live at all.
- **Partial failure** — a two-change card whose second apply throws reports the
  first as applied, not the whole card as failed.
- **Outcome notice consumed once** — a second turn does not repeat it.
- **Shim** — `list`, `get` and `propose` argument parsing, and the propose-time
  validation rejection.

## Risks

- **The registry is a hand-maintained mirror of the dialog.** The coverage guard
  is what keeps it honest; without that test this design rots within two
  features. Write the guard first.
- **`kind: "collection"` is where the complexity is.** Roles, MCP servers and
  skills are the hard entries and the ones most worth proposing. If the build
  runs long, ship scalars plus `network.egress.hosts` first — the collection that
  blocks the agent most often — and add the rest behind the same descriptor
  shape.
- **Browser-local reading is the other candidate to cut** (cut line above).
