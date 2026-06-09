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

- **Docker Desktop / Windows — WSL2 backend (docker 29.4.1; `docker info` →
  Name `docker-desktop`, OperatingSystem "Docker Desktop"):** baseline +
  `make-rshared` rungs → overlay works but
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
  - **Conclusion (Docker Desktop / Windows-WSL2):** the `:rshared`-bind /
    mount-propagation approach the long-lived sidecar relies on **does not work on
    Docker Desktop's WSL2 backend** via any runtime fix — not even a dedicated
    self-bind shared mountpoint (rung A3). The daemon runs inside Docker Desktop's
    managed `docker-desktop` WSL2 distro, whose mount topology rejects the
    `:rshared` source even when `/proc/1/mountinfo` reads `shared`. The only
    untested lever is **daemon-level** config before dockerd starts
    (`MountFlags=shared`), but the `docker-desktop` distro is **managed/ephemeral**
    — a user can't persist a systemd-unit override there the way they can on a VPS,
    so there is **no known user-applicable fix**. → **Docker Desktop on Windows is
    a confirmed plain-install-fallback target.** (NB: this is *not* the same as
    Docker Desktop on **Mac**, which uses a different VM substrate and **does**
    propagate — see below. "Docker Desktop" is not one behaviour.)

**Decisive next test (manual, host-level — cannot be scripted from a container):**
on a real Linux host / VPS, run `propagation-spike.sh` (plain, no
`--with-host-setup`) and check rung **A2**. → **DONE — PROPAGATED on the prod VPS
(systemd, docker 29.5.2) with no dockerd reconfiguration at all** (systemd's
boot-default `/` rshared was already sufficient; the `MountFlags=shared` step this
note anticipated turned out unnecessary on a stock systemd VPS). The sidecar
design works on the VPS.

- **Docker Desktop (Mac, arm64, docker 29.5.3): WORKS by default.** Rung A2
  (host-mountpoint `:rshared`) reported **PROPAGATED ✓ on the FIRST attempt,
  before any host setup** — the LinuxKit VM mounts `/` **shared** by default, so
  the sidecar's `:rshared` bind is accepted with no provisioning. Rung A3 also
  passes. Verdict: "Cross-container propagation ACHIEVED."
- **Bare Linux / VPS (systemd; docker 29.5.2, linux/amd64): WORKS by default —
  CONFIRMED on the prod VPS.** Rung A2 (host-mountpoint `:rshared`) reported
  **PROPAGATED ✓ on the plain run, no `--with-host-setup`** — systemd sets `/`
  rshared at boot, so the sidecar's `:rshared` bind is accepted with no
  provisioning, identical to Docker Desktop/Mac. A0/A1 not-propagated (the
  expected baselines). Verdict: "Cross-container propagation ACHIEVED via
  host-mountpoint :rshared (sidecar pattern)." **This closes the prod-VPS open
  blocker.**

**Corrected conclusion — the requirement is "the daemon's mount substrate provides
shared propagation," which splits BY virtualization substrate (and therefore partly
by platform — Docker Desktop is not one behaviour).** The differentiator is whether
the daemon's host root is a shared mount that accepts a `:rshared` source:

| Daemon host | substrate | propagation | overlay? |
|---|---|---|---|
| Docker Desktop / **macOS** (docker 29.5.3) | LinuxKit VM, `/` shared by default | ✅ proven, no setup | **yes** |
| systemd Linux VPS (docker 29.5.2) | bare metal, systemd sets `/` rshared at boot | ✅ **proven on prod, no setup** (rung A2 PROPAGATED) | **yes** |
| Docker Desktop / **Windows** (WSL2 backend, docker 29.4.1) | managed `docker-desktop` WSL2 distro | ❌ **confirmed rejected** — even a dedicated self-bind shared mountpoint refused; no user-applicable runtime fix | **no → plain install** |
| native docker-ce inside a user WSL2 distro | (NOT tested) | ❓ untested — likely also private `/`; if so, `MountFlags=shared` + restart is at least *possible* (user owns the unit) | unknown |

