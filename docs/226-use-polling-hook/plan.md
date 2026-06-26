---
issue: https://linear.app/shipit-ai/issue/SHI-213
title: usePolling shared hook
description: A shared usePolling<T> hook that collapses the repeated interval-poll-into-state boilerplate, designed so the four call sites' divergence is props, not forks.
---

# usePolling shared hook

A shared `usePolling<T>` hook for the recurring "fetch a snapshot on an interval
into React state, with cleanup" pattern. Several client surfaces hand-roll the
same `[data/error/loading]` + `setInterval` + stale-guard + cleanup scaffolding.

This refactor was catalogued in **`docs/225-component-dedup-refactors`** (Linear
**SHI-212**) under **"Explicitly not doing"**:

> **`usePolling` hook.** Real (`HostPanel`, `SessionDiagnosticsPanel`,
> `useContainerHealthPoll`, `usePreviewHealthPoller` all repeat
> `[data/error/loading]` + `setInterval` + cleanup), but the poll bodies differ
> enough that the shared hook risks an awkward API. Medium confidence — left in
> the backlog.

This doc is the dedicated design that resolves the "awkward API" concern: it
draws the line between **mechanics** (which the hook owns) and **semantics**
(which stay with the caller), so each site's divergence becomes a *prop*, not a
fork. It also identifies the one site that should **not** migrate.

> **Status.** This PR ships the **design + a validated prototype of the hook
> only** (`src/client/hooks/usePolling.ts` + `usePolling.test.ts`). The four call
> sites are **not** migrated here — that is follow-up work itemized in
> `checklist.md`. The prototype exists to prove the API against the real
> divergence before any site is touched.

## The call sites (evidence)

Verified by reading the code. Each row is "what's the same" (the boilerplate)
and, crucially, "what's different" (the divergence the API must absorb).

### 1. `src/client/components/HostPanel.tsx` (~77–124)

- **Poll body** (`refresh`, `87-100`): `fetch("/api/host/overview")`, throw on
  `!res.ok`, `setData(json)`. Uses raw `fetch`, not `useApi`.
- **State shape** (`77-79`): `data: HostOverview | null`, `error: string | null`,
  `loading: boolean` — **uses all three**, including `loading` to swap the
  refresh button's icon for a spinner (`156-158`).
- **Interval**: fixed `POLL_MS = 5000` (`37`).
- **Enable gating**: `isActiveTab` — polls only while the Host tab is visible,
  stops on hide (`120`). This is *app-level* tab gating, not `document.hidden`.
- **Immediate**: yes — `void refresh()` before arming the interval (`121`).
- **Manual refresh**: yes — a refresh button calls `void refresh()` (`152`).
- **Error handling**: `err instanceof Error ? err.message : String(err)`.
- **Note**: the same component has a *second*, **one-shot** fetch
  (`refreshSource`, `102-113`, fired once on tab activation, no interval) — that
  is **not** a polling concern and stays as-is.

### 2. `src/client/components/SessionDiagnosticsPanel.tsx` (~117–146)

- **Poll body** (`poll`, `119-128`): `api.get<DiagnosticsPayload>(…/diagnostics)`,
  `setData`, `setError(null)`. Uses `useApi` + `ApiError`.
- **State shape** (`116-117`): `data`, `error` — **no `loading`** (a static
  "Loading…" placeholder renders while `!data && !error`).
- **Interval**: fixed `POLL_INTERVAL_MS = 2000` (`106`).
- **Enable gating**: `open && sessionId` — polls only while the dialog is open
  (`134`).
- **Reset-on-disable**: **yes** — on close it sets `data`/`error` back to `null`
  so the next open starts clean (`135-138`). The other sites do **not** do this.
- **Immediate**: yes (`139`). **Manual refresh**: no.
- **Error handling**: `e instanceof ApiError ? e.message : String(e)`.

### 3. `src/client/components/SessionHealthStrip/hooks/useContainerHealthPoll.ts` (~37–140)

The richest site, and the one that shows where the line must be drawn.

