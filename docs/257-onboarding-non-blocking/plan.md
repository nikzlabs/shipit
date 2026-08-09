---
issue: planning#335
title: Non-blocking onboarding
description: Harness onboarding stops being a blocking modal and becomes an inline, modal-free panel in the conversation view, so a new user can see and use ShipIt before connecting anything.
---

# Non-blocking onboarding — design

This plan implements [`requirements.md`](./requirements.md). Requirement numbers below are
cited as `(req N)` and refer to that document.

The requirements govern the **harness** half of first-run setup — connecting a credential so
the agent can run. The GitHub / git-identity step stays in the flow and is out of scope for
removal; where this plan changes anything about it, it says so and says why.

> **Two open questions are outstanding** in `requirements.md`, both raised by the
> cross-backend review of this document: when the panel goes away relative to the GitHub
> step, and what an install upgraded with no credentials should see. The sections
> *GitHub: what stays* and *`harnessOnboardingCompletedAt`* are provisional until they are
> answered; nothing else in this plan depends on either.

## The delta, stated against what is in the tree today

Three things exist today and all three change.

**1. Onboarding is a fixed overlay over the whole product.** `OnboardingWizard` renders
`fixed inset-0 z-50` with a backdrop (`OnboardingWizard.tsx:184`), mounted by
`AuthOverlayContainer` whenever `showOnboarding` is true (`AuthOverlay.tsx:42`). Nothing
behind it is reachable — not the file tree, not previews, not Settings (reqs 1, 3).

**2. Its credential step is hard-coded to two providers.** It renders `ProviderAccountsCard`
for `provider="claude"` (`OnboardingWizard.tsx:248`) and `provider="codex"` (`:255`), and
lists every other registered agent as a read-only status row (`:262`). That is the `AgentId`
keying docs/252 removes, on the one screen a user cannot skip (req 6).

**3. The composer is not actually disabled — only its send button is.** `MessageInput` takes
a `disabled` prop that guards `handleSend` (`MessageInput/MessageInput.tsx:429`) and the send
and toolbar buttons (`:863`, `:878`, `:905`, `:917`). The textarea itself carries no
`disabled` attribute and a constant placeholder, `"Describe what to build... (type @ to
attach files)"` (`:766`). So a user can type into a composer that cannot send, and nothing on
it says why (req 3).

The gating logic itself lives in `App.tsx:354–377`: `noAgentReady` (any agent installed *and*
`authConfigured`), `githubNeeded`, their disjunction `needsOnboarding`, and a latch
(`onboardingTriggeredRef`, `onboardingDismissed`) that holds the modal open until "Get
Started" is clicked. All of it goes.

## Dependency on docs/252, and the sequencing decision that is not made here

This feature depends on [`docs/252-custom-models`](../252-custom-models/plan.md) **phases 1–2**:

- **Phase 1** replaces `AgentId`-keyed models with the catalogue and the
  `(serviceId, billingMode, modelId)` triple. Without it there is no "service" for the panel
  to add and req 6's launch set does not exist.
- **Phase 2** ships credential storage per `(service, billing mode)` and the **Settings →
  Services add-flow** ([`mockup-services.html`](../252-custom-models/mockup-services.html)).
  That surface is what req 7 says onboarding must behave identically to, and — per the
  decision in *Reuse* below — is literally the component this panel hosts.

Phase 2 also carries an **interim**: it re-points the two existing cards at `(anthropic, sub)`
and `(openai, sub)` so the current wizard keeps working under the new keying
(docs/252 `plan.md`, phase 2). **This feature is the replacement for that interim, not a
consumer of it.**

**Whether this ships after docs/252 phases 1–2 or is built against phase 2's interim is a
sequencing decision the user has not made, and this plan does not make it.** What the plan
does do is keep the choice cheap: the two halves below are separable, and only the second one
needs the Services surface.

- **Part A — the runnable signal and an honest composer** depends on nothing in docs/252. Its
  predicate has one implementation before docs/252 phase 3 and another after (see
  *`canRunTurns`*), and the swap is invisible to every consumer.
- **Part B — the panel** needs phase 2's Services surface to host. Built against the interim
  it would host two hard-coded provider cards, which meets reqs 1–5 and 7 but not req 6.

