# Findings — overlay rolling-base prototypes (docs/183)

Empirical results from the spikes in [`prototype/`](./prototype/). Updated as
each open question is closed.

## Open question #3 — publish ordering by commit ancestry → **RESOLVED (logic sound + cheap)**

`prototype/run-rolling-base.ts` (33/33 pass) validates the keyless rolling-base
chain on the current copy substrate against a real git repo:

- Publish is a **commit-ancestry compare-and-swap**: advance iff the candidate
  strictly descends the current base (`git merge-base --is-ancestor`), under a
  short per-`(repo, runtime fingerprint)` lock. The decision is **ancestry, not
  wall-clock** — a late-but-older publisher declines (verified).
- **Force-push divergence** is handled conservatively: a diverged `main` is
  not-forward, so the publish is skipped and the base waits for the next
  genuinely-forward commit (verified).
- **Eligibility** (exit-0 ∧ pre-user ∧ source==remote-default) gates publish
  outside the lock; ineligible installs still run on the base but never publish.
- The **stamped marker** only permits a skip on an exact
  `(sourceCommit, runtime, installCommand)` match — non-default checkouts and
  ABI/command changes correctly force a real install.
- **Depth cap** → clean reinstall **from empty** (flatten = reproducibility
  reset); depth never reaches the cap.
- **Concurrency:** N shuffled parallel publishers converge to the newest commit,
  no torn pointer.

**Timings (this container, fork+exec dominated):**

| op | cost | gates |
|---|---|---|
| `git merge-base --is-ancestor` | ~2.3 ms/call | publish only |
| scope lock acquire+release (mkdir) | ~0.1 ms/call | publish only |

Both are negligible and gate only the publish (the install itself runs into each
session's own upper, unserialized). **The ordering machinery is confirmed not a
bottleneck.**

## Open questions #1, #2, #4 — host overlay mount → **CORROBORATED on a WSL2/ext4 host (1 gap: inotify)**

First privileged host run, on **WSL2** (`6.6.114.1-microsoft-standard-WSL2`, ext4):
**PASS=19 FAIL=0 SKIP=1 → "HOST-MOUNT GATE: feasible on this host."** This clears
8 of the 9 checks the container cannot reach:

- **#1 mount/CoW/teardown:** overlay mount on ext4 succeeded; an "install" write
  landed only in the upper, an in-place edit copied up, and the **base lower
  stayed immutable**; the **workdir was not removable while mounted** (so
  `disk-janitor`/archive must unmount first) and the unmount-then-clean order
  worked. ✅
- **#2 git/.git on overlay:** clone + fast-forward worked on the merged dir, a
  linked **worktree's absolute gitdir pointer resolved**, and a published base
  carried source *contents* but **no `.git`**. ✅
  - *Note:* the fast-forward showed `HEAD b042… -> b042…` (unchanged) because the
    fixture clone already had the tip — the ff path ran clean, just as a no-op.
    A multi-commit advance is exercised separately by the logic prototype.
- **#4 compose + watcher:** **16 stacked lowerdirs** all visible (mount-option
  string only **406 bytes**, far under the ~4096 page limit — so a depth cap of
  ~10–20 is comfortably safe); **bind-mounting the merged dir** read through to
  the base and writes via the bind hit the upper (the compose-service pattern). ✅
  - **Gap — inotify not yet verified:** the file-watcher check **SKIPPED**
    because `inotifywait` wasn't installed. Re-run after
    `apt-get install inotify-tools` to confirm the recursive watcher sees plain
    creates **and** copy-up modifies over the overlay.

**macOS (supported install — corrected):** ShipIt's local-Docker install runs on
macOS too (README), so macOS matters. The spike run *on the Mac host* correctly
bailed — XNU has no `/proc`/overlayfs — but that is **not** the place the mount
would happen. All real deployments run `containerized` mode
(`docker/local/prod/compose.yml`: `USE_CONTAINERS=true`, orchestrator is a
container on `/var/run/docker.sock`), so on a Mac the daemon, orchestrator
container, session containers, and the `workspace` **named volume** all live
inside **Docker Desktop's Linux VM**, which has overlayfs. (`local` runtime mode
is only the ShipIt-in-ShipIt dogfood inner orchestrator, not a standalone
deploy.) So the overlay mount is a Linux operation on every platform; on a Mac
run the spike **inside the Docker Desktop Linux VM**, not on XNU. The preflight
now prints this guidance instead of a raw `grep` error.

**Two topology constraints the spike under-tested (Linux AND Mac):**

1. **The orchestrator container is unprivileged.** `docker/local/prod/compose.yml`
   grants it only `docker.sock` — no `privileged` / `cap_add: SYS_ADMIN`. The
   spike ran as root-with-`CAP_SYS_ADMIN` directly, which assumes a capability
   the orchestrator does not currently have. "Orchestrator owns the host-side
   mount" therefore needs a concrete mechanism: add the cap to the orchestrator,
   use a privileged helper/sidecar, or perform the mount via the daemon. **This
   is the real shape of the gate, beyond "does overlayfs work."**
2. **The merged dir must live on the daemon-host filesystem.** Session workspaces
   are Docker volumes/bind-mounts resolved by the **daemon**; the overlay
   `merged` dir must be a path the daemon can bind into a sibling session
   container — i.e. on the daemon host fs (the VPS host, or the Docker Desktop
   VM on Mac), not inside the orchestrator container's private fs.

   *macOS corollary:* keep overlay `upperdir`/`workdir` on the VM's **native
   ext4** (a named volume / VM path). overlayfs refuses a FUSE upperdir, so a
   gRPC-FUSE/virtiofs-backed macOS host path will not work as an upper.

