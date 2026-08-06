# ShipIt private planning — checklist

Nothing past "Cleared" has run. The planning repository holds only the
reachability probe (`planning#1`, closed) and the labels that probe minted.

## Cleared

- [x] Settle the repository and the tracker name. *(`nikzlabs/shipit-planning`, declared as `planning` — req 1.)*
- [x] Confirm whether "fully retire Linear" is scoped to ShipIt's own planning or extends to removing Linear support from the product. *(Answered by 248 req 3: `linear` is a declared kind, so support stays in the product and ShipIt retires it for itself by not declaring it.)*
- [x] Create `nikzlabs/shipit-planning` and confirm the deployment's GitHub credential reaches it (req 5). *(Verified live: list, labels and statuses all answer, and a create + comment + close round-tripped.)*
- [x] Land, release and **deploy** [248](../248-declared-issue-trackers/checklist.md)'s rework, then re-probe from a fresh session. *(The deployed shim takes `--tracker NAME`, requires one on `create`, and fails closed on an undeclared name.)*
- [x] Declare the planning tracker in `shipit.yaml`.
- [x] Settle how much of a Linear issue survives the copy. *(Workflow states collapse — req 8; the issue's original creation date is recorded in its body — req 9.)*

## Migration

- [ ] Export all 322 Linear issues with comments, redirected to files (never piped — the shim truncates piped stdout at 64 KiB), outside the git workspace.
- [ ] Add `createdAt` to `ISSUE_FIELDS` in `trackers/linear/adapter.ts` so an issue's original date is readable at all (req 9).
- [ ] Create the corpus's 20 labels with their Linear colors, plus the five `priority: …` labels that carry priority across.
- [ ] **Pilot** — copy one issue with a long body, several comments, an internal cross-reference, a label and a priority. Stop there for a human look at the body header, the dated comments and the rewritten references before the format is repeated 322 times.
- [ ] Copy every issue in key order, predicting each `planning#M` and asserting each create matches. Rewrite the corpus's 1,146 internal `SHI-N` cross-references and 120 `linear.app` URLs as they are written — comment bodies cannot be edited afterwards. Preserve each comment's original date and each issue's creation date (req 9). Emit the `SHI-N → planning#M` mapping incrementally as a durable artifact.
- [ ] Verify a full round trip in the UI: the tab, an issue with comments, a write, and Undo.
- [ ] Rewrite every reference in this repository from the mapping, in one PR, when nothing else is in flight (req 10): 2,623 mentions across 667 files, 186 doc `issue:` pointers, 221 files with `linear.app` URLs. Use `grep -a` — one source file is flagged binary and would otherwise be skipped.
- [ ] Retire Linear for ShipIt's own planning: drop the `roadmap` declaration and rewrite `CLAUDE.md`'s tracker-sync section (req 11).
- [ ] Delete `planning#1` and the pilot issue.

## Found here, fixed elsewhere

- [ ] The `shipit` shim truncates piped stdout at 64 KiB — it exits via `process.exit()` without draining. Any agent running `shipit issue view … --json | jq` on a large issue silently gets a cut-off document. Not specific to this migration.
- [ ] `shipit issue list` on Linear queries `first: 100` with no pagination. It no longer blocks the export, which walks keys individually, but the limit stands.
