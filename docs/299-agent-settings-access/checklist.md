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
collection operations that create and delete entries. (The credential and
provider-account labels were also out of this slice; they are registered in the
req 4 conformance slice at the end of this file.)

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
- [x] Fixed in the slice below: `applyEgressHostRemove` branched on
      `isBuiltinDefault` before trying the explicit row, so removing a host that
      was both a shipped default and a global entry suppressed the default and
      left the row effective

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

## Conformance against req 4 — the card's whole change, and a true outcome

A third conformance review found req 4 partly met. Each finding re-verified at
the code before being acted on.

- [x] req 4 — a model proposal shows the fields it re-derives. `roles[].model`
      reselects the harness and drops a level the new selection does not offer,
      and `reviewers[].model` substitutes the slot's default level; both used to
      post a card naming the model alone. Operations now declare `alsoChanges`,
      labelled by the neighbouring declaration and formatted through the same
      door as `from`/`to`, and the card renders them under the main change
- [x] req 4 — those side changes are re-derived at apply time and compared with
      the card, because they read live state the baseline does not cover (which
      harnesses are installed); a difference is `refused`, so a click never
      writes something the card did not display
- [x] req 4 — a removal that cannot happen is refused rather than reported
      applied. `buildEffectiveAllowlist` no longer inherits `removable: true`
      from the first source when a second, unremovable one supplies the same
      host, which is what let `.github.com` beside
      `SESSION_EGRESS_ALLOWLIST=.github.com` read as removable
- [x] req 4 — and the write itself now reports what it achieved:
      `applyEgressHostRemove` deletes the explicit row AND suppresses the
      default, then reads the resulting membership, answering `failed` with the
      source that still supplies the host. A repeat removal of a host that is
      genuinely off stays `applied`
- [x] req 4 — every declaration advertising `propose.allowed: true` now has
      somewhere a proposal can go, swept rather than fixed one at a time:
      `roles[].name`, `services.credentials[].label` and
      `services.providerAccounts[].label` gained operations, and a collection
      aggregate keeps its promise through its entry fields, which the refusal now
      names. A test fails the build for any declaration with neither
- [x] `domains()` takes the validated value as well as the target, since a
      rename writes the stored object under the new name too; validation moved
      just outside the lock, where it always belonged
- [x] Every new guard proven red on its own, with the defect restored: the four
      `alsoChanges` cards, the apply-time comparison, the two-source
      `removable` flag on both the operator and the MCP shape, the built-in plus
      explicit-row removal, the operator-supplied removal reporting `applied`,
      the broader entry that still covers a removed host, the missing baseline
      readers, and the declarations with nowhere to send a proposal

### The independent review of those fixes

Three findings, each verified at the code and each a defect rather than taste.

- [x] Both label operations were **registered and unreachable**:
      `settings-baseline.ts` had no reader for either collection, so every valid
      rename refused at `requireBaseline` before a card existed. The registry
      guard could not see it — it checks registration, and the operation tests
      call `apply` directly — so the two readers come with propose-then-click
      tests that exercise the whole path
- [x] `roles[].harness` drops a level the new harness does not honour and
      declared no `alsoChanges`, so the same hole the model fix closed stayed
      open one operation along. It declares them now
- [x] A removal reported "not allowed" where a **broader entry** still covers the
      host: entries are patterns, so taking `api.github.com` off leaves the
      shipped `.github.com` matching it. The entry did go, so the outcome stays
      `applied` — with a detail naming the entry that still allows it — and the
      PENDING card is worded as membership (`on the list` → `off the list`), so
      nothing is promised before the click that the removal cannot deliver
- [x] Comment volume cut back where the added blocks restated `plan.md`, and the
      card interface's own docstring put back above the interface it documents

### A second review of those fixes

- [x] Provider-account renames could be proposed and never applied: the read
      addresses an account by its SERVICE and `renameProviderAccount` takes the
      HARNESS whose sign-in owns that service, so every click answered "Unknown
      provider". The operation converts, and a propose-then-click test covers it
      — the fixture gained an opt-in provider-account manager for it
