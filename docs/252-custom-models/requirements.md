# 252 — Custom models: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today. So a requirement below is silent about an existing capability when this feature
does not change it, and that silence is not permission to drop it. Where a requirement *does*
describe something that already works, it is because this feature changes it in some way.

No open questions remain.

## Requirements

1. A user can run a ShipIt session on a model from any service they have
   configured — for example DeepSeek V4 Flash on the Claude Code harness — and the
   session works like any other session, on a **best-effort** basis. ShipIt adds no
   limitation of its own — but it cannot fix a harness or a model either. Codex declares
   no permission-mode or image support; a model that cannot call tools cannot run skills
   or MCP servers whichever harness drives it; a model that uses tools poorly will use
   them poorly. Those are properties of the harness and the model, not defects in ShipIt,
   and this requirement does not promise otherwise.

2. Using a harness does not require an account or key with that harness's own
   vendor. A user whose only credential is a DeepSeek key can use the Claude Code
   harness; nothing about the harness assumes an Anthropic account exists.

3. Selecting a model works the same way for every model, in the same place.

4. A user can switch models within a session while keeping the same harness, as far
   as that harness supports it.

5. A service offers its models under one or more **billing modes**: an API key, or a
   subscription. A service may have **both**, and they are not interchangeable — the same
   model can cost nothing extra under a subscription and be metered under a key, and a
   subscription may offer fewer models than the key does. So the billing mode is part of
   what a user picks, not something resolved out of sight (reqs 6, 11).

   Several *subscriptions* to one service are a different matter: **the user does not choose
   among them.** ShipIt routes between them (req 12), so what a user picks is the mode, never
   the individual credential.

   That is deliberately not a claim that the accounts are equivalent. Plans come in tiers,
   and a cheaper account may not offer everything a dearer one does — so a turn routed to
   another account can meet a model that account cannot run. ShipIt already routes between
   subscription accounts without comparing what they are entitled to, and this feature does
   not change that; treating tiers properly is a separate feature, not something this one
   silently promises by calling the accounts interchangeable.

   **The mechanism for subscription modes is in scope for this feature**: a catalogue
   service can declare one, and everything built on billing modes — the picker, Settings,
   eligibility, usage, failover — handles it without knowing which vendor it belongs to.
   What is *not* blanket in scope is any particular vendor's subscription: each needs its
   own login, refresh and account handling, which is per-service work decided per service.
   So this requirement says a service *may* have a subscription mode; which services
   actually ship one is req 15's question, not this one.

6. A service may speak more than one API style. A model is offered on a harness when the
   service and the harness **share a style** **and** the catalogue declares that model
   works under that style **under the billing mode in use** — a service can speak a style
   without every one of its models being usable under it, and a subscription can include
   fewer models than the same service's API key.

   The rule is stated as an overlap deliberately: it holds whether a harness speaks one
   API style or several, so discovering that some harness speaks more than one is a
   design problem and not a change to this requirement.

   The catalogue does not mirror everything a service offers. ShipIt lists a
   **maintained subset** — at any moment only a handful of models are worth using for
   coding — so a service advertising hundreds of models does not become hundreds of
   entries. Breadth of the subset is a judgement ShipIt makes and revises over time.

7. A user chooses which of ShipIt's services they use, in their own Settings, by
   supplying a credential for each — no administrator and no involvement from anyone
   else to start using a service ShipIt defines. What the user owns is the credential;
   the service itself is ShipIt's, and Anthropic and OpenAI are services like any other
   rather than privileged defaults.

   The catalogue itself — which services exist, which API styles each speaks, and which
   of their models work where — is authored by ShipIt's developers and ships with ShipIt
   (req 6). So a service or model ShipIt does not yet know about does require a ShipIt
   change. This is a deliberate narrowing of an earlier answer; see the receipts.

8. A model is selectable only when the billing mode offering it has a credential
   configured. One rule applies uniformly to every service, with none treated as a
   default or built-in: so "Claude with no account connected" and "DeepSeek with no key"
   are the same condition, and neither is offered. A service with a key but no
   subscription offers exactly what the key offers.

   This is about credentials, and nothing else. Whether a selectable model then works
   *well* is req 1's best-effort territory — ShipIt does not guarantee that every
   model and harness combination performs, only that it never offers a model it has no
   credential for.

9. The work ShipIt does outside a turn — naming a session, writing a pull-request
   description — runs on a model the user chooses for it, independently of whatever
   model a session is using. It is a model like any other, chosen the same way (req 3),
   so it names a service, a billing mode and a model (req 5) rather than a service alone.
   Which harness runs it is **derived** from what the install has, not chosen — a model
   offered on more than one installed harness does not become a second decision for the
   user to make here.

   That choice is **visible in the UI as its own setting**, and it has a default so
   nobody has to configure it before ShipIt works. The default is **derived, not a named
   model**: it is the first model the install can actually run — the first model of the
   first service and billing mode — so it is never a model whose mode has no credential
   (req 8) or whose harness was not installed (req 14). A default is acceptable where a hidden
   dependency is not: the user can see what non-turn work runs on and change it, and
   until they do it follows whatever the install has rather than pointing at a vendor
   they may never have used or have stopped paying for.

   When that service fails, the surrounding operation still completes with a fallback
   — a session keeps its placeholder title, and a pull request gets a generic
   description rather than an empty one — and ShipIt shows a dismissible notice saying
   which service failed. Failure of background work never blocks the operation around
   it, and is never silent either.

   The pull-request half is a **change**, not a preserved behavior: today a failed or
   unavailable generation yields an empty description, and the generic text exists only
   for a thrown error. The notice must also still be findable after a reload or a
   session switch — a message that vanishes with the tab is silent in practice.

10. Usage is reported per **billing mode of a service**, not per model. A subscription
    exposes a quota, and the indicator reflects whatever the mode in use reports. A mode
    with no quota to report — an ordinary API key, which has no allowance and nothing
    that resets — shows no indicator at all, rather than an empty or placeholder one. So
    a service holding both shows a quota when the subscription is in use and nothing when
    the key is.

11. ShipIt is honest about what a session is running on. The user can tell which model
    and which service are in use, and whether it is billed to a key or a subscription —
    which is knowable exactly because the billing mode is part of the selection (req 5)
    rather than resolved out of sight.

12. When a credential stops working mid-session — revoked, expired, rate limited — what
    ShipIt does depends on **the billing mode in use**, not on what the error says:

    - **Subscriptions fail over.** If the user has more than one subscription to that
      same service, ShipIt moves the turn to another of them, as it does today.
      Failover never crosses to a *different* service: two subscriptions to one service
      are interchangeable, but another service means a different model at a different
      price, which is the user's choice to make and not ShipIt's.
    - **API keys do not fail over.** ShipIt stops and says so. Recovering from a bad
      key is the harness's job; ShipIt runs no recovery or re-prompt flow of its own.

    Failover never crosses **billing modes** either, for the same reason it never crosses
    services: a spent subscription does not silently start charging a key. Moving to the
    key is a selection the user makes (req 5), and one they now *can* make.

    When no subscription is left to fail over to, ShipIt stops and says so, exactly as
    it does for a key.

