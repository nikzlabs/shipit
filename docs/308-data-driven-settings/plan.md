---
issue: planning#580
title: Data-driven settings UI — design
description: How the dialogs render and write from the declarations: two optional declaration fields, a machine-readable route store, a shared scalar reader and writer, and a control table by value kind.
---

# Data-driven settings UI — design

Implements [requirements.md](requirements.md). The per-setting walk this design
rests on is [inventory.md](inventory.md); it is cited below as `P1`…`P19`.

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
attribute makes into a property the code has (req 1).

**This applies to generated rows.** A panel has operations a value writer has no
shape for — add, remove, reorder, sign in, test — so it keeps the writer it has
today. Requirement 3 asks that a component share the same *declaration* and the
same *destination*, not that every write go through one browser function.

## 1. What the declaration gains

`section?: string`, `component?: string`, and an `own-route` store that carries a
**method, a path and a body field** instead of a sentence (P2). `inventory.md`
lists the five fields that looked necessary and were not (req 5).

## 2. One writer, for the scalars

`saveSetting(key, value)` resolves the store from the declaration:

| `store.kind` | What the writer does |
|---|---|
| `credential-store`, `system-prompt-file`, `git-config` | `PUT /api/settings` with `{ [wire]: value }` |
| `browser` | encode for `localStorage`, write `localStorageKey`, update the value record (P17) — and a kind the codec cannot spell is **not** a generated row at all, because a control that changes on screen and stores nothing is worse than one that is not there |
| `own-route` | `method` `path` with `{ [bodyField]: value }` — and two declarations may share one `path`, which is what says they are one write (slice 4) |

**`own-route` is why five settings can be rows at all** (P2). The two that use it
today post different body shapes and carry no `wire`. Three more are single
values a panel happens to write — `project.allowAgentMerge`,
`integrations.github.connection`, `integrations.linear.credential` — and are
re-declared `own-route` rather than `bespoke`, which is what makes them generated
rows.

**The path and the field are the READ as well** (slice 2). The store carries
three facts and no fourth: the read is a `GET` of the same `path`, answering
under the same `bodyField`. `GET /api/egress/settings` already did; the release
channel had no reader at all, so slice 2 added `GET /api/updates/channel` rather
than a fourth field naming somewhere else to look. A later own-route setting owes
its path a GET — that is the contract, and it is what keeps the whole of req 1
inside the declaration for a setting the settings payload does not carry.

**Unless the path never answers it**, which a credential the user pastes never
does (slice 5). `writeOnly: true` is the store's fourth fact and the honest half
of that contract: it says there is no read to make, which is what keeps such a
setting out of the value record — where it would sit at its declared default for
ever while `refreshOwnRouteSettings` asked a path with no GET on every settings
refresh.

It generalises what `src/client/components/Settings/declared-setting.ts` already
solved for booleans (P6): optimistic write, per-field sequencing, and rollback to
the last value the **server** confirmed rather than to the value the failed
request asked for. Explicit-commit rows do not need it and do not get it.

**Commit mode is derived for generated rows** (P5): `text` commits on a button,
everything else on change. That is not a universal rule about settings — an SSH
port saves with its form, a failover cutoff commits on blur — and those live in
panels, which are unaffected.

**An explicit commit is a tab's, not a control's** (slice 3). The catalogue's own
`instructions.commit` exclusion says one Save stores both instruction boxes in a
single write, so the button cannot belong to either declaration — and requirement
3 forbids a custom control from changing where a value goes, which a per-row Save
would have done. So the edit lives in a **draft record** beside the value record
(`useSettingDraft`), and `<DeclaredCommit tab="…"/>` in the tab's footer commits
every edited row on that tab through `commitSettings`, which sends one
one request to the destination those declarations name — `PUT /api/settings`
carrying each one's `wire` for the tabs that have one. The button names a tab
and never a setting, so a third box added to the Instructions tab is committed by
it with no edit anywhere. `git.identity` is the same button on another tab.

