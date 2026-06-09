---
status: planned
description: Share a warm workspace baseline across sessions via one rolling overlay base per repo runtime; each session runs its real install on top, so it's ecosystem-agnostic with no keys and no lockfile detection.
---

# Overlay-mounted rolling workspace base

> **TL;DR — the proposal.** Instead of copying `node_modules` into each session (today's
> `nm-store` `tar`/`cp -a`), keep **one rolling overlay base per repo runtime**: the
> whole-workspace filesystem state right after a successful install for a compatible runtime.
> A new session mounts that base read-only
> as the overlay `lowerdir`, gets a per-session upper layer for copy-on-write, fast-forwards
> its source with git, and runs its **real install command on top** — doing only incremental
> work. Because we overlay the **entire workspace** (not a dependency subdirectory) and just
> run the install command, the design is **environment-agnostic**: no keys, no lockfile
> detection, no need to know where deps live (`node_modules`, `.venv`, `vendor/`, …). The
> chain stays linear because **only a default-branch install may advance the base, and base
> publishes are serialized per repo runtime** (single-writer). Any session still runs its install
> freely into its *own* upper layer — that never races — but publishing a new base is
> restricted and sequential, so the shared chain can't fork. The orchestrator owns the
> host-side mount; the worker keeps owning the install.
>
> A content-addressed *keyed* variant (skip install on an exact match) is kept as an optional
> [alternative](#alternative-the-keyed-immutable-layer). Reasoning and ecosystem detail are
> in [Research & analysis](#research--analysis) at the bottom.

## Problem

Every session that needs dependencies pays to get them into its workspace. Downloads are
already shared (`/dep-cache`, [075](../075-shared-dependency-cache/plan.md)), and whole
`node_modules` trees are cached and keyed by `sha256(lockfile + runtimeKey + installCommand)`
([148](../148-fast-npm-install/plan.md)). But the cached tree is laid down by a **full
copy** — `tar | tar` → `cp -a` ([nm-store.ts:218-259](../../src/server/session/nm-store.ts#L218-L259))
— which is the remaining per-session cost (tens of thousands of tiny file writes) and burns
disk (one physical copy per session). It also forced an explicit rejection of hardlinking
([nm-store.ts:203-208](../../src/server/session/nm-store.ts#L203-L208)) and only works for a
narrow allowlist of single-lockfile npm/Yarn/pnpm commands — monorepos, Python, and
arbitrary install commands get no speedup at all.

## Proposed design

### 1. Overlay the whole workspace, not a dependency directory

The base is the **entire workspace filesystem state** captured right after a successful
install, mounted read-only as the overlay `lowerdir`; each session writes to its own
`upperdir` (copy-on-write). The install command runs and writes wherever it likes —
`node_modules`, `.venv`, `vendor/`, `target/`, a `.pnp.cjs`, a pnpm store inside the tree —
and the overlay captures the whole diff generically.

This is the key simplification: **we never need to know which ecosystem or where deps live.**
There is no `findLockfile`, no command allowlist, no per-manager "mount target path." The
only per-repo input is the `agent.install` command that already exists in `shipit.yaml`. A
monorepo, a polyglot repo, or a custom install script are all just "run the command, capture
the resulting tree." This supersedes the node_modules-specific `nm-store` copy store entirely.

### 2. Keyless rolling base per repo runtime

Route every session for a **`(repo, runtime fingerprint)`** pair to that pair's one current
base and always run the install on top of it:

- **Nothing changed** → the package manager's up-to-date check makes the install a near
  no-op; the `upperdir` delta is ~empty.
- **Something changed** → the install writes only the delta into the `upperdir`; the merged
  result becomes the next base.

The base is scoped per **`(repo, runtime fingerprint)`** — not per lockfile. The runtime
fingerprint must describe ABI compatibility, not just broad language families: image digest,
arch, libc, and each relevant runtime ABI/version (for example Node's native module ABI,
Python implementation + major.minor / ABI tag, and equivalent compiled-extension boundaries
for other runtimes). That prevents a base with compiled native addons/wheels from being reused
across incompatible runtimes; it is *not* lockfile detection, so it doesn't reintroduce the
thing we're avoiding. That tuple is the unit for the current-base pointer, publish lock/CAS,
depth counter, and janitor cleanup. After that scope is established, "per repo" in this doc is
shorthand for "per repo runtime" unless explicitly stated otherwise.

### 3. Lifecycle of a session

Ideally prep happens **on a warm-pool standby** before activation, so install latency is off
the first-turn critical path — but it is **not** the only install path (see the warning
below), so the base-advance rule must hold regardless of where the install runs:

1. **Mount** the repo's current base as `lowerdir` + a fresh per-session `upperdir`/workdir.
2. **Fast-forward source** with git to the session's checkout (normally the new default-branch
   commit; writes the source diff into the upper layer via copy-up). Record that **`main`
   commit** — it stamps any base this session publishes.
3. **Run `agent.install`** on top of the base (writes only the dep delta into *this session's*
   upper layer — this never races another session).
4. **Maybe advance the base** — publish the merged result as the next base **only if** the
   install exited 0, the install ran before any user/agent dependency edits, the session's
   recorded source base is the remote default-branch commit (normal ShipIt sessions are
   per-session branches cut from `origin/HEAD`, not literally named `main`), **and the
   candidate's `main` commit strictly descends the current base's commit** (see the ordering
   rule below). Otherwise the install result is used by the session but never published.
   Activation hands the user the already-prepped tree.

> **Separate "runs an install" from "advances the base."** There is more than one install
> path: the warm pool pre-installs on standbys ([warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L214-L243)),
> **but that is skipped for untrusted remotes**, and `setupServiceManager` runs
> `runner.runInstall(...)` again **on every activation**, guarded only by the worker marker
> ([service-manager-setup.ts:322-329](../../src/server/orchestrator/service-manager-setup.ts#L322-L329),
> [session-worker.ts:659-663](../../src/server/session/session-worker.ts#L659-L663)).
>
> *Why the on-activation install exists* (so it isn't mistaken for redundant): it's the
> **guaranteed, idempotent backstop**, distinct from the best-effort warm pre-install. It is
> the path that installs (a) **trust-deferred** repos — the untrusted-remote early-return
> ([service-manager-setup.ts:278-289](../../src/server/orchestrator/service-manager-setup.ts#L278-L289))
> skips both warm and on-activation install until the user accepts trust, which **re-invokes
> this same setup** via `runner.rerunServiceSetup` ([container-session-runner.ts:136-141](../../src/server/orchestrator/container-session-runner.ts#L136-L141));
> (b) sessions with **no completed pre-install** (pool miss, unfinished standby); and (c)
> **re-created runners** (idle eviction, restart-agent `docs/127`, reconnect). A validated
> `.shipit/.install-done` marker makes the repeat a no-op only when the checked-out source
> commit, runtime fingerprint, and install command still match, so "every activation" is cheap.
> So the warm pool is *not* the single installer. The
> invariant we actually rely on is narrower and
> must be enforced explicitly: **(a)** any session may run install into its own `upperdir`
> (safe — no shared state); **(b)** only an **exit-0**, pre-user install whose recorded source
> base is the remote default-branch commit may *publish* a new base; **(c)** the publish advances
> the base only if it moves it **forward in `main`'s history** (ordering rule below). That, not
> "one installer," is what keeps the chain linear.

> **Ordering rule — compare by `main` commit, never by publish time.** Each base is stamped
> with the `main` commit it was built from (step 2). On publish, advance the base **iff the
> candidate's commit strictly descends the current base's commit** —
> `git merge-base --is-ancestor <base.commit> <candidate.commit>` true **and** the two differ.
> Equal commit → deps already current, no-op. Behind, or diverged (e.g. a force-push rewrote
> `main`) → **skip the publish**; the session keeps its own tree and the base waits for the
> next genuinely-forward install. A short **per-`(repo, runtime fingerprint)` lock** makes the
> read-compare-swap atomic;
> the *decision* is git ancestry, **not** wall-clock or lock-acquisition order — so an
> older-commit install that grabs the lock late can never clobber a newer base. (This is a
> compare-and-swap keyed on commit ancestry, but the "loser" simply declines to publish — no
> reconciliation, no redo.)

Two properties keep the published chain clean:

- **It advances monotonically.** Normal creation paths branch from the default branch
  (`origin/HEAD`) — manual/warm-pool/unarchive and generic agent-spawned sessions
  ([warm-pool-manager.ts:147-164](../../src/server/orchestrator/warm-pool-manager.ts#L147-L164),
  [claim-session.ts:361-374](../../src/server/orchestrator/services/claim-session.ts#L361-L374),
  [session.ts:202-216](../../src/server/orchestrator/services/session.ts#L202-L216),
  [child-sessions.ts:70-81](../../src/server/orchestrator/services/child-sessions.ts#L70-L81)).
  Generic spawned sessions therefore look like any other fresh claim and are publish-eligible
  only if they satisfy the same pre-user/default-source rules as manual sessions. The only
  non-default reset path here is internal Ops `--shipit-source`, where ShipIt pins a fix
  session to a system-resolved inspected build commit. Those source-pinned sessions run their
  install on the base into their own upper layer but are **excluded from publishing** (rule
  (b)), so they never inject a historical or divergent tree into the chain — which therefore
  stays `main@t1 → main@t2 → …`. They also must not inherit a default-branch install marker:
  any internal source pin or other non-default checkout whiteouts the marker before
  `agent.install`, forcing the real install to validate that checkout's manifests against the
  shared base.
- **Mid-session `npm install foo` never feeds the chain.** That's the agent's own shell
  command, landing in the session's `upperdir` — not `agent.install`. A session's divergent
  dependency work can't pollute the shared base.

The existing **`.shipit/.install-done` marker** is kept in concept, but presence alone is no
longer enough. Today it is deleted when HEAD changes
([claim-session.ts:204-206](../../src/server/orchestrator/services/claim-session.ts#L204-L206))
and checked at [session-worker.ts:659-663](../../src/server/session/session-worker.ts#L659-L663);
the overlay design must upgrade it to a stamped marker containing the source commit it
validated, runtime fingerprint, and install command. A session may skip `agent.install` only
when those fields match its current checkout and base scope. Any non-default checkout/reset,
or any checkout whose source commit differs from the marker's stamped commit, whiteouts or
deletes the marker before `agent.install` runs. That preserves the cheap unchanged-`main` path
without letting source-pinned sessions or historical branches reuse dependencies from the
default branch base blindly.

### 4. Orchestrator owns the host-side mount

The mount can't happen inside the session container — ShipIt's containment model is
unprivileged containers, HTTP-only, no `docker exec` (`docs/172-agent-containment`). So the
**orchestrator mounts on the host and bind-mounts the merged dir into the session**: mount
(lower + upper + workdir) on activate, unmount + clean workdir on disposal, and teach
`disk-janitor` / archive flows about live mounts before they tear down dirs. This is the one
genuinely new subsystem and the gating unknown for the whole proposal.

#### Host-mount design decisions (decided — see [`FINDINGS.md`](./FINDINGS.md))

After the spikes confirmed the substrate, the gate became a design problem, now settled —
including propagation on the prod VPS (proven, see the prerequisite bullet):

- **Mount mechanism — privileged helper driven via `docker.sock`.** The orchestrator stays
  **unprivileged**; it uses the `docker.sock` it already holds (already root-on-host-equivalent)
  to drive a small **privileged helper** that performs the `mount -t overlay` on the daemon
  host with **shared mount propagation**, so the mount lives in the host namespace and the
  daemon can bind the `merged` dir into the session. `CAP_SYS_ADMIN` is confined to that one
  tiny, single-purpose component rather than added to the central long-lived orchestrator.
  *(Rejected: standing `CAP_SYS_ADMIN` on the orchestrator; a custom Docker volume plugin —
  too heavy to build/operate.)*
  - **Helper shape — long-lived privileged sidecar.** A small `--privileged` "mounter" service
    runs alongside the orchestrator and exposes a tiny **mount/unmount API over a local unix
    socket**. It owns a **stable mount namespace** with propagation (`rshared` on the volume
    backing dir) configured **once**, so mount lifecycle, health, and observability are simple
    to reason about. It has no network surface. *(Rejected: ephemeral per-operation
    `--privileged` container — correctness would lean on mount propagation outliving the
    container, a known footgun, plus per-op spawn latency.)*
  - **Prerequisite — shared mount propagation on the daemon host** (partially validated by
    [`prototype/propagation-spike.sh`](./prototype/propagation-spike.sh)). For the sidecar's
    overlay mount to reach a *separate* session container, it must mount under a **shared
    mountpoint** the daemon sees — a dedicated self-bind dir marked `rshared`
    (`mount --bind D D && mount --make-rshared D`). This requires the daemon host's mount
    tree to support shared propagation. **It splits by virtualization substrate — so
    "Docker Desktop" is not one answer.** Status by target:
    - **systemd Linux VPS — proven on prod, no setup.** `propagation-spike.sh` rung A2 ran on
      the prod VPS (systemd, docker 29.5.2, linux/amd64) and reported PROPAGATED on the plain
      run — systemd mounts `/` rshared at boot, so the `:rshared` bind is accepted with no
      provisioning. The always-on #1 install target is confirmed; the open blocker that gated
      the Phase 1 nm-store deletion is **closed**.
    - **Docker Desktop / macOS — propagation works with no setup, proven.** The LinuxKit VM
      mounts `/` shared by default (rung A2 PROPAGATED, docker 29.5.3, arm64). **Open caveat:**
      the spike did not confirm this survives a **VM restart** (the LinuxKit VM is recreated
      routinely); Phase 2's startup probe must **re-verify/re-arm propagation on each daemon/VM
      start**, not assume one-time setup persists.
    - **Docker Desktop / Windows (WSL2 backend) — CONFIRMED to NOT propagate.** Tested on a
      real Docker Desktop/Windows install (docker 29.4.1; `docker info` → `docker-desktop` /
      "Docker Desktop"): every rung — plain volume, runtime `make-rshared`, and even a
      dedicated self-bind shared mountpoint — was **rejected** by the daemon. The daemon lives
      in Docker Desktop's managed `docker-desktop` WSL2 distro, whose mount topology refuses
      the `:rshared` source even when `/proc/1/mountinfo` reads shared, and the distro is
      managed/ephemeral so there's **no user-applicable `MountFlags=shared` fix**. → This is a
      **confirmed plain-install-fallback target**, and a *mainstream* one (a common Windows
      local-dev setup), not a narrow edge. (An earlier draft mislabelled this run as "bare
      docker-ce-in-WSL2" — it was Docker Desktop; corrected.)
    - **Native docker-ce inside a WSL2 distro (no Docker Desktop) — UNTESTED.** Likely also
      private `/`; if so, `MountFlags=shared` + restart is at least *possible* because the user
      owns the dockerd unit. TBD — run the spike there to classify it.

    So the requirement is "shared propagation on the daemon substrate," documented as a
    prerequisite, detected at startup; overlay is not lost where it's absent, it degrades to a
    plain install. Overlay-eligible (proven): VPS + Docker Desktop/Mac. No-overlay fallback
    (confirmed): Docker Desktop/Windows.
  - **No copy-store fallback — `nm-store` is removed, not retained.** Where overlay is
    unavailable the fallback is simply running `agent.install` into the workspace as today,
    warmed by the **existing download cache** (`/dep-cache`, [075](../075-shared-dependency-cache/plan.md))
    — a *separate* subtree from `nm-store`, so a plain install pulls tarballs locally with **no
    network**. Note this removes network only, **not** the node_modules extract/link cost (the
    tens-of-thousands-of-tiny-writes that dominate a large-tree install — e.g. ~24s for ShipIt's
    own repo); that extract cost is precisely what the overlay warm-base path eliminates and the
    fallback still pays. So the fallback is "correct + network-free," not "fast." The `nm-store`
    materialization (`tar`/`cp -a`, lockfile detection,
    command allowlist, store keying) adds nothing the overlay base doesn't do better and is
    **deleted entirely** ([nm-store.ts](../../src/server/session/nm-store.ts)), leaving exactly
    two paths: overlay (warm, near-no-op) or plain full install (correct everywhere).
- **Storage layout — single workspace volume, base in the dep-cache subtree.** Per-session
  `upper`/`work`/`merged` live under the session subtree (`sessions/{uuid}/`); the shared base
  (lowerdir) lives under the per-repo **dep-cache** subtree — already cross-session shared,
  mounted, and GC'd per repo, the natural home for a per-`(repo, runtime)` base. Everything is
  on the one workspace named volume (one fs → satisfies overlay's upper+work+merged same-fs
  rule). **How the merged dir reaches the session:** the session's volume-Subpath mount
  (`buildMounts`, [container-lifecycle.ts:97-104](../../src/server/orchestrator/container-lifecycle.ts#L97-L104))
  resolves the `merged` subpath, but a Subpath mount does **not** by itself surface a *nested*
  mount the sidecar created inside the volume — the merged dir only appears in the session
  **because the overlay mount propagated into the daemon's namespace** (the `rshared`
  prerequisite above). The Subpath mechanism and propagation are not separable steps: Subpath
  is the addressing, propagation is what makes the nested overlay visible. **Unverified gap:**
  `propagation-spike.sh` validated a *direct bind-mount* of merged into a sibling container,
  **not** the volume-Subpath path production actually uses — Phase 2 must verify the overlay
  surfaces through a real volume-Subpath mount, not only a direct bind.
  *(Rejected: a dedicated overlay volume — extra plumbing for the janitor/helper without a
  clear win at single-user scale.)*

### 5. Bounding drift and overlay depth

Re-running install over generations can leave extraneous packages or stale links, and
stacked `lowerdir`s are limited (mount-options must fit in a page; Docker overlay2
historically capped at 128). **Decision: depth-cap-triggered clean rebuild.** When the
overlay stack reaches a **specific configured depth** (a tunable on the order of ~10–20,
deliberately well below the environment's hard limit), rebuild the base from **empty** — a
clean reinstall, not a layer collapse — so every flatten doubles as a reproducibility reset.
This single mechanism bounds both overlay depth and incremental-install drift; no separate
periodic clean-rebuild schedule is needed.

## Decisions (this iteration)

> **Prototype status:** the keyless rolling-base **logic** is built and validated —
> [`prototype/run-rolling-base.ts`](./prototype/run-rolling-base.ts) (33/33 against a real git
> repo); the host overlay mount has a ready spike,
> [`prototype/host-overlay-spike.sh`](./prototype/host-overlay-spike.sh), that must run on the
> ext4 host (it **cannot** run inside a session container — no `CAP_SYS_ADMIN`). Results and
> timings in [`FINDINGS.md`](./FINDINGS.md), how-to in [`prototype/README.md`](./prototype/README.md).

- **Sequencing:** prototype the **keyless rolling-base logic first** (on the current copy
  substrate), then build the host-mount subsystem. *Caveat:* the host-side mount remains the
  true gating risk — validating the chain logic first does not de-risk it, so keep it next in
  line. *(Logic prototype done; host spike written and pending a host run.)*
- **Environment-agnostic:** overlay the **whole workspace**; no ecosystem/target-path
  knowledge. Settled by §1.
- **Skip policy:** keyless + upgrade the existing marker/`headChanged` skip into a stamped
  marker (source commit + runtime fingerprint + install command). Unchanged `main` still skips
  at ~0, but non-default checkouts and mismatched marker stamps must delete/whiteout the marker
  before `agent.install`. No manifest fingerprint for now.
- **Base advancement is restricted and ordered by `main` commit — not "one installer."** The
  code has multiple install paths (warm-pool pre-install, *skipped for untrusted remotes*; and
  an on-activation `runInstall` guarded only by the marker), so we cannot rely on the warm pool
  being the sole installer. Instead: any session runs install into its **own** `upperdir` (no
  shared state, no race — installs need not be serialized), and only an **exit-0**, pre-user
  install whose recorded source base is the remote default-branch commit may **publish** a new
  base. A publish advances the base **only if its `main` commit strictly descends the current
  base's commit** (`git merge-base --is-ancestor`), under a short per-`(repo, runtime
  fingerprint)` lock that makes the read-compare-swap atomic. The decision is **commit ancestry,
  not publish/wall-clock time**, so a late-but-older install can't clobber a newer base; a stale
  or diverged publish is simply **skipped** (no reconciliation, no redo). This is a
  compare-and-swap keyed on commit ancestry — lighter than the loser-reconciliation we ruled out.
  Internal Ops source-pinned sessions, any other session whose source base is not the remote
  default commit, and sessions with user/agent dependency edits before publish run on the base
  but never publish (§3), and their non-default checkout invalidates any inherited install
  marker before install so they cannot skip against default-branch dependencies. Generic
  agent-spawned children branch from the same freshly fetched `origin/HEAD` claim path as
  manual sessions and follow the same publish rule.
- **Flatten = clean reinstall.** When the depth cap is hit, rebuild the base from **empty**
  rather than collapsing layers, so every flatten is also a correctness reset (no separate
  clean-rebuild schedule needed). The **depth cap is a specific tunable value** (on the order
  of ~10–20, revisited from measurement), deliberately well below the environment's hard
  layer limit — not the max itself.
- **Cold start & trust:** the first prep for a repo builds base **v0 from empty**, under the
  **existing repo trust gate** (`docs/178`) — no new gate; base creation simply rides the
  trust decision already made when the repo was added.
- **Sharing scope:** single-user deployment today, so a base is effectively per repo runtime
  for the one user. Cross-user sharing (and its secret-leak surface) is **deferred** until
  ShipIt has a multi-user model.
- **Capture filter:** capture the workspace **as-is**, with **one exclusion: `.git`** (see
  below). No secret-filtering — env-var secrets are never written to the tree (so not
  captured); the only on-disk vector is an injected credential file (e.g. private-registry
  `.npmrc`) or a committed `.env`, both of which stay within the single user / are already in
  git.

  *Why exclude `.git`:* the base is captured on **some session's branch** (post-install,
  pre-agent), so its `.git` holds that session's branch ref, `HEAD`, and reflog. If the base
  carried `.git` forward, the next session would inherit a stale branch/`HEAD` instead of its
  own. Each session must bring its **own** `.git` — via the normal repo-cache clone + the
  per-session branch cut from `origin/HEAD` — which lands in the session's upper layer. So
  `.git` is excluded from the shared base for **correctness** (not security); the base
  contributes only the install output + checked-out source *contents*. (Worktree gitdir
  pointer files use absolute paths — confirm they resolve under the overlay; tracked in
  Open Questions.)
- **Archive/restore:** **re-derive on unarchive** — persist only source/metadata; on
  unarchive re-clone and reinstall from the current base. We never persist the per-session
  `upperdir`, which removes the upper-layer ↔ base-generation coupling: base generations need
  only respect **live** mounts, not archived sessions.
- **Bad-base gate:** advance the base **only when the install exits 0**. A non-zero install
  still serves the current session's tree but is never published as the base.

## Implementation phases

Ordered; see [`checklist.md`](./checklist.md) for the per-phase task list. **Phase 1 deletes
nm-store first** — a clean, self-contained simplification — then the overlay subsystem is built
on top of the simplified install path.

0. **Prototypes & decisions** *(done)* — rolling-base logic (33/33), overlay substrate
   (WSL2 + Docker Desktop/Mac), and the §4 design are settled. Cross-container propagation is
   proven on the two overlay-eligible substrates: Docker Desktop/**Mac** and the **prod systemd
   VPS** (`propagation-spike.sh` rung A2 PROPAGATED, plain run, docker 29.5.2). **Docker
   Desktop/Windows (WSL2 backend) is confirmed NOT to propagate** (no user-applicable fix) →
   plain-install fallback; native docker-ce in a WSL2 distro is untested.
1. **Delete the nm-store fast path** — remove the copy store + its gate wiring; keep
   `runtimeKey`/`detectLibc` (overlay reuses it) and `tuneNpmInstall`; the worker install path
   becomes marker-skip-or-plain-`agent.install` (download cache stays). Mark
   [148](../148-fast-npm-install/plan.md) superseded. *Interim:* fast-path-eligible repos pay a
   full install per fresh session until Phase 3 — a conscious, temporary regression with a known
   end date now that overlay is proven on the prod VPS.
2. **Host-mount sidecar subsystem** — the long-lived privileged sidecar (mount/unmount over a
   unix socket, dedicated self-bind `rshared` mountpoint), orchestrator wiring, the startup
   shared-propagation probe that **re-verifies/re-arms propagation on every daemon/VM start**
   (not a one-time setup — guards the Docker Desktop VM-restart case) and selects overlay vs
   plain-install fallback, verification that the overlay surfaces through the **real
   volume-Subpath mount** (not only a direct bind), `disk-janitor`/archive teardown ordering, and
   the VPS propagation + mount-cost confirmation.
3. **Rolling-base logic wired to the real install** — per-`(repo, runtime fingerprint)` scope,
   base in the dep-cache subtree + per-session upper/work/merged, the stamped marker, the publish
   commit-ancestry CAS, the exit-0 gate, depth-cap flatten, `.git` exclusion, cold-start v0.
4. **Session lifecycle integration** — on-activation install → publish rule, eligibility
   exclusions (Ops source-pin / non-default / user-edited), re-derive on unarchive, compose +
   watcher production wiring.
5. **Measure & tune** — warm-vs-cold install timing on the containerized path, set the depth cap,
   optional manifest-fingerprint skip.

## Open questions

These are now mostly **empirical / feasibility** items to settle in the prototype — the
design decisions are made (see Decisions). Status of each is tracked in
[`FINDINGS.md`](./FINDINGS.md); #3 is resolved, #1/#2/#4 are pending a host run of
[`prototype/host-overlay-spike.sh`](./prototype/host-overlay-spike.sh).

1. **Host-mount feasibility (the gate).** Can the orchestrator own a per-session
   whole-workspace overlay (mount on activate, unmount + workdir cleanup on dispose) within
   the containment model (`docs/172`), on the prod VPS's ext4? overlayfs works on ext4, but
   the privileged host-side mount + teardown ordering with `disk-janitor` is unproven.
   *Status: substrate **confirmed** — spike passed **WSL2/ext4 19/19** and **Docker Desktop/Mac
   21/21** (named-volume substrate, incl. inotify): mount, CoW with immutable base, 16-deep
   stacked lowerdirs, bind-mount of the merged dir, safe teardown ordering. But the spikes ran
   `--privileged`/root-with-`CAP_SYS_ADMIN`, which sidesteps the real shape of the gate: the
   orchestrator runs as an **unprivileged container** (only `docker.sock`, no
   `cap_add: SYS_ADMIN` — `docker/local/prod/compose.yml`), and session workspaces are Docker
   **named volumes** whose bind-mounts the **daemon** resolves. So "orchestrator owns the
   host-side mount" needs (a) a mount-capable mechanism (add the cap, a privileged helper, or
   go through the daemon) and (b) the `merged` dir on the **daemon-host fs**, not the
   orchestrator container's private fs. This holds identically on Linux and on macOS local
   Docker (where everything runs inside the Docker Desktop **Linux VM**; keep overlay layers on
   the VM's native ext4, not a FUSE-backed host path — confirmed by the Mac run). Remaining to
   close: resolve the **privilege/daemon-host-fs mechanism** (the real gate now), plus a
   nice-to-have run on the prod (non-WSL/non-Desktop) kernel and mount/unmount timing — see
   [`FINDINGS.md`](./FINDINGS.md).*
2. **Source + `.git` on the overlay.** ✅ **Resolved** (WSL2/ext4 + Docker Desktop/Mac): clone +
   fast-forward work on the merged dir, a linked worktree's absolute gitdir pointer resolves,
   and a published base carries source contents with `.git` excluded cleanly.
3. **Publish ordering by commit ancestry.** ✅ **Resolved** by
   [`prototype/run-rolling-base.ts`](./prototype/run-rolling-base.ts). The base advances only
   when a candidate's `main` commit strictly descends the current base's commit (§3). The
   `git merge-base --is-ancestor` check (~2.3 ms/call) + short per-`(repo, runtime
   fingerprint)` lock (~0.1 ms/call) are confirmed cheap and gate only the *publish*. Diverged
   history (force-pushed `main`) is handled conservatively: skip the publish, let the next
   forward commit re-advance. A late-but-older publisher correctly declines (ancestry, not
   wall-clock).
4. **Compose + file watcher over the merged dir.** ✅ **Resolved.** Bind-mounting the overlay
   **merged** dir reads through to the base and writes via the bind reach the upper
   (compose-service pattern); `inotify` over the overlay sees both plain creates and copy-up
   modifies. Confirmed on Docker Desktop/Mac (named-volume substrate, `run-in-docker.sh`,
   21/21 incl. inotify) and bind-mount-corroborated on WSL2.

*Resolved this iteration (see Decisions): concurrency (installs run into each session's own
upper — no serialization needed; base publishes restricted to exit-0 pre-user installs whose
recorded source base is the remote default-branch commit, and advance only forward by
**`main`-commit ancestry**, a compare-and-swap with no reconciliation), flatten
(depth-cap-triggered clean reinstall, specific tunable cap), cold start + trust (build v0 under
the existing repo trust gate), sharing scope (single-user), secret capture (as-is, no filter),
archive/restore (re-derive on unarchive), bad-base (exit-0 gate).*

## Key files

| Concern | File |
|---|---|
| dep-cache dir + mount + env | [container-lifecycle.ts](../../src/server/orchestrator/container-lifecycle.ts#L83-L211), [session-dir-factory.ts](../../src/server/orchestrator/session-dir-factory.ts#L56-L66) |
| Today's node_modules copy store (superseded) | [nm-store.ts](../../src/server/session/nm-store.ts#L218-L309) |
| Install paths (warm-pool pre-install + on-activation) | [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L214-L243), [service-manager-setup.ts](../../src/server/orchestrator/service-manager-setup.ts#L322-L329) |
| Install gate + marker / `headChanged` skip | [session-worker.ts](../../src/server/session/session-worker.ts#L649-L707), [claim-session.ts](../../src/server/orchestrator/services/claim-session.ts#L204-L206) |
| Default-branch creation paths | [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L147-L164), [claim-session.ts](../../src/server/orchestrator/services/claim-session.ts#L361-L374), [session.ts](../../src/server/orchestrator/services/session.ts#L202-L216) |
| Generic spawned sessions + internal Ops source pin | [child-sessions.ts](../../src/server/orchestrator/services/child-sessions.ts#L70-L81) |
| Cache cleanup | [disk-janitor.ts](../../src/server/orchestrator/disk-janitor.ts#L568-L676) |

---

# Research & analysis

*This section is the investigation that led to the proposal above. With the **whole-workspace**
overlay (§1) the per-ecosystem and target-path detail below is **background, not a
requirement** — we run the install and capture the tree regardless. It's kept to explain why
overlay beats copy/hardlink and where each manager's costs come from.*

## The one axis that decides everything

A package manager either **dumb-copies** files into the project (no native dedup) or
maintains a **content-addressable store + hardlinks/reflinks** into the project. That
single property decides whether a ShipIt-side overlay/canonical-volume adds anything:

- **Dumb-copy managers** (npm, Yarn classic, Yarn `node-modules` linker, pip→venv):
  no native dedup → a ShipIt overlay/canonical-volume is a **real win**.
- **Store-based managers** (pnpm, uv, conda, Yarn PnP): they **already** do this →
  adding our own *hardlink* layer on top is redundant or slower. (Overlay still helps,
  because a warm base makes even their install a near no-op and shares disk.)

## Node ecosystem

| Manager | On-disk model | Overlay value | Notes |
|---|---|---|---|
| **npm** | Real copied `node_modules`, no dedup | **High** | Copy is the remaining cost |
| **Yarn classic (v1)** | Real copied `node_modules` | **High** | Same as npm |
| **Yarn Berry, `node-modules` linker** | Real copied `node_modules` | **High** | `nodeLinker: node-modules` |
| **Yarn Berry, PnP** | No `node_modules`; `.pnp.cjs` + zip cache | Captured by whole-workspace overlay | Nothing special to do |
| **pnpm** | Global store + **hardlinks** into `node_modules/.pnpm` | Warm base = near no-op install | Don't stack a hardlink store |

## Python ecosystem

| Tool | On-disk model | Overlay value | Notes |
|---|---|---|---|
| **pip + venv** | Copies into `site-packages`; built-wheel cache | **Medium** | Wheel cache already kills the slow part |
| **poetry** | pip/venv under the hood | **Medium** | Same as pip+venv |
| **uv** (Astral) | Global cache + **hardlink/reflink** into venv | Warm base = near no-op | The pnpm of Python |
| **conda** | pkgs cache + hardlinks into envs | Warm base = near no-op | — |

### Python's venv wrinkle — dissolved by whole-workspace overlay

A virtualenv hardcodes absolute paths in `pyvenv.cfg`, activation scripts, and console-script
shebangs, so a venv laid down by **copy or hardlink** at a *different* path breaks. With the
**whole-workspace** overlay this is a non-issue: the venv lives inside the workspace, is
captured in the base, and is presented back at the **same** workspace-relative path. Since
ShipIt's workspace root is constant (`/workspace`), the venv's baked-in absolute paths stay
valid with no rewriting and no special handling.

## Strategy comparison (getting the cached tree into a session)

| Strategy | Speed | Disk usage | Cross-filesystem | Privileges | Mutation safety |
|---|---|---|---|---|---|
| **Full copy** (today) | Slow (tens of k tiny files) | 1 physical copy per session | Works anywhere | None | Trivially isolated |
| **Hardlink from store** (pnpm-style) | Near-instant | Shared inodes | **No** — needs same fs | None | Safe *iff* tools write-by-rename; in-place edits corrupt store |
| **OverlayFS (CoW)** | Near-instant (a mount) | Shared until write | Lower layer can differ; **upper + workdir must share fs** | `CAP_SYS_ADMIN` in-container, or host-side mount | Isolated by design (copy-up + whiteouts) |

### The same-filesystem caveat

Hardlinks and reflinks **cannot cross mount boundaries**. OverlayFS is more forgiving: only
its upper + work dir must share a filesystem; the read-only lower layer can live elsewhere —
fitting ShipIt's volume layout better than hardlinks do, and avoiding the silent pnpm/uv
fall-back-to-copy that a separate-mount store would cause.

### Overlay operational cost

- Container rootfs is already overlayfs; a **nested** overlay inside an unprivileged
  container needs `CAP_SYS_ADMIN`-ish config — friction ShipIt avoids. Hence the
  host-side-mount route in the proposal.
- Lower layer must be **immutable** (the base is published, never edited in place).
- **ext4 on the prod VPS**: reflink (`cp --reflink`) is out (ext4 has no reflink), but
  overlayfs works fine on ext4.
- Runtime-fingerprint discipline matters: native addons / compiled wheels are arch + libc +
  interpreter-version specific and must scope the base.

## Why overlay, not hardlink

Hardlink and overlay are **not co-equal** — the choice is deployability vs. correctness:

| | Hardlink ladder | OverlayFS |
|---|---|---|
| New architecture | None — swap the materialize ladder | Privileged mount layer + per-session mount lifecycle |
| Privileges | Unprivileged | `mount(2)` needs `CAP_SYS_ADMIN` |
| Works on prod today | Yes | Needs the host-mount plumbing first |
| Teardown | `rm` the workspace | Unmount + clean workdir on disposal |
| Cross-filesystem canonical | **No** — same fs required | **Yes** — only upper + workdir share an fs |
| In-place mutation (`patch-package`, hand-edit) | **Corrupts the shared store** unless guarded | Copy-up isolates it — base is immune |
| Whole-workspace (ecosystem-agnostic) | Awkward — hardlinks a tree you must enumerate | Natural — mount one tree |
| Cache cost | Create N links (large for big trees) | One mount, O(1) regardless of tree size |

Overlay wins on every axis **except** the one-time cost of building the mount layer. Its
decisive advantage is uniformity: one read-only lowerdir is shared by unlimited concurrent
sessions and captures the whole workspace regardless of ecosystem — that's what overlayfs
lowerdirs are for.

## Alternative: the keyed immutable layer

An earlier iteration routed by a **content-addressed key** —
`sha256(lockfileName + lockfileContent + runtimeKey + tunedInstallCommand)` — and on an
**exact match skipped the install entirely**, mounting an immutable per-key dependency layer.
Why the keyless rolling base is preferred instead, and what the keyed variant still buys:

- **Keyed pros:** the hit path is **~0** (a mount, no installer process) and fully
  **reproducible** and **concurrency-safe** by construction. Per-key routing would also avoid
  cross-branch thrash — but that isn't a real scenario today (sessions only branch from the
  default), so this pro is mostly theoretical.
- **Keyed cons (why it's not primary):** it depends on **detecting the lockfile** and
  isolating the dependency directory — exactly what we're avoiding. Today's `findLockfile`
  only handles a *single top-level* lockfile and deliberately punts **monorepos**, and
  `isCacheableInstall` only fast-paths a narrow command allowlist. The whole-workspace keyless
  base sidesteps all of it.
- **Reconciliation:** a keyed *skip* can be re-added later **without** fragile detection, via
  a **detection-free manifest fingerprint** (hash *all* manifest files by a fixed glob, not
  "the one lockfile"). So the keyed fast path is an optional optimization on top of the
  keyless base, not a competing design.

## Related docs

- [075-shared-dependency-cache](../075-shared-dependency-cache/plan.md) — the download cache
- [148-fast-npm-install](../148-fast-npm-install/plan.md) — the materialized `nm-store`
- [162-fast-install-gate-race](../162-fast-install-gate-race/plan.md) — synchronous fast-path gate