13. Models leave the catalogue as ShipIt revises which ones are worth carrying (req 6).
    A session already pinned to a removed model keeps working: each service maps its own
    retired models to their successors, and the session moves onto the successor. A
    successor is always another model **of the same service and the same billing mode, and
    one the session's harness can run** — a retirement never moves a session to a different
    service, which would change the credential it needs and who provides it; it never moves
    a session across billing modes, which is the same silent shift onto metered billing that
    req 12 refuses to make on failover; and it never lands on a model the pinned harness
    cannot speak to (req 6), which would strand the session as surely as having no successor
    at all. If any of those has no successor to offer, that is a catalogue mistake to fix
    rather than a case to fall back from.

    What a retirement does **not** preserve is the price. Two models under one service's key
    are priced differently, so a metered session's turns can get cheaper or dearer across a
    remap. Holding the billing mode fixed is what keeps *included* work from becoming
    *billed* work, which is the discontinuity worth preventing; the rate is not promised, and
    the change is visible rather than silent because the session reports the model it moved
    to. The session then reports what it is actually
    running (req 11) — a remap is never invisible, and never leaves a session unable to
    take a turn.

14. **Harnesses are not user-editable.** Nothing in Settings adds, defines, or removes a
    harness: a harness is an agent CLI plus the adapter that normalizes its event stream,
    so the set of them is ShipIt's, exactly as the service catalogue is (req 7).

    Which harnesses a ShipIt install *has* is chosen **when ShipIt is installed**, from
    the set ShipIt supports. Claude Code and Codex are selected by default, so an install
    that accepts the defaults gets today's behaviour. A harness that was not installed
    offers no models and appears nowhere in the picker — being installed is a
    precondition of req 8's credential rule, not an exception to it.

    The set is a property of the **deployment**, not a setting: changing it means changing
    the deployment's configuration and redeploying. Adding a harness to a running install
    without a redeploy is deliberately not offered.

15. **The catalogue ships with the services that make the feature usable, not merely with
    the ability to hold services.** "ShipIt supports gateways" has to be a statement about
    what a user finds in Settings, not about what the data model permits — so what ships is
    itself a requirement. At minimum:

    - **first-party providers** — Anthropic and OpenAI, as ordinary rows (req 7);
    - **at least one direct key-authenticated provider** — DeepSeek is the founding case;
    - **common gateways** — OpenRouter and Vercel AI Gateway;
    - **at least one custom service carrying a subscription** — GLM, whose coding plan sits
      alongside an ordinary API key, so a single non-first-party service exercises both
      billing modes (req 5).

    Which API styles each of these speaks, and which of its models are declared under each,
    follows req 6 and is authored per service; this requirement is about the services being
    present, not about what they turn out to offer.

    **Beyond those, which services ship a subscription mode is left open.** Req 5 puts the
    *mechanism* in scope, but each vendor's subscription is its own integration, so
    coverage past the minimum above is decided per service rather than promised here.
    Anthropic and OpenAI already have theirs; GLM is named so the mechanism ships
    exercised on a custom service rather than only on the two that predate it. What GLM
    actually speaks, offers and limits is research for when its row is authored — naming it
    fixes the launch commitment, not its contents.

    A gateway is not a new kind of thing. It is a service with a key that reaches many
    upstream vendors, so it needs no mechanism of its own — which is why this is a statement
    about catalogue contents rather than about capability. One consequence is worth naming
    because it looks like a bug and is not: a gateway key can make a vendor's own models
    available to someone with no account at that vendor, and — since a gateway typically
    speaks the OpenAI style — can offer them under a harness that vendor did not write.
    That is reqs 2 and 6 behaving as specified.

    **Letting a user point ShipIt at a gateway or endpoint it does not carry is deferred,
    not rejected.** Reqs 5 and 7 stand: for now every service is ShipIt's. Adding
    user-supplied endpoints later would extend this requirement rather than contradict it.

16. Usage and cost are reported **split by service and billing mode**, so it is clear where
    money was actually spent and where a subscription was used. Reporting usage is not new;
    the split is. Once a session's turns can span both, a single combined total stops being
    meaningful — money that left the user's account and usage covered by a plan they already
    pay for are different things, and are not added together into one figure.

    For subscription usage the user can also see **what it would have cost at that service's
    API rates**, which is what says whether the subscription is worth keeping. It is shown as
    a comparison and never as money spent.

    Volume is reported in **tokens**, not turns. A turn is not a unit of anything — one can be
    a one-line question and the next a full refactor — so a turn count says little about what
    was consumed, and it is not the unit either price or quota is computed in. Tokens are.

    Wherever ShipIt shows a **running figure for the session in progress**, a session on a
    subscription shows its at-API-rates estimate, labelled as such, rather than a blank or a
    zero. The estimate is still never presented as money spent, and it is never added to a
    metered total — but the user keeps a live sense of what the session is consuming
    regardless of how it is paid for, which is what those surfaces are for.

    This holds at session scope and across all sessions, for usage recorded **from this
    feature onward**. Turns recorded before it carry no service and no billing mode — for
    sub-agent turns, not even a credential route — so the attribution is not in the data and
    cannot be reconstructed. Those are shown as their own group rather than split, guessed at,
    or dropped from the totals.

    **The same group also holds work that is unattributable going forward.** Some work
    genuinely resolves no model — session naming falling back when nothing is eligible runs on
    the session's own harness with no service, no billing mode and therefore no rate. Its
    tokens are real and its attribution does not exist, which is the same condition as a
    pre-feature turn arrived at from the other direction. It goes in the same group rather
    than being dropped, and it is never priced: a $0 row would assert the work was free, which
    is the one thing this requirement exists to stop the totals saying.

    So the group is **not** purely historical and does not empty by itself. It is the honest
    home for volume whose attribution is unknown, whatever the reason.

17. **There is one way to add a credential, and signing in is part of it.** Every credential
    is added the same way — a key, a second key, a first subscription account, a second one —
    and where a billing mode is connected by **signing in**, the sign-in happens inside that
    one flow. The user is not handed off to a control somewhere else to finish what they
    started. A configured service shows what is there and lets the user manage it — the
    credentials, their order, disconnecting one — and offers no second way to add.

    This is a change of the surface, not of what a credential is: it takes a few more clicks
    to add a second account, which is rare, and in exchange there is one door rather than two
    permanently on screen.

    **A service the user has not finished connecting does not appear.** Choosing a
    subscription and then abandoning the sign-in leaves nothing behind. Today it leaves a
    service listed with no credential and no way to remove it, which is the direct cost of
    the hand-off this requirement removes.

    **Leaving before it finishes is leaving, however the user leaves.** Cancelling and
    closing do the same thing: the attempt is called off and nothing is listed. A sign-in
    that is still in progress is not preserved for later, so there is no state in which a
    service appears because the user stepped away from connecting it.

