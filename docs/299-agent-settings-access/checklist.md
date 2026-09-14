# Agent access to ShipIt settings — checklist

This branch is design only, and the design is done. **The implementation plan
lives on planning#537**, because it spans several pull requests and a checklist
is scoped to its own PR (CLAUDE.md). Review history lives there too.

- [x] `requirements.md` written from the user's words, open questions raised
- [x] Every open question answered, each with a dated receipt
- [x] `plan.md` written against the numbered requirements, citing them
- [x] Scope inventory verified control by control against both dialogs
- [x] `mockup.html` — the card's pending and eight terminal states, both themes
- [x] Independent design reviews, each cold, each with a removal brief, with
      every finding verified against the code before being acted on
- [x] `plan.md` reduced by half once the reviews were done, with every citation
      diffed to prove no constraint was dropped

## Phase 2, slice 1 — the shared apply layer

No agent-facing surface; the proposal card is the next slice.

- [x] Four outcomes (`applied` / `partial` / `failed` / `uncertain`), with
      `failed` reserved for a writer that can prove nothing changed
- [x] `CredentialStore.save()` rolls a failed disk write back and reports it
- [x] `writeGlobalSystemPrompt` reports a refused `unlink` instead of swallowing
      it, so "cleared" cannot be false
- [x] `setGitIdentity` reports `partial` when the name lands and the email does
      not, and says which half
- [x] `services/settings-apply.ts` — one operation per settings write, each doing
      the whole act the route did
- [x] Every named writer routed through it, including the egress prompt card's
      global add and merge-revoke's cancellation
- [x] `services/settings-conflict-domain.ts` — the per-stored-object lock
- [x] A `settings_changed` broadcast, and a client refetch on both that event and
      the global SSE connection's recovery
- [x] An untouched instructions box adopts a value that moved; an edited one
      keeps its draft and says so
- [x] `services/settings-baseline.ts` — the per-declaration revision over the
      whole stored value, tested directly
- [x] Every new guard proven red on its own, with the defect restored

## Phase 2, slice 2 — propose, and the decision handler

- [x] `shipit settings propose <key>=<value> [--item] --reason` and
      `--add`/`--remove` for one list entry; posts, returns, never waits
- [x] The server takes the snapshot — the displayed `from` and the private
      baseline in one read, never carried from the agent's earlier `get`
- [x] Validated at propose time and again inside the lock at apply time
- [x] `services/settings-operations.ts` — what an Apply button runs, per declared
      operation, ending in the shared apply layer
- [x] `ws-handlers/settings-proposal-handlers.ts` — transport only; the session
      is the connection's and never the message's
- [x] Dismiss as its own short path: one atomic `pending → dismissed`
- [x] Apply: claim atomically, then the conflict domains held across the
      baseline re-read, the revalidation and the write
- [x] `unknown` — boot recovery converts an interrupted apply before any
      decision is accepted, and never retries it
- [x] Settlement with no runner at all
- [x] `lastProposal` in `shipit settings get`, per target and per instance, from
      any session; a pending card does not block a second proposal
- [x] `shipit-docs/settings.md` — propose, the one-change rule, the phase table
- [x] Every new guard proven red on its own: two decisions produce one apply, a
      turn snapshot does not restore `pending`, and a projection-dropped field
      resolves `stale` where comparing `from` would not

Not in this slice, and named in `plan.md` → *What a card can apply today*: the
collection operations that create and delete entries, and the credential and
provider-account labels.

## Conformance against reqs 2, 3 and 7

An independent review of the shipped read surface against the numbered
requirements; each finding verified at the code before being acted on.

- [x] req 2 — a name the user typed is emitted only when it is shaped like a
      name, so a secret or role called `https://user:token@host/?token=…` is
      named by nothing in the index, in an item address, in text or in `--json`
- [x] req 2 — the four collections an item's address is projected through carry
      one rule between them, and a `derived` projection emitting the user's own
      words says so with a reason review reads
- [x] req 2 — the reflected-input echo decided: not stored credential material,
      so flattened and capped as presentation hygiene, and justified in `plan.md`
- [x] req 3 — `no-sidecar` separated from `disabled`: the containment setting is
      what refuses the container's start, and the read names it instead of
      calling it irrelevant
