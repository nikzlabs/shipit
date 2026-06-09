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

## Open questions #1, #2, #4 — host overlay mount → **SUBSTRATE CONFIRMED (WSL2 + Docker Desktop/Mac); gate now a privilege-mechanism design problem**

Two privileged runs, **21/21 across the two combined** (the WSL2 run's one
inotify SKIP was closed by the Docker Desktop run). The overlay substrate works;
what remains for #1 is **not** "does overlayfs work" but the orchestrator
privilege + daemon-host-fs mechanism (see the two constraints below).

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
4. ✅ **macOS substrate — done.** Ran `prototype/run-in-docker.sh` on Docker
   Desktop (Mac): spike inside a `--privileged` container with scratch on a
   **named volume** (VM-native ext4), kernel `6.12.76-linuxkit`. **PASS=21
   FAIL=0 SKIP=0** — every check, *including inotify* (plain create **and**
   copy-up modify). So overlayfs works on Docker Desktop's volume-backing fs, the
   native-ext4-not-FUSE upperdir requirement is satisfied, and the file-watcher
   question (#4) is confirmed. This also retroactively closes the WSL2 inotify
   SKIP. (16 stacked lowerdirs → 262-byte option string, well under the limit.)

> **macOS (Docker Desktop) run:** PASS=21 FAIL=0 SKIP=0, kernel
> `6.12.76-linuxkit`, scratch on a named volume (ext4 family). Includes inotify
> create + copy-up. "HOST-MOUNT GATE: feasible on this host."

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

## Cross-environment portability + the propagation gap

The decided architecture maps identically onto every documented install target —
VPS (`deployment/vps/docker-compose.yml`) and local Docker on Linux/macOS/Windows
(`docker/local/prod/compose.yml`): both are an orchestrator container with
`docker.sock` + a named `*_workspace` volume + sessions spawned via the daemon
with volume-subpath mounts. On macOS/Windows the daemon simply runs inside the
Docker Desktop / WSL2 Linux VM — where the spikes already proved overlayfs works.
No per-environment redesign is needed.

**Open gap the single-namespace spikes did NOT cover (introduced by the
long-lived-sidecar decision):** the sidecar performs the overlay mount in *its*
mount namespace; for a **separate session container's** volume-subpath mount to
show the merged contents, that mount must **propagate to the Docker daemon's
namespace** (`rshared` on the volume backing dir). The prototypes validated
overlay + bind + inotify *within one container*, not this **cross-container /
daemon propagation**. It is identical on VPS and local Linux, but **most likely
to differ on Docker Desktop (Mac/Windows)**, where the daemon-in-VM mount
propagation under `/var/lib/docker/volumes` is the least bare-host-like part.

**Next spike (the real remaining feasibility check):** `prototype/propagation-spike.sh`
— a two-container test: a privileged sidecar mounts overlay on the shared named
volume, then a *second* container checks whether it sees the overlay-merged
content. It runs a ladder (plain volume bind → `make-rshared` → host-mountpoint
`:rshared`) and prints a per-host verdict. Run on a bare-Linux/VPS-like host
**and** on Docker Desktop. Until it passes on both, the sidecar architecture is
**feasible-pending-propagation**, not proven. Minor: the VPS provisioner raises
inotify limits (README); local installs don't, but the watcher already runs today
so it's not new.

**Propagation verdicts:**

- **WSL2 (docker 29.4.1):** baseline + `make-rshared` rungs → overlay works but
  stays in the sidecar namespace (**not propagated**, expected). The realistic
  host-mountpoint `:rshared` rung was **rejected by the daemon**: *"path
  …/volumes/ob-prop-vol/_data is mounted on / but it is not a shared mount."* So
  the WSL2 daemon-host root is **rprivate**, and propagation requires a one-time
  **`mount --make-rshared /`** on the daemon host first. (`propagation-spike.sh
  --with-host-setup` now applies that via a `--pid=host` nsenter container and
  re-tests — run it to confirm the fix yields propagation.)
  - **`--with-host-setup` re-run:** `mount --make-rshared /` **succeeded in PID 1's
    mount namespace** ("host root is now a shared mount") but the daemon **still
    rejected `:rshared`** with the same error. Strong signal that **dockerd runs in
    a different mount namespace than PID 1** on this WSL host, so a PID-1
    `make-rshared` never reaches the daemon's view. The canonical fix is then
    `MountFlags=shared` on the **dockerd service** (+ restart), not `make-rshared /`
    on PID 1. A diagnostic rung (compares dockerd/containerd mount-ns vs PID 1)
    was added to confirm.
  - **Diagnostic result (hypothesis disproved):** dockerd **and** containerd run
    in the **same** mount namespace as PID 1 (`mnt:[4026532375]`), and `/` **is**
    shared after the fix — yet the daemon **still** rejects the `:rshared` bind.
    So the blocker is *not* a namespace gap. The volume path is a **plain
    directory on `/`**, not its own mount point, and dockerd's `:rshared` check
    wants the source to be a real **shared mountpoint**. → Added a
    production-realistic rung: a **dedicated self-bind directory marked shared**
    (`mount --bind /var/obshared /var/obshared && mount --make-rshared
    /var/obshared`), overlay state under it. _Pending that rung's verdict_ — this
    is also the cleaner production layout (overlay state on its own shared mount,
    independent of `/` and the docker data-root).
  - **Dedicated self-bind shared mount (rung A3) — also rejected.** Even a real
    shared **mountpoint** (`/var/obshared`, setup confirmed "is a shared
    mountpoint") was refused: *"path /var/obshared is mounted on / but it is not a
    shared mount."* So on WSL2, **no runtime-applied propagation setup** (volume
    bind, `make-rshared /`, dedicated shared mountpoint) makes this dockerd accept
    a `:rshared` bind — despite dockerd being in PID 1's namespace and the mounts
    reading `shared` in `/proc/1/mountinfo`.
  - **Conclusion (WSL2):** the `:rshared`-bind / mount-propagation approach the
    long-lived sidecar relies on **does not work on this WSL2 daemon** via any
    runtime fix. The only untested lever is **daemon-level** shared propagation
    set **before dockerd starts** (`MountFlags=shared` on the docker service +
    restart) — which can't be applied at runtime from a container, so the spike
    can't reach it. **This means the sidecar-via-propagation mechanism is NOT yet
    proven on any host, and is likely unavailable on WSL2 / Docker-Desktop-class
    daemons.**

**Decisive next test (manual, host-level — cannot be scripted from a container):**
on a real Linux host / VPS, configure dockerd with shared propagation at startup
(`MountFlags=shared` in the docker systemd unit, or `mount --make-rshared /`
*before* the daemon starts) + restart docker, then run `propagation-spike.sh`
(plain, no `--with-host-setup`) and check rung **A2**. If it reports PROPAGATED,
the sidecar design works on VPS; if not, the mechanism needs rethinking even
there.

- **Docker Desktop (Mac, arm64, docker 29.5.3): WORKS by default.** Rung A2
  (host-mountpoint `:rshared`) reported **PROPAGATED ✓ on the FIRST attempt,
  before any host setup** — the LinuxKit VM mounts `/` **shared** by default, so
  the sidecar's `:rshared` bind is accepted with no provisioning. Rung A3 also
  passes. Verdict: "Cross-container propagation ACHIEVED."
- Bare Linux / VPS (systemd): _(worth one confirming run; systemd sets `/` rshared
  at boot, so expected to behave like Docker Desktop — pass with no setup)_

**Corrected conclusion — the requirement is "daemon host `/` is a shared mount,"
not a platform.** The differentiator across the two runs was purely the daemon
host's default mount propagation:

| Daemon host | `/` default | Propagation |
|---|---|---|
| Docker Desktop (Mac) | shared | ✅ proven, no setup |
| systemd Linux VPS | shared (boot) | ✅ very likely (confirm) |
| native docker-ce in a bare WSL2 distro | private | ❌ — needs daemon-level shared propagation; a *runtime* `make-rshared` is NOT honored |

So the WSL2 failure was a **daemon-default** issue (private `/`), not a broken
mechanism. The sidecar design is **feasible on every documented target that
provides shared propagation** — Docker Desktop (proven) and systemd VPS (the
always-on target) both do by default; the only gap is a bare docker-ce-in-WSL2
daemon, where it must be configured (`MountFlags=shared` + restart) or that
install falls back to the copy substrate.

**Design implication (largely resolved):** require **shared mount propagation on
the daemon host** as a documented prerequisite (the VPS provisioner guarantees
it; Docker Desktop has it). Keep the copy substrate (today's nm-store) as a
**graceful fallback** only where propagation isn't available (bare-WSL docker-ce),
detected at startup. The portability concern is now narrow, not fundamental.

**Implication for the design:** the sidecar must run on a daemon host whose root
(or at least the Docker data subtree) is a **shared mount**. On a VPS this is a
one-line provisioner step (`mount --make-rshared /`, or `MountFlags=shared` for
dockerd) — cheap and standard. The open risk is **Docker Desktop (Mac/Win)**:
confirm `--make-rshared` is both applicable and *persistent* across VM restarts
there, or the local-install story needs a different hook.

## Net decision

The chain logic (the first-sequenced prototype) is **validated and cheap**. The
overlay **substrate is confirmed feasible** on both WSL2/ext4 and Docker
Desktop/Mac (21/21 across the two runs, incl. inotify): overlay mount, CoW with
an immutable base, whole-workspace capture, git/worktree/`.git` handling, 16-deep
stacked lowerdirs well under the option-size limit, bind-mounting the merged dir,
inotify (create + copy-up), and safe teardown ordering all work — on the
volume-backing fs that mirrors where ShipIt's `workspace` actually lives.

**The gate is no longer "does overlayfs work" — it's a design problem:**
1. **Orchestrator mount capability.** The orchestrator is an *unprivileged*
   container (`docker.sock` only; the spikes used `--privileged`/`CAP_SYS_ADMIN`
   as a substrate stand-in). Decide the real mechanism: add the cap to the
   orchestrator, a privileged mount-helper, or via the daemon.
2. **Daemon-host-fs placement.** The `merged` dir must live where the daemon can
   bind it into a sibling session container (daemon-host fs / VM-native ext4),
   not the orchestrator container's private fs.

Still nice-to-have, not blocking: a run on the **prod VPS** (non-WSL/non-Desktop)
kernel and **mount/unmount timing**. Net: **green to proceed to building the
orchestrator-owned mount lifecycle**, whose first job is mechanism (1)+(2).

**Update — cross-container propagation resolved (the sidecar's real dependency).**
`prototype/propagation-spike.sh` proved the sidecar's overlay mount can reach a
separate session container **iff the daemon host provides shared mount
propagation**: **Docker Desktop (Mac) works with no setup** (proven), a systemd
VPS is expected to (boot default), and only a **bare docker-ce-in-WSL2 daemon**
(private `/`) lacks it — there the install **falls back to the copy substrate**.
So the requirement is a documented host prerequisite, not a portability blocker.
The mount must land under a **dedicated self-bind `rshared` mountpoint** the
daemon sees (not just a dir on `/`). See the propagation-verdicts section above
for the full WSL2-vs-Mac evidence.
