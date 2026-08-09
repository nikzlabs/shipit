---
issue: planning#335
title: Non-blocking onboarding
description: Harness onboarding stops being a blocking modal over the product and becomes an inline panel in the conversation view, so a new user can see and use ShipIt before connecting a subscription.
---

# Non-blocking onboarding — design

This plan implements [`requirements.md`](./requirements.md). Requirement numbers below are
cited as `(req N)` and refer to that document.

The requirements govern the **harness** half of first-run setup — connecting a credential so
the agent can run. The GitHub / git-identity step stays in the flow and is out of scope for
removal; where this plan changes anything about it, it says so and says why.

**The two halves separate rather than merge.** The 2026-08-09 answers settle that the GitHub
step keeps today's behaviour **in full, including that it blocks**: the product stays gated
until GitHub is connected, and a later loss gates it again. Only the harness half becomes the
inline panel. Everything below assumes that split, and it is what makes the design smaller
than an earlier draft that tried to carry both steps in one non-blocking surface.

## The delta, stated against what is in the tree today

Three things exist today. One is preserved, two change.

**1. Onboarding is a fixed overlay over the whole product — and for GitHub that stays.**
`OnboardingWizard` renders `fixed inset-0 z-50` with a backdrop (`OnboardingWizard.tsx:184`),
mounted by `AuthOverlayContainer` whenever `showOnboarding` is true (`AuthOverlay.tsx:42`).
Nothing behind it is reachable. That gate survives, trimmed to **step 1 only**: while GitHub
is unconnected the product is blocked exactly as today. What leaves the overlay is step 2 —
the harness credential — which is what reqs 1 and 3 are about.

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
(`onboardingTriggeredRef` + `onboardingDismissed`, cleared by `onComplete` at `App.tsx:2084`).
**`noAgentReady` goes. `githubNeeded` and the latch both stay**, and `needsOnboarding` becomes
`githubNeeded` alone.

**Keeping the latch is not caution, it is what "unchanged" costs.** An earlier draft dropped it
on the reasoning that its only job was stopping the modal closing reactively when agent auth
completed mid-wizard — true of step 2, and irrelevant once step 2 leaves. But the latch has a
*second* effect nobody designed and the code has anyway, and it is load-bearing for a GitHub
gate. `showOnboarding` is `triggered && !dismissed`, so:

| Situation | Today | Direct `githubNeeded` gate |
|---|---|---|
| Established user, fresh page load, token already invalid | wizard shows | gate shows — same |
| Established user, token expires *during* the page load, never dismissed this load | wizard pops mid-session | gate shows — same |
| User completed onboarding *in this page load*, then the token dies | nothing — `dismissed` is still true | gate pops over their work — **changed** |

Only the third row differs, and it is precisely the row the human's ruling protects. So the
latch stays, with one substitution: there is no "Get Started" any more, so **dismissal fires
when GitHub connects**. That is the same shape as today, where connecting GitHub advanced the
wizard rather than closing it only because a second step was waiting behind it.

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

**Live updates: there is exactly one push channel, it is not the obvious one, and nothing
carries the fields for free.** The push path is the **SSE `agent_list` event**
(`hooks/useServerEvents.ts:437`), whose payload today is `{ agents }`. Every site that emits it
must also emit the two fields, and there are **ten**, not the seven an earlier draft listed:

- `app-lifecycle.ts:1300`, `:1339`, `:1451`, `:1468`, `:1492`
- `api-routes-bootstrap.ts:245`, `:282`, and the two **provider-wide sign-out** routes at
  `:419` (Claude) and `:481` (Codex) — the ones that remove the last credential, so omitting
  them leaves `canRunTurns` true over an install that can no longer run anything, and the
  composer accepts a message the server then refuses
- `route-registry.ts:163`, the **initial / reconnect SSE snapshot**, which hand-writes
  `{ agents }` onto the stream. Miss it and a reconnecting tab either keeps a stale value or
  clobbers a good one, depending on how the handler merges

One more site is a gap rather than a producer: the pre-252 Codex API-key endpoint
(`api-routes-bootstrap.ts:147`) returns `agents` in its response and broadcasts **nothing**, so
adding a key there makes the install runnable while every other tab stays stale until its next
bootstrap. It needs a broadcast, not just the new fields.

