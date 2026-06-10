# Measuring warm-install + tuning the overlay depth cap

A runbook for the empirical step in docs/183 Phase 7: measure install time on the **real
containerized path** with the overlay store on, classify the warm-vs-cold scenarios, and set
`DEFAULT_DEPTH_CAP` from data. This can only be run where there is **real Docker overlay** (a
canary / staging VPS), not the dev sandbox.

## Prerequisites

- A deployment with `OVERLAY_DEP_STORE=1` set on the orchestrator (the canary). Everything below
  is inert with the flag off. Both the VPS compose and the local dev compose pass the flag
  through from the host env (`OVERLAY_DEP_STORE=${OVERLAY_DEP_STORE:-}`) — export it **before**
  `docker compose up`, and verify it actually landed:
  `docker inspect <orch> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep OVERLAY`.
  (The orchestrator reads its own process env; a flag exported only in your shell does nothing.)
- Shell access to the orchestrator's logs (`docker logs <orch>` / `journalctl`), where the
  instrumentation line below is printed.
- The local dev stack (`docker/local/dev/compose.yml`) on Docker Desktop/WSL2 **is** a valid
  measurement host — the daemon performs real overlay mounts there (proven live 2026-06-10);
  "not the dev sandbox" in the original phrasing meant the cloud agent's Docker-less sandbox.

## The instrumentation line

After each overlay session's `agent.install` resolves and the per-dep-dir publish runs, the
orchestrator prints one greppable line (only when overlay is active for that session):

```
[overlay-measure] session=<id> repo=<url> install_ok=<bool> install_ms=<n> dirs=<depDir>:<outcome>[:d<depth>g<generation>],...
```

- **`install_ms`** — orchestrator-observed wall-clock from install kickoff to resolve. A
  marker-skip ("deps already materialized") resolves in ~0.2–1 s (worker HTTP roundtrips
  dominate, not the marker check — measured live 2026-06-10); a real install takes
  seconds. Duration alone separates a no-op from a materialize.
- **`<outcome>`** — the publish CAS result per dep dir: `created` (first base), `advanced`
  (incremental, depth++), `flattened` (depth cap hit → clean rebuild), `skipped-equal` (deps
  already current), `skipped-ineligible`, `skipped-not-forward`, or `error`.
- **`d<depth>g<generation>`** — overlay depth + base generation **after** the publish. `depth`
  is the number of incremental layers stacked since the last clean rebuild — the signal the
  depth cap bounds. Absent for skips/errors that read no pointer.

Tabulate a run:

```sh
docker logs <orch> 2>&1 | grep '\[overlay-measure\]' \
  | sed -E 's/.*install_ms=([0-9]+) dirs=(.*)/\1\t\2/' \
  | awk -F'\t' '{ printf "%6s ms\t%s\n", $1, $2 }'
```

## The three scenarios

Each maps to an overlay base state for a `(repo, runtime, dep-dir)` scope. Drive them on the same
repo + hardware, and run each **with the flag off too** (control) — the off-vs-on delta on a real
install is what the feature buys.

| Scenario | How to produce | Expect |
|---|---|---|
| **Cold** | New repo (no base for the scope), first session | `install_ms` = full; `outcome=created d1g1` |
| **`main` unchanged** | A second session for the same repo at the same default-branch commit | `install_ms` ≈ marker-skip (~0.2–1 s); `outcome=skipped-equal`. **Today this still pays a full install** — the marker lives in the host clone, not the base; see the base-hit pre-stamp follow-up in `checklist.md`. |
| **`main` advanced** | Push a commit that changes a dep, then a fresh session | `install_ms` = delta install; `outcome=advanced d<n>` |

The headline saving is **cold/advanced install_ms with the flag on vs off** — overlay removes the
materialize (extract/link of ~tens of thousands of files into `node_modules`), not the package
**download** (npm still fetches into its cache / the `dep-cache` mount).

### Separating network (download) from extract/link

The `[overlay-measure]` line is end-to-end. To attribute within a run, the cheapest split is npm's
own timing rather than instrumenting the worker's npm internals:

- Run the repo's install with `npm install --timing` (or inspect `~/.npm/_logs/*-timing.json`) and
  read the `npm timing reify:* ` phases — `reifyNode` / extract / link is the materialize cost;
  the `idealTree`/fetch phases are network.
- Or compare two flag-off runs: one with a **cold** npm download cache and one with a **warm**
  cache. The warm-cache run still pays ~full materialize, so its `install_ms` ≈ the extract/link
  cost overlay targets. The overlay-on run should drop that toward the marker-skip floor.

## Deriving the depth cap

`DEFAULT_DEPTH_CAP` (currently **16**, in `overlay-base.ts`) bounds how many `advanced` layers
stack before a `flattened` clean rebuild. Deeper stacks add per-file overlay lookup latency; a
flatten costs one full base copy. To set it from data:

1. On one repo, push a sequence of dep-changing commits to its default branch, creating a fresh
   session after each so the base keeps `advanced`-ing. Watch `d<depth>` climb in the
   `[overlay-measure]` lines (and in the pointer JSON at `overlay-base-meta/<scope-hash>.json`).
2. At depths ~1, 4, 8, 12, 16, record the **mount + first-install `install_ms`** for a new
   session on that base.
3. Set the cap where the marginal cost of one more layer starts exceeding the amortized cost of a
   flatten (flatten cost ÷ expected commits-between-flattens). If `install_ms` is flat across
   depth, the cap can rise; if it degrades by depth ~8–12, lower it.

To experiment without redeploying, `publishBase` accepts a `depthCap` override (today only the
test suite passes it); wire it to an env var if you want to sweep the cap on the canary.

## After measuring

- Set `DEFAULT_DEPTH_CAP` to the chosen value (or leave 16 if the curve is flat).
- Decide on the flag flip (the other Phase 7 user item) — ideally keep the canary on for a soak
  before flipping the fleet.
