# Checklist — overlay-mounted rolling workspace base

Design proposal. Core decisions: **overlay the whole workspace** (environment-agnostic, no
keys / no lockfile detection); **keyless rolling base per `(repo, runtime)`**; **installs
serialized through the warm pool** (the single base-advancer, no concurrency / no CAS); keep
the existing marker/`headChanged` skip; **depth-cap-triggered clean reinstall** (specific
tunable cap); **re-derive on unarchive**; **exit-0 base-advance gate**; cold start builds v0
from empty under the **existing** repo trust gate. Prototype the rolling-base logic first;
the host mount stays the gating risk.

- [ ] Prototype the keyless rolling base on the current substrate: mount current base →
      git fast-forward source → run real install on top → publish on exit 0 (serial)
- [ ] Measure warm-install time: `main` unchanged (warm no-op, ~marker skip) and `main`
      advanced its deps (incremental) vs. cold
- [ ] Spike the orchestrator host-side **whole-workspace** overlay mount (mount on activate,
      unmount + workdir cleanup on dispose); size its cost — the gating unknown
- [ ] Confirm host kernel/fs support overlayfs lowerdir sharing on the prod VPS (ext4)
- [ ] Make `disk-janitor` aware of live overlay mounts before teardown
- [ ] Verify the host-mount route stays within the containment model (docs/172)
- [ ] Confirm git fast-forward behaves on the overlay and the source diff in the upper
      layer stays small (`t → t'`)
- [ ] Scope the base per `(repo, runtime fingerprint)` so a base is never reused across
      incompatible runtimes (arch + libc + interpreter)
- [ ] Make the warm pool the single **serial** base-advancer; funnel pool-miss + unarchive
      + any direct-create through the same serial installer; measure throughput / pool-miss wait
- [ ] Set a **specific** depth cap (~10–20, tunable); on hit, rebuild base from empty (clean
      reinstall = drift + reproducibility reset)
- [ ] Exclude/normalize `.git` from the base (correctness — don't carry session branch refs
      forward); verify git/worktree (absolute gitdir pointers) behave on the overlay
- [ ] Gate base advance on install **exit code 0** (non-zero serves the session, isn't published)
- [ ] Re-derive on unarchive (persist source/metadata only; re-clone + reinstall) — so base
      GC only respects live mounts, not archived sessions
- [ ] Cold-start path: build base v0 from empty under the existing repo trust gate (docs/178)
- [ ] Verify compose bind-mounts using the overlay merged dir + `inotify` file watcher work
- [ ] Remove/retire the node_modules-specific `nm-store` copy store once the base supersedes it
- [ ] Optional/future: detection-free manifest fingerprint to skip no-op installs — only if
      measurements call for it