18. **A step that can only be answered one way answers itself.** Where the chosen billing
    mode is connected *only* by signing in, choosing that mode starts the sign-in: the user
    arrives at the provider's code, not at a screen whose single control repeats the choice
    they just made. A mode that offers something else as well — a key to paste — still asks,
    because there the sign-in is one option among several.

19. **A configured service is stated compactly.** A service's card says what the service is
    and what the user gave it; it does not spend space on prose that would read the same on
    every install, and it does not say a thing twice in two ways. The models a card can run
    stay reachable **from** the card without occupying it.

20. **A credential ShipIt takes from the deployment's environment is an ordinary
    credential.** Where the deployment supplies one in an environment variable, it appears
    in Settings like any other: it can be seen, renamed, reordered, replaced and removed,
    and it takes part in exactly the same ordering and failover rules as one the user pasted
    in. Nothing on the screen presents it as a different class of credential, and nothing
    about where it came from changes how it is used. Removing it is a removal: a later
    restart does not bring it back.

21. **The order of a service's credentials is changed by dragging one into place, and that is
    the only way to change it.** The order is what the rows show, so being first is being at
    the top; there is no separate command that promotes a credential and no badge naming the
    one at the top as different in kind.

## Open questions

_None._

## Resolved questions

- 2026-08-13 — Does a card holding one credential explain that there is nothing to route
  between yet? **Chosen: no — it says nothing at all.** The mock-up carried the strip ("One
  account — nothing to route between yet. Add a second to choose an order and a strategy."),
  the UI audit adopted it as D8, and the human rejected it on sight in the dogfood instance:
  "this is not needed, shouldn't be shown at all when there is only a single account." No
  requirement changes — req 19 already refuses prose that reads the same on every install, and
  the argument for keeping this one (a key card can never route, so explaining *that* absence
  is noise, while this one names a reachable capability) was a carve-out req 19 does not
  contain. The routing band now appears only when there is something to route between.

- 2026-08-12 — A service card carries four sentences of explanation, an empty-state box and a
  row of model-id chips around a single credential row (272 px for 39 px of credential). How
  compact, and what goes? **Chosen: the compact card, with the model ids moved into a control
  in the card's top-right corner that names them on hover.** The human picked the compact
  option over a denser one that also flattened the chips into a truncated line — "A, but the
  model names should be in a tooltip of a separate control, e.g. 'models' chip or icon, maybe
  on the right top corner" — which keeps the ids scannable while taking their row out of every
  card. Req 19 added. The prose cut with it is listed in `plan.md`; the one item that was not
  merely verbose is the account empty-state box, which printed "No Anthropic subscription
  connected" directly above a connected Anthropic credential.

- 2026-08-12 — Does an account row keep its **Make primary** command, and how is the fallback
  order changed? **Chosen: drag a row into place, and drop Make primary entirely.** The human
  asked what Make primary was for and judged it unnecessary. It is: `isPrimary` is not stored,
  it is computed as position 0 (`orderCredentialRoutes`), and the server verb behind the button
  is `reorder([this, …rest])` — so with the order under direct manipulation the command is a
  second way to do one thing, which req 17 already refuses elsewhere on this screen. The
  "Primary" badge goes with it: the row at the top *is* the primary one, and the routing band
  says what being at the top means. Req 21 added.

- 2026-08-12 — A deployment-supplied variable (`ANTHROPIC_AUTH_TOKEN`, `DEEPSEEK_API_KEY`)
  creates no credential row: it is invisible in Settings and used only when nothing is stored.
  Keep that, or adopt it as an ordinary credential? **Chosen: adopt it.** The human's words are
  the requirement — "I want these environment variables applied through ShipIt to behave
  exactly as if I would add the service manually" — and the reason they arose is worth keeping:
  a deployment (the dogfood instance) could not be used to judge what a real user sees, because
  its credentials were a category the product treats differently. Req 20 added. Two consequences
  the human accepted with it: the value is copied into ShipIt's encrypted credential store, and
  a removal is remembered so the next boot does not re-import what the user deleted.

- 2026-08-12 — When every connected subscription of a mode is exhausted, should ShipIt move
  onto a supplied key on the same card? **Chosen: no — it stops and reports when quota
  resets**, confirming the phase 5 decision behind reqs 12 and 13 rather than changing it. The
  question was put because the card printed a sentence describing that rule and the human read
  it as a special case for environment-supplied credentials. It is not one: the rule applies to
  every supplied key sitting on an account-backed card, and the sentence was wrong only in
  claiming to know the credential came from the environment. It changes no requirement; the
  false sentence goes with req 19's compaction and the rule stays as reqs 12 and 13 state it.

- 2026-08-11 — A sign-in is in progress, the provider's code is on screen, and the user
  dismisses the dialog with Esc / the backdrop / the close button rather than pressing
  Cancel. Is the attempt kept or discarded? **Chosen: discarded — closing means cancelling.**
  Raised by the independent review, which found the implementation deliberately keeping a
  dismissed attempt (visible on the service card as an unfinished account, finishable and
  removable there) while req 17 said no unconnected service appears at all — a distinction
  that existed in the design and the code but never in the requirement. The rejected reading
  was to narrow the requirement around it, on the grounds that the provider may already have
  authorised the code and losing it costs a restart. The answer keeps the requirement whole
  instead: "unless you pressed Escape" is not a clause anybody would predict, and one press
  to start again is cheaper than a service listed that nobody asked for. Req 17 amended to
  say so.

- 2026-08-11 — Once the sign-in moves inside the add-service flow, does a configured service
  keep a shortcut for adding another credential? **Chosen: no — the panel's "Add a service" is
  the only way in**, and the existing "Add another" on key cards goes with it, so the rule is
  uniform rather than per-card-type. The human's reasoning, recorded because it is the whole
  trade: adding a second account is a rare occurrence, so a couple of extra clicks is fine,
  whereas the alternative is supporting two ways to do the same thing and having them in the
  user's face every time. The question arose from the state that prompted this requirement: an
  OpenAI subscription chosen in the dialog appears in Services with no credential and cannot be
  removed. Req 17 added, including that last consequence, because "does not appear until it is
  connected" is observable and was being treated as an implementation detail.

- 2026-08-09 — Where does non-turn work that resolves **no** model belong — session naming's
  `nothing_eligible` fallback, whose tokens are real but whose attribution does not exist?
  **Chosen: req 16's legacy group.** Raised as `planning#343` while closing `planning#341`;
  the finding is harness-independent and predates both. The group already exists to hold rows
  whose attribution cannot be reconstructed, and this is that condition arrived at forward in
  time rather than historically. The rejected alternative was leaving the tokens unrecorded
  and narrowing the requirement's claim; recording them as unattributable volume keeps the
  totals complete without pricing them. Pricing them was never an option — a $0 row asserts
  the work was free, which is the trap this feature has now walked into twice (a metered
  consult recorded as free in phase 3, and Codex's absent telemetry in phase 6).

  **The consequence is that the group stops being purely historical and no longer drains on
  its own**, which contradicts the earlier receipt below saying it "empties by itself as old
  sessions age out". That sentence is superseded rather than merely extended, and req 16 now
  says so.

- 2026-08-09 — Phase 1's catalogue authoring raised one: **a subscription that includes a
  model still billed per token has no column in req 16's split.** **Chosen: the case does not
  exist — no requirement changes.** The question rested entirely on a premise the human
  corrected: `claude-fable-5` no longer bills "per token (usage-based) rather than against
  the subscription plan limit", which is what ShipIt's own picker comment (and therefore the
  question) asserted. With Fable counting against the plan like any other subscription model,
  `BillingMode` remains the sole thing that decides the column: a `sub` row is included work,
  a `key` row is money. Req 16's split stands unamended, and the three readings the question
  offered are all moot.

  Recorded rather than deleted because the *shape* of the question outlives its instance. If a
  service ever does offer a plan-reachable, per-token-billed model, this is the requirement it
  contradicts and the fact to check first — the comment in the code, not the vendor's current
  terms. The stale claim is now corrected at its source; see the phase-1 notes in `plan.md`.

- 2026-08-09 — Should usage volume be reported in turns or tokens? **Chosen: tokens.** Stated
  directly rather than asked: the prototypes and the design had carried turn counts as the
  volume measure, inherited from the existing usage view. A turn is not a fixed quantity of
  anything, so a turn count is a poor proxy for consumption and is not the unit price or quota
  is computed in. Req 16 amended. Turn counts are not forbidden as session metadata — the
  requirement is about the volume figure the usage split reports.

- 2026-08-09 — A subscription session's running dollar figure goes to zero under req 16. What
  should those surfaces show instead? **Chosen: the at-API-rates estimate, labelled as such.**
  An end-to-end review of the cost story found that req 16 settles the *usage view* but that
  ShipIt shows a running session cost in several other places — the context dial's trigger and
  popover, and the usage modal's per-session cost, average per turn, per-turn column and
  by-spend ranking. Every one reads zero for a subscription session, which today is most
  sessions. The three options were: show the at-API-rates estimate, drop dollars for turns and
  tokens, or show metered spend only and leave it blank when nothing was spent. The estimate
  was chosen because those surfaces exist to give a live sense of what a session is consuming,
  and that need does not change with how the session is paid for; the alternatives either go
  quiet for the majority case or remove a running proxy users rely on. The accepted cost is
  that a dollar figure on the dial no longer means money left the account, so the label carries
  the distinction in ShipIt's smallest text — the mitigation is that it is never unlabelled and
  never summed into a metered total. Req 16 amended.

- 2026-08-08 — Does req 16's split cover usage recorded **before** this feature? **Chosen: no
  — a legacy group, and the requirement applies going forward.** Review found req 16's "across
  all sessions" unqualified while the data cannot support it: existing turns store a model id,
  tokens and a cost, with no service or billing mode, and sub-agent turns not even a route. The
  three options were a legacy group, hiding pre-existing usage from the split view, or
  backfilling an inference. Backfilling was rejected as producing a confident, wrong split of
  real money; hiding was rejected as silently removing spend from totals users have already
  seen. The group is honest about what is unknown and drains on its own. Req 16 amended.

- 2026-08-08 — **Codex's review of this document**, three questions answered together. Run
  under CLAUDE.md's cross-backend rule (Claude-authored work reviewed by the other backend).
  It returned five findings and all five held up on checking; two were stale sentences in
  `plan.md` and one was a missing phase assignment, all fixed there rather than here.

  - **Must a successor still run on the session's harness? Chosen: yes.** Req 13 scoped the
    successor to the same service and mode and then promised a session is "never left unable
    to take a turn" — but req 6 makes availability depend on the **API style** as well, so a
    successor declared only under a style the pinned harness does not speak breaks that
    promise. This is the *third* time the same defect surfaced on a new axis: the successor
    was scoped to the service on 2026-08-05, to the billing mode earlier on 2026-08-08, and
    the harness was missed both times. Req 13 now states the condition it was always
    promising — the successor must be one the session's harness can run — which closes the
    axis rather than the instance. `plan.md`'s per-`(service, mode)` map cannot express a
    per-harness successor and is flagged there.
  - **Are several subscriptions to one service really interchangeable? Chosen: no — narrow
    the claim.** Req 5 asserted it, and req 12 routes between them on that basis, but tiered
    plans make it false: a cheaper account may not offer what a dearer one does, so req 8 can
    offer a model the routed-to account cannot run. `mockup-services.html` had already
    contradicted the requirement in its own copy — "a bigger plan first, a smaller one as
    backup". Req 5 now claims only what it needs, that the user does not choose among them,
    and says explicitly that this is not an equivalence claim. Not a regression this feature
    introduces: ShipIt already routes between accounts without comparing entitlements, so
    handling tiers is a separate feature rather than something to bolt on here.
  - **May a retirement change what a metered turn costs? Chosen: yes, and no requirement
    change.** A same-price successor is not generally available; holding the billing mode
    fixed is what prevents *included* work becoming *billed* work, which is the discontinuity
    worth preventing, and req 11 makes the moved-to model visible so the change is not
    silent. Req 13 gained a paragraph saying so, because the absence of the promise was
    being read as the promise. `plan.md` *had* claimed the price was unchanged — twice, in
    two different wrong ways — and is corrected.

- 2026-08-08 — Four gaps found by a review pass, answered together. Three are the same
  failure: the billing-mode decision was applied to reqs 5, 6, 8, 10, 11 and 12 and not to
  the rest, so the requirements disagreed with each other rather than being incomplete.

  - **Must a retirement successor stay in the same billing mode? Chosen: yes.** Req 13 said
    "another model of the same service" and stopped, which — once a service's model set
    became a property of each mode (reqs 5, 6) — allowed a session on a subscription to be
    remapped onto a model only the key offers. That either fails or starts charging, and
    req 12 already refuses that exact move on failover. Scoping the map per `(service, mode)`
    removes the case rather than handling it; a mode with no successor is a catalogue
    mistake, not a fallback path. Req 13. `plan.md`'s claim that a remap is safe because
    "the credential, the endpoint, the API style and the price are all unchanged" was
    untrue under billing modes and is corrected with it.
  - **Does "a harness speaks one API style" belong in the requirements? Chosen: no — state
    the overlap instead.** Req 6 asserted it as fact while `plan.md`'s third-harness survey
    lists it as the assumption most likely wrong and most expensive to fix late (OpenCode is
    multi-provider). Req 6 now says a model is offered when the service and the harness
    **share** a style, which is true either way — so if the survey finds a multi-style
    harness, the design changes and this requirement does not.
  - **Should the launch catalogue name the subscription-carrying custom service? Chosen:
    yes — GLM.** Req 15 exists because "ShipIt supports gateways" is unverifiable unless
    stated as catalogue contents; its own subscription paragraph then wanted "at least one
    custom service with a real subscription" without naming one, and GLM was named only in
    `plan.md` and the prototypes. That put a launch-content decision in the design. GLM is
    now a launch row; what it speaks and offers stays research for when the row is authored.
  - **What does the non-turn setting name, and which harness runs it? Chosen: the triple,
    with the harness derived.** Req 9's "a service and a model" predated req 5. The real gap
    was the harness: running a model means spawning a CLI, and a model can be offered on
    several installed ones. Deriving it keeps req 9's setting a model choice like any other
    (req 3) instead of growing a second control that exists nowhere else; the derivation
    rule is design and lives in `plan.md`.

- 2026-08-08 — Does this feature add subscription modes, or only key modes? **Chosen: the
  mechanism yes, specific vendors case by case.** Review found req 5's scope limit ("this
  feature adds key modes") contradicted its own illustrations, which demonstrated the
  billing-mode split with a *DeepSeek subscription*. The sentence had survived the
  billing-mode rewrite unedited. Resolved by separating the two things it had bundled:
  building support for subscription modes is in scope, so the picker, Settings, eligibility,
  usage and failover all handle one without knowing whose it is; integrating any particular
  vendor's subscription stays per-service work, decided per service. Req 15 gained the
  matching note that the launch set's subscription coverage is left open.

  A factual correction came with it: **DeepSeek has no subscription**, so every mock
  illustrating one was wrong. The prototypes now use **GLM**, which has a coding plan
  alongside its API — a service that genuinely has both modes, and the intended test case
  for the mechanism.

- 2026-08-08 — Should the usage/cost split be a requirement? **Chosen: yes, and only the
  split.** Review found the cost view had no requirement behind it — "cost" and "price"
  appeared in these requirements only as rationale, never as an obligation — while the design
  and `plan.md`'s phase 6 both promised one. The human's correction narrowed what to add:
  **reporting usage and cost is an existing feature, and existing behaviour is already a
  requirement without being restated.** What is new, and therefore what req 16 states, is the
  *split* by service and billing mode, plus the API-rate comparison for subscription usage.
  The general principle went into this document's preamble, because it governs how every
  requirement here should be read — and it is why several requirements are silent about
  capabilities this feature does not change.

- 2026-08-08 — Does reasoning effort need to say anything about the model? **Chosen: no —
  reasoning stays a property of the harness, and this feature adds nothing.** No new
  requirement: the offered levels are whatever the harness accepts, and a model that ignores
  them is already covered by req 1's best-effort clause.

  This **overrides the agent's recommendation**, which was to declare per-model support and
  hide the control when absent. Two arguments defeated it. First, **there is no source for
  the fact** — it would come from reading around the internet per model, which is exactly
  the per-model upkeep req 6 kept the catalogue small to avoid. Second and decisive, **the
  harness is not a transparent pipe**: even a correct per-model claim says nothing about
  whether *this* harness forwards the setting, so a harness that silently drops it would
  leave ShipIt asserting support that does nothing. The proposal would have relocated the
  dishonesty while making it look more precise, not removed it.

  The corollary is that pre-disabling values in the UI is the wrong instinct here: a wrong
  value is something **the harness can complain about**, and its error is the authoritative
  answer, where a ShipIt-side guess is not.

- 2026-08-08 — Is a service's billing mode part of what you select, or resolved per turn?
  **Chosen: part of the selection.** A model is identified by `(service, billing mode,
  model)`, and the picker shows one group per service *per mode* — so a service holding both
  a subscription and an API key is two blocks, not one. Three reasons, any one sufficient:
  a subscription may include **fewer models** than the same service's key, so a merged list
  would offer a model the resolved route cannot serve; the two **differ in price**, which is
  already this design's stated reason for listing the same model id separately per service
  (DeepSeek-direct vs OpenRouter), and included-versus-metered is that same distinction
  inside one service; and it closes a real gap, since ShipIt never fails over from a spent
  subscription onto metered billing, so under one merged entry a user holding both had no
  way to say "charge me, keep working".

  Scoped deliberately to the **mode**, not the credential: several subscriptions to one
  service stay merged, because req 12 already routes between them and choosing among them
  would be noise — which also caps the picker at two groups per service rather than one per
  credential. Reqs 5, 6, 8, 10, 11 and 12 reworded from "a service is authenticated by X" to
  the billing-mode form. The agent had proposed this from the human's question; the human's
  "yes, I think it makes sense" is what adopted it. Not hypothetical either: ShipIt already
  holds subscription accounts and a metered key route together for Anthropic, so the
  singular wording was already slightly false.

- 2026-08-07 — Gateway support: catalogue *content*, or a capability the catalogue does not
  have? **Chosen: content — carry the common gateways explicitly; custom URLs later.** The
  feedback ("gateway support — at least openrouter/vercel/1st party providers") turned out to
  ask for almost nothing the design lacked: a gateway is a service like any other, which the
  2026-08-05 receipt had already settled by dropping "should we support gateways?" as the
  wrong axis. What it did expose is that no requirement said what the shipped catalogue must
  *contain*, so "ShipIt supports gateways" was true in principle and unverifiable in
  practice — an install could carry zero gateways and violate nothing. Requirement 15 states
  the launch set. The second reading — a user supplying a gateway's own base URL — was
  explicitly **deferred rather than adopted** ("we can always add custom urls later"), so
  reqs 5 and 7 are untouched and no settled decision was reopened.

- 2026-08-07 — What *is* ShipIt's default for non-turn work? **Chosen: derive it — the
  first model of the first service.** Re-reading found the default was the one part of
  req 9 that a fixed value could not satisfy: any named model (the mockup showed
  `Anthropic · haiku-4.5`) names a service that the very install this feature exists to
  create — a user whose only credential is a DeepSeek key — has no credential for, so
  every session title and pull-request description would fail from the first day and fire
  req 9's own notice. Req 14 sharpened it: an install that did not select the Claude Code
  harness has no way to run that default at all. A derived default removes the failure
  by construction rather than reporting it, and it also self-heals the original incident
  — when a subscription lapses, an unset default moves to whatever the install still has
  instead of continuing to point at the vendor that went away. Requirement 9.

- 2026-08-06 — Can the installed harness set change after install, without reinstalling?
  **Chosen: no — redeploy.** The harness set is an input to the session-image build, so
  changing it is a deployment-config change and a redeploy, not a setting. This is what
  `docs/154-cursor-agent-adapter` already sketched (`INSTALL_CLAUDE_CLI` /
  `INSTALL_CODEX_CLI` / `INSTALL_CURSOR_CLI` booleans written to
  `/opt/shipit/agents/installed.json` at build time) and never implemented. Installing a
  harness into a running deployment was rejected as materially larger — mutable session
  images or a runtime install path, harder version pinning, and a harder warm-container
  pool — and as pulling against req 14's "not user-editable", since it is very close to
  editing the harness set at runtime. Requirement 14.

- 2026-08-06 — Which requirements could be **removed**? **Chosen: cut 16 to 13.** A review
  round was run with the inverted brief CLAUDE.md prescribes — for each requirement, would
  anyone notice if it were deleted? — because every prior round had added mechanism and
  none had removed any. Deleted outright: the old req 3 (the harness stays put), derivable
  from reqs 1, 2 and 4; and the old req 9 (a new harness picks up services already speaking
  its style), derivable from req 6's offering rule. Folded: the old req 6's best-effort
  qualifier into req 1, dropping its enumeration of session features — the qualifier had to
  move rather than vanish, because it exists to *weaken* req 1 and deleting it outright
  would have left req 1 promising more than was ever agreed. Trimmed: the old req 7 down to
  its key-versus-subscription scope limit (its "first-class concept" framing was already
  carried by reqs 7 and 8), and the old req 8 down to its offering rule and curation (its
  authorship clause moved into req 7). Everything from here down is dated 2026-08-05 and
  cites the **old** numbering where a requirement no longer exists under any number.

- 2026-08-05 — Can a retirement move a session to a different service? **Chosen: no —
  the map is between models of a single service.** Review found req 13 as first written
  promised a session "never left unable to take a turn" while allowing a successor on any
  service, including one the user has no credential for, which req 8 would then refuse
  to offer. Scoping the map inside a service removes the contradiction at its source
  rather than patching it: the credential, the price and the provider are all unchanged
  by a remap, so there is nothing left to fail. Requirement 13; the design's
  "keyed by pair" framing goes with it.

- 2026-08-05 — Non-turn work names a *service*, but running it needs a model. **Chosen:
  make it explicit in the UI, with a reasonable ShipIt-supplied default.** It is a model
  choice like any other (req 3), naming a service and a model. The default is what keeps
  this from being configuration everyone must do before ShipIt works; making the setting
  visible is what keeps the default from being the silent dependency req 9 exists to
  prevent. Requirement 9.

- 2026-08-05 — What happens to a session pinned to a model that later leaves the
  catalogue? **Chosen: maintain a fallback map from retired pairs to their successors,
  and move the session onto the successor.** Not "keep running on the removed pair",
  which was the agent's suggestion — that leaves sessions on models ShipIt has stopped
  standing behind. Requirement 13. The gap only exists because curation (req 6) makes
  removal a deliberate, recurring act rather than an accident.

- 2026-08-05 — How do compact declarations coexist with per-model metadata? **Chosen:
  (c) ship only an explicitly maintained subset of a large service's models.** Only a
  handful of models are worth using for coding at any time, so the catalogue carries
  those rather than mirroring a service's full offering. This *removed* a requirement
  rather than adding one: req 6's "one piece of configuration must cover many models"
  constraint is gone, and with it the need for build-time generation or a
  defaults-plus-exceptions scheme. Per-model metadata is no longer in tension with
  anything, because there are few enough models to state it per model.

- 2026-08-05 — What does req 8 promise, and for how long? **Chosen: strip the promise.**
  The requirement bundled two things — a vague "only offers models it can actually run",
  and the credential-eligibility rule chosen earlier the same day. The first is what made
  it unclear and what a stale catalogue could not honour; ShipIt does not guarantee that
  every model and harness combination works (req 1 is best-effort). Req 8 now states
  only the credential rule, which is the part that does real work: it is why the picker
  stops offering `claude-*` models on an install whose only credential is a DeepSeek key.
  With the guarantee gone, no staleness policy is needed — a model that stops working is
  a catalogue update, and req 1's best-effort clause covers the interim.

- 2026-08-05 — Who authors a service's per-model declarations, and what keeps them
  fresh? **Chosen: ShipIt's developers author them, with configuration that can cover
  many models at once.** Not user-authored and not auto-discovered. Requirement 6 gained
  the authorship and the "one config covers many models" constraint, which is what keeps
  an aggregator's hundreds of models from being hundreds of entries.

  **This narrowed requirement 7.** That requirement previously said trying a new service
  or model needs no code change or release; with the catalogue shipping in ShipIt, a
  service ShipIt does not know about *does*. Req 7 was rewritten so what the user owns
  is the **credential**, and the catalogue is ShipIt's. The two answers are recorded
  separately rather than merged, because the second changes the first.

- 2026-08-05 — What is "a service the user adds"? **Chosen: there is no such thing.**
  Services are ShipIt-defined ("hardcoded"); a user supplies credentials for them and
  never describes a new one. This is the same conclusion the catalogue answer reached
  from the other direction — if ShipIt authors the catalogue, a user-invented service
  was never coherent — but reqs 5 and 7 still carried the older phrasing. Both
  rewritten. It also simplifies the receipt below: the scope limit is not "user-added
  services are key-authenticated" but simply that this feature adds key-authenticated
  services to ShipIt's catalogue.

- 2026-08-05 — Are user-added *subscription* services in scope? **Chosen: no, out of
  scope for now.** *(Phrasing superseded by the receipt above — there are no user-added
  services at all; the substance, that this feature adds only key-authenticated
  services, is unchanged.)* Each subscription needs custom ShipIt-side support — its own login,
  refresh, and account handling — which cannot be inferred from configuration. A service
  a user adds is key-authenticated; subscription-backed services remain the ones ShipIt
  implements. Requirement 5.

- 2026-08-05 — What should failure of non-turn work look like? **Chosen: (a) keep the
  existing fallbacks and surface a dismissible notice.** The operation still completes —
  placeholder title, generic pull-request description — and the user is told which
  service failed. Background failure neither blocks the operation nor passes silently.
  Requirement 9.

- 2026-08-05 — Confirm or strike the two agent-supplied requirements (then numbered 6
  and 14; now req 1's best-effort clause and req 11). **Chosen:
  both kept.** The first additionally gained a *model*-capability qualifier alongside the
  harness one: a model that cannot call tools cannot run skills or MCP servers whatever
  the harness does. Refined further the same day, on the human's framing — "ShipIt works
  best effort for models/harnesses, it can't fix them" — so the requirement is now
  explicitly best-effort. It does not promise a given model works well, only that ShipIt
  imposes nothing extra. A model that handles tools badly is not a ShipIt defect.

- 2026-08-05 — Can one service offer different models to different harnesses?
  **Chosen: (b) — a service declares which of its models work under which API style.**
  Compatibility is therefore a property of *service × model × harness*, not service ×
  harness. Req 6 and the then-separate future-harness requirement were narrowed
  accordingly: the latter's "no further work by the user" held only as far as a
  service's declarations already reach. The cost is
  more configuration per service; the alternative was offering models that are listed
  and then fail, which is exactly what req 8 forbids.

- 2026-08-05 — At the moment a credential failure arrives, can ShipIt tell a spent
  subscription apart from a bad key? **Chosen: it does not have to.** The rule keys on
  how the service is authenticated *(narrowed 2026-08-08 to the billing mode in use, since
  one service can hold both — see that receipt; the substance below is unchanged)* —
  subscriptions fail over, API keys do not — which
  ShipIt knows statically from its own configuration, instead of having to classify an
  error whose text is not reliable. Failover is scoped to subscriptions of the *same*
  service, because that is the only case that is lossless: the model and price are
  unchanged and the user need not be consulted. This generalizes an existing rule
  rather than inventing one — ShipIt already excludes metered API-key routes from quota
  tracking and never fails over onto them (docs/150 req 12). Requirement 12 rewritten.

- 2026-08-05 — What should happen when a configured service's credential stops working
  mid-session? **Chosen: stop, and report it — nothing more.** Recovering from a bad
  credential is the harness's responsibility, not ShipIt's. ShipIt's involvement in
  credentials is deliberately limited to the one thing harnesses do not do: letting a
  user run several subscriptions and routing between them. Requirement 12. This
  *removes* designed behavior rather than adding it — the plan had proposed a
  service-aware re-prompt flow, which is now explicitly out of scope.

- 2026-08-05 — What should the indicator show for a service that has no quota to
  report? **Chosen: (a) render no indicator.** This preserves what a key-based
  credential already does today rather than introducing a new behavior. Showing
  accumulated spend or token counts there was considered and rejected *for this
  feature* — it is buildable, but it is a separate feature and should not be decided
  as a side effect of this one. Folded into requirement 10. (Why it is the status quo,
  in code terms, is in `plan.md`.)

- 2026-08-05 — How far should "any custom model" reach: only providers already
  serving a harness-compatible API, or also OpenAI-compatible ones through a
  gateway? **Chosen: neither — the framing was wrong.** The primitive is the
  *service*, defined by its API key or subscription. A service may support several
  API styles, and therefore several harnesses; compatibility is derived from that
  overlap rather than being a scope decision. A DeepSeek key yields DeepSeek models
  in both Claude Code and Codex; a service speaking only the OpenAI style yields
  Codex only; a harness added later automatically picks up the services that speak
  its style. Requirements 5 and 6 were added, along with a future-harness requirement
  later deleted as derivable; the gateway question is dropped as
  not the axis. *(Later narrowed the same day — a service's models are not all usable
  under every style it speaks; see the compatibility receipt above.)*

- 2026-08-05 — Who decides which custom models exist? Chosen: each user, in their own
  Settings — not an admin-curated list and not the source tree. Requirement 7.

- 2026-08-05 — When only a custom credential is configured, what happens to the
  backend's own models? Chosen: model-level eligibility, so models with no usable
  credential are not selectable. Reframed on review: there is no "backend's own"
  category — the rule applies uniformly to every service, which is the clearer
  statement of the same gist. Requirement 8.

- 2026-08-05 — Should non-turn work (session naming, PR descriptions) run on the
  custom model? Chosen initially: yes, follow the session's model. **Revised the same
  day on review**: it must be *explicitly configurable* and chosen independently of
  the session's model. The human reported session naming breaking in practice when
  their Claude subscription expired and they switched to Codex — following the
  session's model would not have prevented that, because the failure was a
  credential disappearing underneath work that silently assumed it. Requirement 9.

- 2026-08-05 — Should "a user can try a model cheaply, without ShipIt shipping
  support for it first" be a requirement? **Chosen: no — removed.** The human noted
  that configuring a service *is* how a model becomes supported, so the statement
  described the feature rather than constraining it. Supporting additional harnesses
  is orthogonal and not part of this feature.

- 2026-08-05 — What should the usage indicator show for a custom model? **Chosen:
  the question was mis-framed.** Usage belongs to the service, not the model, and a
  service may have its own subscription that ShipIt supports later — so the
  abstraction has to be flexible enough to carry that. Requirement 10. The narrower
  residual question it left — services that report nothing — was resolved the same day
  (first receipt above).

## Requirement provenance

Recorded because the generalization from "DeepSeek Flash" to any model came from the
human, but most of the mechanism did not. What the human actually said, in order:

- "DeepSeek Flash … what harness is the best for it, and how hard would it be to
  integrate it into ShipIt?" → the feature exists at all.
- "supporting DeepSeek Flash in Claude Code, essentially supporting any custom
  model" → reqs 1 and 3. The generalization beyond DeepSeek is the human's.
- "start from the service, which is defined by the API key … every service may
  support various APIs and thus harnesses … if we add another harness in the future,
  it would be also supported for some of the API keys" → reqs 5 and 6. This replaced
  the agent's framing, which had treated API compatibility as a scope boundary
  rather than as a property of each service.
- "using claude or codex doesn't require authenticating with the respective model
  provider … without having a key or account with anthropic or openai" → req 2.
- "we should also allow freely switching models within a session (keeping the same
  harness), to the extent how this is supported by the harness" → req 4.
- "or subscription. And Anthropic/OpenAI services should work the same way" → req 5.
- "we need to aim for full separation between harness and service providers" → the
  reframing of req 8, and the wording throughout.
- "probably need to make it explicitly configurable. I already had an issue when
  claude subscription expired and I used codex, but session naming broke" → req 9.
- "a 'service' may have its own subscriptions that ShipIt may support (in the
  future) … the usage indicator already shows usage for a service, not for a model"
  → req 10.
