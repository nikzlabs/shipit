---
issue: planning#483
title: Network mode at session creation
description: Fold network containment into the composer's existing permission-mode control, for new and running sessions alike.
---

# Network mode at session creation

1. The regular new-session UI (the `/{owner}/{repo}/new` composer) lets me set the
   new session's network mode before I send its first message.
2. The Quick Capture (quick session) UI lets me set the new session's network mode
   before I send its first message.
3. The mode I pick is in force for the session's **first** turn. I never have to
   start the session, stop it, change Session settings, and continue it. An explicit
   **Contained** or **Open** is a hard guarantee; **Inherit workspace** means the
   workspace setting as it stands when the session's container starts — which is what
   "inherit" says, and the only case a workspace-default change during Send can move.
4. "Network mode" is the same choice the session's own Session settings dialog
   offers — Inherit workspace / Contained / Open. It is not the host allowlist,
   which stays where it is (Settings → Network, and the blocked-egress card).
5. The choice does **not** get its own control in the composer row. It is needed
   rarely and must not take prominent space, so it shares the control that already
   holds the permission mode (Plan / Guarded / Auto).
6. That combined control changes both settings for **new and already-running**
   sessions, and is the **same control on desktop and on mobile**.
7. A session's network mode has **one authoritative value, consistently represented**.
   The composer control and the session's own settings dialog may both show and change
   it, but they show the same value and neither is a second source of truth.
8. The pick never carries over to the next new session — every new session starts
   at "Inherit workspace".
9. The composer's settings menu never keeps a level of nesting that exists only to
   hold one or two rows. With the mode gone from it, a session running under a role
   opens straight onto the role list instead of a root row that opens another panel.
10. The control states what it will do before I commit to it: which mode the session
    will run in, and — when that is not the inherited default — that it is a
    deliberate change from the workspace setting. While **Inherit workspace** is
    selected it names the value currently inherited, and does not present that value
    as pinned (req 3).

11. The control does not claim that a session's *setup* ran under the chosen mode. If the
    workspace default is Open, a trusted repository's `agent.install` may already have run
    in the warm container before the mode was picked; the guarantee is the first **turn**,
    and the UI says so rather than leaving it implied.

## Open questions

- (none)

## Resolved questions

- 2026-08-28 — *Where should the Network control sit in Quick Capture: its own pill
  in the composer toolbar, or a line in the footer beside auto-merge?* Neither. Both
  are too prominent for something needed this rarely. Fold it into the existing
  permission-mode control instead, as one menu covering mode **and** network, the
  same on desktop and mobile and for new and existing sessions — and take the mode
  out of the parameters menu, which removes a nesting level there. → reqs 5, 6, 7, 9.
- 2026-08-28 — *Should the pick carry over to the next new session, like the model
  seed does?* No — reset every time, as the Quick Capture auto-merge checkbox does.
  → req 8.
- 2026-08-29 — **REVERSES the 2026-08-28 decision below.** *A review found a third option:
  keep the eager claim and reconcile the container at first Send using the existing
  `restartContainer` flow.* Taken. `/new` keeps claiming as it does today, so the live
  preview, the warm container and `@file`/`/skills` autocomplete are **not** given up, and
  the whole late-claim prerequisite is deleted. `services/recovery.ts` force-disposes the runner, destroys the
  container *including cancelling a creation still in preflight*, reaps orphans and recreates
  through the ordinary factory — the hard parts the draft design was re-inventing. (It does
  **not** reliably wait for readiness, nor reattach other viewers; `plan.md` states its real
  contract and how both are handled.) Cost: pressing Send with a changed mode waits for that
  restart, with the existing restarting UI. → the mechanism in `plan.md`.
- 2026-08-28 — *Is a live runner and preview before the first Send a product
  requirement?* **Superseded on 2026-08-29 (above).** The answer at the time was "no —
  `/new` may hold a plain draft until Send", accepted to remove the need for a first-turn
  admission protocol. It is recorded rather than deleted because it is why two designs were
  written, and because the reasoning was sound given the options known then; a cheaper
  option existed and was not checked first.
- 2026-08-29 — *Should `Inherit` be snapshotted at Send, so a workspace-default change
  during Send cannot move it?* No. Containment is resolved when the container is created
  (`container-lifecycle.ts` ~1435), so snapshotting would mean new claim-owned boot state
  carried through materialization — machinery for a race nobody would hit except during a
  concurrent workspace-default change. `Inherit` means what it says: the workspace setting
  at container start. Explicit Contained/Open keep the hard guarantee. → reqs 3, 10.
- 2026-08-29 — *A sessionless `/new` would lose `@file` and `/skills` autocomplete while
  composing.* **Moot as of the reversal above** — the session is claimed on arrival again,
  so both work exactly as they do today and no draft-context endpoint is needed. (The
  investigation stands on its own: a warm session's tree *is* readable without claiming it,
  since `resolveSessionDir` has no warm-session guard. Worth knowing, not needed here.)
- 2026-08-28 — *A review argued that the running-session half of requirement 6 is the
  largest remaining cost and should be cut, leaving the composer control on creation
  surfaces only.* No — requirement 6 stands as written: one menu, new and existing
  sessions alike. The cost was also overstated. The review assumed a keyed client cache
  and a new session-scoped SSE payload; the composer can instead do exactly what
  `SessionSettingsDialog` already does — fetch on open, write with `PUT`, read the
  returned `EgressSessionSettings` — since the per-session route emits no SSE today and
  the dialog uses no store. Only the always-visible trigger can go stale, and two
  components in one browser tab do not need a server round trip to agree.
- 2026-08-28 — *If the workspace default is Open, a trusted repo's `agent.install` may
  already have run in the warm container before Contained is chosen. Accept, force
  pre-installs to be contained, or defer pre-install until the mode is known?* Accept and
  **state the limitation plainly** — keep today's warm-start behaviour and say in the UI
  that the guarantee is the first turn. → req 11.
- 2026-08-28 — *Must the network setting live in exactly ONE place, so the Session
  settings dialog loses its network section?* No — that was an agent inference from
  "one control", not a stated requirement. The dialog keeps its network section for
  existing sessions; requirement 7 now asks for one authoritative value rather than one
  location. Removing it added special cases (a composer control that must work while the
  composer is inert, a dialog that vanishes for non-sandbox sessions, an enforcement
  warning needing relocation) without removing any underlying state. → req 7.
