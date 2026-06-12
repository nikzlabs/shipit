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

## Open question #4 — one shared `type=overlay` volume across N containers (compose/preview) → **RESOLVED (all 3 hosts green)**

`volume-driver-overlay-spike.sh` proved daemon-overlay for a single consumer and for
two **distinct** volumes sharing one read-only lower. The compose/preview path needs
the opposite and untested case: **one** per-session `type=overlay` volume mounted into
the agent container **and** every separate compose dev-server service — the path that
depends on Docker's volume **refcount** performing `mount -t overlay` once and
bind-sharing `_data` into the rest (not a second overlay over the same upper, which the
kernel rejects). [`prototype/shared-volume-spike.sh`](./prototype/shared-volume-spike.sh)
settles it.

**Status: PROVEN on the decisive host — Docker Desktop/Windows-WSL2** (`docker-desktop`,
docker 29.4.1, linux/amd64). **PASS=8 FAIL=0, cold-trials=25:**

1. 3 containers mounted the **same** overlay volume concurrently — no EBUSY / `upperdir
   is in-use`.
2. **The decisive check — exactly ONE overlay superblock backs all 3 containers**
   (read from the daemon namespace's `/proc/1/mountinfo` via a `--pid=host` probe). This
   confirms Docker did a single `mount -t overlay` + bind-shared `_data`, *not* N
   independent overlay mounts — which is exactly why the kernel's shared-upperdir error
   can't fire.
3. Writes are coherent across containers (agent ↔ service see each other's files); a
   service reads lowerdir content through the merged view.
4. **HMR polling substrate** — a service container sees the agent's fresh writes + an
   updated mtime through the shared mount (what `usePolling`/`WATCHPACK_POLLING` reads).
5. **25 cold-race trials** (fresh `volume rm`+create each, racing first-mount): **0**
   mount errors.
6. Teardown↔startup overlap: a new consumer mounted cleanly while another was stopping;
   merged view intact; still one superblock.

**Empirically confirms the polling design:** cross-container inotify did **not** fire
(the non-gating data point) — exactly as predicted. The mount-namespace boundary between
the agent and a separate dev-server container blocks native inotify, so HMR polls; the
gate is the write/mtime coherence in (4), which passed. ShipIt's own file-tree watcher
(chokidar/inotify) is unaffected — it runs in the agent container, same namespace as the
mount.

**Significance.** This is green on the very host where the rejected sidecar/propagation
approach died, so the shared-volume compose/preview mechanism is proven on the hardest
target. Remaining: re-run on the **prod VPS (ext4)** and **Docker Desktop/Mac** to
complete the matrix; green on both retires Open Q #4 and unblocks the compose-generator
wiring (point overlay-session services at the per-session overlay volume by subpath).

> **Docker Desktop / Windows-WSL2 run:** PASS=8 FAIL=0, daemon `docker-desktop`
> (Docker Desktop), docker 29.4.1, linux/amd64, cold-trials=25. "SHARED type=overlay
> VOLUME ACROSS N CONTAINERS WORKS — one daemon overlay mount, bind-shared into every
> consumer, no EBUSY." Cross-container inotify did not fire (expected; HMR polls).
> **Docker Desktop / Mac run:** PASS=8 FAIL=0, daemon `docker-desktop` (Docker Desktop),
> docker 29.5.3, **linux/arm64**, cold-trials=25. Identical result on a different arch —
> single superblock, 0 EBUSY across 25 cold-race trials, polling substrate green,
> cross-container inotify did not fire (expected).

> **Prod VPS run:** PASS=8 FAIL=0, daemon `shipit-16gb` (Ubuntu 24.04.4 LTS), docker
> 29.5.2, linux/amd64, **cold-trials=50**. Native (non-VM) Linux daemon on **ext4** —
> the actual production substrate and the storage driver the other two hosts didn't
> exercise. Single superblock, 0 EBUSY across 50 cold-race first-mounts, polling
> substrate green, teardown overlap clean. Cross-container inotify did not fire (expected).

**Matrix COMPLETE — 3 of 3 green → Open Q #4 RESOLVED.**

| Host | Arch / kernel | Storage | Trials | Result |
|---|---|---|---|---|
| Docker Desktop/Windows-WSL2 | amd64 / LinuxKit VM | overlay2-on-overlay2 | 25 | ✅ PASS=8/8 |
| Docker Desktop/Mac | arm64 / LinuxKit VM | overlay2-on-overlay2 | 25 | ✅ PASS=8/8 |
| Prod VPS `shipit-16gb` | amd64 / native Ubuntu 24.04 | **ext4** | 50 | ✅ PASS=8/8 |

The decisive property held on every target: Docker's `local`-volume refcount performs
**exactly one** `mount -t overlay` and bind-shares `_data` into every additional
container (verified by the single-superblock probe), so the kernel's shared-`upperdir`
error never fires and N containers — the agent + every compose service — get one
coherent merged view. **Nothing else gates the compose/preview path; proceed to the
compose-generator wiring** (point overlay-session services at the per-session overlay
volume by subpath; dev-server HMR keeps polling, which the write/mtime-coherence check
confirmed works over the shared mount).

## Nested overlay under the `/workspace` bind (dep-dir design — the current gate)

All the runs above proved the overlay **at the `/workspace` root** (the whole-workspace
design). The design pivoted to the **dependency-directory** model: `/workspace` stays a
normal bind (the host clone — source + `.git`, authoritative), and **each declared dep
dir** is a separate `type=overlay` volume mounted at a **nested subpath**
(`/workspace/node_modules`, `/workspace/packages/*/node_modules`). Nothing prior mounted
an overlay volume onto a *subdirectory of an already-mounted parent* — the one unproven
topology gating the dep-dir mount wiring. [`prototype/nested-overlay-spike.sh`](./prototype/nested-overlay-spike.sh)
settles it per host.

**Status: PROVEN on the decisive host — Docker Desktop/Windows-WSL2** (`docker-desktop`,
docker 29.4.1, linux/amd64). **PASS=13 FAIL=0:** nested overlay mounts under the parent
and shows the dep lower; source + `.git` coexist on the parent; copy-up isolation holds
(dep delta → per-session upper / base immutable; source write → the bind, never the dep
upper); two dep dirs at distinct depths merge at once with absent-leaf auto-creation;
two sessions share one read-only base with no EBUSY; one dep overlay volume
refcount-shares across agent + service while nested (HMR-poll substrate confirmed). The
Windows-WSL2 backend is again the decisive host (it's where the rejected sidecar's
propagation failed), so a clean run here is the strongest single signal that the nesting
mechanism is sound.

> **Docker Desktop / Windows-WSL2 run:** PASS=13 FAIL=0, daemon `docker-desktop`
> (Docker Desktop), docker 29.4.1, linux/amd64. All six functional rungs (2–6) green;
> rung 7 (real host-bind parent) correctly auto-skipped on Desktop — the named-volume
> parent in rungs 2–6 exercises the nesting mechanism, and a host bind of the VM's
> volume path isn't shared into Desktop, so the real-bind topology is deferred to the
> VPS run. **Data point:** the daemon also `mkdir -p`'d an absent *parent* chain
> (`/workspace/ghost/deep/...`), not just the leaf — so prod must still resolve dep dirs
> against the host clone to guarantee the parent is real rather than relying on the
> daemon to invent it.

> **Docker Desktop / Mac run:** PASS=13 FAIL=0, daemon `docker-desktop` (Docker Desktop),
> docker 29.5.3, **linux/arm64**. Same six functional rungs green as Windows-WSL2,
> confirming the topology on the other Desktop backend + a different arch (arm64). Rung 7
> auto-skipped (Desktop), same absent-parent data point observed. Both Desktop backends
> now agree; the only un-run axis is the real host-bind parent on native Linux/ext4.

> **Prod VPS run:** PASS=14 FAIL=0, daemon `shipit-16gb` (Ubuntu 24.04.4 LTS), docker
> 29.5.2, linux/amd64. The decisive run: **rung 7 executed** (native Linux, not skipped) —
> "REAL bind parent: nested overlay merges under a host bind mount (prod VPS topology
> proven)" — so the literal production topology (a `type=overlay` volume nested under a
> real **host bind** on **ext4**) is now validated, not just the named-volume proxy. The
> extra pass vs the Desktop runs (14 vs 13) is exactly rung 7. All other rungs green.