- [x] A label longer than the writers store posted a card that could only ever
      resolve `refused`; both preflights now hold it to
      `MAX_CREDENTIAL_LABEL_LENGTH`, which is one exported constant rather than
      the three literals the two writers and the check would otherwise be
- [x] Each new guard proven red alone: the address passed through unconverted,
      the length check removed, and the reachability wording restored

### A third review of those fixes

- [x] The shared removal writer could not see MCP-supplied hosts, so
      `DELETE /api/egress/hosts` — which runs no proposal preflight — still
      reported a host gone that the next container reaches.
      `EgressApplyDeps.credentialStore` is now a **required** key, named at all
      three construction sites
- [x] A rename skipped the role validator every other role edit runs, so a role
      pinned to a retired model could be proposed and only refused at the click
- [x] Both guards proven red alone

### A fourth review, after the rebase

- [x] A role could be renamed to a value the card could not show: the projection
      names no URL back, so the card read `deep-dive → not set` while Apply
      stored the URL and deleted the old name. Propose now refuses any value the
      declaration's own projection drops — over the projection, not over one
      setting's shape — without quoting the value back
- [x] Guard proven red alone; the account-address comment trimmed to the
      constraint, with its bug history left in `plan.md`
- [x] The rebase resolution checked from both sides: `settings-baseline.ts` holds
      a NUL byte in a source string, so git kept main's whole version with no
      markers and the two readers were re-applied on top

### A fifth review, of that fix

- [x] The removal's own detail claimed reachability — the very thing the
      membership wording exists to stop — and in a network-off sandbox it was
      false. It names the entry that still matches the host and says nothing
      about what a session can reach
- [x] And it was hiding the answer: `subLine` returned the outcome's detail
      INSTEAD of the effect's, so a card could report the write and drop the
      reason the write is not live for this session. The card renders both, the
      write's first. Pre-existing for every operation that sets both; this change
      is what made the pair common
- [x] Guard proven red alone

### planning#577 — a value cannot forge a line of the agent's output

- [x] `shared/settings-catalogue/rendered.ts`: one door, three mints, and a
      branded `Rendered` on every field that carries a value into the text
      output — so shortening a projected value, or formatting a stored one some
      other way, is a compile error
- [x] Every string quoted with no exception, decided against a "plain enough to
      leave bare" predicate: getting that predicate wrong is a hole, not a
      blemish, and quoting is what separates a stored `not set` from ShipIt's
      own words for one
- [x] The address gated at the read rather than at each declaration:
      `services.credentials` and `services.providerAccounts` project ids their
      collections only filter for being strings
- [x] The same `\s+` gap closed in the next-turn notice, where `\s` matches
      none of U+0085, U+2028 and U+2029
- [x] `requireShowable` measures the rendered text, and its message says
      "needs N characters to show in full" rather than reporting a value as
      longer than it is
- [x] Proven red alone: the end-to-end store → read → shim test, the read's
      wire-contract walk, the propose refusal, and the notice's flattening all
      fail on main's formatter

## Req 9 — a prose setting is proposable in practice