- [x] req 7 — `BESPOKE_READERS` and `OWN_ROUTE_READERS` keyed by a type derived
      from the catalogue, so a missing reader is a compile error and the two
      runtime guards are gone
- [x] req 7 — a stored MCP field with no declaration is a compile error
      (`MCP_SERVER_FIELD_SETTINGS`), which is what the DOM walk cannot see
- [x] The field that guard found — MCP `setup`, stored since docs/088 and read by
      nothing — removed rather than declared, so every stored field is a
      declaration and the map carries no exemption
- [x] req 7 — the MCP form and the credential-routing band render the
      declaration's description, and their hand-written copy moved into it
- [x] Every new guard proven red on its own, with the defect restored
- [x] A second independent review of the fixes themselves, its six findings each
      verified at the code: the refusal made a suffix on every branch rather than
      a branch of its own; the `live` detail carried through both CLI renderers,
      not only `--json`; the MCP map's value keyed to the field's own name; the
      routing description trimmed to what the band renders; and the name gate's
      claim narrowed to what it does — it removes a URL, it is not a credential
      scanner, and the design rejected scanners

## Conformance against reqs 2 and 4 — the card names its whole change

A closing independent review of the shipped feature; each finding verified at the
code before being acted on.

- [x] req 4 — the MCP `enabled` toggle writes one field through
      `setMcpServerEnabled` instead of a whole-object update, which reconciled
      the server's secrets and deleted the ones its config does not reference
- [x] req 4 — every other collection operation checked for the same shape: roles,
      reviewer pins, failover cutoffs, selection mode and the repository row all
      patch already
- [x] req 2 — no error message interpolates a stored value that did not come
      through the projection door; the role refusal names what the read names and
      counts what it withholds
- [x] req 4 — a release-channel switch whose update check fails reports the
      change it made, not a refusal: `applyReleaseChannel` returns the check's
      error instead of raising it, and the route raises it
- [x] `POST /api/updates/channel` still answers the check's own 503 and records
      no update result, which is the contract the returned error replaced
- [x] Every new guard proven red on its own, with the defect restored
- [x] An independent review of the fixes themselves: no functional finding, and
      its two observations acted on — the added comments cut back to the
      constraint beside its code, and the route's branch covered

Known and not fixed here: the MCP panel's own Enable/Disable button saves the
whole server through `PUT /api/mcp/servers/:id`, so it clears an unreferenced
secret the same way. That is the user's own dialog rather than a proposal card,
and fixing it needs a narrow route and a client change.

## Conformance against reqs 1 and 3 — three read-surface defects

A closing review of the shipped read surface found req 1 and req 3 partly met.
Each finding re-verified at the code before being acted on.

- [x] req 1 — an address the read emits resolves back to the item it came from:
      `userNameProjection` emits a stored name verbatim instead of trimming it,
      so `" helper "` beside `"helper"` can no longer produce one address twice
      or address the wrong role. A name that cannot be emitted as itself joins
      the ones the gate already drops and is counted in the "not listed" note
- [x] req 1 — `hostEntryProjection` is the case that MAY normalize, because the
      store normalizes identically — but `normalizeHost` stripped only ONE
      trailing dot, so `a.test..` stored as `a.test.` and was advertised as
      `a.test`, addressing no row. It strips every trailing dot now, and
      `removeHost` matches on the normalized row rather than the stored string,
      so a row an older build already wrote is addressable too
- [x] req 3 — MCP `args` put through the same missing-reference check as `env`
      and `headers`, so the settings read no longer answers `{configured: true}`
      about a server whose token secret is absent and which `resolveMcpServer`
      omits from the turn. The field list taken from the resolver: `args`, `env`,
      `headers` are substituted; `command`, `url` and `npmPackage` are not
- [x] req 3 — and the check answers only for the two reference shapes the MCP
      panel writes. The orchestrator cannot see the worker's environment — the
      pushed set is a Compose snapshot it has no handle on, and the worker
      augments `process.env` rather than replacing it — so any other reference
      gets "ShipIt cannot say", not a blocker the server does not have. Verified
      that no wider environment fixes this: widening to the account env trades a
      false blocker for a false "configured"
- [x] req 3 — the definite answer is recorded as a judgement rather than as an
      ownership claim: project secrets merge over account values reserving no
      prefix, so `mcp__…` is what the panel writes and not a name nobody else can
      supply. And the two counts are independent, so a field with a blank key row
      AND a reference to the session's environment reports both, rather than
      whichever branch ran first