- **Poll body** (`poll`, `47-127`): `api.get<ContainerHealth>(…/container/health)`,
  then a large **success-side-effect block** that drives Zustand store state
  (`setRescueState`, `setPauseNotice`, `setMemoryExhausted`) off the fetched
  health — the rescue-finalize logic (`78-119`).
- **State shape** (`37-38`): `health` (the `data`), `error` — no `loading`.
  Also re-exports `setHealth`/`setError` so the strip can poke them.
- **Interval**: **variable** — `isRestarting ? RESTART_POLL_INTERVAL_MS (1500)
  : POLL_INTERVAL_MS (10_000)` (`137`). The effect re-arms when `isRestarting`
  flips.
- **Enable gating**: `sessionId` presence (`135`).
- **Stale guard**: **explicit and load-bearing** — a `sessionIdRef` + `if (sid
  !== sessionIdRef.current) return` on **both** the success and error paths
  (`61`, `124`), because an old session's in-flight fetch can resolve after the
  new session's state is set (the strip-flicker bug, `52-60`).
- **Immediate**: yes (`136`). **Manual refresh**: `poll` is returned so the
  strip can call it directly.
- **Secondary effect**: a separate 1 Hz `setInterval` (`147-151`) that only
  forces a re-render to tick an elapsed-time label. **Not a data poll** — stays
  put.

### 4. `src/client/hooks/usePreviewHealthPoller.ts` (~128–196)

- **"Poll body"**: a **bounded converge-once retry loop**, not a steady
  interval. A `for (i < 60 && !cancelled)` loop with a 15 s wall-clock deadline,
  a per-fetch `AbortSignal.timeout(2000)`, and a 250 ms inter-iteration sleep
  (`159-175`). It polls **until** `data.ready`, then **stops permanently** and
  creates an iframe slot (`183-189`).
- **State shape**: **none** — returns `void`. No `data`/`error`/`loading`.
- **Coordination**: mutates shared refs (`pollingRef`, `createdSlotsRef`) under a
  subtle ownership/cancellation invariant (`99-110`, `141-195`).

This one is structurally different — see *Sites that should NOT migrate*.

### Divergence matrix

| Site | client | state used | interval | enable | immediate | refresh | reset-on-disable | success side-effects |
|------|--------|-----------|----------|--------|-----------|---------|------------------|----------------------|
| HostPanel | raw `fetch` | data, error, **loading** | 5000 fixed | `isActiveTab` | yes | **yes** (button) | no | none |
| SessionDiagnosticsPanel | `useApi` | data, error | 2000 fixed | `open && id` | yes | no | **yes** | none |
| useContainerHealthPoll | `useApi` | data, error | **1500/10000 variable** | `sessionId` | yes | yes (`poll`) | no | **heavy** (store) |
| usePreviewHealthPoller | raw `fetch` | — (void) | converge-once loop | derived | n/a | n/a | n/a | iframe slot |

The first three vary along **orthogonal axes** (which state fields, fixed vs
variable interval, with/without reset, with/without store side-effects). That is
exactly what makes a single hook viable: each axis is a prop with a sane default,
so no site pays for another site's needs. The fourth varies along a *structural*
axis (loop shape, no state) — it doesn't belong.

## Proposed API

```ts
interface UsePollingOptions<T> {
  poll: () => Promise<T>;        // one poll; may have side effects; returns the value
  intervalMs: number;           // changing it re-arms the loop (variable cadence)
  enabled?: boolean;            // default true — app-level gate
  immediate?: boolean;         // default true — fire once on (re)start
  pauseWhenHidden?: boolean;   // default false — also pause on document.hidden
  resetOnDisable?: boolean;    // default false — clear data/error when disabled
  onSuccess?: (data: T) => void; // runs after a non-stale success (store side-effects)
  onError?: (error: unknown) => void; // runs after a non-stale failure
}

interface UsePollingResult<T> {
  data: T | null;
  error: string | null;        // err.message, stringified
  loading: boolean;
  refresh: () => Promise<void>; // off-cycle manual poll, stale-guarded
}

function usePolling<T>(options: UsePollingOptions<T>): UsePollingResult<T>;
```