**One correction to "phases 1–2", found by review and worth stating precisely: req 6 is not
actually *delivered* until docs/252 phase 3.** Phase 2 ends with "a key you can save, edit and
remove … and used by nothing" (docs/252 `plan.md`), and custom services first run a turn at
phase 3. So between phases 2 and 3, a user who adds a DeepSeek or OpenRouter key through this
panel gets a card that says configured and a `canRunTurns` that stays false — onboarding never
finishes and the composer stays correctly disabled. Phases 1–2 are what the panel needs to
*exist* and to host the real surface; phase 3 is what makes the launch set actually satisfy
req 6. Shipping in the phase-2 window is coherent only for a user connecting Anthropic or
OpenAI.

## Three predicates, one source each

The single failure this design has to prevent is a flow that says it is finished above a
composer that is still, correctly, disabled (req 8). The way to prevent it is not to check
carefully in three places — it is to have one fact with one owner, read by all three
consumers.

### `canRunTurns` — "the install can actually run something" (req 8)

**Definition.** There is at least one **installed harness** for which at least one model is
**eligible** — that is, the model's `(service, billing mode)` has a configured credential
route the harness can carry.

That is deliberately the *same* predicate the picker applies, evaluated across installed
harnesses instead of the active one. docs/252 splits today's `AgentInfo.authConfigured` into
*available* (installed) and *eligible* (the mode has a credential) and predicates the picker
on the second; `canRunTurns` is the existential over that.

