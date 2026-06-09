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

## Open questions #1, #2, #4 — host overlay mount → **BLOCKED on host run (cannot validate in-container)**

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
host mount remains the gating risk and is **not de-riskable from inside a
session container** — the spike script is the next concrete step, to be run on
the host.
