# Checklist

- [x] Stop demanding a `user:` a contained service cannot get right
      (`validateServiceSecurity`), while keeping root / 911 / 912 / session-range
      declarations refused.
- [x] Add `g+rwX` + setgid to the orchestrator-side worktree handoff
      (`chownWorktreeRecursive`), so a root-materialized checkout is reachable
      through the shared group.
- [x] Add the same two passes to the container-side handoff
      (`chown_workspace`), with the git-object and pnpm-store prunes intact.
- [x] Add `group_add: [<sharedGid>]` for a service that declares its own user,
      so an image with a baked-in account still reaches the tree.
- [x] Reconcile `shipit-docs/compose.md` — it told services to share a UID it
      forbade them to name.
- [x] Tests: fill-in accepted under containment, refusals that must survive,
      `group_add` injection, worktree modes, entrypoint modes.
- [x] Verify live: the dogfood `dev` service starts and its inner orchestrator
      serves again.
- [x] Follow-up (github#2374 re-verification): correct the four surfaces that
      kept asserting the deleted rule — `shipit-docs/plugins.md` (which told the
      agent to *add* the harmful `user:`), `shipit-docs/compose.md`'s empty-list
      troubleshooting, `session-worker-uid.ts`'s `RESERVED_EGRESS_UIDS` reasoning,
      `plugin-compose.ts`'s `toComposeService` comment, plus `docs/262` and
      `docs/150`. Added the missing contained-plugin acceptance test.
- [x] After this ships: drop the `user: "1000:1000"` lines from this repo's
      `docker-compose.yml` (see plan.md §4). **Done in
      [docs/272-services-run-as-session-uid](../272-services-run-as-session-uid/checklist.md)**
      (`fec4444e`, 2026-08-17), which took the item over along with the rest of
      the uid-1000 cleanup and gated it on the check this item implied — that the
      deployed orchestrator accepts a contained service with no `user:` — before
      removing anything. `emulator`'s `1300:1301` stays: a baked-in image account
      that writes no workspace, kept working by half B's `group_add`.
- [x] Close §3's residual (planning#420): a POSIX default ACL on every workspace
      directory, so what a foreign-UID service creates is group-writable too.
      Orchestrator pass (`applyDefaultGroupAcl`), entrypoint pass, `acl` in the
      five images, `HANDOFF_SCHEME` 2 → 3 so already-claimed trees are repaired.
- [x] Silence the dropped-uid git's `/root/.config/git/ignore` warning
      (`pinGlobalExcludesFile`) — it was the first line of the stderr that
      reported the §3 rebase failure and made the banner name the wrong cause.
      Leaves an operator's own `core.excludesFile` alone.
- [x] Make the scheme bump actually reach an existing workspace: the mount
      loop's `[ -w "$d" ]` probe ran ahead of the sentinel, and a handed-over
      workspace is unwritable to the entrypoint's root, so a bump reached no
      existing session. The workspace now has its own stat-gated branch above
      the probe, with the sentinel written through `gosu` after the walk.
      (Independent review finding.)