Two required fields (`poll`, `intervalMs`); everything else is a defaulted knob.
The headline `usePolling({ enabled, intervalMs, poll, onError })` stays clean —
the extra options exist for the sites that need them and are invisible to the
sites that don't.

### How the API absorbs each divergence

- **Which state fields** — the hook always exposes `data`/`error`/`loading`;
  sites read only what they render. A site without a spinner ignores `loading`.
- **Request client** — the hook never touches `fetch`/`useApi`; the caller's
  `poll` closure decides. Raw-`fetch` and `useApi` sites both just return `T`.
- **Variable interval** — the caller computes `intervalMs` (e.g.
  `isRestarting ? 1500 : 10000`) and passes it; the effect re-arms on change.
- **Site-specific success logic** — `onSuccess(data)` runs **under the
  stale-guard**, so `useContainerHealthPoll`'s store writes inherit the same
  protection they hand-roll today, without living inside `poll`.
- **Reset semantics** — `resetOnDisable` for the dialog that wants a clean
  reopen; off for the panel that wants to keep its last snapshot while hidden.

### The four hard parts, addressed

1. **Stale-response guarding (unmount / fast re-poll / session switch).** A
   monotonic `epochRef` is bumped on every effect cleanup (unmount, or any
   dep change — `enabled`, `intervalMs`, `immediate`). Each `runPoll` captures
   the epoch at start; after the `await` it bails before *any* `setState`/
   `onSuccess`/`onError` if the epoch moved. This generalizes
   `useContainerHealthPoll`'s `sessionIdRef` guard: there, the dep that changes
   on a session switch is `sessionId`, which flows into the caller's `poll`
   closure → the effect re-runs → cleanup bumps the epoch → the old session's
   late fetch is dropped. The guard covers **both** success and error paths,
   matching `61`/`124`. (It does **not** serialize two *same-config* overlapping
   polls — last-write-wins — which matches today's behavior, since intervals are
   far longer than fetch latency.)
2. **Immediate first poll vs interval-only.** `immediate` (default `true`)
   matches all three migrating sites, which fire once before arming the
   interval. `immediate: false` is available for an interval-only loop.
3. **Pause-while-hidden.** `pauseWhenHidden` (default `false`) wires a
   `visibilitychange` listener that stops the interval on `document.hidden` and
   restarts (immediate poll if `immediate`) on re-show. **Deliberately distinct
   from `enabled`:** HostPanel's `isActiveTab` is *app-level* tab selection, not
   document visibility, so it maps to `enabled`. No current site needs
   `pauseWhenHidden`, but the design accommodates it as a free win for the
   background-ops case.
4. **Manual refresh.** `refresh()` runs a poll immediately, off-cycle, under the
   current epoch (so it's stale-guarded too) — covering HostPanel's button and
   `useContainerHealthPoll`'s returned `poll`.

### WebSocket-lifecycle compliance (CLAUDE.md)

The hook is **client-only** and touches no runner/agent/container/persistence
state — it's plain React `useState` + an interval, the same category as the
existing per-site effects it replaces. It does not subscribe to the session
WebSocket and cannot drive server-side state, so the "WebSocket lifecycle MUST
NOT affect server behavior" rules are not implicated. (For
`useContainerHealthPoll` specifically, the health poll is *deliberately a
separate channel from SSE* — see its docstring — so moving its mechanics onto
`usePolling` keeps that separation intact.) The `useEffect`/interval is
centralized behind one justified `eslint-disable` in the hook, removing the
per-site disables.

## Per-site migration mapping (follow-up PRs, not this one)

### HostPanel → migrate (host-overview poll only)

```ts
const { data, error, loading, refresh } = usePolling<HostOverview>({
  enabled: isActiveTab,
  intervalMs: POLL_MS,                       // 5000
  poll: async () => {
    const res = await fetch("/api/host/overview");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<HostOverview>;
  },
});
```

`data`/`error`/`loading`/`refresh` drop in 1:1, including the spinner swap and
the refresh button. The separate `refreshSource` one-shot stays untouched.