- "(a) render no indicator, which is what a key-based route does today" → the closing
  sentence of req 10.
- "(b) narrow them so a service declares which of its models work on which API style"
  → the narrowing of req 6.
- "We just stop. This is the harness' responsibility to handle such cases. ShipIt only
  helps with using multiple subscriptions, because harnesses don't handle it." → req 12,
  including its scope boundary and the carve-out for multi-subscription routing.
- "I'd say that subscriptions should fail over but not API keys" → the rule in req 12.
- "failover between subscriptions of the same service" → its scoping to a single
  service.
- "ShipIt developers (me), with a convenient way to cover many models with a single
  config" → req 6's authorship, and the narrowing of req 7. (The compactness constraint
  this originally added was later replaced by curation — see the receipt.)
- "each subscription would require custom support from the ShipIt side. So it is out of
  scope of this feature for now" → req 5's key-authentication limit.
- "there should be only ShipIt-supported ('hardcoded') services" → reqs 5 and 7, which
  had still described users adding services of their own.
- "we need to maintain the fallback map (old pair -> new pair) and make sure it works"
  → req 13.
- "the map should be between models on a single service, not between pairs" → req 13's
  same-service constraint.
- "we should make it explicit in the UI, with shipit providing a reasonable default"
  → req 9's visible setting and default.
