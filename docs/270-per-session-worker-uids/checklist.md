# Checklist — per-session worker identities

Build sequence from [plan.md](./plan.md) §2. Requirements are cited as `(req N)`.

## Shipped

- [x] **Requirements first, then design.** `requirements.md` written before any
      code; Q1 (reserved range) and Q2 (new sessions only) asked as one batched
      question and answered 2026-08-16, with dated receipts and the resulting
      requirement changes (4a, 8a, 8b) in the same diff.
- [x] **The allocator** (`session-uid-allocator.ts`, reqs 3, 4a, 6, 7, 11) —
      range `2_000_000..2_999_999`, a monotonic ledger in its own one-row table
      so an identity is never reused (making req 7 vacuous rather than a cleanup
      path that has to be correct), `SessionUidExhaustedError` instead of
      wrapping, and `assertSessionUidRange` at boot beside the existing
      `assertWorkerUidNotReserved`.
- [x] **The record and the seal** (`shared/session-identity.ts`,
      `sealSessionDir`, reqs 1, 2, 5) — `<sessionsRoot>/<sessionId>` is owned by
      the identity and mode 0700. It is mounted into nothing, so it is the one
      link in the chain a session cannot re-own; 0700 there means no inner file
      needs a mode of its own.
- [x] **`resolveGitTreeUid` reads the session record, never the tree** (req 2).
      Gated on `sessionIdForPath`, so for a session path the record is the only
      answer and "no record" resolves to the deployment's configured value —
      `identityForPath` returning null was **not** enough, and the test that
      asserts it caught the fall-through before it shipped.
- [x] **Old sessions sealed without being migrated** (`sealLegacySessionDirs`,
      req 8b) — one non-recursive chown + chmod per root-owned session directory
      at boot. Not a migration (req 8a rules that out); the permission change
      without which "new sessions only" would leave every new session readable
      by every old one, and the reverse.
- [x] **One shared gid** (`sessionWorkerGid`, req 9) — only the uid became
      per-session. It must be the PRIMARY gid: Node's `spawn({uid, gid})` sets no
      supplementary groups, so a design reaching the shared surfaces through one
      would work in the container and fail silently in the orchestrator.
