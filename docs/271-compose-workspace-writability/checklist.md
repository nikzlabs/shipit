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
- [ ] After this ships: drop the `user: "1000:1000"` lines from this repo's
      `docker-compose.yml` (see plan.md §4).