**Matrix COMPLETE — 3 of 3 green → the dep-dir mount-topology gate is CLEARED.**

| Host | Arch / kernel | Storage | Rung 7 (real bind) | Result |
|---|---|---|---|---|
| Docker Desktop/Windows-WSL2 | amd64 / LinuxKit VM | overlay2-on-overlay2 | auto-skipped (Desktop) | ✅ PASS=13/13 |
| Docker Desktop/Mac | arm64 / LinuxKit VM | overlay2-on-overlay2 | auto-skipped (Desktop) | ✅ PASS=13/13 |
| Prod VPS `shipit-16gb` | amd64 / native Ubuntu 24.04 | **ext4** | **✅ ran + passed** | ✅ PASS=14/14 |

**GATE CLEARED.** A `type=overlay` volume mounts cleanly at a subpath nested under the
`/workspace` mount on all three targets, including under a **real host bind on ext4** (the
literal prod topology, rung 7 on the VPS). The dep-dir model's load-bearing properties all
held everywhere: nested merged dep view, source + `.git` coexistence on the parent, copy-up
isolation (dep delta → per-session upper / base immutable; source → the bind), multi-depth
mounts + absent-leaf auto-creation, concurrent shared-base with no EBUSY, and one dep volume
refcount-shared across agent + service. **Proceed to the dep-dir mount wiring** (read
`agent.dep-dirs`; emit N overlay mounts at the dep-dir subpaths; per-dir scope/snapshot;
compose services mounted at the same subpaths). Two carry-forward notes: **(1)** prod must
resolve dep dirs against the host clone so the parent dir is real (the daemon will `mkdir -p`
an absent parent, which we do **not** want to rely on); **(2)** still validate separately —
the recursive file-tree watcher descending into the nested submount (same-namespace inotify
across a mount boundary), via `host-overlay-spike.sh`'s inotify rung.

