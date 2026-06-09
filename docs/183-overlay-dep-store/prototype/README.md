# Prototypes — overlay-mounted rolling workspace base (docs/183)

These spikes exist to **settle the remaining empirical decisions** in
[`../plan.md`](../plan.md). They are throwaway validation code, not the shipping
feature — kept in-repo so the results are reviewable and reproducible.

The plan splits the work deliberately: prototype the **keyless rolling-base
logic first** (on the current copy substrate), then build the **host-side mount**
(the true gating risk). The two artifacts here mirror that split.

| File | Settles | Runs where |
|---|---|---|
| `rolling-base.ts` + `run-rolling-base.ts` | The publish commit-ancestry CAS, stamped marker, eligibility gates, depth-cap flatten, ordering (open question #3) | Anywhere — `npx tsx` |
| `host-overlay-spike.sh` | The host overlay mount + git/.git/inotify/bind-mount/teardown over the merged dir (open questions #1, #2, #4 — the gate) | **Host only** (needs `CAP_SYS_ADMIN`) |

## 1. Rolling-base logic (runnable anywhere)

```
npx tsx docs/183-overlay-dep-store/prototype/run-rolling-base.ts
```

`rolling-base.ts` is the substrate-agnostic core: a "base" is a directory + a
stamped pointer, with a `materializeBase()` hook that is `cp -a` today and an
overlay publish later. The harness drives it against a **real git repo** so the
`git merge-base --is-ancestor` ordering is exercised for real.

**Result: 33/33 checks pass.** It demonstrates:
- cold start builds **v0 from empty**; unchanged `main` is `skipped-equal` (~0 work);
- a forward `main` **advances** (depth++); the stamped marker only allows a skip
  on an exact `(sourceCommit, runtime, installCommand)` match;
- the CAS is ordered by **commit ancestry, not wall-clock** — a late-but-older
  publisher reads the newer base under the lock and declines (`skipped-not-forward`);
- a **force-push diverged** `main` is correctly not-forward → publish skipped, base
  waits for the next genuinely-forward commit;
- **ineligible** publishers (exit≠0, user-edited deps, Ops source-pinned/non-default)
  run on the base but never publish;
- the **depth cap** triggers a clean reinstall **from empty** (flatten = drift +
  reproducibility reset), and depth never reaches the cap;
- **N concurrent** shuffled publishers converge to the newest commit with no torn
  pointer.

**Timings (this container):** `git merge-base --is-ancestor` ≈ **2.3 ms/call**
(fork+exec dominated) and a full scope lock acquire+release ≈ **0.1 ms/call**.
Both gate only the *publish*, not the install — so the ordering machinery is
confirmed negligible. **Decision: the keyless rolling-base chain logic is sound
and cheap; proceed to the host mount.**

## 2. Host overlay mount (host only — the gate)

```
sudo bash docs/183-overlay-dep-store/prototype/host-overlay-spike.sh [scratch-dir-on-ext4]
```

This **cannot run inside a session container** — see `../FINDINGS.md` for the
capability probe. The script preflights `CAP_SYS_ADMIN` and exits early with an
explanation when absent (as it does in-container), then on a privileged host
validates the nine things the design depends on: overlay mount on ext4,
copy-up/delta capture, whole-workspace generality (writes outside
`node_modules`), git clone + fast-forward on the merged dir, `.git` exclusion on
publish, stacked-lowerdir depth, bind-mounting the merged dir (compose pattern),
inotify incl. copy-up events (file-watcher pattern), and **teardown ordering**
(unmount before workdir removal — the disk-janitor hazard).

**Run it on the prod-equivalent ext4 host and paste the summary into
`../FINDINGS.md`** to close open questions #1, #2, and #4.

### macOS (and the inotify check) — `run-in-docker.sh`

On macOS the mount happens inside Docker Desktop's Linux VM, on the fs that backs
Docker **named volumes** — not the host. To test *that* substrate (and run the
previously-skipped inotify check in one go):

```
bash docs/183-overlay-dep-store/prototype/run-in-docker.sh
```

It runs `host-overlay-spike.sh` inside a `--privileged` Linux container with the
scratch dir on a Docker named volume (VM-native ext4), installing `git` +
`inotify-tools` first. `--privileged` is a stand-in for however the orchestrator
eventually gets mount capability — it validates the substrate, not the
production mechanism (see `../FINDINGS.md`). Works on any Docker host, so it's
also the easiest way to get the inotify result on Linux.

### Cross-container propagation (the sidecar architecture's real gap) — `propagation-spike.sh`

The spikes above prove overlay works *within one container*. The chosen
long-lived-sidecar design needs more: an overlay mounted by the sidecar must be
visible to a **separate session container** through the shared named volume —
i.e. the mount must propagate to the Docker daemon's namespace.

```
bash docs/183-overlay-dep-store/prototype/propagation-spike.sh
```

Driven entirely through the `docker` CLI (so it runs the same on Linux and Docker
Desktop/WSL2), it runs a ladder of propagation setups — plain volume bind
(baseline), `make-rshared`, and the realistic host-mountpoint `:rshared` sidecar
pattern — and reports per rung whether container B sees the overlay-merged
content, ending with a verdict. **Run on BOTH a bare-Linux/VPS host and Docker
Desktop; the verdict can differ** — paste both into `../FINDINGS.md`.

Result so far: VPS ✅ and Docker Desktop/**Mac** ✅, but Docker Desktop/**Windows
(WSL2 backend)** ✗ — propagation is rejected with no user-applicable fix. That
failure motivated the next spike.

### Daemon-performed overlay, no propagation — `volume-driver-overlay-spike.sh`

The sidecar's whole difficulty is *propagation*. Docker's `local` volume driver
sidesteps it: with `--opt type=overlay --opt o=lowerdir=…,upperdir=…,workdir=…`
the **daemon** performs the overlay mount as it builds the container, so the
merged view is in the container by construction — no propagation, no privileged
sidecar, no `CAP_SYS_ADMIN` in our containers.

```
bash docs/183-overlay-dep-store/prototype/volume-driver-overlay-spike.sh
```

Seeds a shared read-only base + two per-session uppers, mounts daemon-overlay
volumes into two **unprivileged** containers, and checks merged visibility,
copy-up isolation, base immutability, and concurrent shared-lower mounts (the
`upperdir in-use` / EBUSY case). **The decisive run is Docker Desktop/Windows-WSL2**
(where `propagation-spike.sh` fails); also run a Linux/VPS host. Paste both
summaries into `../FINDINGS.md`. If Windows passes, this likely **replaces** the
sidecar design — see the "Alternative mechanism" section in `../FINDINGS.md`.