- "yes, update" (req 9's wording) and "simplify" (the future-harness requirement, since
  deleted) → both applied; the agent's
  suggestion to move req 9's third paragraph out was declined, the human judging the
  factual context worth keeping since it states a fact rather than prescribing an
  implementation.
- "(a) keep the existing fallbacks and surface a dismissible notice" → req 9's failure
  behavior.
- "sounds good" (the best-effort statement, now part of req 1) and "good" (req 11)
  → both confirmed as requirements.
- "ShipIt works 'best effort' for models/harnesses, it can't fix them" → req 1's
  best-effort framing.
- "There are only so many models at any point of time that can do good coding" → req 6's
  maintained-subset framing, replacing the compactness constraint.
- "ShipIt as a product doesn't provide guarantees that all model/harness combinations
  will work … maybe strip it?" → req 8 reduced to the credential rule.
- "apply your recommendation" (on which requirements could be removed) → the cut from 16
  requirements to 13; see the receipts.
- "let's add the requirement that harnesses wouldn't be user editable, but when installing
  ShipIt, the user should be able to choose which harnesses to install, with Codex and
  Claude being selected by default" → req 14, both halves. The human also identified the
  prior unimplemented sketch (`docs/154-cursor-agent-adapter`) that req 14 now supersedes.
- "Redeploy" → req 14's closing paragraph: the harness set is a property of the deployment.
- "I would say we support what the harness supports … the harness that we would use, let's
  say OpenCode, would not actually pass it through … so it would be on the harness level
  only" → the decision that reasoning effort adds no requirement, against the agent's
  recommendation to declare it per model.