Three consequences the design had not stated. **The record moves only after the
server answers, and it takes the value the server ECHOED** — the writers trim, so
what was sent is not always what is stored. **A refused write keeps the draft**,
because that is the user's unsaved typing and the toast is the only thing they
have left. And **what may be committed comes from the value type's `validate()`**
(P8), so the 50,000-character bound the tab used to carry in JSX is gone and the
keyboard path cannot enforce a different limit from the button.

**A draft is never dropped for looking unchanged, and that is what makes it safe.**
The first cut treated a draft equal to what it started from as no draft at all,
so that typing back to the original re-adopted an outside change. Two ways to
lose a keystroke followed, both found by review and both reproduced: a dropped
draft left its **seed** behind, so the next edit after an outside change was
compared against a value nobody was looking at and vanished; and an edit made
*during* a save that happened to equal the pre-save value was dropped in favour
of the value the save stored. So a draft now lives from the first keystroke until
the write that carries it lands, or until the dialog closes — a box that was
typed in always shows what was typed. Settling is one store action: a draft still
holding what was sent is done and goes, one typed in since stays with its **seed
advanced to what is now stored**, because that write was the user's own and not
the outside change the seed exists to detect.

**Two commits of one destination must not overlap**, and slice 3's answer — the
button is disabled while its write is in flight — turned out not to be enough.
That state belongs to a component, so switching tabs re-mounts the button enabled
while the request is still out, and the older of two responses then leaves the
record on the older value with the server holding the newer, after the
`settings_changed` refresh that would have corrected it has already run. So
`commitSettings` keeps a module-level sequence **per destination**, exactly as
`saveSetting` keeps one per setting: an answer that is not the newest moves
nothing. The disabled button stays, as the thing that makes a double-click do
nothing.

**Unless one component owns every half of the commit** (slice 4). The webhook's
Save saves both halves of one credential to one address, so it belongs to that
component: a tab-level button would have sat at the foot of the tab, away from
the boxes it saves. The rule below is for a Save that spans two independent rows.

**A tab that has an explicit-commit row must place a `DeclaredCommit`**, and
nothing checks that it does: moving a `system-prompt-file` row to a tab without
one would render a textarea nobody can save. Both tabs that have one place it
today; a later slice that moves such a row owes the check.

**A generated row's writer awaits the response and does nothing else** (P3).
A setting whose write has a client-side effect is not a generated row: hands-free
must arm audio inside the click gesture, and the TTS provider repairs the voice
and speed. Both are components.

## 3. One reader

A generic `Record<SettingKey, unknown>` in the settings store, hydrated from the
settings payload by `wire`, from `localStorage` by `localStorageKey`, and from
its own route for the `own-route` settings. `useSetting(key)` returns
`{ value, set }`.

**Hydration walks the declarations, and that is what finishes req 1** (slice 2,
`src/client/stores/setting-hydration.ts`). Slice 1 left a row that saved
correctly and came back as its default after a reload, because the three places
that apply a settings payload — `App.tsx`, `session-data.ts`,
`message-handlers/global-settings.ts` — each named the settings they knew about.
They now call `hydrateSettingValues(payload)`, which walks `GENERATED_SETTINGS`
and reads each row from its own `wire`; `applyGlobalSettings` additionally calls
`refreshOwnRouteSettings()`, which reads the rows the payload does not carry from
their declared paths. Both run wherever global settings land — so also on the
`settings_changed` broadcast, which is what keeps a row the agent changed
current.

**A read in flight is discarded when the value moves under it.** These reads
take as long as a request, and a save writes the record the moment it is made —
so a read that began first and answered second would put the old value back
under a control the user has just changed, after the `settings_changed` refresh
that would have corrected it had already run. The record's value before and
after the read is the whole test.

So **for a tab in `GENERATED_TABS`, adding a row is one edit in one place**:
declaration in, row rendered, value written, value read back. The seven
per-setting hydration lines and the six store setters that existed only to carry
them are gone. What a later slice still owes req 1 is each tab's *entry* into
`GENERATED_TABS` — a setting on an unconverted tab is still read through its
named field, written by that field's own setter (P18).