The user's answer to a card that refused an improvement to their own
instructions: *"but I want this instructions to be proposable"* (planning#576).
The refusal's principle is untouched — the chip is what could not carry the
change.

- [x] `requirements.md` req 9 appended, req 4's clause about what "the exact
      change" claims, and the dated receipt naming the option not chosen
- [x] `plan.md` → *A prose value is shown as a change to the text*: the diff, the
      bound and why it is lower than the declared `maxLength`, and what replaces
      flattening for a value that cannot be flattened
- [x] `mockup.html` — the long-text state, in both themes
- [x] A full-context line diff, computed server-side at propose time and
      snapshotted, so two viewers cannot see two accounts of one approval
- [x] `from`/`to` become ShipIt's own summary for a prose change, so the text is
      persisted once rather than three times
- [x] `CARD_TEXT_MAX` — 10,000 a side, past which the card still refuses;
      `alsoChanges` sides keep the chip's 200
- [x] A value whose rendering differs from its content is refused, on every card
- [x] `get` reports `proposeMaxLength` where the card carries less than the
      dialog's box
- [x] `shipit settings propose <key> --value-file -`, because prose does not fit
      in one shell word
- [x] The card carries ShipIt's summary and the dialog carries the diff, plain
      text, with the server's counts on the card — verified in both themes
- [x] `shipit-docs/settings.md` and the capability wiki
- [x] Every new guard proven red on its own
- [x] An independent review, each finding verified at the code
- [x] The independent review's four findings, each verified at the code first:
      the writer's trim (the card showed a trailing line Apply discarded — fixed
      on the declaration, where `text({ trim: true })` is visible); four
      invisible characters a hand-listed range missed (now Unicode's own
      `Default_Ignorable_Code_Point`, minus the variation selectors an emoji is
      written with); the applied outcome, which the server composes and the
      client renders in preference to anything of its own, so the prose line had
      to move to `appliedOutcome`; and a diff whose only distinction was colour
      and an `aria-hidden` glyph
- [x] Its three test findings closed: a propose-then-apply round trip, which is
      what the propose test alone could not see; an unchanged line BETWEEN two
      changes, which is the only assertion the LCS has to earn; and a height cap
      whose test stayed green without it
- [x] Its correction to the bound taken: the "about 20 KB" claim was false — a
      diff line costs far more than its characters — so `CARD_TEXT_LINES_MAX`
      bounds the row and the plan says which bound does what. And a `current`
      value over the bound no longer advises a smaller edit, which is not
      something a proposal can do

### Rebased onto planning#577's rendered output

- [x] The two changes meet at one measure: what decides between a chip and a diff
      is the RENDERED length, the same number `requireShowable` refuses on.
      Deciding on the raw length would have refused a 150-character instructions
      rewrite for having newlines in it — req 9's own failure, one notch smaller
- [x] A diff's lines stay the raw value: they reach the browser as their own
      elements rather than a line of the agent's output, and escaping them would
      show the user something other than their instructions. The
      display-integrity refusal is what covers that path
- [x] `from`/`to` for a prose card are minted with `renderOwn` — a character
      count is ShipIt's own words about a value, not the value
- [x] planning#577's "measured over the rendered text" guard re-pointed at
      `git.identity`, which is the case that still reaches the chip refusal now
      that prose does not; a new guard pins that the same measure chooses the
      diff. Both proven red alone

### The diff moved into a dialog

- [x] The user, on the first build: *"let's make the card just say that there is
      a change, for a case of a long values. And the full diff should be shown in
      a dialog."* Receipt under `requirements.md` → *Resolved questions*, and
      req 9's second sentence rewritten to match
- [x] The card is a summary row — two sizes, `+n −n`, and *Review the change* —
      so a prose value never occupies the scrollback, and the card's height no
      longer depends on the value at all
- [x] The dialog keeps every property the inline block had: full context, plain
      text, per-line Added/Removed labels, and a bounded scrolling region
- [x] The counts stay on the CARD, so padding a value cannot make the control
      look cheaper to skip than it is

## Conformance against reqs 5 and 7 — SSH destinations, and the guard that missed them

A conformance review of the SSH hosts area found a part of the Integrations tab
the catalogue never covered, and the walk that should have caught it. Each
finding re-verified at the code first.

- [x] req 5 — the add-a-destination form's four boxes are declared per field.
      They were an `action` exclusion on the reasoning that a draft field stores
      nothing and "the collection is what carries the policy", which was false of
      three of them: the collection carries labels only, while the dialog sends
      address, user and port to `POST /api/ssh-hosts` and shows them back on the
      row. `integrations.sshHosts[].label|address|user|port`, each with its own
      projection, its own refusal reason and a reader in `BESPOKE_READERS`