The HTTP read paths need explicit wiring too — the "carried for free" claim in an earlier draft
was wrong. Neither reader destructures `settings` generically: the bootstrap copies named
fields (`client/utils/session-data.ts:349`) and so does the settings refetch (`App.tsx:1107`).
Both need the two fields added by hand, along with the client store field behind them.

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
  - **An install upgraded with *no* credentials is treated as never-configured and does see
    the panel** (answered 2026-08-09; req 9 now records it). Disconnecting deletes the record
    (`credential-store.ts:280`), so "completed, then removed everything" and "never
    configured" are the same bytes on an install that predates the flag, and the chosen rule
    fails toward showing a correct ask to someone who cannot run a turn rather than hiding it
    from someone who needs it. There is **no second stamp condition** — an earlier draft added
    "also stamp if any credential record exists" as a narrowing; that was an agent inference,
    and it is withdrawn.

**The stamp must be confirmed on disk before it is reported.** `CredentialStore.save()` catches
and logs write failures and returns normally (`credential-store.ts:238`), so a stamp written
through the ordinary path can report "onboarding completed" from memory, survive until the
process restarts, and then be gone — and req 9 says the panel never returns. The setter
therefore has to surface a failed write rather than swallow it, and a failed write means the
install is reported as *not yet* completed: the panel staying up one more session is a
harmless repeat of a correct ask, where a lost stamp is a requirement violation that looks like
a bug months later.

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

Lives in `client/utils/chat-runnable.ts` beside the composer's own predicate, so the prompts
gate and the composer's disabled state are the same expression read twice, not two expressions
that agree today.

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
`HomeScreen` or the message list (`App.tsx:1892`). It is not an overlay and has no backdrop; it
sits in the layout rather than over it (reqs 1, 2). The only thing that ever renders on top of
it is the "Add a service" dialog it opens (req 5).

It replaces **both** branches of that ternary, not just the conversation one. Req 9 says a
user who is not set up "meets the same panel wherever they are", and on a fresh install with
no repositories the branch that renders is `HomeScreen`. Replacing only the conversation
branch would mean a brand-new user — the one this feature exists for — never sees the panel
until they have created a session.

That is safe for req 1 because `HomeScreen`'s only affordance is add-repo, and it is not the
only route to it: `SessionSidebar/SessionSidebar.tsx:458` and the repo switcher's menu item
(`RepoSwitcher.tsx:52`) both open the same dialog, on desktop and in the mobile sessions
drawer. The moment the flow finishes, `HomeScreen` renders again with its on-ramp intact.

**`showHomeScreen` is a layout flag as well as a content flag, and this design deliberately
does not touch the layout half.** Besides choosing the chat pane's content, it gives the chat
panel 100% width and suppresses the right panel entirely (`AppLayout.tsx:338`, `:341`),
disables the mobile content tabs (`:313`) and pins mobile to the chat panel
(`MobileContentPanels.tsx:23`). So the panel, on the home route, sits in a layout with no
preview, files, Present or terminal beside it.

Review read that as breaking reqs 1 and 3, and it is worth being exact about why it does not:
**that is the home route's layout today, panel or no panel.** There is no session on the home
route, so those panes have nothing to show — they are suppressed because they would be empty,
not because onboarding is unfinished. Nothing is taken away relative to what a user sees now.
The accurate statement of req 1 is therefore per-route:

- **In a session** (`showHomeScreen` false) the panel replaces only the conversation, and the
  right panel, terminal, file tree, Present, sidebar and Settings are all live beside it —
  which is the state req 1 describes.
- **On the home route** the panel replaces `HomeScreen`, the layout is unchanged from today,
  and the way out is creating a session from the sidebar, which the panel does not touch.

Forcing the right panel to render beside the panel on the home route was considered and
rejected: it would show empty preview and file panes for a user with no session, which is worse
than the honest empty state and is a layout change no requirement asks for.

### Layout: one column, not the split

The wizard's two-column hero/form split (`WizardHero`, `OnboardingWizard.tsx:61`) exists
because the modal is `max-w-3xl` and wide. The chat pane is narrow and tall, so the panel is a
single column: a short product lede above the Services surface. The hero's content is
kept — a first-time user still needs to be told what ShipIt is (that is the drop-off req 3
names) — but as a compact lede, not a facing panel. This is also what makes the mobile case
fall out for free rather than needing the `hidden md:flex` the hero uses today.