**Keeping the storage key is necessary and not sufficient** (req 9, P17).
`localStorage` holds strings and JSON, and `bool.read` returns its default for
anything that is not a real boolean — so a reader that hands stored text straight
to `type.read()` silently resets every browser boolean. The browser store
therefore gets a **codec per value kind**, the three legacy keybinding keys keep
their fallback, and the slice that moves a value ships fixtures written in
today's on-disk format.

**The named selectors stay** (P1). The 51 lines in `src/client` that read
per-setting fields keep reading them; the fields become a thin view over the
record. They are a compatible read path, not a registration step, so nothing
forces a migration.

## 4. The renderer

`<DeclaredSettings tab="advanced" />` walks the tab's declarations, groups by
`section` in declaration order, and renders one control per declaration:

| Value kind | Control |
|---|---|
| `bool` | toggle |
| `enumOf` | a card per option when every option declares a **description**, otherwise a select — the declaration decides, with no new field (slice 4). A card exists to carry an option's sentence; the release channel is the only set that has one |
| `numeric` | number input, with the declared unit |
| `text` | textarea when the store is `system-prompt-file`; a `text` row over any other store has no control yet, so it is **not generated at all** (slice 3) |
| `gitIdentity` | the name-and-email pair |
| `modelSelection` | the model picker |
| a declaration naming a `component` | that component, rendered **once** however many declarations name it |

A **credential row** — configured or not, replace, remove — was in this table
until slice 5 built one. It is not a control kind: its write has a client-side
effect, its remove is a second address, and what it shows is the connection
rather than the value. It is a component, and slice 5 says why.

**What the walk skips**: a declaration carrying an `address` and naming no
`component`, because a panel owns it and renders it per item (P11).
`voice.providerKey` is addressed and has no collection declaration — its owner is
the Voice tab's provider-key list, which is a component, so naming one is exactly
how an addressed declaration says it is not a standalone row (slice 4). Such a
component may also own a store the shared writer cannot reach, and then it writes
as a panel does; what it never does is put a value in the record, which nothing
would hydrate.

Label and description come from the declaration. Validation messages come from
the value type's `validate()`, which already returns the `Rendered` text the
agent is shown, so a control stops carrying its own bounds and placeholders (P8).

**Content that is not a setting stays hand-placed and needs no schema** (P12). A
tab file is still a React component; it puts `<DeclaredSettings/>` and the update
panel or the enforcement warning where it wants them.

The renderer also takes `rowNotes`, keyed by **setting**: derived status that
reports on the row above it, which a section's prose cannot be because it renders
above the whole group (slice 4 — the key a dictation provider still needs, and
whether transcript cleanup can run).

Slice 1 found one shape that needs more than "around the block": prose that
belongs to a **section** rather than to any one declaration — Advanced's *"Saved
for this browser…"* under Conversation, and the sentence explaining what a
notification is for. The renderer therefore takes a `notes` map keyed by section
name, and the tab supplies it. That stays P12 rather than a declaration field:
the words are in the tab file, and the first of them says in the code today that
it is deliberately **not** part of the setting's description, because it is about
the browser rather than about what the setting does and the agent has no use for
it.

## 5. Components

```ts
component: "services-panel"
```

A registry maps the name to a React component
(`src/client/components/Settings/components/registry.ts`, slice 2), which
receives the setting's **key** and resolves its own value through `useSetting` —
one prop rather than two, and the same hook every generated control uses, so
there is no second way for a component to read or write. Custom is presentation;
the declaration and the destination are the same ones every row uses (req 3).

A declaration naming a component is a generated row whatever its value kind: what
the control table has no control for is exactly what a component is for. The
memory budget is the first, and it is why the Advanced tab's number row is a row
at all (P4).

**A component named by several declarations renders once, at the first of them,
and names its own keys** (slice 4). The prop is the one key a single-setting
component needs; a component that owns several has to know which is which — the
TTS trio is a provider, a voice and a speed — so a positional list would put that
decision in the catalogue file instead.