- "if the user chooses the wrong value, the harness may complain … it doesn't necessarily
  need to be disabled in the UI from the get-go" → the corollary that the harness's own
  error is the authoritative signal, not a ShipIt-side prediction.
- "as part of this feature, we should build support for other subscriptions. Whether we
  actually add actual subscriptions remains to be seen" → req 5's scope rewrite, splitting
  the mechanism from each vendor's integration, and req 15's open subscription coverage.
- "there is no DeepSeek subscriptions, but there is a GLM coding plan, and we could use that
  for testing" → the correction of every mock that illustrated a DeepSeek subscription, and
  GLM as the intended validation case.
- "we should probably split it across services, so it's clear for the user where they were
  paying and where they were using the subscription" → req 16.
- "Legacy bucket, req 16 applies going forward" → req 16's closing paragraph, chosen from
  three options after review found the requirement's scope exceeded what the stored data can
  answer.
- "I'd like to understand how much tokens it would cost without a subscription" → req 16's
  API-rate comparison, overruling the agent's decision to withhold it.
- "it is an existing feature. So whatever is existing is a requirement … we don't need to
  clarify that everything else that worked before should work at least on the same level or
  better" → the preamble, and the narrowing of req 16 to the split alone.
- "if there was also a DeepSeek subscription, it would be a separate block here, right?" and
  "subscriptions, they may provide more restricted model choice" → the billing-mode split
  across reqs 5, 6, 8, 10, 11 and 12. The agent had first answered "no, one block" from how
  the code models routes today; the human rejected that as the wrong basis — "who cares how
  this is currently modeled in the code? we need to provide the best UX from the user
  perspective" — which is what produced the rewrite.