### SessionDiagnosticsPanel → migrate

```ts
const { data, error } = usePolling<DiagnosticsPayload>({
  enabled: open && !!sessionId,
  intervalMs: POLL_INTERVAL_MS,              // 2000
  resetOnDisable: true,                       // clean reopen (replaces the manual reset)
  poll: () => api.get<DiagnosticsPayload>(`/api/sessions/${sessionId}/diagnostics`),
});
```

The hand-rolled `setData(null)/setError(null)` on close becomes
`resetOnDisable: true`. `copyPayload` reads `data` exactly as before.

### useContainerHealthPoll → **partial** migrate (mechanics only)

```ts
const { data: health, error, refresh, setError } = usePolling<ContainerHealth>({
  enabled: !!sessionId,
  intervalMs: isRestarting ? RESTART_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
  poll: () => api.get<ContainerHealth>(`/api/sessions/${sessionIdRef.current}/container/health`),
  onSuccess: (data) => { /* rescue-finalize: setRescueState / setPauseNotice / … */ },
});
```

The fetch + interval + variable cadence + stale-guard collapse onto the hook.
The **rescue-finalize logic stays caller-owned**, moved verbatim into
`onSuccess` (where it inherits the epoch stale-guard, replacing the manual
`sessionIdRef` check). The site keeps its hook wrapper (it still owns
`UseContainerHealthPoll`'s extra surface: `setHealth`/`setError` re-exports and
the separate 1 Hz elapsed-time tick effect). This is honestly a *partial*
collapse — and that's the point: the hook takes the mechanics, the site keeps
its semantics. (If `usePolling` doesn't expose a `setData` escape hatch, this
site keeps a thin local mirror for the `setHealth` re-export; the prototype
exposes `data` read-only and leaves that decision to the migration PR.)

### usePreviewHealthPoller → **do NOT migrate**

See below.

## Sites that should NOT migrate

**`usePreviewHealthPoller` is explicitly excluded.** It is not a recurring
snapshot poll — it is a **converge-once-then-stop** bounded retry loop:

- It loops *until a condition* (`data.ready`) and then **terminates
  permanently**, creating an iframe slot. `usePolling` is a steady interval that
  never self-terminates. Forcing a "stop the interval from inside a poll"
  affordance would warp the API for one caller.
- It has **no `data`/`error`/`loading`** to expose — it returns `void`.
- It needs a **per-fetch `AbortSignal` timeout + a wall-clock deadline + an
  inter-iteration sleep**, none of which `usePolling` models.
- It coordinates **shared external refs** (`pollingRef`, `createdSlotsRef`) under
  a documented ownership/cancellation invariant that has nothing to do with
  interval polling.

Collapsing it in would re-introduce exactly the "awkward API" SHI-212 flagged.
It stays as a bespoke hook.

## Prototype (this PR)

- `src/client/hooks/usePolling.ts` — the hook, as specified above.
- `src/client/hooks/usePolling.test.ts` — fake-timer tests proving: immediate +
  interval cadence, `immediate: false` skips the leading poll, `data`/`error`/
  `onError`/`onSuccess` plumbing, disabled = no polling, stop-on-disable,
  `resetOnDisable`, **stale-response dropped after teardown**, **cleanup on
  unmount**, `refresh()` off-cycle poll, and **re-arm on `intervalMs` change**.

Validated with `npm run typecheck` and ESLint (full `npm test` OOMs the session
container — see CLAUDE.md; the co-located file runs green under `vitest run`).

## Key files

- `src/client/hooks/usePolling.ts` — the hook (this PR).
- `src/client/hooks/usePolling.test.ts` — co-located tests (this PR).
- Migration targets (follow-up): `src/client/components/HostPanel.tsx`,
  `src/client/components/SessionDiagnosticsPanel.tsx`,
  `src/client/components/SessionHealthStrip/hooks/useContainerHealthPoll.ts`.
- Excluded: `src/client/hooks/usePreviewHealthPoller.ts`.
- Originating catalog: `docs/225-component-dedup-refactors/plan.md` (SHI-212).