- [x] The claim that `[].address` and `[].user` must stay undeclared — "the
      enumeration the rest of docs/305 is built to prevent" — did **not** hold
      against docs/305-ssh-hosts: its req 3 withholds the private key from a
      settings read and nothing there makes an address confidential from an
      ungranted session, whose membership the labels already emit account-wide.
      Recorded in the declaration rather than acted on as written
- [x] Two projections of their own rather than the near neighbours, because
      either reuse would have emitted a stored value as nothing:
      `hostEntryProjection` refuses every IPv6 literal (docs/305 req 12 admits
      one) and `userNameProjection` requires an alphanumeric first character
      (`requireUser` does not)
- [x] req 7 — `SSH_HOST_FIELD_SETTINGS`, keyed by `keyof SshHostPublic`, so a
      field added to the stored shape is a compile error until it is declared or
      explained. It does not depend on anything being rendered, which is what the
      DOM walk could not manage for a form nobody opened
- [x] req 2 — the `derived` origin is a **required argument**: `{ userText }` or
      `{ shipItComputed }`, each with its reason. `integrations.sshHosts` and
      `network.egress.hosts[].host` both emitted the user's own text under a bare
      `derived`, which claims ShipIt computed it. No output changed
- [x] req 5, req 7 — the coverage walk **crawls** instead of opening named forms.
      Every trigger in scope is pressed and whatever appears is walked, so the
      SSH form is reached by nothing naming it. A hand list of forms was the same
      failure one level up, and the SSH form was the proof
- [x] What the crawl then found, accounted rather than excused: the
      add-a-provider wizard, which `UNREACHED` had called "a flow rather than a
      pane". Its secret box, Save and Sign in bind their declarations, its two
      address steps bind the credentials collection, and its three ways out are
      one exclusion. `UNREACHED` is now empty
- [x] `region` on an exclusion — a container whose every control is that one
      exclusion, for a surface the install produces rather than anyone writing:
      the supported-models dialog's filters are one per (service, mode, harness)
- [x] Each fix proven red alone: the canary label emitted under an unmarked
      `derived`; an SSH address the agent cannot read (`settings list` knows no
      such setting); and the four SSH boxes named as unaccounted by the crawl
      against the form as it was

### After the rebase onto the in-place edit (docs/305 req 14)

- [x] `main`'s shared `HostFields` renders the declaration-bound boxes, so the
      new EDIT form carries the bindings and the declared copy as well as the add
      form — one component rather than two that can drift
- [x] Each refusal re-decided on the new facts rather than reworded. The comment
      said "the only write the dialog offers is the collection's `add`", which
      the edit made false. `[].address` and `[].user` stay `external_flow` — they
      decide which account on which machine must hold the public line — while
      `[].label` and `[].port` become `unsafe_to_display`: neither needs an act
      outside ShipIt, and a card cannot show that a rename moves the derived
      `~/.ssh/config` alias, or that a port change discards the recorded server
      host key (which is why req 14 makes the DIALOG warn before saving)
- [x] The coverage crawl reaches the edit form: it is disclosed from a
      destination row, and the panel loads its rows over HTTP, so the fixture
      answers a GET of `/api/ssh-hosts` with one host and rejects everything else
      as before. Verified by instrumenting the crawl — it presses *Edit prod*,
      then *Save changes* and *Cancel* inside the form. A test guards the fixture,
      since a row that stopped rendering would take the surface with it silently
- [x] Two defects the merge introduced, both caught by `main`'s own tests: the
      declared description ran into the input's accessible name, so
      `getByLabelText("Address")` found nothing — the label is now `aria-label`
      and the description `aria-describedby`; and `type="number"` on the port box
      reads back `""` for `abc`, which would have sent an empty port and coerced
      it to 22, defeating main's "send the port as typed" contract

### Scoped to the grant, which closes a hole older than this slice