**Correction (this row was previously mislabelled).** The failing WSL2 run was
**Docker Desktop's WSL2 backend** (confirmed: `docker info` → `docker-desktop` /
"Docker Desktop"), *not* "bare docker-ce in a WSL2 distro" as an earlier draft
asserted — that bare config was never tested. So the failure is **not** a
daemon-default quirk of an obscure setup; it is **Docker Desktop on Windows**, a
mainstream local target. "Docker Desktop has shared propagation" is therefore
**false in general** — it holds on the Mac LinuxKit VM and fails on the Windows
WSL2 backend.

The sidecar design is **feasible on the targets whose substrate provides shared
propagation** — Docker Desktop/**Mac** (proven) and systemd Linux/**VPS** (proven).
Docker Desktop/**Windows** is a **confirmed no-overlay target** → plain-install
fallback, with no known runtime fix. Native docker-ce inside a WSL2 distro is
untested and TBD.

> **⚠ This entire propagation split is now MOOT — superseded by the daemon-overlay
> mechanism (next section).** It is the verdict for the *rejected* privileged-sidecar
> approach, kept as evidence for why that approach was abandoned. With the daemon
> performing the overlay mount via the `local` volume driver, there is no
> propagation in the path, so **all four targets — VPS, Docker Desktop/Mac, Docker
> Desktop/Windows, and Linux — are overlay-eligible.** Docker Desktop/Windows is
> proven; the others are expected (Mac/VPS already pass the harder sidecar test;
> Linux daemon-side overlay is bog-standard). The "no-overlay fallback" framing
> below applies only to the abandoned sidecar design.

**Design implication:** require **shared mount propagation on the daemon host** as
a documented prerequisite, detected by the startup probe; where it's absent, **fall
back to a plain full `agent.install`** — *not* a copy store. Overlay-eligible
targets (proven): systemd Linux/**VPS** and Docker Desktop/**Mac**. No-overlay
fallback target (confirmed): Docker Desktop/**Windows-WSL2**, with no known runtime
fix. Untested: native docker-ce in a WSL2 distro.

`nm-store` is **removed entirely**, not retained: the existing download cache
(`/dep-cache`, docs/075) is a separate subtree, so a plain install runs with **no
network** — but that removes network only, **not** the node_modules extract/link
cost (the dominant cost; ~24s for ShipIt's own repo). That extract cost is exactly
what overlay's warm base eliminates and the fallback still pays, so the fallback
is "correct + network-free," **not fast**.

**This is no longer "a narrow edge."** The fallback now covers **Docker Desktop on
Windows**, a mainstream local-dev target — not just an obscure bare-WSL config.
The mitigating context: the overlay feature is aimed squarely at the **always-on
VPS** (the intended production setup per the README), which is proven; local
installs are dev/trial, where a slower-but-correct install is acceptable. Still,
the doc should not undersell it — two paths remain (overlay where the substrate
propagates; plain full install otherwise), and Windows/Docker-Desktop users land on
the latter until/unless Docker Desktop changes its WSL2 mount topology.

**Live measurement — production ShipIt session on the ShipIt repo (the real
containerized path).** Inspected from inside such a session:

- Download cache **working**: `npm_config_cache=/dep-cache/npm`, an ext4 mount
  with **2.4 GB** of cached tarballs → installs are **not** network-bound.
- nm-store fast path **engaging**: install is bare `npm install` (qualifies),
  single `package-lock.json`, store has 5 populated keys (2.4 GB).
- `node_modules` = **473 MB across 31,396 files**. The **~24s is the `cp -a`/tar
  materialization of those ~31k tiny files** — nm-store working *as designed*,
  and exactly the "remaining per-session cost (tens of thousands of tiny file
  writes)" the plan calls out.
- That 24s is the **fresh-session** cost (no `.install-done` marker yet). A
  re-activation with `main` unchanged hits the marker and **skips install (~0)**.

So the caching is not broken — **materialization is the bottleneck**, and
31,396 files / ~24s is live proof. **Overlay replaces that copy with a ~0 mount**
(mount the base read-only, run `npm install` as a near-no-op up-to-date check).
This is the strongest empirical case for the feature, captured on the exact path
it targets.

> **Earlier dogfood caveat (separate, still true):** a dogfood session, which
> runs in `RUNTIME_MODE=local` (docs/118) — in-process, **no container**, so (a)
> **no overlay** there ever (overlay is containerized-only), and (b) the shared
> download-cache env (`npm_config_cache=/dep-cache/...`, wired via container
> `buildEnv`) may not apply, so that number could be partly cache-cold *and* is
> not the path overlay changes. Overlay's win lands on **containerized** sessions
> whose daemon propagates (VPS, Docker Desktop/**Mac** — *not* Docker
> Desktop/Windows). Measure warm-vs-cold install on the *containerized* path
> (checklist) before trusting any single number.

**Implication for the design:** the sidecar must run on a daemon host whose root
(or at least the Docker data subtree) is a **shared mount**. On a VPS this is the
boot default (proven). Docker Desktop is **substrate-dependent**: the Mac LinuxKit
VM propagates (proven); the **Windows WSL2 backend does NOT and has no
user-applicable runtime fix** (confirmed → fallback). Two open risks remain for the
Docker Desktop/**Mac** case: confirm propagation is *persistent across VM restarts*
(the LinuxKit VM is recreated routinely) — covered by the Phase 2 re-arm-on-boot
probe — and run the spike on Docker Desktop/Mac for **Windows-vs-Mac** parity is
already established (they differ). For Windows users the local-install story is the
plain-install fallback, full stop, unless Docker Desktop changes its WSL2 mount
topology.

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

**Cross-container propagation on the prod VPS — CONFIRMED (blocker cleared).**
Rung A2 of `propagation-spike.sh` ran on the prod VPS (systemd, docker 29.5.2,
linux/amd64) and reported **PROPAGATED ✓ on the plain run, no host setup** —
proving the sidecar's `:rshared` mechanism on the always-on #1 install target.
Propagation is proven on the two substrates that get overlay (Docker Desktop/**Mac**
+ systemd **VPS**); **Docker Desktop/Windows (WSL2 backend) is confirmed NOT to
propagate** (→ plain-install fallback, no known runtime fix); native docker-ce in a
WSL2 distro is untested. The Phase 1 nm-store deletion therefore has a guaranteed
end date on prod. Still genuinely nice-to-have (non-blocking): **mount/unmount
timing**. Net: **proceed to building the orchestrator-owned mount lifecycle**
(whose first job is mechanism (1)+(2)).

**Update — cross-container propagation resolved (the sidecar's real dependency).**
`prototype/propagation-spike.sh` proved the sidecar's overlay mount can reach a
separate session container **iff the daemon host provides shared mount
propagation**: **Docker Desktop (Mac) works with no setup** (proven) and a
**systemd VPS works with no setup** (proven on prod — docker 29.5.2, rung A2
PROPAGATED on the plain run); **Docker Desktop on Windows (WSL2 backend) does NOT
propagate** (confirmed — `docker info` → `docker-desktop`; no user-applicable
runtime fix) and falls back to a plain full `agent.install` (no copy store;
`nm-store` is removed, the download cache keeps it network-free). So the
requirement is a documented host prerequisite, satisfied by default on the two
overlay-eligible substrates; the prod-VPS confirmation that was an open release
blocker is now **closed**, but Docker Desktop/Windows is a confirmed
no-overlay target, not the "narrow edge" an earlier draft claimed.
The mount must land under a **dedicated self-bind `rshared` mountpoint** the
daemon sees (not just a dir on `/`). See the propagation-verdicts section above
for the full WSL2-vs-Mac evidence.

## Daemon-performed overlay via the `local` volume driver — **PROVEN on Docker Desktop/Windows (the decisive host); adopt over the sidecar**

**Motivation: kill the propagation dependency that fails on Docker Desktop/Windows.**
The sidecar design's hard part is making a privileged helper's overlay mount
*propagate* into the daemon's namespace. That propagation is what Docker
Desktop's WSL2 backend rejects. Web research surfaced a mechanism that avoids
propagation entirely: Docker's **`local` volume driver wraps `mount(8)`** and
accepts `type` / `device` / `o=` options, including **`type=overlay`**. When a
container mounts such a volume, the **daemon itself runs `mount -t overlay`** as
it constructs the container, so the merged view is in the container's mount
namespace **by construction** — there is no cross-container propagation in the
path. Demonstrated working in [docker/for-linux#1206](https://github.com/docker/for-linux/issues/1206):

```
--mount type=volume,dst=/workspace,volume-driver=local,\
  volume-opt=type=overlay,volume-opt=device=overlay,\
  "volume-opt=o=lowerdir=<base>,upperdir=<up>,workdir=<wk>"
```

The commas inside `o=` are handled by quoting that one `volume-opt`. lower/upper/
work must be **absolute daemon-host paths** — computable exactly as the
propagation spike did (`docker volume inspect -f '{{.Mountpoint}}'`). This fits
ShipIt's model: the orchestrator already holds `docker.sock`, stays unprivileged,
and our containers need no `CAP_SYS_ADMIN`.

**If it holds, it's strictly better than the sidecar:** it removes the
privileged-sidecar subsystem *and* the shared-propagation prerequisite, and —
critically — should make overlay work on **Docker Desktop/Windows-WSL2** (the
user's setup), where the sidecar mechanism is confirmed dead.

**Caveats to respect (from the moby issue tracker):**
- The kernel (≥4.13) errors `upperdir is in-use by another mount` if two overlays
  **share an `upperdir`**. Our design already gives each session its own upper;
  a **shared read-only `lowerdir`** across sessions is fine.
- `error creating overlay mount … device or resource busy` is a known overlay2
  hazard under **parallel** container creation — serialize the create/mount.
- Standard overlay rules: `workdir` empty + same fs as `upperdir`.

**Status: PROVEN on the decisive host — Docker Desktop/Windows-WSL2.** The spike
[`prototype/volume-driver-overlay-spike.sh`](./prototype/volume-driver-overlay-spike.sh)
ran on Docker Desktop/Windows (`docker info` → `docker-desktop` / "Docker Desktop",
docker 29.4.1 — the **same daemon that rejected propagation** in `propagation-spike.sh`)
and reported **PASS=7 FAIL=0**:

- ✅ an **unprivileged** container sees the overlay-merged LOWER content — the
  daemon performed the `mount -t overlay`, no propagation, no `CAP_SYS_ADMIN`;
- ✅ writes copy-up into the **per-session upper**, the shared **base stays
  immutable**;
- ✅ **two concurrent sessions** sharing one read-only base, each with its own
  upper, mount with **no EBUSY** and writes stay **isolated**.

**This is the decisive result.** The mechanism works on the exact target where the
sidecar/propagation design is dead, so:

1. **Docker Desktop/Windows-WSL2 flips from "no-overlay fallback" to overlay-eligible.**
2. **The privileged sidecar and the shared-propagation prerequisite can be dropped
   from the design** — fewer moving parts, no startup propagation probe, no
   re-arm-on-boot, no `CAP_SYS_ADMIN` anywhere. Teardown ordering is also handled
   by Docker (the daemon unmounts the overlay when the last container stops; we
   just `docker volume rm`), removing the disk-janitor unmount-before-rm hazard.

**→ Decision: adopt the daemon-performed `local`-volume overlay as the §4
mechanism; demote the privileged sidecar to a rejected alternative.** (plan §4
updated.)

> **Docker Desktop / Windows-WSL2 run:** PASS=7 FAIL=0, daemon `docker-desktop`
> (Docker Desktop), docker 29.4.1. "DAEMON-MOUNTED OVERLAY WORKS — no sidecar, no
> propagation needed." *(This run used the earlier **scratch-sibling** layout —
> base/upper/work as siblings in a dedicated volume.)*

**Confirm-before-build — CLOSED.** The mechanism is now proven in the **production
layout** (base in `overlay-base/<hash>/`, upper/work in `sessions/<uuid>/`,
**cross-subtree nested subpaths of the one workspace volume**) on **both** a
Docker Desktop daemon and a bare-Linux systemd daemon — the two axes that were
open. Nothing else is gated before building Phase 2 (mount-cost timing remains a
nice-to-have measurement, not a gate).

> **Linux / VPS run (updated prod-layout spike):** PASS=7 FAIL=0, daemon
> `shipit-16gb` (Ubuntu 24.04.4 LTS), docker 29.5.2, linux/amd64. "DAEMON-MOUNTED
> OVERLAY WORKS in the PRODUCTION layout — no sidecar, no propagation, no
> privilege." Confirms the cross-subtree nested-subpath layout **and** a
> non-Docker-Desktop Linux daemon.
> **Docker Desktop / Windows (scratch-sibling layout):** PASS=7 FAIL=0 (docker
> 29.4.1) — earlier run; the mechanism on that daemon is already proven.