## Live end-to-end on real Docker (2026-06-10, local dev stack, Docker Desktop/WSL2) — five defects found + fixed

First-ever live exercise of the merged Phases 1–7 (the cloud agent that built them had no
real Docker). Setup: local dev stack (`docker/local/dev/compose.yml`) with
`OVERLAY_DEP_STORE=1`, test repos `template-vue` (npm, ~50 pkgs / 66 MB) and `tanks`.
Every defect below was observed live, root-caused, and fixed behind the flag (one PR each):

1. **The flag never reached the orchestrator** (PR #1230). Neither the dev compose nor the
   VPS compose forwarded `OVERLAY_DEP_STORE` into the `shipit` service env, so
   `isOverlayEnabled()` was always false — exporting the flag on the host (what the
   measurement runbook instructed) silently no-oped. Both stacks now pass
   `OVERLAY_DEP_STORE=${OVERLAY_DEP_STORE:-}` through (default empty = off).

2. **Compose referenced overlay volumes that were never provisioned** (PR #1231). The
   compose path re-derived eligibility instead of consulting actual provisioned state, so a
   session whose agent container predated the flag flip had its whole `compose up` fail with
   `external volume "shipit-<id12>_overlay-<hash8>" not found`. Compose now waits for the
   container (`whenWorkerReady`) and mounts only volumes that exist (`requireProvisioned`).

3. **Cold overlay mounts always failed with ENOENT** (PR #1232). Nothing created the
   `lowerdir`/`upperdir`/`workdir` before the daemon's `mount -t overlay`: a cold scope has
   no published base dir, and the per-session upper/work dirs were created nowhere. Every
   overlay container create failed → the merged Phases 3–7 had never actually mounted on a
   real daemon. Specs now carry orchestrator-visible `orchDirs`, mkdir'd at create.

4. **Stale marker + fresh overlay = dep-less session AND a poisoned shared base**
   (PR #1234). A warm session's clone carried `.shipit/.install-done` from a pre-overlay
   install; the recreated container mounted an EMPTY overlay over the (hidden) deps; the
   marker still matched → `/install` skipped → `install_ok=true` → the publish hook tarred
   the empty merged view and published it as `created:d1g1`. The equal-commit skip then made
   the empty base permanent. Observed twice (template-vue and tanks scopes, both bases 4 KB).
   Fixes: the worker gate distrusts a marker when any declared dep dir is an empty overlay
   mount (`/proc/self/mounts` detection), and the publish declines empty snapshots
   (`skipped-empty` — verified live blocking the poisoning when an old broken container was
   claimed again).

5. **The publish swap broke every live same-scope mount** (PR #1235). The atomic
   rename-over-the-scope-path design assumed pinned lowerdir inodes leave in-flight sessions
   unaffected. Isolated spike (privileged alpine, tmpfs, kernel 6.6):

   ```
   before swap: readdir=2 lookup=a
   after swap:  readdir=0 lookup=a
   ```

   Unlinking a mounted lowerdir breaks merged-**readdir** (returns empty) while path lookups
   still resolve — observed live as three containers whose `node_modules` enumerated empty
   with 66 MB uppers (vite resolved fine; `ls`/`npm`/`tar` saw nothing — which is also what
   fed defect 4's empty snapshots). Bases are now **immutable generations**
   (`overlay-base/<hash>/g<N>`): a publish materializes the next generation beside the
   previous and moves only the pointer; the janitor reaps superseded generations after the
   age cutoff.

Also attributable from this run, no code change:

- **`npm warn tar TAR_ENTRY_ERROR ENOENT` during installs** has two non-overlay-specific
  sources: (a) the template's dev service (`command: sh -c "npm install && npm run dev"`)
  re-running npm over the same shared `node_modules` the agent's `agent.install` populated
  (two npm processes racing one dir — pre-overlay behavior too), and (b) post-defect-5
  broken-readdir views confusing npm's reify. Benign `warn`-level noise in case (a);
  case (b) is eliminated by generational bases.
- **`ETXTBSY` on `esbuild` postinstall**: the dev service's npm install exec'd a binary the
  agent-side install had just written through the shared overlay; the service exited 1 and
  (because the install-running gate had already closed) latched to `error` instead of
  retrying. A manual restart succeeded (`vite ready in 258 ms` through the overlay). Worth a
  follow-up on the service retry window; not overlay-specific.
- **Spawn self-claim + archive recursion** (PR #1236, not overlay-related): `shipit session
  create` from an ungraduated session claimed the calling parent itself (self-parented
  session), and the archive cascade had no cycle guard → "Maximum call stack size exceeded".

### Measured (template-vue, npm, warm npm cache, Docker Desktop/WSL2)

All three runbook scenarios were driven live after the fixes (including the base-hit
marker pre-stamp, PR #1239):

| Scenario | install_ms | outcome | per-session upper | notes |
|---|---|---|---|---|
| Marker-skip (no overlay work) | ~220–970 | — | — | floor is worker roundtrips, not "tens of ms" |
| Cold (empty g0 lower, full npm install) | 2209–3296 | `created:d1g1` | 66 MB | base materialized 75 MB `g1` + pointer w/ marker stamp |
| **`main` unchanged, BEFORE pre-stamp** | 2605 | `skipped-equal` | **66 MB** | full reinstall + full copy-up — zero benefit (the gap) |
| **`main` unchanged, AFTER pre-stamp** | npm skipped | `skipped-equal:d1g1` | **1.1 MB** | standby pre-install: `pre-stamped … (base-hit)` → skip in **25 ms** (was ~4 s); deps served from the shared `g1` lowerdir; the residual upper is the dev service's no-op npm pass |
| `main` advanced (+1 dep on default) | 5640 | `advanced:d2g2` | 1.2 MB | pre-stamp correctly declined (commit mismatch); npm ran a true **delta** over `g1`; `g2` published beside `g1` (generational) |
| Broken-readdir standby re-claimed | 1211 | `skipped-empty` | — | C5 guard declining the poison — by design |

Headline: the warm path went from "full install + 66 MB per session" to "no npm at all +
~1 MB per session" (≈60× per-session disk for same-commit sessions), and the advanced path
does delta-only work. Still open: the **depth sweep 1→16** (needs a sequence of dep-changing
default-branch pushes; nothing measured so far stresses `DEFAULT_DEPTH_CAP=16` — d2 showed no
degradation) and a **flag-off control on a large repo** (template-vue's install is small
enough that cold-with-overlay ≈ plain install; the canary should measure a ~30 k-file repo).
Note for operators: never delete a live scope's current generation by hand — that replicates
the readdir breakage on every session pinning it (the janitor's keep-rules encode this).

## Production canary on the prod VPS (2026-06-11, `shipit-16gb`) — Phase 7 measurement + depth sweep

First production-scale run, on the real always-on target (Ubuntu 24.04, ext4, docker 29.5.2,
4 cores). Flag enabled via `deployment/vps/.env` (`OVERLAY_DEP_STORE=1` — the `.env` file is
read by every compose invocation including the systemd updater/restarter, so the flag survives
restarts and self-updates; delete the file + `restart.sh` to disable). Deployed build:
`main@ece80987`, which includes the two canary-blocker fixes below. Measurement repos:
`nicolasalt/shipit` (the ~31k-file / 491 MB `node_modules` target this feature was sized
against) and `nicolasalt/overlay-canary-183` (a throwaway private repo mirroring shipit's
`package.json`/lockfile, used for all synthetic default-branch dep pushes — real repos got
none). Sessions were driven via `POST /api/sessions/headless`.

### Two production defects found by the canary (both fixed + merged before measuring)

1. **Fresh sessions never got overlay mounts — the feature was inert for exactly its target
   population** (PR #1256). `validDepDirsForOverlay` queried `git check-ignore` with the bare
   dep-dir name; a *directory-only* `.gitignore` pattern (`node_modules/`, the most common
   form — shipit uses it) does not match the bare name while the directory doesn't exist, and
   a fresh clone never has dep dirs materialized. Every fresh clone / warm standby / claim
   silently fell back to a plain install; `docker events` showed zero overlay-volume creates
   across consecutive fresh sessions. Only a pre-existing workspace whose `node_modules` was
   already on disk ever mounted an overlay — which is why the 2026-06-10 local live-test (pre-
   populated workspaces) missed it. Fix: query both bare and trailing-slash forms.
2. **The install gate could resolve before the install ran** (PR #1257). `runInstall` opens
   SSE before POSTing `/install`; the first-connect resync probed `/install/status` pre-POST,
   read `{running:false, lastResult:null}`, and synthesized completion. Observed live:
   `install_ms=1465` for a ~22 s install, compose starting mid-install, and the publish hook
   snapshotting a not-yet-installed dep dir (`skipped-empty` guard caught it; a later snapshot
   would have **published a partially-installed base** which the equal-commit skip then pins).
   Fix: resync only synthesizes after the POST returns, plus one deterministic post-POST
   re-probe so lost-`install_done` recovery no longer depends on SSE timing.

### Measured results (warm npm download cache throughout)

| Scenario | install_ms | outcome | per-session upper |
|---|---|---|---|
| **Flag-off control** — plain full install, serial (marker timestamps) | **~23 000** | — | n/a (491 MB into the host clone) |
| Cold (no base), overlay on, concurrent standby install | 46 969 / 46 417 | `created:d1g1` | full install → 503 MB base published |
| **`main` unchanged — pre-stamped standby** | **npm never ran**; standby ready ~2–3 s after create | (pre-install skipped) | **4 KB** |
| `main` unchanged — claim of a pre-built standby | 5 428–6 666 | `skipped-equal` | 4–316 KB |
| `main` advanced — source-only commits (shipit) | 27 681 | `advanced:d2g2` | 316 KB |
| `main` advanced — one-dep change (canary repo), depths d2…d15 | 22 200–29 532 (median ≈22.5 s) | `advanced:dNgN` | ~hundreds of KB |
| Depth-cap flatten (16th advance) | 22 380 | `flattened:d1g16` | — |
| Post-flatten advance | 22 832 | `advanced:d2g17` | — |

Notes on reading the numbers: `install_ms` includes container create (~1.3 s) + claim/worker
overhead — the marker-skip floor on this host is **~5.4–6.7 s** (vs the 0.2–1 s measured on the
local stack), so harness overhead dominates skips. The two "cold" rows ran with one concurrent
warm-pool standby install (the pool replenishes on every claim and pre-installs in parallel);
the serial flag-off control is the clean baseline.

**What the feature buys, honestly:**
- **Disk: a conditional win — it holds iff concurrent sessions outnumber retained base
  generations.** Per-session dep cost drops 491 MB → 4–316 KB, but the store pays ~0.5 GB per
  *publish* (every default-branch advance followed by a fresh session — source-only commits
  included, as the shipit `advanced:d2g2` row shows), and superseded generations are retained
  until reclaim. Both sides of the ledger are ~0.5 GB units, so the net is
  `(concurrent sessions) − (retained generations)` × 0.5 GB. Under today's reclaim policy
  (30-day cutoff, startup-only sweep) an actively-merged repo retains *more* generations than
  it has live sessions — i.e. **as currently configured the disk claim can invert on busy
  repos**. With a 2–3-day cutoff the win holds for any repo with more than a handful of
  concurrent sessions (the parallel-sessions workflow ShipIt is built around, and the warm
  pool's shape — every standby used to be a full private copy). With generation hardlink-dedup
  (finding 1 below) the win becomes unconditional.
- **Time: the win is the pre-stamp path, and it is unconditional.** A pre-stamped standby skips npm entirely (~23 s
  saved per fresh session at an unchanged tip — the common case). The `advanced` path is
  time-neutral vs plain (~22.5 s either way: npm's idealTree/reify pass over a complete 31k-file
  tree costs about the same as a full extract on a warm cache); its win is disk-only.

### Depth sweep → DEFAULT_DEPTH_CAP decision

15 synthetic one-dep default-branch pushes on the canary repo, one fresh session per push
(d2→d15), then the cap flatten and one post-flatten advance. **install_ms is flat across the
entire range** — 22.2–25 s at every depth (one 29.5 s outlier at d3), flatten itself 22.4 s,
post-flatten normal. No depth-dependent degradation is detectable above harness noise on ext4.
**Decision: keep `DEFAULT_DEPTH_CAP = 16`** (the cap's value is bounded-lineage hygiene +
mount-option length, not performance).

### Operational findings for the flip decision

1. **Generation accumulation is the main pre-flip risk — it decides whether the disk win
   exists at all.** The sweep left
   `overlay-base/<canary-scope>/` holding 17 immutable generations ≈ **7.9 GB for one repo in
   ~30 min of churn** (8.9 GB total with shipit's 3). Superseded generations are reclaimed by
   the disk-janitor only **at orchestrator startup** and only past the `DISK_JANITOR_CACHE_DAYS`
   cutoff (**30 days** on this host). A busy repo advancing a few times/day at ~0.5 GB/gen
   accumulates tens of GB between deploys — run the break-even: two merges/day retains ~60
   generations ≈ 30 GB, versus the ~5–10 × 0.5 GB the same repo would have spent on
   per-session copies without overlay. Two fixes, in order of leverage:
   **(a) hardlink-dedup between generations** — consecutive generations differ by deltas
   measured in hundreds of KB, yet each publish materializes a full independent ~470 MB copy
   (verified: g1…g17 share no inodes). Hardlinking unchanged files from the previous
   generation at publish time makes each advance cost ≈ its delta — the same per-version
   dedup property a content-addressed store gives — and removes the accumulation concern
   outright. **(b) a short dedicated cutoff (2–3 days) plus a sweep that isn't startup-only**
   — the sweep's own justification ("no session container plausibly outlives the cutoff
   without recreate") holds at 2–3 days too. At least one — preferably both — should land
   before any fleet flip; without either, the feature trades per-session disk for store-side
   disk and loses on actively-merged, low-concurrency repos.
2. **`SESSION_WORKER_IMAGE_ID` is not set on the VPS**, so `overlayRuntimeKey()` =
   `unknown|x64` and worker-image rebuilds do NOT rotate base scopes. Correctness still holds
   (the worker-side marker key carries glibc/node and forces a real install on ABI change),
   but after an ABI bump every session pays `advanced`-style npm over a stale-ABI base instead
   of a clean cold. Wire the image id into the orchestrator env at deploy time before flip.
3. **Flag-rollback hazard (code-path analysis; live repro was not exercised).** A marker
   written while deps lived in an overlay upper is trusted after a flag-off restart — the
   `/install` gate only distrusts markers over *empty overlay mounts*
   (`overlayBackedEmptyDepDirs`), and with the flag off there is no overlay mount to contradict,
   while the host-clone dep dir is empty → dep-less session. Follow-up: distrust a matching
   marker whenever a declared dep dir is empty/missing, regardless of mount type. Until then,
   rolling the flag off on a host that ran overlay sessions should be paired with clearing
   `.shipit/.install-done` from unclaimed warm clones.
4. **Publish eligibility lags pushes by ~one session.** Eligibility compares the session HEAD
   against the *bare cache's* default tip, and a session created seconds after a push usually
   claims a warm clone cut pre-push — observed as `skipped-equal`/`skipped-ineligible` on the
   first session after every sweep push (the next session advanced correctly every time). Benign
   (ancestry CAS keeps order; hit-rate cost only), worth knowing when reading canary logs.
5. **`skipped-empty` fired exactly once, pre-fix, by design** — the C5 guard declining the
   early-resolve race's empty snapshot (defect 2 above). Post-fix it has not recurred; during
   the soak it should stay at zero.
6. **Warm standby starvation suppresses the pre-stamp win.** Standby containers are skipped
   once `realCount ≥ maxIdleContainers`; during the sweep most claims got clone-only warm
   sessions (no standby → no pre-install/pre-stamp), so the npm-skip benefit landed on the
   *claim*-side marker path instead. Not a regression (flag-off behaves identically), but the
   "standby ready with zero npm" experience depends on standby capacity.
7. One pre-existing janitor nit observed in every startup log: `failed to delete orphan branch
   shipit/overlay-dep-store-c27joi: remote: Write access to repository not granted` — the
   host-side PAT is read-only; unrelated to the overlay but noisy.

### Would pnpm / Yarn give better savings? (considered 2026-06-11)

Worth asking, because pnpm's design solves the same two problems the overlay targets — and
the comparison clarifies what the overlay is actually for.

- **pnpm** keeps a content-addressable store and **hardlinks** files into each project's
  `node_modules`. For a repo that uses it: per-session disk ≈ KBs (same ballpark as overlay),
  warm installs are link-speed (typically faster than npm's ~22 s reify pass — it skips the
  extract entirely), and — the part the overlay currently lacks — **per-version dedup is
  free**: two dependency states share every unchanged file in the store, so there is no
  generation-accumulation problem at all. On disk economics alone, a pnpm repo beats
  overlay-over-npm today.
- **Yarn v1** materializes full copies like npm — no structural saving. **Yarn Berry PnP
  (zero-installs)** eliminates `node_modules` entirely (zipped cache + `.pnp.cjs`) — the
  largest possible saving, but an invasive compatibility choice (native postinstalls, tools
  that expect a real `node_modules`).

**Why this doesn't replace the overlay: the package manager is the repo author's lever, not
the platform's.** ShipIt runs whatever the repo declares in `agent.install`; it cannot migrate
user repos from npm (the overwhelming default) to pnpm, and the overlay's design goal is
ecosystem-agnostic dep-dir caching (any git-ignored artifact dir, not just the npm layout).
The right reading is: **adopt pnpm's key idea platform-side** — content/hardlink dedup between
base generations (finding 1a) gives the overlay the same per-version economics for every npm
repo, no repo cooperation needed.

**Interaction warning — overlay actively hurts pnpm repos.** A hardlink cannot cross the
overlayfs boundary: linking from the store (plain ext4 mount) into an overlay-merged
`node_modules` fails with `EXDEV`, and pnpm silently falls back to **copying** — restoring the
full ~0.5 GB per-session upper *and* losing pnpm's link-speed installs. A repo already using
pnpm gets strictly worse under overlay than on a plain bind. Today the escape hatch is the
`agent.dep-dirs: []` opt-out in `shipit.yaml`; before any fleet flip the platform should skip
overlay automatically when the repo's lockfile is `pnpm-lock.yaml` (likewise Yarn Berry's
PnP mode, which has no `node_modules` to overlay). Filed as a follow-up; not exercised live on
this canary (no pnpm repo on the host).

### Recommendation

**No fleet flip yet — keep the canary on and soak.** The mechanism is correct end-to-end at
production scale (all publish outcomes incl. flatten exercised; bases verified complete; no
broken-readdir or EBUSY events; generational model behaved exactly as designed), the pre-stamp
time win is unconditional, and the disk win is real for the high-concurrency workflow the
product targets but conditional on generation reclaim (finding 1's break-even). But the
canary itself found two ship-blocking defects on day one, so the soak it interrupted has
effectively just started. Flip preconditions:
(a) ≥ a few quiet days of canary soak — zero `skipped-empty`, zero compose failures mentioning
overlay volumes, disk growth under `overlay-base/` bounded; (b) generation storage work
(finding 1): hardlink-dedup and/or the short dedicated reclaim cutoff — without at least one,
the disk claim inverts on busy repos; (c) `SESSION_WORKER_IMAGE_ID` wired (finding 2);
(d) auto-skip overlay for pnpm / Yarn-PnP repos (the EXDEV copy degradation above). The
rollback-marker follow-up (finding 3) should land before the flip too, since flag-off is the
documented incident response.