- [x] req 1 — `voice.language` declared as the `enum` it is, with the Voice tab
      rendering the declaration's list rather than its own; `voice.ttsVoice` and
      `voice.ttsSpeed` carry their per-provider options as a `live` detail, which
      is now resolved for an entry whose value is unreadable. Audited: no other
      declaration's option set lives only in a component
- [x] Every new **guard** proven red on its own, with the defect restored:
      the trimmed address, the duplicate role address, the missing argument
      secret, a reference ShipIt does not store reported as a blocker, the
      trailing-dot host on insert and the un-normalized row an older build left,
      a field reporting only one of its two faults, the missing enum, a divergent
      option list in the dialog, per-provider voices replaced by one provider's,
      a dropped speed range, and the cross-layer agreement — which
      lives in `integration_tests/` because the orchestrator may not import
      `session/`. One added test is success-path coverage and is NOT a guard:
      arguments reading as configured once their secret is stored passes with the
      original defect too, because the old reader called any non-empty argument
      list configured
- [ ] **Not this slice, and not this file's to fix**: `applyEgressHostRemove`
      branches on `isBuiltinDefault` before trying the explicit row, so removing
      a host that is both a shipped default and a global entry suppresses the
      default and leaves the row effective — the read then advertises it again as
      removable and every further removal reports success. `plan.md` carries the
      reproduction (`.github.com`); the fix belongs with `settings-apply.ts`

## Conformance against reqs 7 and 8 — the closing review

Three findings from a closing conformance review, each verified at the code
first. One of the three did not hold as stated and is recorded as such.

- [x] req 7 — a declared global boolean generates its **save wiring**: the
      optimistic write, the `PUT /api/settings` payload, the rollback and the
      toast all come from `wire` and `label`, so
      `<DeclaredToggle settingKey="…" />` is the whole of a new toggle. Seven
      hand-written copies of that block removed, including the one threaded
      through `App.tsx` as a prop
- [x] req 7 — what the derivation does NOT reach is named rather than implied:
      the browser store field is hand-written, so a declaration missing its field
      or setter drops out of `DeclaredBooleanKey` and binding a control to it
      without the two props is a compile error. `plan.md` → *Settings are
      declared once* carries the derived/detected split as a table
- [x] req 7 — a control may bind only a declaration **from its own tab**; before
      this the walk asked only whether the named declaration existed, so a role
      field bound to `advanced.liveSteering` passed
- [x] req 7 — `ROLE_FIELD_SETTINGS` / `ROLE_PARAMS_FIELD_SETTINGS`, the role's
      half of what `MCP_SERVER_FIELD_SETTINGS` does: a field added to `AgentRole`
      or `RolePinnedParams` is a compile error until it is declared under its own
      name, with `partOf` confined to the roles family for the model tuple and
      the harness
- [x] req 8 — the read renders `lastProposal` in the **plain** output, phase
      headline and instruction included. It reached `--json` and nothing else,
      so a dismissed card was invisible to the command the notice tells the agent
      to run, and the agent re-proposed a value the user had declined
- [x] The phase table moved to `shared/settings-proposal-guidance.ts`, read by
      both the notice and the shim, so the two surfaces cannot word a phase
      differently
- [x] req 8 — an automatic turn carries the notice: the requirement says *the
      next turn* and names no kind. Compaction and a verbatim harness command
      stay out because neither carries any agent prefix at all, and the outcome
      rides the turn after
- [x] The compaction exclusion taken to the user rather than encoded, and their
      answer written back as a dated receipt under `requirements.md` →
      *Resolved questions*. The verbatim harness command is recorded beside it as
      a **known limitation**, not a decision: there is no prefix slot at all, and
      the user was not asked because there was nothing to decide
- [x] The reviewer's third claim did **not** hold as stated: `BESPOKE_READERS`
      detects a missing reader rather than deriving one, and a reader is
      per-owner code that cannot be generated. Recorded in `plan.md` as detection
      rather than changed
- [x] Every new guard proven red on its own: the plain-`get` rendering removed
      fails three of its four tests (the fourth is the negative control), the
      system-turn exclusion restored fails the automatic-turn test, the tab
      check removed fails the cross-tab test, and a field added to `AgentRole` or
      `RolePinnedParams` fails `tsc` in both maps