### The steps (req 4)

**There is no step rail.** The panel's own step is one — **Add a service**, the docs/252
Services surface (below), complete when `canRunTurns` — and req 4's sequence is that surface's
own, inside its dialog: choose a service, then a billing mode, then supply the credential. The
dialog shows one decision at a time and says where you are in it.

An earlier draft put a two-entry rail above the panel whose first entry was an inert
"GitHub — done" marker. It is deleted. It was always true by construction, nothing about it was
interactive, and it contradicted this same plan's statement that GitHub does not appear in the
panel. Review asked the right question — would anyone notice if it were gone — and the answer
is no: the dialog already carries the sequence req 4 asks for.

Removing the blocking behaviour does not scatter setup across the app (req 4): what remains is
one thing to do, in one place, with its own ordered steps.

### There is no completion button, and completion is not a click

The wizard's "Get Started" (`OnboardingWizard.tsx:278`) exists only because the modal is a
gate that has to be closed. The harness half is not gated any more, and req 9 makes the panel
non-dismissible, so the button has nothing to do: the panel's presence is a computed fact, not
a click, and it yields the pane the moment the server stamps `harnessOnboardingCompletedAt`.

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

**docs/252 phase 2 needs no adjustment at all.** Its Settings → Services surface is a list of
configured `(service, billing mode)` cards plus an "Add a service" **dialog** carrying the
catalogue ([`mockup-services.html`](../252-custom-models/mockup-services.html)). The panel
renders that list, and its "Add a service" button opens that same dialog (req 5, amended
2026-08-09). Reuse is therefore whole-surface: same list, same button, same dialog, same steps
inside it.

An earlier draft of this section required phase 2 to re-author the add-flow **host-agnostically**
— steps rendered into whatever container they were given, with the dialog demoted to a host
Settings happens to pick — so that the panel could render the same steps inline under the
then-stricter req 5. That is deleted. It was a refactor bought to avoid a dialog nobody
objected to, and it made the reuse *less* literal, not more: two containers, two layout paths,
and a component whose shape existed only for onboarding.

Density may differ and that is already the established pattern: `ProviderAccountsCard` takes a
`compact` prop for exactly this reason and its docstring is explicit that it changes "how much
prose sits above" the rows and nothing else (`ProviderAccountsCard.tsx:60–73`). The Services
surface gets the same treatment if it needs it.

**One dialog, never two — scoped to what the flow itself opens.** The panel is not a modal, so
the add dialog is the only thing *this flow* puts on top, which is what req 5 asks for and what
the "two modals at once" complaint was about. The scope matters: a user can still open Settings
(itself a dialog, `Settings/Settings.tsx:122`) or the add-repo dialog while the panel is up, and
req 1 requires exactly that. Those are the user's own overlays, not the flow's. The GitHub gate
cannot overlap the panel at all, because the panel is suppressed while the gate is up.

The link out to a provider's own sign-in page stays a link (`ProviderAccountsCard.tsx:476`) —
req 5 names it as the other thing that legitimately leaves the panel, and CLAUDE.md §3 puts
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

**One toast is fired from outside the card and still belongs to this flow.** A refused
*duplicate* account arrives as `agent_auth_failed` with `reason: "duplicate"` and is turned
straight into a global toast in `useServerEvents.ts:304`, deliberately, because the refusal
usually deletes the row the per-row error would have landed on (docs/150 req 22). It is
reachable during onboarding — sign in with an account already connected — so it is in scope,
and it needs somewhere in the panel to land now that the row it named is gone. An earlier draft
filed it under "toasts from elsewhere in the app", which is wrong: the trigger is this flow's
own credential step.

Two errors already render inline and are the model to follow: the per-row auth error
(`:516`) and the pinned-session replacement picker (`:522`), the latter deliberately a
row-local question rather than a toast.

Not in scope: toasts with no connection to a credential action — rate-limit banners, session
events. Req 5 binds this flow, not the app's whole toast surface.

### The panel accommodates the launch set by construction (req 6)

Req 6's bar is docs/252's launch set: Anthropic, OpenAI, DeepSeek, OpenRouter, Vercel AI
Gateway and GLM, GLM carrying two billing modes (docs/252 req 15). The panel meets it for two
structural reasons, neither of which is "we made the box bigger":

