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
