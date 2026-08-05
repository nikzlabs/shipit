# Declared issue trackers — checklist

Ordered by dependency: config shape first, then the registry it feeds, then
resolution, then the surfaces that consume it. See [plan.md](./plan.md) for why
each item is where it is.

## Decide first

- [ ] How an unresolvable or ambiguous name renders — fail closed and stay legible, never a broken link (req 11).
- [ ] Whether a tracker name may collide with a GitHub owner name, given `owner/repo#42` and `name#123` are distinguished only by the slash. No real ambiguity in parsing; this is about whether to warn.

## Config shape

- [ ] Add `name` to an `issues.trackers` entry: required, unique per repository, warn-and-skip on a duplicate (reqs 2, 6).
- [ ] Extend the persisted issue-write card to record both the tracker **name** it was written with and the **resolved destination** — the name so a re-point re-targets it (req 16), the destination so an undeclared target stays undoable (req 11). Card schema + migration; the only database change in the rework.
- [ ] Add `kind: linear`, identified by its team key (reqs 3, 5).
- [ ] Update `shipit-docs/shipit-yaml.md` for both.

## Registry

- [ ] Build the registry from the declarations plus the session's own repository, instead of always constructing a Linear tracker from `CredentialStore` (req 1).
- [ ] Take `LinearTracker`'s team from its declaration; support two Linear declarations on different teams.
- [ ] Retire `getLinearTeam` / `setLinearTeam` and the stored `linear.team` field; Settings keeps the token (req 4).
- [ ] Remove the team picker from `SettingsTrackers.tsx`; keep `listLinearTeams` as a lookup for writing a declaration.
- [ ] Drop the self-declaration skip in `buildTrackerRegistry`, without producing a duplicate tab (req 12).
- [ ] Delete the `get()` synthesizer so `get()` and `list()` agree — an address naming no declared tracker must fail closed (req 11).
- [ ] Keep Undo resolvable against an undeclared destination (req 11's carve-out): give the Undo path its own resolution rather than routing it through the narrowed `get()`.

## Resolution

- [ ] Add a resolver layer above `parseIssueRef`, keeping that parser pure and context-free. Req 11's fail-closed and ambiguity rules live in the resolver, not at each caller.
- [ ] Resolve all three forms: `name#123`, `name#SHI-304`, and each backend's canonical address (req 10).
- [ ] Give each `kind` its canonical-address format, so a backend added later brings its own instead of being special-cased in the parser.
- [ ] Route the eight current `parseIssueRef` call sites through the resolver — `tracker-link.ts`, `DocsViewer.tsx`, `FrontmatterHeader.tsx`, `pr-issue-refs.ts`, `shipit-issue.ts` (×3), `issue-lifecycle.ts`.
- [ ] Feed the client resolver from the store that already holds the tracker list, rather than adding a second fetch.

## Emitting references

- [ ] Add one formatter and call it from both reference producers — `parseIssueRef`'s branches and `github/adapter.ts`'s `${owner}/${repo}#${number}` — so a name renders wherever the destination has one (req 15).
- [ ] Instruct the agent to write the name form (req 15). Prompt composition, not a code path: the text belongs in the `.md` fragment, per this repo's prompt rules.

## CLI and errors

- [ ] Replace `--repo` with addressing a tracker by name, and remove the `"linear"` fallback passed to `resolveTrackerFlag` by both `issue create` and `label create` (reqs 1, 12).
- [ ] Require an explicit destination on `create` — no default, no unnamed fallback to the session's own repository (req 13).
- [ ] Surface declaration warnings in `shipit` CLI output (req 8) — they currently reach only a `service-manager-setup.ts` chat message and `diagnostics.ts`.
- [ ] Surface resolution and reachability failures where the operation started: inline in the Issues UI for a user action, CLI output for an agent action (req 19).
- [ ] Update `shipit-docs/issues.md` for name addressing.

## Tests

- [ ] A repository declaring nothing has only its own GitHub Issues, and no Linear tab — including a deployment that still has a stored Linear team, which is a clean break with no migration.
- [ ] A bare `create` is rejected rather than filing into the session's own repository (req 13).
- [ ] Undo still works on a card whose destination is no longer declared (req 11), and follows the new destination when its name was re-pointed (req 16).
- [ ] `kind: linear` declared, including two teams at once.
- [ ] Each of the three reference forms resolves, in the UI highlight and in the CLI.
- [ ] A canonical address naming an undeclared destination fails closed; an ambiguous reference fails rather than resolving to one match.
- [ ] A self-declaration produces a name without a duplicate tab.
- [ ] A name re-pointed at a different destination re-targets an existing recorded card (req 16).
- [ ] ShipIt-emitted references carry the name form (req 15).
- [ ] Declaration warnings and resolution failures appear in CLI output (reqs 8, 19).
- [ ] The shipped two-repository `#42` fixture still passes — the regression guard for the routing invariant that carries over.

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

## Follow-on

- [ ] `shipit issue list` on Linear queries `first: 100` with no pagination, so it cannot enumerate a tracker larger than that. Out of scope here; blocks [247](../247-shipit-private-planning/checklist.md)'s export step.