- [x] req 5 — the SSH read answers with the destinations THIS session is granted
      (`sessionSshHosts`, over the shipped `grantedSshHosts`), for the collection
      and for every `sshHosts[]` field. `api-container-guard.ts` hard-denies
      `/api/ssh-hosts` to every container — "a container has no business editing
      destinations or reading the list" — while `/api/sessions/:id/settings` is
      container-accessible, so the settings door crossed a decision the guard
      makes at its own door
- [x] The name list scoped too, not only this slice's new fields: the guard's
      words are about reading THE LIST, so the label enumeration on `main` is
      already what that decision forbids. Reachable today, not hypothetical
- [x] A session with no grant gets an empty **readable** answer — it holds none,
      which is not ShipIt failing to read — with the reason on the collection's
      own description, which every `list` carries. No count of what was withheld:
      "4 more destinations" is the same enumeration one step weaker
- [x] The guard that matters is red against `main` and not only against this
      branch: with `main`'s reader restored, a session granted nothing reads
      `["prod", "staging"]` from `integrations.sshHosts`
- [x] req 5 gained a clause and the decision a dated receipt, both in
      `requirements.md`: a setting's per-session availability may be narrower
      than the dialog's where ShipIt already gates the resource per session

### The card's value, and the store's — a fourth req 4 slice

A fourth conformance review found req 4 partly met: two proposals displayed one
value and stored another. Both re-verified at the code.

- [x] req 4 — a declared type's `validate` now answers with the value the store
      will hold, so `read(serialize(v))` is `v` for anything it accepts. A
      budget of `0` validates to `null`, so the card says "4096 → not set"
      instead of "4096 → 0" over a write that removes the field. `text`'s `trim`
      already worked this way; `unsetBelow` was the one option that did not
- [x] req 7 — the contract is held over the WHOLE registry, not the two types
      that carry it today: `store-round-trip.test.ts` walks every declaration
      with boundary candidates built from its own `shape`, so a normalising
      declaration added tomorrow is covered without a second step. It holds the
      class where SERIALISING drops the value, and not a writer that normalises
      on its own — the codec cannot see one, which is what the next item is for
- [x] req 4 — a writer's own normalisation is declared too: `pinned()` stores no
      level for an empty string, so `roles[].reasoningEffort` emits through an
      allowlist of the levels a harness offers and an empty one reads as "not
      set" on both sides of the card. Clearing a role's level showed `"high" →
      ""` over params that store no level at all
- [x] req 4 — clearing `services.nonTurnModel` is refused while a model is
      eligible, rather than shown as "not set". `seedNonTurnModel` runs from the
      save hook AND from every build of the settings payload, so unset is not a
      state that setting can be left in — `alsoChanges` was considered and
      rejected, because naming the same setting twice with two destinations is
      not a change anyone can approve by looking. The seeded model is not named
      back either: what the seed picks at apply time is not what it picks now
- [x] req 4 — the refusal and the seeding read ONE function
      (`nonTurnModelSeedCandidate`), so they cannot come to different answers
- [x] req 4 — the store has the last word: after an `applied` write the apply
      reads the setting back through the agent's own read surface — the read
      that already answers `effect`, so no second round trip — and resolves a
      disagreement with the card as `partial` naming both values
- [x] req 4 — the read-back is scoped so that it cannot invent a defect, and
      NOT SEEING a value is never treated as one: a `set` only, since a
      membership card shows ShipIt's wording rather than a value and those
      writers already answer from the resulting membership; a prose card
      compared against the approved TEXT rather than against ShipIt's summary of
      its size, which any rewrite of the same length would pass; and silence
      about an instance the read no longer lists, since an address leaves the
      read for reasons that are nothing to do with the write — a rename retires
      the name the card used, and a service/mode setting stops being listed the
      moment its last credential goes (`settings-store-readers.ts` → `modePairs`)
- [x] The release-channel fixture stubbed a reader that could not see its own
      mocked write, so the apply's read-back was right to call it `partial`. The
      fixture now moves with the write, as the real file-backed pair does
