# ShipIt private planning — checklist

Nothing past "Cleared" has run. The planning repository holds only the
reachability probe (`planning#1`, closed) and the labels that probe minted.

## Cleared

- [x] Settle the repository and the tracker name. *(`nikzlabs/shipit-planning`, declared as `planning` — req 1.)*
- [x] Confirm whether "fully retire Linear" is scoped to ShipIt's own planning or extends to removing Linear support from the product. *(Answered by 248 req 3: `linear` is a declared kind, so support stays in the product and ShipIt retires it for itself by not declaring it.)*
- [x] Create `nikzlabs/shipit-planning` and confirm the deployment's GitHub credential reaches it (req 5). *(Verified live: list, labels and statuses all answer, and a create + comment + close round-tripped.)*
- [x] Land, release and **deploy** [248](../248-declared-issue-trackers/checklist.md)'s rework, then re-probe from a fresh session. *(The deployed shim takes `--tracker NAME`, requires one on `create`, and fails closed on an undeclared name.)*
- [x] Declare the planning tracker in `shipit.yaml`. *(Landed on `main` in its own PR, split out so the tab appeared without waiting on this doc's review.)*
- [x] Settle how much of a Linear issue survives the copy. *(Workflow states collapse — req 8; the issue's original creation date is recorded in its body — req 9.)*

## Migration

- [ ] Confirm the two fixes on `main` (`9b031908`) have reached the **deployed** shim: a large issue piped to `wc -c` returns its full length rather than 65,536, and `shipit issue view … --json` includes `createdAt`. The export depends on both.
- [ ] Export all 322 Linear issues with comments, redirected to files, outside the git workspace.
- [ ] Create the corpus's 20 labels with their Linear colors, plus the four `priority: …` labels that carry priority across.
- [ ] **Pilot** — copy one issue with a long body, several comments, an internal cross-reference, a label and a priority, then stop. **Human gate 1** (plan.md → *Where a human has to look*): the comment format is settled for good here, since comments can't be edited or deleted through the shim afterwards.
- [ ] Sync to the latest `main` before the copy starts, so the mapping and the sweep apply to a current tree.
- [ ] **Pass A** — create all 322 issues in **ascending key order** (req 12), strictly sequential and halting on a failure rather than skipping it, with titles, labels, and bodies carrying their `SHI-N` origin and original creation date (req 9). Cross-references stay unrewritten. Append each assigned number to the `SHI-N → planning#M` mapping as it comes back, so the mapping is complete and observed when the pass ends.
- [ ] **Human gate 2** — after Pass A, before anything reads the mapping: 322 issues present, a spot-check against their Linear originals, the list in ascending key order, the mapping complete and duplicate-free. A wrong mapping propagates into 667 files.
- [ ] **Pass B** — replay the 1,344 comments with their original dates, and edit the 322 bodies to rewrite their 1,146 internal `SHI-N` cross-references and 120 `linear.app` URLs. Comment bodies cannot be edited afterwards, so a comment's cross-references must be correct when it is posted. Tracker writes only — no diff, no PR.
- [ ] Verify a full round trip in the UI: the tab, an issue with comments, a write, and Undo.
- [ ] Teach `remarkLinkifyIssues` the name form ([SHI-323](https://linear.app/shipit-ai/issue/SHI-323)) before the sweep — `planning#57` matches nothing today, so inline badges in chat prose would break the moment references are rewritten.
- [ ] Rewrite every reference in this repository from the mapping, in one PR, when nothing else is in flight (req 10). **Human gate 3** — review the diff by category (frontmatter, code comments, prose, fixtures), watching for `SHI-N`-shaped text that isn't a pointer: 2,623 mentions across 667 files, 186 doc `issue:` pointers, 221 files with `linear.app` URLs. Use `grep -a` — one source file is flagged binary and would otherwise be skipped. The migration's only diff.
- [ ] Retire Linear for ShipIt's own planning. **Human gate 4** — confirm nothing still depends on it; recoverable by re-declaring. Drop the `roadmap` declaration, and rewrite all seven places `CLAUDE.md` names Linear as the destination — lines 306, 326, 328, 329, 333, 340, 342, spanning three sections, not just the tracker-sync one (req 11). Prefer tracker-neutral wording; name `planning` only where a destination must be named.
- [ ] Delete `planning#1` and the pilot issue.

## Found here, fixed elsewhere

- [x] The `shipit` shim truncated piped stdout at 64 KiB — it exited without draining, so any agent running `shipit issue view … --json | jq` on a large issue silently got a cut-off document. Fixed on `main` in `9b031908` (`shim-exit.ts` flushes before exit); not yet in the deployed shim.
- [x] `trackers/linear/adapter.ts`'s `ISSUE_FIELDS` did not select `createdAt`, so an issue's creation date was unreadable — which req 9 requires. Fixed in the same commit; not yet in the deployed shim.
- [ ] `shipit issue list` on Linear queries `first: 100` with no pagination. It no longer blocks the export, which walks keys individually, but the limit stands.
- [ ] `CLAUDE.md` lines 306 and 329 describe behaviour docs/248 deleted — a bare `create` no longer defaults to Linear, and `issue:` should be written in the name form ([SHI-324](https://linear.app/shipit-ai/issue/SHI-324)). Wrong today, independent of the migration.
- [ ] Inline chat badges don't recognize the name form ([SHI-323](https://linear.app/shipit-ai/issue/SHI-323)) — in progress.