Nine panels own the 34 addressed fields between them (P11) — one of which,
`keyboard.keybindings`, has a fixed item set rather than a user-created one and
is still a component, for the four reasons P16 gives. Five small components cover
eight declarations: the memory budget (P4), the webhook pair (P9), the TTS
provider, voice and speed together (P3, P7), hands-free (P3), and the repository
colour picker.

## Slices

Each is one pull request. **A slice names the declarations it generates and the
ones it leaves hand-written** (P18) — it never converts a whole tab and hopes the
rest follows, because a control whose support has not landed either duplicates an
existing one or renders a row that cannot save.

1. **The spine, on Advanced's toggles.** The value record with its browser codec
   (P17), `useSetting` / `saveSetting` for `credential-store` and `browser`
   scalars, the control table for `bool`, `section`. Generates the six server
   toggles and three browser toggles on Advanced. Explicitly left alone: the
   memory budget, the release channel, and the update panel around them.
2. **Routes and the rest of Advanced.** The `own-route` store shape (P2), then
   the release channel — including removing the duplicate control from the update
   panel — the memory-budget component (P4), and `network.egressContained`.
   Shipped with two things the design had not settled. **The release channel got
   a `section`, and moved to the front of the catalogue's Advanced block**: its
   own row is useless three sections away from the Check-for-Updates button that
   acts on it, so the update panel became the Software Updates section's `note`
   and the channel renders beneath it (req 11 — order comes from the
   declaration, and this is what moving the declaration is for). **The
   enforcement warning on the Network tab now reads the setting's value rather
   than the egress store's copy of it**: the two agree, and reading one of them
   is what stops them disagreeing for the round trip after a change. What slice 2
   gave up with the hand-written channel control: it can no longer be disabled
   while an update applies, and a failed switch reports through the shared toast
   instead of the panel's own error line.

   **One route had to change, because a shared writer reads a status code
   literally.** `POST /api/updates/channel` stored the channel and then answered
   the *update check's* error — 503 — on the reasoning that its caller wanted an
   update status. Its caller is now the shared writer, which reads any non-2xx as
   "the write did not land" and rolls the control back: the user would have been
   shown the old channel with the new one stored (docs/299 req 4). It answers 200
   once the write has landed, with `checkError` carrying why there is no status.
   **The update panel re-checks when the channel moves**, which is what keeps the
   changelog and the downgrade warning beside the choice that produced them now
   that the write's own answer is not read; and it keeps an answer only while the
   selection has not moved since it asked, because both orderings happen.
3. **Instructions and Git.** The textarea rule and the instruction conflict state
   (P14), and the git identity control.

   **P14 is decided, and it is neither of the two shapes the design offered.**
   The conflict notice is not a declared capability and does not need a component:
   it falls out of **being an explicit-commit row**. Such a row has a draft and a
   seed, and comparing the two against the stored value answers both halves — an
   untouched box adopts a value that moved underneath it, an edited one keeps the
   draft and says so. A declaration field would have had exactly one user, which
   requirement 5 refuses; a component would have been custom presentation for
   something that is not presentation at all.

   **And the instruction boxes are NOT the first shared component** — the dedup
   slice 2 deleted stays deleted, and the webhook pair in slice 4 still decides
   it. They are two ordinary `text` rows; what makes their Save one write is that
   the Save belongs to the tab. That also gave the control table its `text` entry,
   which a shared component would have left with no user at all.

   Knowingly given up, all of it on the Instructions tab: **Save no longer closes
   the dialog** (it says "Saved", as the git identity and the memory budget
   already did; Cancel and the close button still close it), the two boxes **lost
   their placeholders** (per-setting copy a generated control cannot hold — the
   declared description carries the same guidance), and **switching to the tab no
   longer focuses the first box** (it was a `ref` the dialog passed into the
   hand-written textarea). The built-in-instructions toggle moved to the bottom of
   the tab, because the disclosure that belongs under it is chrome and a `note`
   renders above a section (req 11).

   One more thing the slice found: **the git identity had two write paths**, the
   declared `PUT /api/settings` and `POST /api/settings/git-identity`. The dialog
   now uses the declared one, and the route keeps its other callers.

   Gained rather than given up: an unsaved git edit now survives a tab switch,
   because the draft outlives the control that holds it.