- [x] **The four shared surfaces converted to group ownership** (req 9) — the
      dep cache (entrypoint, gid-stamped sentinel so it is walked once per
      *cache* rather than once per *session*), the pnpm store
      (`ensurePnpmStoreDir`, now verifying the gid), the overlay dependency base
      (`shareTreeWithAllSessions`, which sets a **mode** as well as a group
      because copy-up preserves the lower file's mode too), and
      `/credentials/.gitconfig` at `0640 root:<sharedGid>`.
- [x] **The entrypoint stops re-owning hardlinked git objects** (req 1) —
      measured first: a bare repo and two `--local` clones report the same inode
      for the same object file, so a plain `chown -R` handed one session chmod
      and rewrite rights over content every sibling session and the shared cache
      read. Object *directories* are still chowned; `.pnpm-store` is pruned
      whole.
- [x] **The privilege drop keeps its supplementary groups** (req 10) — an
      allocated uid has no passwd entry, so the drop would have taken the
      `setgroups`-clearing form on every session and ops sessions would have lost
      the host journal. `usermod -u` first, best-effort like the blocks around it.
- [x] **Compose** (reqs 4, 4a) — fill-in is now `user: <sessionUid>:<sharedGid>`
      and still only when the service declares none; a declared `user:` inside
      the reserved range is refused for every service, contained or not, since
      the hazard is identity rather than egress.
- [x] **Plugin CLI and install containers** take the session's identity.
- [x] Tests: `session-identity.test.ts`, `session-uid-allocator.test.ts`,
      docs/270 blocks in `git-tree-uid.test.ts`, `session-worker-uid.test.ts` and
      `compose-generator.test.ts`, and six new cases in
      `session-worker-entrypoint.test.ts` that **execute** the script — including
      the `chown_workspace` `find` expression, extracted and run against a
      fixture tree, because its prune/`-o` precedence is not provable by reading.

## Not closed — named, not rounded off

- [ ] **Pre-existing sessions still reach each other.** Requirement 8a, decided
      by the requester. They keep the shared identity and are sealed only against
      sessions that hold a distinct one. Shrinks as they are archived; never
      grows.
- [ ] **Shared package caches stay mutually writable between sessions of the
      same repo/runtime** — a payload can poison a cached tarball or a
      content-addressed pnpm store entry another session later installs, and a
      pnpm store entry is hardlinked into the consumer's `node_modules`. **This
      is pre-existing** (every session shares uid 1000 today, so the same write
      is available now) and this feature neither widens nor narrows it. Outside
      req 1's scope, the largest remaining cross-session channel, and filed as
      **planning#414** rather than left as a sentence.
- [ ] **planning#384 / docs/266 is NOT closed.** `safe.directory` is still `*`
      (planning#403), the dropped git still reaches the PAT (planning#404), and a
      project's own hooks still do not fire on ShipIt's auto-commit (docs/266
      E4).

## Could not be verified here

No root, and `unshare -r` is refused, so nothing below was exercised — stated
plainly rather than implied by green tests:

- the uid drop itself, a foreign-owned tree, and the 0700 seal denying a
  *different* uid. Everything uid-dependent is behind an injection seam and
  tested through it; the seal is tested as "the mode and owner we set", never as
  "another uid was denied";
- `usermod -u` inside the real image (the entrypoint tests stub it and assert it
  is invoked, which is the call, not its effect);
- overlayfs copy-up preserving the lower file's mode. The group-write requirement
  follows from it and is read from docs/183, not measured here;
- that libuv performs no `setgroups` on `spawn({uid, gid})` — read, not measured.
  If it is wrong, the primary-gid rule is unnecessary rather than unsafe.

## Defects found while building, all fixed

Recorded because each was invisible until something specific looked for it, and
most were found by a test rather than by reading:

- `resolveGitTreeUid` fell through to the tree when a session path carried no
  record, handing the drop decision back to the party req 2 exists to keep out
  of it. Fixed with a configured fallback identity. **Found by the test written
  to assert req 2.**
- `cloneFromCache` ran `safeSimpleGit(sessionDir)` — which now drops — against a
  tree `git clone --local` had just created as root, EACCESing on `.git/config`
  and failing session creation. It had held only because a root-owned tree meant
  "do not drop", which stopped being true when the record moved off the tree.
  **Found by tracing the call path, not by a test**; guarded now by a source
  ordering check, since no test here can exercise a real drop.
- **Four orchestrator paths used the object-blind recursive chown on a
  workspace**, re-owning the `.git/objects` inodes `git clone --local` hardlinked
  from the shared bare cache — the same cross-session write channel as the
  entrypoint's walk, on the orchestrator side. `cloneFromCache`, `forkSession`
  (whose clone hardlinks from the PARENT session's tree, so a fork would have
  taken rewrite rights over its parent's repository content), and the two restore
  paths in `services/session.ts`. All now use the object-aware handback, and a
  scanner in `session-identity-ordering.test.ts` fails the build on the next one.
- **`forkSession` builds its own session directory** instead of going through
  `createSessionDirFactory`, so it got neither an identity nor the 0700 seal:
  requirement 1 would have held for every kind of session except a fork, silently.
  Allocation now lives behind one `allocateAndSealSessionDir`, configured at boot
  rather than threaded through an eleven-parameter call chain, and a guard asserts
  both creators call it.
- The `/plugins` and `/plugin-bin` prep blocks still chowned `uid:uid`, leaving
  them group-owned by a gid the worker does not hold. **Found by an entrypoint
  test.**
- `usermod` ran *after* the journal-group alignment that needs the passwd entry
  it creates, so an allocated uid would have been moved onto an account the
  journal group was never added to — the drop succeeds and the journal is
  silently unreadable, indistinguishable from having no `usermod` at all. Fixed,
  and the regression test asserts the whole `groupOps` sequence rather than that
  `usermod` merely ran; verified it fails on the reversed order.
- Making the shared handoff recursive broke two things at once: the pnpm store's
  deliberately non-recursive hot-path handoff, and — because `canHardlink`
  compares MODE — docs/183's generation dedup, which would have silently turned
  every overlay base generation back into a full ~0.5 GB copy. **Found by
  docs/183's own end-to-end dedup test**, which is the only thing that would
  have.
