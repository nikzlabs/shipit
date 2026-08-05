# Declared issue trackers — checklist

Ordered by dependency: config shape first, then the registry it feeds, then
resolution, then the surfaces that consume it. See [plan.md](./plan.md) for why
each item is where it is.

## Decided

- [x] **How an unresolvable or ambiguous reference renders** — it stays what it already was and never becomes an in-app link: a markdown href keeps its external link, a doc/PR chip renders a static badge, a bare key in prose stays plain text, and the CLI reports the failure with the declared names listed.
- [x] **Whether a tracker name may collide with a GitHub owner name** — allowed, no warning. The slash makes `acme#3` and `acme/planning#3` un-collidable in the grammar, and ShipIt cannot check GitHub's owner namespace anyway.

## Config shape

- [x] Add `name` to an `issues.trackers` entry: required, unique per repository, warn-and-skip on a duplicate (reqs 2, 6).
- [x] Extend the persisted issue-write card to record both the tracker **name** it was written with and the **resolved destination** — the name so a re-point re-targets it (req 16), the destination so an undeclared target stays undoable (req 11). *No migration was needed after all: the card is a JSON blob in the existing `issue_write` column, so the rework touches no database schema.*
- [x] Add `kind: linear`, identified by its team key (reqs 3, 5).
- [x] Update `shipit-docs/shipit-yaml.md` for both.

## Registry