4. **Voice.** The remaining browser values, the TTS component (P3, P7), the
   hands-free component (P3), the provider-key list (P11), the webhook pair (P9),
   and the webhook becoming always visible (P13).

   **The shared component is decided, and it is both halves of the question at
   once.** The webhook's URL and token are one credential written in one request
   and declared as two settings, so the store became a machine-readable
   **address** — both declarations name the same `own-route` `path` and `method`
   and differ only in the `bodyField` they occupy — *and* `commitSettings` takes
   its destination **from the declarations** instead of assuming the settings
   payload. Neither half works alone: prose could not have produced the request,
   and a commit hard-coded to `PUT /api/settings` could not have sent it. What it
   buys is exactly requirement 3: the component's Save names two keys and no
   path, no method and no payload field. The read follows the same contract — one
   GET per **address**, whose answer carries a field per setting, so
   `GET /api/voice/webhook` answers `{ url }` and nothing answers the token,
   which is what `configuredOnly` already said about it. A field the answer omits
   leaves the record alone, on both the read and the commit.

   **What it did NOT need is a commit that fans out across destinations.** The
   first cut grouped entries by address and reported partial success; review
   asked what would notice if that went, and nothing would — every commit that
   exists targets one address. So a commit resolves one destination, refuses a
   caller that mixes two by name, and sends one request (req 5). "One
   destination" is not "a hard-coded destination", and conflating them is what
   made the fan-out look necessary.

   **A component that owns several declarations renders once, at the first of
   them, and names its own keys.** The dedup slice 2 deleted comes back because
   two Saves over one credential is what the second render would be. The keys
   are NOT passed in as a list: the TTS component has to know which of its three
   is the provider, which the voice and which the speed, so a positional list
   would decide that in the catalogue file. The registry's one prop stays what a
   single-setting component needs, and a component that does not need it takes no
   props.

   **A component may own a declaration the shared value machinery cannot hold.**
   `voice.providerKey` is addressed by a provider and its write carries a second
   body field, so the list that repeats it keeps its own writer, as a panel does
   — and it is a generated row because it names a component, not in spite of its
   address (P11). What it must not do is enter the value record: nothing would
   hydrate it, and the reader prefers the record to the named field. So
   membership of the record is narrower than membership of the rows.

   **An explicit commit is a tab's — unless one component owns every half of it.**
   The webhook's Save is the component's, because it saves both halves of one
   credential to one address; a `DeclaredCommit` at the foot of the tab would
   have been a Save far from the boxes it saves, and a second one beside them.
   The rule slice 3 wrote still holds for the case it was written for: a Save
   that spans two independent rows belongs to the tab.

   **A choice is cards or a select, decided by the declaration** (req 5): cards
   exist to carry an option's own sentence, so an option set that declares
   descriptions gets cards and one that does not gets a select. That leaves the
   release channel on cards and puts the two provider lists, the dozen dictation
   languages and the delivery mode on selects, with no new field and no threshold
   anyone has to maintain. It is VS Code's answer (req 6) with one exception,
   taken only where there is something to spend the room on.

   **The renderer gained `rowNotes`, keyed by setting rather than by section.**
   Slice 3 found that a section `note` renders above its rows and left it with
   one user; this tab has two lines that report on the row *above* them — the key
   the chosen dictation provider still needs, and whether transcript cleanup can
   run at all. Both are derived status rather than copy, so P12 holds: they stay
   in the tab file.

   **Order changed, and one part of it could not be chosen** (req 11). The tab
   reads Voice notes → Provider API keys → Voice input (dictation) → Voice
   playback. A section is placed where its first declaration is, and
   `voice.deliveryMode` is a payload setting in `GLOBAL_SETTINGS`, which is the
   first source in the registry — so the Voice notes section leads whatever the
   other files say. Moving the declaration across files would have changed the
   derived `GlobalSettings` payload types, and reordering the registry's sources
   would have moved rows on other tabs and in `shipit settings list`. Neither is
   worth it: requirement 11 accepts the order that falls out.

   **A commit is sequenced by the writer, not by the button** (found in review).
   Slice 3's rule was that `DeclaredCommit` is disabled while its write is in
   flight, and that is a component's state: switching tabs re-mounts the button
   enabled while the request is still out, so two commits of one address overlap
   and the older answer can put the older value in the record with the server
   holding the newer. `commitSettings` now keeps a module-level sequence per
   destination, exactly as `saveSetting` does per setting, and an answer that is
   not the newest moves nothing.

   **A draft settles against what was SENT, so the component must not normalise**
   (found in review). Trimming the token before the commit sent `"secret"` while
   the draft still held `" secret "`; settling read that as typing since the save
   and left a stored credential in the password box, which the next save would
   send again instead of the blank that keeps the stored one. The route trims and
   the record takes what it echoed — normalisation belongs to the writer.

   **Removing settles rather than drops** (found in review). The first cut
   discarded both drafts outright when the DELETE landed, which erased a
   replacement typed while it was in flight. It now settles the values that were
   on screen when Remove was pressed, so a box typed in since keeps what was
   typed — the same rule every other write follows.

   **A webhook write broadcasts `settings_changed`** (found in review). The old
   tab re-read the webhook status whenever it mounted, so switching tabs picked
   up another browser's change; the generated row reads on the global-settings
   refresh instead, and this route raised no such event. Broadcasting covers
   strictly more than the mount-fetch it replaces: every open viewer re-reads,
   not just one that left the tab and came back.

   Knowingly given up: the webhook's hand-written sentence about the POST body
   (it moved into `voice.webhook.url`'s declared description, so the agent reads
   it too) and its `Configured → <url>` line (the URL box shows the URL);
   `voiceWebhookConfigured` as a store field (a webhook exists exactly when a url
   is stored, and the url is read back, so the second fact was the first one
   twice); and `GET /api/voice/webhook/status`, replaced by the own-route
   `GET /api/voice/webhook` that answers the same thing under the declared field.
   One more, and it is a **correction** rather than a loss: the old speed
   accessor accepted any finite number above zero, so a stored `"9"` read back as
   9; going through `numeric.read` answers the declared default for anything
   outside `[0.25, 4]`. Nothing the dialog or the play button ever offered is
   outside that range, so no selection a user made is affected.

   Two limitations this slice inherits and does not fix, both stated so they are
   not read as new: the scalar writer's rollback is still wrong for an older
   request succeeding after a newer one failed (slice 1 recorded it, and
   `voice.deliveryMode` now rides it), and two concurrent own-route reads can
   still leave the older answer in the record, because the guard compares the
   value rather than ordering the requests (slice 2).