- **The surface is proportional to the user's setup, not to the catalogue.** Settings →
  Services is an add-flow: the screen lists what you configured and the catalogue appears
  inside the add step, at the moment it is a choice (docs/252 `plan.md`). A first-run user has
  zero cards and adds one. The catalogue growing does not grow the panel.
- **Nothing is crammed into part of something else.** The complaint req 6 records is "a lot of
  functionality in a small dialog, actually even in part of the dialog" — literally the wizard
  stacking two provider cards into a fixed-height half-pane beside a hero
  (`OnboardingWizard.tsx:195` sets `md:h-[600px]` for step 2, with the right column scrolling
  internally). Both halves of that are gone. What the user has configured lives in a
  full-height pane that scrolls with the page, and adding a service gets a dialog **of its
  own**, showing one decision at a time. A dedicated dialog is not the thing req 6 objects to;
  a shared, crowded one is. Note this is what req 5's amendment bought — the earlier
  everything-inline version had to fit the catalogue into the pane as well.

### GitHub stays a blocking gate, and that is what keeps this design small

The step is unchanged in every respect, including that it blocks (requirements → *Out of
scope*, receipt of 2026-08-09). Concretely: `OnboardingWizard` is trimmed to its step 1 and
renamed `GitHubGate` — same overlay, same `GitHubTokenForm` (`OnboardingWizard.tsx:234`), same
`githubNeeded` condition (`App.tsx:363`) and the same latch, no step dots, no `initialStep`, no
agent props. A revoked token re-gates on the next load exactly as it does now — including the
one case where today it does *not* re-gate, per the table above.

Three consequences worth naming, because each removes a problem an earlier draft had to
argue its way around:

- **The panel is suppressed while the gate is up.** Its condition is
  `harnessOnboardingCompletedAt == null && !showGitHubGate`. The second clause is not
  decoration: on a fresh install *both* conditions are true at once, so without it the panel
  mounts behind the gate's backdrop, and a mid-session token loss stacks the gate over a panel
  that may itself have the add dialog open. Review caught this; an earlier draft asserted the
  two "are never on screen together" and shipped no clause that made it so.
- **GitHub does not appear inside the panel at all.** Nothing about GitHub holds the panel open
  or brings it back; the gate owns that step end to end.
- **A user can no longer end the flow with GitHub unconnected.** Settings is not reachable
  while the gate is up, so the "connect a service from Settings during step 1" path an earlier
  draft had to accommodate does not exist.

The GitHub step's other surfaces are unaffected and unchanged: Settings → Integrations renders
the same form (`SettingsIntegrations.tsx:120`), as does the add-repo dialog
(`AddRepoDialog.tsx:133`).

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
  only `!bootstrapLoaded || selectedRepo?.status !== "ready"` (`:147`). It must pass
  **`disabledReason`**, not merely add `!canRunTurns` to `disabled`: `disabled` guards
  submission only, so that narrower fix would leave a user able to type, attach files and
  dictate into Quick Capture with just the Send button dead — including auto-started recording
  (`MessageInput.tsx:206`, `:254`). That is the "block at submit" failure req 3's receipt
  rejected, reached through a different door. An earlier draft specified the narrow fix, and
  the test it specified would have certified it.

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
| 2 | The panel | 1, 2, 4, 5, 6, 7, 9 | `harnessOnboardingCompletedAt`; `HarnessOnboardingPanel` in the chat pane; the wizard trimmed to a GitHub-only gate. |

Phase 1 is coherent alone: under today's code its predicate is `!noAgentReady`, so it makes
the existing product honest without changing the flow. Phase 2 is where the dependency on
docs/252 phase 2 bites (see *Dependency* above). If both land in one PR, nothing is lost —
the split is about reviewability, not about shipping order.

## Key files