**Caveats before calling #1/#2/#4 fully closed:**
1. Run the **inotify** check (install `inotify-tools`) — it's the one untested item.
2. WSL2 ≠ prod: this corroborates feasibility but the **prod VPS** has a stock
   (non-WSL) kernel. Repeat on the prod-equivalent host to be definitive.
3. **Cost not yet measured:** open question #1 also asks to *size* the mount —
   time a few mount/unmount cycles on the real host.
4. **macOS substrate not yet tested.** Docker Desktop's Linux VM + its
   volume-backing fs differ from WSL2 and from a bare VPS. Run
   `prototype/run-in-docker.sh` (spike inside a privileged container, scratch on
   a named volume) on a Mac to confirm overlayfs works on that fs and the
   native-ext4-not-FUSE upperdir requirement holds. This run also closes #1
   (inotify) since it installs `inotify-tools`.

> **macOS run output:** _(paste `run-in-docker.sh` summary here)_

<details><summary>Full WSL2 run output</summary>

```
0. Preflight
  PASS CAP_SYS_ADMIN present (CapEff=0x000001ffffffffff) — can mount(2)
  PASS scratch=/var/tmp/ob-spike fstype=ext2/ext3 kernel=6.6.114.1-microsoft-standard-WSL2
  (note: prod VPS is ext4 — this matches)
1. Overlay mount (lower ro + upper + work) on ext2/ext3
  PASS mounted overlay at /var/tmp/ob-spike/s1/merged
  PASS base content visible through merged
2. CoW — an 'install' write lands ONLY in the upper layer
  PASS new dep captured in upper
  PASS in-place edit copied-up (base immune)
  PASS BASE unchanged by session edit (immutable lower)
3. Whole-workspace — writes outside node_modules captured generically
  PASS .venv / vendor / .pnp.cjs all captured — no ecosystem knowledge needed
4. git clone + fast-forward on the merged dir; small source diff
  PASS git clone into merged dir
  PASS fast-forward on overlay HEAD b0421842e3c0e0129e79cebae877af129719efa5 -> b0421842e3c0e0129e79cebae877af129719efa5
  PASS .git present in upper (must be excluded on base publish)
  PASS linked worktree gitdir pointer resolves on overlay
5. Base publish must exclude .git (correctness, not security)
  PASS published base carries source CONTENTS but no .git (no stale branch ref)
6. Stacked lowerdirs — overlay depth up to a tunable cap
  PASS 16 stacked lowerdirs all visible (depth cap is safe)
  (mount option length for 16 layers: 406 bytes; kernel page limit is ~4096 for the whole option string)
7. Bind-mount the merged dir as a source (compose service pattern)
  PASS bind-mount of merged dir reads through to base
  PASS writes via bind-mount hit the overlay upper
8. inotify over overlay (file-watcher pattern), incl. copy-up events
  SKIP inotify checks — inotifywait not installed (apt-get install inotify-tools)
9. Teardown ordering — unmount BEFORE removing workdir (janitor-safe)
  PASS workdir NOT removable while mounted (janitor must unmount first)
  PASS unmount then cleanup succeeds in order
  PASS workdir cleanup after unmount
Summary
  PASS=19 FAIL=0 SKIP=1
  HOST-MOUNT GATE: feasible on this host.
```

</details>

### (original in-container probe — why the host run was necessary)

The actual mount **cannot be exercised from inside a ShipIt session container** —
this is the design's whole premise (docs/172: unprivileged containers,
HTTP-only, no `docker exec`). Capability probe from this container:

```
CapEff: 0x00000000000004eb        # CAP_SYS_ADMIN (bit 21) NOT set
mount -t overlay ...  -> mount: permission denied (exit 32)
unshare --map-root-user --mount -> Operation not permitted
/workspace fstype: ext2/ext3      # matches prod ext4 family
overlay present in /proc/filesystems
```

So `mount(2)` is unavailable to a session container even as uid 0 — confirming
the mount must be **host-side, owned by the orchestrator**, exactly as the plan
states. The container is uid 0 but capability-stripped; entering a user+mount
namespace is also denied.

`prototype/host-overlay-spike.sh` is ready to close #1/#2/#4 — run it on the
prod-equivalent **ext4 host** (where the orchestrator runs) and paste its summary
below. It validates, in order: overlay mount on ext4, CoW delta capture,
whole-workspace generality, git clone + fast-forward on the merged dir, `.git`
exclusion on publish, stacked-lowerdir depth, bind-mount of the merged dir
(compose), inotify incl. copy-up (file watcher), and teardown ordering.

> **Host run output:** _(paste `host-overlay-spike.sh` summary here)_

## Net decision

The chain logic (the first-sequenced prototype) is **validated and cheap**. The
host mount — the gating risk — is now **corroborated feasible** on a WSL2/ext4
host (19/19 of the runnable checks pass): overlay mount, CoW with an immutable
base, whole-workspace capture, git/worktree/`.git` handling, 16-deep stacked
lowerdirs well under the option-size limit, bind-mounting the merged dir, and
safe teardown ordering all work. **Remaining to fully close the gate:** (1) the
inotify check (install `inotify-tools` and re-run), (2) a repeat on the
prod-equivalent (non-WSL) kernel, and (3) timing the mount/unmount cost. Net:
the design is **green to proceed to building the orchestrator-owned mount
lifecycle**, with those three confirmations folded into that work.