5. **Integrations.** The two credential rows over their declared routes (P2, P10)
   and `autoCreatePr` becoming always visible (P13).

   **The control table was wrong about this row, and the build says so.** It
   promised a generated control for "`text` whose dialog value is write-only".
   There is none, and neither credential could have used one — three separate
   reasons, each fatal on its own. **The write has client-side effects** (P3):
   GitHub's answer carries the account *and* the repositories the Add Repository
   dialog lists, Linear's carries the teams the token reaches and the reason a
   refused token was refused, and a generated row's writer awaits the response
   and does nothing else. **Removing is a second address** —
   `POST /api/github/logout`, `POST /api/trackers/linear/disconnect` — which no
   value write expresses, exactly as the webhook's DELETE did not. And **being
   configured is not the value**: nothing reads either token back, so what the
   card shows is the CONNECTION, which a generated control has no way to learn.
   So both are components, and what the slice actually delivers is req 3 — one
   declaration, one destination, custom presentation. The control table's
   credential-row entry is deleted rather than left as a promise.

   **`own-route` gained one field, and it is the honest half of the read
   contract.** "The read is a GET of the same path" holds where a value is read
   back; a credential the path never answers has no read to make, and saying so
   is what keeps it out of the value record — where it would otherwise sit at
   its declared default for ever while `refreshOwnRouteSettings` asked a path
   with no GET on every settings refresh. `writeOnly: true` is that, with two
   users, both real (req 5). It is emphatically **not** `emits:
   configuredOnly()`: that is the agent's projection, and `voice.webhook.url`
   carries it while being read back in full — which is the distinction
   `inventory.md` → *Four kinds of control* already drew and the control table
   had blurred.

   **A component builds its request from the declaration too**, so the request
   builder moved from the writer into `setting-values.ts` as `settingRequest`.
   The shared writers discard the response; a connection's card is made of it.
   That is what lets both components — and `submitGitHubToken`, which the
   first-run gate shares — name no path, no method and no body field.

   **Order changed, by the same mechanism as the Voice tab's** (req 11).
   `integrations.autoCreatePr` is a payload setting in `global-settings.ts`, the
   first source in the registry, so its *Pull requests* section leads the tab —
   above the *Connected services* section it depends on. Moving that declaration
   would change the derived `GlobalSettings` payload types, so requirement 11
   takes the order that falls out.

   What a disconnected GitHub actually gated, checked before moving the row out
   of it: the connected card's own chrome — the account name and Disconnect,
   which genuinely need a connection — and `integrations.autoCreatePr`, which
   did not. Nothing else lived in that branch.

   **What review found, all of it about the credential the row now KEEPS on
   screen.** The old card swapped the token form for the connected view, so
   success unmounted the box; a row that can replace a credential keeps the box,
   and three defects followed from that alone. **A stored token stayed in the
   password input** — and survived a disconnect — because the form had never had
   to clear one. **Replace and Disconnect could overlap**, which is two writes
   over one credential: a validation landing after a logout stores a token the
   user has just removed, and a connect answering late puts a connection back on
   screen that the server no longer holds; they are one card's state, so
   disabling each other is the whole fix. And **a token typed during a save was
   erased** by the clear that followed it, on both rows — so clearing now takes
   the value that was SENT, which is the rule slices 3 and 4 already settled for
   every other write here. One more, inherited rather than introduced: the
   Linear status read applied its answer unconditionally, so a read that began
   before a replacement could report the old credential's teams, or "not
   connected" over a connection that had just succeeded. A write invalidates a
   read in flight, as slice 2 does for the own-route reads.

   Subtraction it asked for and this took: the two "renders the declaration's own
   copy" assertions (requirement 12 gives that guarantee up rather than
   replacing it), the exact three-key roster of the tab's generated rows (a
   second list to edit, and `setting-values.ts`'s full roster already holds it),
   the duplicated always-visible assertion, and `service-marks.tsx` — the tile
   belongs to the card and the logo beside its one consumer.

   Knowingly given up: the *Connected services* header's `· managed by ShipIt`
   hint (a generated section heading has no hint slot, so the sentence moved
   into the section's `note`), and both cards' hand-written headings and
   paragraphs (they render the declared label and description now, which is what
   put both keys in `EXPLAINED_IN_THE_DIALOG`). Gained rather than given up: a
   **refused GitHub token now says so in the dialog** — its caller returned
   `undefined` whatever happened, so only the first-run gate ever reported one —
   and either credential can be **replaced without disconnecting first**, which
   is the "replace" the control table described and neither card had.
6. **Panels.** Register the nine as components and bind them to their
   declarations; they keep their own writers and operations.
7. **Project Settings** (req 10) — the second dialog, its repo-scoped write, the
   colour picker and the secrets panel.
8. **Cleanup.** Delete `settings-coverage.test.tsx` and the `data-setting`
   attribute (req 12). The walk proves three things and generation replaces one;
   the other two are given up knowingly, and the loss is bounded to the 42
   declarations the panels and components own (P15).

Until a tab joins `GENERATED_TABS`, its values are read through their named store
fields and written by those fields' own setters (P18) — hydration walks the
declarations for the rows the record holds, and reaches nothing else. Slice 1 made that rule explicit rather than
a convention: `GENERATED_TABS` in `src/client/stores/setting-values.ts` names the
tabs whose rows are generated, and so exactly which settings the record holds. A
tab joins that list in the slice that moves its hydration, and a setting the
record does not hold is still read through its named field — which is what keeps
`integrations.autoCreatePr` and `instructions.agentInstructionsEnabled` working
on the same reader while their tabs wait for slices 5 and 3.

## Key files

| File | Role |
|---|---|
| `src/server/shared/settings-catalogue/types.ts` | the declaration; gains `section`, `component`, and the `own-route` address |
| `src/client/components/Settings/declared-setting.ts` | today's boolean reader and writer — generalised into `useSetting` / `saveSetting` |
| `src/client/components/Settings/declared.tsx` | the low-level controls a generated one is built from |
| `src/client/components/Settings/declared-controls.tsx` | the control table: what each value kind gets |
| `src/client/components/Settings/DeclaredSettings.tsx` | the renderer: the section grouping, `notes`, the component lookup |
| `src/client/components/Settings/DeclaredCommit.tsx` | a tab's Save: every edited row on it, in one write |
| `src/client/stores/setting-values.ts` | which settings the record holds, the browser codec (P17), the named fields each one mirrors (P1), where an own-route row is written and read (P2) |
| `src/client/stores/setting-hydration.ts` | the payload read and the own-route read, both walking the declarations |
| `src/client/components/Settings/components/registry.ts` | the components a declaration may name |
| `src/client/components/Settings/components/VoiceWebhook.tsx` | the first component two declarations share: one credential, one address, one Save |
| `src/client/components/Settings/components/GitHubConnection.tsx` | the GitHub credential row: the declared address, the account, and a remove at an address of its own |
| `src/client/components/Settings/components/LinearCredential.tsx` | the Linear credential row: the same shape, with the teams the token reaches as its status |
| `src/client/components/Settings/components/ConnectedServiceCard.tsx` | the frame both share — mark, declared words, badge, status |
| `src/client/stores/setting-values.ts` → `settingRequest` | the request a declaration produces, for the writers AND for a component that needs the answer |
| `src/client/components/Settings/components/VoiceTts.tsx` | provider, voice and speed together, because changing the first repairs the other two (P3, P7) |
| `src/client/components/Settings/components/VoiceHandsFree.tsx` | the toggle that arms audio inside the click gesture (P3) |
| `src/client/components/Settings/components/VoiceProviderKeys.tsx` | the addressed key list, which keeps its own writer as a panel does (P11) |
| `src/client/voice/voice-key-status.ts` | which speech providers have a key: one fact, three readers, and a component takes no props to pass it by |
| `src/client/components/Settings/tabs/UpdatePanel.tsx` | the Software Updates chrome, placed as that section's note (P12) |
| `src/client/components/Settings/setting-binding.ts` | `data-setting`; deleted in slice 8 |
| `src/client/components/Settings/settings-coverage.test.tsx` | the walk; deleted in slice 8 (P15) |
| `src/client/stores/settings-store.ts` | gains the value record and the draft record; the named fields become views over the first |
| `src/client/utils/local-storage.ts` | loses its 13 accessor pairs for settings; keeps the legacy keybinding fallback (P17) |

## What stays exactly as it is

The agent's half (req 8). `emits`, `propose`, the projection, the refusal
reasons, `LIVE_DETAILS`, the proposal card and `shipit settings` are untouched —
this feature is client-side, and the declaration it reads is the same one it
reads now. The **stored-shape** maps (`MCP_SERVER_FIELD_SETTINGS` and its
siblings) also stay: they catch a stored field nobody declared, which is the
opposite direction from the walk, and they are compile errors rather than tests
(P15).