**It is an install-level fact, and it is not per-session turn admission.** Turn admission is
`isAgentAuthenticated` (`services/agent-auth-gate.ts:22`), consulted by
`ws-handlers/send-message.ts:44` for the session's *own* harness, and the two can disagree in
a reachable state: an install with a working Claude credential and a Codex-pinned session
whose Codex credential was removed has `canRunTurns === true` while that session's next turn
is refused. That is today's behaviour and this feature does not change it — the refusal
already returns an error pointing at Settings. `disabledReason` is *added to* the existing
per-session `disabled` expression rather than replacing it, so nothing that is disabled today
becomes enabled. Reqs 3 and 8 are both install-level questions ("this install cannot run
anything"), which is the question `canRunTurns` answers; a per-session "this session cannot
run" composer state is a different feature and is not proposed here.

**Where it is computed: the server, not the client.** It is derived in
`services/settings.ts` next to `listAgents`, returned on `GlobalSettings`, and therefore
arrives on `GET /api/bootstrap` (`services/misc.ts:64`) and on every settings broadcast. The
client never re-derives it from `agentList`. Deriving it in the browser is how the three
consumers get three subtly different answers, and it is also unusable for the persisted flag
below, which must be stamped server-side.

**Two implementations, one contract.**

| When | Implementation |
|---|---|
| Before docs/252 phase 3 | `listAgents(...).some(a => a.installed && a.authConfigured)` — exactly today's `noAgentReady`, inverted (`App.tsx:354`). |
| After docs/252 phase 3 | `installedHarnesses.some(h => eligibleModels(h).length > 0)`, using phase 3's eligibility function. |

The swap is internal: the wire field and all three consumers are unchanged. This is what lets
Part A ship independently of the sequencing decision above.

**Live updates: there is exactly one push channel, and it is not the obvious one.** Because
the field sits on `GlobalSettings`, the read paths carry it for free — the HTTP bootstrap
(`client/utils/session-data.ts:348`) and the settings refetch (`App.tsx:1203`) both already
destructure `settings`. The push path is the **SSE `agent_list` event**
(`hooks/useServerEvents.ts:437`), whose payload today is `{ agents }` and is broadcast from
several producers: `app-lifecycle.ts:1300`, `:1339`, `:1451`, `:1468`, `:1492` and
`api-routes-bootstrap.ts:245`, `:282`. The two fields join that payload, and every producer
sends them — a producer that omits them leaves the panel stale over a working install.

The **WS `global_settings` message is a dead channel and must not be relied on.** Its wire
type exists (`shared/types/ws-server-messages/misc.ts:21`) and the client has a registered
handler (`message-handlers/index.ts:157` → `global-settings.ts:14`), but nothing in
`src/server/` ever sends one. Wiring the fields through that handler would look correct in
review and do nothing at runtime. It is left alone here; removing it is a separate cleanup.

### `harnessOnboardingCompletedAt` — the historical condition (req 9)

Req 9 asks a question about the install's **history**, and no field in the tree answers it:
every existing signal (`authConfigured`, the accounts list, stored keys) describes the
*present*. So this feature adds one.

- **Shape.** `harnessOnboardingCompletedAt?: string` (ISO timestamp) in `CredentialData`
  (`credential-store.ts:34`) — the install-level persisted settings blob that already holds
  `failoverCutoffs`, `accountSelectionMode`, and the other global toggles. Install-global
  rather than per-session (req 9) and server-side rather than `localStorage`, so a second
  browser sees the same answer.
- **Stamped when the server first observes `canRunTurns === true`**, in the same helper that
  computes `canRunTurns`. Idempotent, never cleared.
- **Never a click.** There is no "Get Started" and no dismissal (req 9), so there is no user
  action to hang the stamp on; and a client-driven stamp is lost if the tab closes between the
  credential landing and the click.
- **Existing installs that are currently runnable migrate by the same rule.** The first
  settings read after the upgrade finds the flag absent, finds `canRunTurns` true, and stamps
  — so every already-configured install is "completed" before it renders a frame. No separate
  migration step.
  - **An install upgraded with no credentials is an open question, not a decision this plan
    makes.** Req 9's condition is historical, and disconnecting deletes the record
    (`credential-store.ts:280`), so "completed, then removed everything" and "never
    configured" are the same bytes on an install that predates the flag. Under the rule above
    the first group sees the panel again, which req 9 forbids. The alternative — stamp *every*
    pre-existing install unconditionally — hides the panel from a genuinely unconfigured
    upgrader. See `requirements.md` → *Open questions*. An earlier draft of this section
    resolved it by adding a second stamp condition ("also stamp if any credential record
    exists"); that was an agent inference dressed as a narrowing, and it is withdrawn.

Putting the stamp in the read path is a deliberate impurity. The alternative — stamping at
each credential-mutation site — misses the migration case entirely and silently un-covers
itself the next time a credential path is added.

### `starterPromptsAllowed` — the docs/216 gate (req 10)

`harnessOnboardingCompletedAt != null && canRunTurns`. Both conditions, per req 10: they
coincide except where onboarding completed and every credential was later removed, and there
the prompts are hidden because a chip seeds the composer rather than sending
([`docs/216` plan:41](../216-onboarding-starter-prompts/plan.md)) — a chip above a disabled
composer would fill an input that cannot send and replace the placeholder explaining why
(req 3).

Lives in `client/utils/chat-runnable.ts` beside the composer's own predicate, so the gate and
the composer's disabled state are the same expression read twice, not two expressions that
agree today.

**docs/216 is design-only and does not need reconciling first.** Its implementation was
reverted and is not in the tree
([its checklist](../216-onboarding-starter-prompts/checklist.md) says so), and its plan and
checklist disagree about eligibility — the plan gates on `showRocket`, i.e. every empty
session (`plan.md:54`), while the checklist says "regular repo sessions only (no sandbox)"
(`checklist.md:14`). Req 10 was written as a gate that only ever *removes* prompts, so it
composes with whichever eligibility docs/216 settles on. Concretely: this feature ships the
predicate and a unit test for it, and adds one item to docs/216's checklist requiring the
re-implementation to `&&` it into its render condition. Nothing here changes docs/216's scope
and nothing here waits on it.

## The panel

### Where it renders

`HarnessOnboardingPanel` occupies the **chat pane** — the same slot that today holds either
`HomeScreen` or the message list (`App.tsx:1892`). It is not an overlay, has no backdrop, and
nothing renders on top of it (reqs 1, 2, 5).

It replaces **both** branches of that ternary, not just the conversation one. Req 9 says a
user who is not set up "meets the same panel wherever they are", and on a fresh install with
no repositories the branch that renders is `HomeScreen`. Replacing only the conversation
branch would mean a brand-new user — the one this feature exists for — never sees the panel
until they have created a session.

That is safe for req 1 because `HomeScreen`'s only affordance is add-repo, and it is not the
only route to it: `SessionSidebar/SessionSidebar.tsx:458` and the repo switcher's menu item
(`RepoSwitcher.tsx:52`) both open the same dialog, on desktop and in the mobile sessions
drawer. The moment the flow finishes, `HomeScreen` renders again with its on-ramp intact.

Everything outside the chat pane is untouched and stays live while the panel is up: the
sidebar, the preview and Present tabs, the terminal, the file tree, Settings (reqs 1, 3).

### Layout: one column, not the split

The wizard's two-column hero/form split (`WizardHero`, `OnboardingWizard.tsx:61`) exists
because the modal is `max-w-3xl` and wide. The chat pane is narrow and tall, so the panel is a
single column: a short product lede, the step rail, and the active step. The hero's content is
kept — a first-time user still needs to be told what ShipIt is (that is the drop-off req 3
names) — but as a compact lede, not a facing panel. This is also what makes the mobile case
fall out for free rather than needing the `hidden md:flex` the hero uses today.

### The steps (req 4)

Two, in order, with a rail showing what is done and what remains:

1. **Connect GitHub** — `GitHubTokenForm`, unchanged, exactly as the wizard uses it today
   (`OnboardingWizard.tsx:234`). Complete when `githubStatus.authenticated`.
2. **Add a service** — the docs/252 Services surface, hosted inline (below). Complete when
   `canRunTurns`.

Removing the blocking behaviour does not scatter setup across the app (req 4): the steps are
still a sequence in one place, and the rail still says where the user is in it.

### There is no completion button, and completion is not a click

The wizard's "Get Started" (`OnboardingWizard.tsx:278`) exists only because the modal is a
gate that has to be closed. Nothing is gated now, and req 9 makes the panel non-dismissible,
so the button has nothing to do: the panel's presence is a computed fact, not a click, and it
yields the pane the moment the server stamps `harnessOnboardingCompletedAt` (whether GitHub
also holds the panel open is the open question above; nothing here turns on the answer).

**What confirms success, then?** The yield itself. The pane becomes the conversation and the
composer's placeholder goes back to normal — the thing the user was told they could not do
becomes possible in the same frame, driven by the same field. That is a stronger signal than a
card briefly turning green, and it cannot disagree with the composer, because it *is* the
composer's signal. A user who wants to inspect what they connected finds it in Settings →
Services, which is where every later credential change lives (req 9).

An in-flight sign-in does not trip this: `canRunTurns` flips when the account becomes usable,
not when the challenge opens, so the panel cannot vanish out from under an OAuth code the user
is still pasting.

### Reuse: the panel hosts the Settings surface, it does not re-implement it (req 7)

Req 7 requires identical *behaviour* and explicitly leaves the mechanism to this document.
**The decision is literal reuse**: step 2 renders the same component Settings → Services
renders, with the same state, the same endpoints and the same actions. This continues the
existing line rather than starting one — docs/150 req 16 already collapsed onboarding's
provider cards onto the Settings component after a user's first account was being connected by
different code than their second, and today's wizard is that collapse
(`OnboardingWizard.tsx:114–127`).

The one adjustment docs/252 phase 2 must make for this to be possible: **its add-flow has to be
host-agnostic.** In the Settings mockup the catalogue lives in an "Add a service" *dialog*
inside the Settings modal
([`mockup-services.html`](../252-custom-models/mockup-services.html)). Req 5 forbids a modal
here. So the flow is authored as a component that renders its steps in whatever container it
is given, and the dialog becomes the *host* Settings picks — not part of the flow. The panel
hosts the identical component inline as step 2. No behaviour is duplicated; only the container
differs.

Density may differ and that is already the established pattern: `ProviderAccountsCard` takes a
`compact` prop for exactly this reason and its docstring is explicit that it changes "how much
prose sits above" the rows and nothing else (`ProviderAccountsCard.tsx:60–73`). The Services
surface gets the same treatment if it needs it.

The link out to a provider's own sign-in page stays a link (`ProviderAccountsCard.tsx:476`) —
req 5 names it as the one thing that legitimately leaves the panel, and CLAUDE.md §3 puts
OAuth screens on the short list of things ShipIt does not own.

### Errors render in the panel — by fixing the shared surface, not by forking it (req 5)

The surface being reused reports several failures through **global toasts**: `toast()` at
`ProviderAccountsCard.tsx:105`, used by add, rename, reorder, disconnect, connect, cancel and
code submission. Req 5 says **results and errors** must render next to the step that produced
them — and the results half matters here too: a *successful* disconnect reports "moved N
sessions" or "N sessions have no connected account" through the same global toast
(`:253`, `:258`). Both halves move.

**Decision: move those results and errors inline in the shared component, for both hosts.**
Settings gets the same improvement; there is no onboarding-only branch.

The alternative — inject an error sink so Settings keeps toasts and the panel renders inline —
was rejected on two grounds. It creates a second error-presentation path through the one
component req 7 exists to keep single, which is precisely the drift req 7 forbids. And a toast
is a global side effect fired from inside a panel: it cannot be scoped to its host, so the
"sink" would have to be threaded through every call site anyway, at which point inline
everywhere is both smaller and better.

Two errors already render inline and are the model to follow: the per-row auth error
(`:516`) and the pinned-session replacement picker (`:522`), the latter deliberately a
row-local question rather than a toast.

Not in scope: toasts fired from elsewhere in the app (rate-limit banners, session events).
Req 5 binds this flow.

### The panel accommodates the launch set by construction (req 6)

Req 6's bar is docs/252's launch set: Anthropic, OpenAI, DeepSeek, OpenRouter, Vercel AI
Gateway and GLM, GLM carrying two billing modes (docs/252 req 15). The panel meets it for two
structural reasons, neither of which is "we made the box bigger":

- **The surface is proportional to the user's setup, not to the catalogue.** Settings →
  Services is an add-flow: the screen lists what you configured and the catalogue appears
  inside the add step, at the moment it is a choice (docs/252 `plan.md`). A first-run user has
  zero cards and adds one. The catalogue growing does not grow the panel.
- **The container is the chat pane, not part of a dialog.** The specific complaint req 6
  records — "a lot of functionality in a small dialog, actually even in part of the dialog" —
  is about the wizard stacking two provider cards into a fixed-height half-pane
  (`OnboardingWizard.tsx:195` sets `md:h-[600px]` for step 2 with an internally scrolling right
  column). A full-height pane that scrolls with the page removes the constraint rather than
  budgeting within it.

### GitHub: what stays, and the open question underneath it

The step stays, and its content is unchanged (out of scope). Inside the panel it is step 1,
before the service step, exactly as today. What is **not** settled is the panel's *lifetime*
relative to it, and this plan does not settle it — it is under *Open questions* in
`requirements.md`.

The conflict, stated so the answer can be checked against it. The requirements' terminology
paragraph says "when the flow is finished" means the harness half, which points at visibility
being `harnessOnboardingCompletedAt == null` with GitHub playing no part. The *Out of scope*
section says the GitHub step keeps today's behaviour, and today `githubNeeded` alone summons
the whole wizard — `needsOnboarding = githubNeeded || noAgentReady` (`App.tsx:364`) — including
for an established user whose token was later revoked. Both were true of a modal that only ever
covered an empty product. They stop being jointly true once the panel replaces the conversation
and is not dismissible (req 9):

- **Harness-only lifetime.** A user who connects a service from Settings while step 1 is on
  screen — now reachable, because req 1 makes Settings usable — ends the flow with GitHub
  unconnected, and a later GitHub loss never re-opens the panel.
- **Waits on GitHub too.** The panel sits permanently and undismissibly in the conversation
  view of a user who has a working agent and does not want GitHub, and returns over an
  established user's real chat when a token expires.

An earlier draft of this plan chose the first and called it forced. Review disagreed, and it
was right to: the second reading has textual support in the requirements, so choosing between
them is a human decision, not an inference.

Whichever is chosen, GitHub keeps its existing non-panel surfaces — Settings → Integrations
renders the same `GitHubTokenForm` (`SettingsIntegrations.tsx:120`), as does the add-repo
dialog (`AddRepoDialog.tsx:133`) — so no answer strands a user without a way to connect it.

The add-repo dialog is itself a modal, and that is fine: req 5 binds harness onboarding, and
adding a repository is not part of it.

## The composer (req 3)

Req 3 says the composer "does not accept input that could not run" and is disabled **as a
whole**. Taken literally that is more than one flag, and the review of this plan found three
places where a narrower reading leaks.

**A `disabledReason?: string` prop on `MessageInput`.** When set it:

- disables the **textarea** and makes the reason its placeholder, replacing the constant at
  `MessageInput/MessageInput.tsx:766` — today the textarea carries no `disabled` attribute at
  all, so "disabled" currently means "cannot send", not "cannot type";
- disables the rest of the input cluster, which is otherwise unconditionally live: the
  attach-files button (`:780`, whose comment says "always enabled"), paste and drag-drop
  ingestion (`:681`), the mic (`:799`) and the permission-mode selector (`:820`). Attaching a
  file to a message that cannot be sent is the same category of dead input as typing one;
- **renders the textarea empty**, so the reason is always visible. The textarea is controlled
  by `value={text}`, so a retained per-session draft or a `setPrefillText` seed would hide the
  placeholder behind text the user cannot send — the exact state req 10 refuses to create with
  a starter-prompt chip. The draft is retained in the store, not destroyed; it is simply not
  rendered while the input is dead, and returns when the install becomes runnable.

**Three call sites, not one.**

- `App.tsx:1985` — the main composer. `disabledReason` is set when `!canRunTurns`, *in
  addition to* the existing `disabled` expression, which is unchanged.
- `App.tsx:1982` — **the render gate has to move.** Today the composer is suppressed whenever
  `showHomeScreen && !showNewSessionView`, which is exactly the branch the panel takes over on
  a fresh install (see *Where it renders*). Left alone, the first-run user would meet the panel
  with no composer beneath it and therefore no placeholder — the one state req 3 was written
  for. The gate becomes "render the composer when the panel is up, too".
- `QuickCaptureOverlay.tsx:254` — it renders the same `MessageInput`, and its own `disabled` is
  only `!bootstrapLoaded || selectedRepo?.status !== "ready"` (`:147`). Without `canRunTurns`
  in it, an unconfigured user can type and submit a prompt from Quick Capture that the server
  then rejects — the "block at submit" failure req 3's receipt explicitly rejected, reached
  through a different door.

Only the not-runnable case sets `disabledReason`. The other conditions in the main composer's
expression keep today's behaviour — repo trust in particular already renders its own inline
notice next to the composer (`RepoTrustNotice`, `App.tsx:1979`), which is a better fit for a
consent than a placeholder and is not what req 3 is about.

### The exact wording

> **Add a service to start chatting**

Three properties it has to have, and why this string has them:

- **It names no location.** The same string serves while the panel is on screen (where the ask
  is directly above the input) and long after onboarding, when the panel is absent and the
  answer is Settings (req 3's receipt names this as the consequence to get right). A string
  that says "in Settings" is wrong in the first case; a string that says "above" is wrong in
  the second.
- **Its verb and noun match the control the user must find** — docs/252's Settings surface is
  "Services" and its action is "Add a service". A placeholder that says "connect a
  subscription" would send a DeepSeek-key user looking for something that is not there.
- **It says what is blocked, not what is broken.** The composer is the only disabled thing
  (req 3); everything else works, so the message is an instruction rather than an error.

## Phases

Two PRs. This is a small feature and does not want more.

| # | Phase | Reqs | Lands |
|---|---|---|---|
| 1 | Runnable signal + honest composer | 3, 8, 10 | `canRunTurns` on the wire; the composer is genuinely disabled and says why; the starter-prompts predicate exists and is tested. The wizard is untouched. |
| 2 | The panel | 1, 2, 4, 5, 6, 7, 9 | `harnessOnboardingCompletedAt`; `HarnessOnboardingPanel` in the chat pane; `OnboardingWizard` and `AuthOverlay` deleted. |

Phase 1 is coherent alone: under today's code its predicate is `!noAgentReady`, so it makes
the existing product honest without changing the flow. Phase 2 is where the dependency on
docs/252 phase 2 bites (see *Dependency* above). If both land in one PR, nothing is lost —
the split is about reviewability, not about shipping order.

## Key files

| File | Change |
|---|---|
| `client/components/OnboardingWizard.tsx` | **Deleted.** Replaced by the panel. |
| `client/AuthOverlay.tsx` | **Deleted.** Its only job is mounting the wizard. |
| `client/components/OnboardingWizard.test.tsx` | **Deleted**, replaced by the panel's tests. |
| `client/components/HarnessOnboardingPanel.tsx` | **New.** The panel: lede, step rail, GitHub step, Services step. |
| `client/App.tsx` | Drop `noAgentReady` / `needsOnboarding` / the latch (`:354–377`) and the `AuthOverlayContainer` mount (`:2039`); render the panel in the chat-pane slot (`:1892`); pass `disabledReason` to the composer (`:1985`). |
| `client/components/MessageInput/MessageInput.tsx` | `disabledReason` prop: disables the textarea (`:766`), attach (`:780`), paste/drop (`:681`), mic (`:799`), permission selector (`:820`); renders the textarea empty so a draft cannot hide the placeholder. |
| `client/components/QuickCaptureOverlay.tsx` | Its own `disabled` (`:147`) gates on `canRunTurns` too — it renders the same composer. |
| `client/utils/chat-runnable.ts` | **New.** `canRunTurns` reader + `starterPromptsAllowed`. |
| `client/components/Settings/ProviderAccountsCard.tsx` | Inline the global toasts next to the row that produced them — failures (`:105`) and disconnect results (`:253`, `:258`). |
| *docs/252 phase 2's Services surface* | Must be host-agnostic — the add-flow renders in a given container; Settings supplies the dialog. |
| `server/orchestrator/services/settings.ts` | Compute `canRunTurns`; stamp `harnessOnboardingCompletedAt`. |
| `server/orchestrator/services/misc.ts` | Both fields on `BootstrapData.settings` (`:64`). |
| `server/orchestrator/credential-store.ts` | `harnessOnboardingCompletedAt` on `CredentialData` (`:34`). |
| `server/orchestrator/app-lifecycle.ts`, `api-routes-bootstrap.ts` | Both fields on the SSE `agent_list` payload at every producer (`:1300`, `:1339`, `:1451`, `:1468`, `:1492`; `:245`, `:282`). |
| `client/hooks/useServerEvents.ts` | Read both fields off the SSE `agent_list` event (`:437`). |
| `docs/216-onboarding-starter-prompts/checklist.md` | One item: the re-implementation must `&&` in `starterPromptsAllowed`. |

## Rejected alternatives

- **Keep the modal, make it dismissible.** Req 9's receipt already disposes of it: dismissal
  only matters for something that covers the product. Removing the cover is the fix.
- **Ask for the credential when the user tries to send.** Considered and rejected in the
  requirements (req 3's receipt): it lets a user type something that cannot run and blocks at
  submit, which is a worse moment to learn the rule than an obviously-disabled input.
- **Derive "runnable" in the browser from `agentList`.** Cheaper, and wrong: the flag has to be
  stamped server-side, turn admission is answered server-side, and a second derivation is how
  the panel and the composer come to disagree.
- **An onboarding-only copy of the Services surface.** Directly contrary to req 7, and
  docs/150 req 16 already paid for this lesson once, when a user's first account was connected
  by different code than their second.
- **An error sink so Settings keeps its toasts.** See *Errors render in the panel*.
- **A success/confirmation step before the panel yields.** It is a dismissal wearing a
  different hat, and the yield plus the enabled composer is the stronger signal.

## What this plan decides that the requirements deliberately left open

Recorded together so review can check each against req 7's warning — a design decision does
not belong in `requirements.md`, and none of these is promoted there.

| Question the requirements left to design | Decision |
|---|---|
| Exact placeholder wording (req 3) | "Add a service to start chatting" — no location, verb/noun matched to Settings → Services. |
| How "the install can actually run something" is computed (req 8) | `canRunTurns`: at least one eligible model on an installed harness, computed server-side by the picker's predicate. Install-level, deliberately not per-session turn admission. |
| Whether behavioural identity with Settings is literal reuse (req 7) | Yes — the panel hosts the same component; docs/252's add-flow becomes host-agnostic so Settings' dialog is a container, not part of the flow. |
| Where results and errors go, given the surface uses toasts (req 5) | Inline in the shared component for both hosts, rather than an onboarding-only branch. |
| How far "disabled as a whole" reaches (req 3) | The whole input cluster, an empty textarea so the reason is always legible, and Quick Capture as well as the main composer. |
| Whether the panel replaces `HomeScreen` too | Yes — req 9's "wherever they are"; add-repo stays reachable from the sidebar and the repo switcher. |

**Not on this list, because they are not the plan's to decide:** the panel's lifetime relative
to the GitHub step, and what a legacy install with no credentials sees. Both are under
*Open questions* in `requirements.md`.