| File | Change |
|---|---|
| `client/components/OnboardingWizard.tsx` | **Trimmed to step 1 and renamed `GitHubGate.tsx`** — same blocking overlay, same `GitHubTokenForm`; step 2, `StepDots`, `initialStep` and the agent props go. |
| `client/AuthOverlay.tsx` | **Kept**, now mounting the gate alone. |
| `client/components/OnboardingWizard.test.tsx` | Step-1 cases kept as the gate's tests; step-2 cases replaced by the panel's. |
| `client/components/HarnessOnboardingPanel.tsx` | **New.** The panel: lede + the Services surface. No step rail. |
| `client/App.tsx` | Drop `noAgentReady` (`:354`); `needsOnboarding` becomes `githubNeeded` (`:363`) alone; **keep the latch**, with dismissal firing on GitHub connect rather than "Get Started" (`:2084`). Render the panel in the chat-pane slot (`:1892`), suppressed while the gate is up; widen the composer render gate (`:1982`); pass `disabledReason` (`:1985`). |
| `client/components/MessageInput/MessageInput.tsx` | `disabledReason` prop: disables the textarea (`:766`), attach (`:780`), paste/drop (`:681`), mic (`:799`), permission selector (`:820`); renders the textarea empty so a draft cannot hide the placeholder. |
| `client/components/QuickCaptureOverlay.tsx` | Passes `disabledReason` (`:254`) — `disabled` (`:147`) guards submission only, so it alone would leave the input typeable. |
| `client/utils/chat-runnable.ts` | **New.** `canRunTurns` reader + `starterPromptsAllowed`. |
| `client/components/Settings/ProviderAccountsCard.tsx` | Inline the global toasts next to the row that produced them — failures (`:105`) and disconnect results (`:253`, `:258`). |
| `client/hooks/useServerEvents.ts` (duplicate refusal) | `reason: "duplicate"` toasts at `:304` because the refusal deletes the row; needs an in-panel landing place. |
| *docs/252 phase 2's Services surface* | **No change needed.** The panel renders its card list and opens its "Add a service" dialog as-is. |
| `server/orchestrator/services/settings.ts` | Compute `canRunTurns`; stamp `harnessOnboardingCompletedAt`. |
| `server/orchestrator/services/misc.ts` | Both fields on `BootstrapData.settings` (`:64`). |
| `server/orchestrator/credential-store.ts` | `harnessOnboardingCompletedAt` on `CredentialData` (`:34`); the stamp's write must be confirmed, not swallowed by `save()` (`:238`). |
| `server/orchestrator/app-lifecycle.ts`, `api-routes-bootstrap.ts`, `route-registry.ts` | Both fields on the SSE `agent_list` payload at **all ten** emit sites (`:1300`, `:1339`, `:1451`, `:1468`, `:1492`; `:245`, `:282`, `:419`, `:481`; `route-registry.ts:163`), plus a missing broadcast at `api-routes-bootstrap.ts:147`. |
| `client/hooks/useServerEvents.ts` | Read both fields off the SSE `agent_list` event (`:437`). |
| `client/utils/session-data.ts`, `client/App.tsx` | Both readers copy named settings fields (`:349`, `:1107`) — the two fields need adding by hand. |
| `docs/216-onboarding-starter-prompts/checklist.md` | One item: the re-implementation must `&&` in `starterPromptsAllowed`. |

## Rejected alternatives

- **Keep the modal, make it dismissible.** Req 9's receipt already disposes of it: dismissal
  only matters for something that covers the product. Removing the cover is the fix.
- **Carry both steps in one non-blocking surface**, with the panel's lifetime defined by the
  harness half. An earlier draft of this plan chose it and called it forced; the 2026-08-09
  answer rejects it. Keeping GitHub a blocking gate is smaller — no ordering between two
  surfaces, no reachable "finished with GitHub unconnected" state, and no change at all to a
  step that was out of scope.
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
| Whether behavioural identity with Settings is literal reuse (req 7) | Yes, whole-surface — same card list, same "Add a service" dialog, same steps inside it. docs/252 phase 2 needs no change. |
| Where results and errors go, given the surface uses toasts (req 5) | Inline in the shared component for both hosts, rather than an onboarding-only branch. |
| How far "disabled as a whole" reaches (req 3) | The whole input cluster, an empty textarea so the reason is always legible, and Quick Capture as well as the main composer. |
| Whether the panel replaces `HomeScreen` too | Yes — req 9's "wherever they are"; add-repo stays reachable from the sidebar and the repo switcher. |
| Whether the panel needs a step rail of its own | No — the add dialog already carries req 4's sequence, and an inert "GitHub — done" marker contradicted GitHub being absent from the panel. |

**Not on this list, because the requirements answer them:** the GitHub step keeps today's
blocking behaviour, and a legacy install with no credentials sees the panel. Both were open
questions and are now dated receipts in `requirements.md`.