- [x] Build the registry from the declarations plus the session's own repository, instead of always constructing a Linear tracker from `CredentialStore` (req 1).
- [x] Take `LinearTracker`'s team from its declaration; support two Linear declarations on different teams.
- [x] Retire `getLinearTeam` / `setLinearTeam` and the stored `linear.team` field; Settings keeps the token (req 4).
- [x] Remove the team picker from `SettingsTrackers.tsx`; keep `listLinearTeams` as a lookup for writing a declaration.
- [x] Drop the self-declaration skip in `buildTrackerRegistry`, without producing a duplicate tab (req 12).
- [x] Delete the `get()` synthesizer so `get()` and `list()` agree — an address naming no declared tracker must fail closed (req 11).
- [x] Keep Undo resolvable against an undeclared destination (req 11's carve-out): give the Undo path its own resolution rather than routing it through the narrowed `get()`.

## Resolution

- [x] Add a resolver layer above `parseIssueRef`, keeping that parser pure and context-free. Req 11's fail-closed and ambiguity rules live in the resolver, not at each caller.
- [x] Resolve all three forms: `name#123`, `name#SHI-304`, and each backend's canonical address (req 10).
- [x] Give each `kind` its canonical-address format, so a backend added later brings its own instead of being special-cased in the parser.
- [x] Route the eight current `parseIssueRef` call sites through the resolver — `tracker-link.ts`, `DocsViewer.tsx`, `FrontmatterHeader.tsx`, `pr-issue-refs.ts`, `shipit-issue.ts` (×3), `issue-lifecycle.ts`.
- [x] Feed the client resolver from the store that already holds the tracker list, rather than adding a second fetch.

## Emitting references

- [x] Add one formatter and call it from both reference producers — `parseIssueRef`'s branches and `github/adapter.ts`'s `${owner}/${repo}#${number}` — so a name renders wherever the destination has one (req 15).
- [x] Instruct the agent to write the name form (req 15). Prompt composition, not a code path: the text belongs in the `.md` fragment, per this repo's prompt rules.

## CLI and errors

- [x] Replace `--repo` with addressing a tracker by name, and remove the `"linear"` fallback passed to `resolveTrackerFlag` by both `issue create` and `label create` (reqs 1, 12).
- [x] Require an explicit destination on `create` — no default, no unnamed fallback to the session's own repository (req 13).
- [x] Surface declaration warnings in `shipit` CLI output (req 8) — they currently reach only a `service-manager-setup.ts` chat message and `diagnostics.ts`.
- [x] Surface resolution and reachability failures where the operation started: inline in the Issues UI for a user action, CLI output for an agent action (req 19).
- [x] Update `shipit-docs/issues.md` for name addressing.

## Tests

- [x] A repository declaring nothing has only its own GitHub Issues, and no Linear tab — including a deployment that still has a stored Linear team, which is a clean break with no migration.
- [x] A bare `create` is rejected rather than filing into the session's own repository (req 13).
- [x] Undo still works on a card whose destination is no longer declared (req 11), and follows the new destination when its name was re-pointed (req 16).
- [x] `kind: linear` declared, including two teams at once.
- [x] Each of the three reference forms resolves, in the UI highlight and in the CLI.
- [x] A canonical address naming an undeclared destination fails closed; an ambiguous reference fails rather than resolving to one match.
- [x] A self-declaration produces a name without a duplicate tab.
- [x] A name re-pointed at a different destination re-targets an existing recorded card (req 16).
- [x] ShipIt-emitted references carry the name form (req 15).
- [x] Declaration warnings and resolution failures appear in CLI output (reqs 8, 19).
- [x] The shipped two-repository `#42` fixture still passes — the regression guard for the routing invariant that carries over.
- [x] Live run against two real GitHub repositories through the dogfood inner ShipIt — routing, req 13, req 15, fail-closed, ambiguity, self-declaration, the Undo carve-out and declaration warnings all confirmed end to end. Linear stays fake-only. See plan.md → *Live run against two real repositories*.

## Carries over unchanged

Listed so absence is not mistaken for oversight: `tracker-id.ts`'s qualified-id
vocabulary, the per-request `shipit.yaml` read in `resolveGitHubTrackerContext`,
`accessError()`'s missing-vs-inaccessible wording, `issue-lifecycle.ts`'s
pointer-derived destinations, `seedFromIssueRef`'s pointer-only branch names
(req 22), and the `kind`-discriminated parse that warns and skips rather than
failing a session (req 7).

## Settled earlier

- [x] Reference syntax for Linear — all three forms are recognized (req 10).
- [x] Whether GitHub's `owner/repo#42` stays recognized — generalized to every backend's canonical address format (req 10).
- [x] The break with existing behavior — accepted (req 20).
- ~~`issues.default`~~ — superseded. Req 1 removes implicit destinations, so `shipit issue create` has no fallback left to point anywhere.

## Open — found during implementation, not closed here

Each is filed; the tracker holds their status from here.

- [ ] **Requirement 22 is not held on the in-app path.** ([SHI-320](https://linear.app/shipit-ai/issue/SHI-320)) The Issues tab's "Start
  session" pre-fills the chat instead of calling `seedFromIssueRef`, so the
  session's first message carries the issue **title** and the AI branch-namer
  derives the pushed branch from it. Pre-existing (docs/236 reshaped that flow);
  closing it means pinning the branch — or suppressing the branch rename — for a
  session started from an issue. See plan.md → *Requirement 22 is not actually
  held on the in-app path*.
- [ ] **The seed-time → started transition does not fire from the Issues tab**
  either, for the same root cause: the session carries no `issueRef`.
  `shipit-docs/issues.md` still promises it. (Same root cause, filed with the
  above as [SHI-320](https://linear.app/shipit-ai/issue/SHI-320).)
- [ ] **The browser's declaration view can go stale.**
  ([SHI-321](https://linear.app/shipit-ai/issue/SHI-321)) `fetchTrackers` runs on
  session change and on Issues-tab activation, so editing `shipit.yaml` with the
  tab already open doesn't re-resolve names until one of those happens. The
  server reads the file per request, so only the client is affected.

## Follow-on

- [ ] `shipit issue list` on Linear queries `first: 100` with no pagination, so it cannot enumerate a tracker larger than that. Out of scope here; blocks [247](../247-shipit-private-planning/checklist.md)'s export step.