- "yes, I think it makes sense" → adopting the billing-mode selection.
- "gateway support - at least openrouter/vercel/1st party providers imo" → req 15. Raised as
  feedback the human relayed without endorsing a reading ("not sure that I fully understand
  it"), so it was recorded as an open question first and only became a requirement after the
  answer below.
- "let's do 1, i.e. explicitly support common gateways. We can always add custom urls later"
  → req 15's launch set, and its closing paragraph deferring user-supplied endpoints instead
  of ruling them out.
- "This is no longer the case for fable, so we can probably ignore this corner case" → the
  2026-08-09 receipt closing the only open question phase 1 raised. It changed no requirement:
  it withdrew the premise, which was a stale comment in ShipIt's own picker rather than
  anything these requirements said.
- "the default would be 'first model on the first service', something like this" → req 9's
  derived default, replacing the fixed model an earlier draft assumed. The mechanism is the
  human's sketch and is stated in `plan.md`; the requirement states only the property it
  has to have — a default the install can actually run.

- "when I click on the subscription, there are no other controls other than continue signing
  in … an extra click for the user that doesn't make sense. Make it so when I click to a
  subscription, it already jumps to the page where the token is shown" → req 18. The carve-out
  for a mode that also takes a key is the agent's, from the catalogue rather than from
  anything said: Anthropic's subscription has a field on that step, so the click there is not
  the empty one being described.

- "I want the service definition panel in the settings to be way more compact" → req 19.
- "it's hard for me to understand how it would look like for the user, from a DogFood service.
  So there is some special case for DogFood environment variables, which I don't want. I want
  these environment variables applied through ShipIt to behave exactly as if I would add the
  service manually" → req 20. The premise was half wrong — the rows the human was looking at
  were ordinary stored credentials that a card had *described* as environment-supplied — and
  the requirement is stated for the real case the complaint uncovered: a deployment variable
  that produces no row at all.
- "A, but the model names should be in a tooltip of a separate control, e.g. 'models' chip or
  icon, maybe on the right top corner" → req 19's closing clause. The corner placement is the
  human's; the requirement states only that the models stay reachable without occupying the
  card.
- "what is 'Make primary'? seems to be not needed. Also, for the order change, let's use drag
  and drop" → req 21. The judgement is the human's; what the agent contributed is the check
  that nothing else depends on the command — primary is a computed position, not a stored
  property — which is why the requirement can say there is no separate promote at all rather
  than only hiding the button.

Reqs 5 and 13 were changed again on 2026-08-08 from **Codex's** review, under CLAUDE.md's
cross-backend rule. Same shape as the round below: the findings are the reviewer's, the
choice among the options is the human's, and all three recommendations were taken as offered.

Reqs 6, 9, 13 and 15 were changed on 2026-08-08 from **the agent's** review findings, not
from anything the human said: the human's contribution was choosing among the options, and
all four recommendations were taken as offered. They are recorded here rather than in the
list above because nothing in the transcript prompted them — the trigger was the question
"any other remaining issues in the requirements?".

Reqs 5, 7 and 9 were corrected on 2026-08-05 after review found they still described
the *superseded* model in which users authored declarations and added services outright,
and claimed a pull-request fallback that does not exist today. Those are corrections to
the agent's drafting, not new decisions.

Req 1's best-effort clause and req 11 are the agent's reading of "works like any other
session" and of ShipIt's existing product principles. They are stated as requirements
rather than open questions because they restate expectations ShipIt already meets
everywhere else — but they were not said out loud, and should be struck if wrong.

Everything the agent learned while spiking — spawn-site ordering, which environment
variables carry a credential, where eligibility is computed — is design, and lives in
`plan.md`.