### The independent review of those fixes

Three findings, each verified at the code and each a defect rather than taste.

- [x] A **superseded** turn no longer acknowledges its notice. A retired process
      can emit a result for its own prompt after a successor took the agent slot;
      the turn settles `interrupted` with its work discarded, and the receipt was
      spent on it. Failover and the quota retry deliberately keep acknowledging,
      since those re-dispatch the same prompt
- [x] **Overlapping saves.** Reverting a failed save to the opposite of its own
      requested value is wrong the moment it is not the only save: off-then-on
      with both failing left the server on and the browser off. A failure now
      reverts to the value the server last accepted, and only from the newest
      request. Pre-existing in all seven hand-written copies; centralising them
      is what made one fix cover it
- [x] The role map's `partOf` narrowed from *any key in the roles family* to an
      enumerated allowlist of the two aggregates, and `fieldsDeclaredIn` from any
      string to the one map's name — the prose claimed a restriction the types
      did not make, and `{ partOf: "roles[].description" }` typechecked
- [x] Three test gaps the review named, closed: two saves held pending at once,
      a superseded turn with a late result, and the `agent-execution.ts` line
      that no test can distinguish, which says so in a comment
- [x] Each new guard proven red alone, and one candidate guard **dropped** rather
      than kept: pinning the server's confirmed value to the newest successful
      request has no interleaving where the right answer is knowable, so there
      was nothing a test could assert

## Phase 2, slice 3 — the outcome notice (req 8)

- [x] `agent_notified` on the private proposal row, with
      `listUnnotifiedResolved` / `markAgentNotified` as two separate calls —
      reading is never a consume
- [x] `services/settings-outcome-notice.ts` — the notice, joining the same
      `agentPrefix` chain as the bug-report notice, batching every outcome
      resolved since the last turn into one and starting no turn of its own
- [x] `NoticeDelivery` in `turn-settlement.ts`, acknowledged from ONE place in
      `turn-executor.ts` — the `agent_result` handler, after the `exhausted`
      check and the failover decision, never for an error result, and only once
      `promptSubmitted`: a resident process can land a result of its own before
      env preparation finishes and the prompt is sent
- [x] At-least-once proven on every shape review found: every account refusing
      for quota (which then goes on to a later runnable turn and receives the
      outcome); a refusal on a route that cannot fail over, which settles the
      turn `completed`; a refusal arriving as successful-looking assistant text;
      an error result; and a proxied submission the session worker never
      accepted. The last four assert the outcome is still pending, which is the
      invariant; only the quota test carries it through a second turn
- [x] A resident streaming turn, which calls `finishTurn` never and whose
      listeners the next reuse discards, acknowledges on its result — and a
      result arriving before that turn's prompt was sent acknowledges nothing
- [x] The notice carries no values at all: `from`/`to`, `outcome`,
      `outcomeDetail` and an effect's prose are all channels for text the user or
      the agent supplied, and a dismissed proposal would otherwise replay its own
      proposed instructions in ShipIt's voice
- [x] The one field ShipIt did not author — the instance address — cannot leave
      the region marking it as data: a role name may hold `"` and `]`, and a
      reviewer had a working exploit before the delimiters were stripped
- [x] A card resolved with no runner alive still notifies on the next turn
- [x] `shipit-docs/settings.md` — what the notice is, that `lastProposal` is the
      authority, and that it can arrive twice
- [x] Every new guard proven red on its own: marking at prompt assembly (the
      bug-report copy) fails the quota tests; acknowledging at settlement on a
      `completed` outcome fails all three of the refusal and resident-streaming
      tests; dropping the `promptSubmitted` gate fails the before-submission
      test; re-interpolating the card's values fails the trust-boundary test;
      un-flattening any one field fails the flattening test; quoting the
      instance without stripping delimiters fails the hostile-name test;
      ignoring `submissionSettled()` fails the unaccepted-submission test;
      dropping the flag on the reuse path fails the reused-process test;
      counting writes,
      not the flag, is what makes the idempotence test able to fail. Both clauses
      of `resultIsTheAgentsOwn` are covered directly in
      `turn-settlement.test.ts`, because no shipped adapter can produce the
      `error`-without-`error`-status pair an integration test would need
