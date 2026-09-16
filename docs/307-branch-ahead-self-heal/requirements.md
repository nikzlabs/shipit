---
issue: planning#579
title: A branch ahead of its remote must heal itself
description: What ShipIt must do when a session's commits never reached GitHub and nothing will arm another push.
---

# A branch ahead of its remote must heal itself

Written from an ops incident: session `e5d30875`, branch `shipit/txkdkh`, PR
nikzlabs/shipit#2850. CI green, no conflicts, no review gate — and the pull
request could not merge, because the branch held commits GitHub had never seen.
Four turns ran after the branch went ahead and none of them pushed.

1. A session branch that is ahead of its remote must reach the remote on its
   own, without the user noticing, asking, or running a command.
2. It must heal both when the session keeps taking turns and when it takes no
   further turn at all.
3. A branch that has **diverged** from its remote must NOT be pushed
   automatically. A plain push is rejected and a force push discards the
   remote's history; that case stays held.
4. A branch that is only **behind** its remote is not a problem and must not be
   touched.
5. A branch whose pull request has already merged must still be refused, on
   every healing path, on the same terms as the turn path refuses it.
6. Healing must not fight a push the turn path is already making, and must not
   push repeatedly while one is in flight or armed.
7. A repair that keeps failing must not produce unbounded noise, and must still
   converge if the cause clears.
8. When ShipIt is holding a merge because the branch has not reached GitHub, the
   user must be able to see that from the pull-request card — including when
   managed auto-merge is armed and no merge button is rendered.
9. A turn that is killed or restarted must not leave its work uncommitted and
   unpushed.
10. A repair must never write where the turn path would not: not for a session
    kind ShipIt does not auto-commit, and not for a session whose commit ShipIt
    has refused.

## Resolved questions

- 2026-09-15 — Should the poller's repair also cover `diverged`? No. The ops
  diagnosis is explicit that only `ahead` is safe to auto-heal; `diverged`
  stays held and reported (req 3).
- 2026-09-15 — Is "idle" a new definition? No — it is the one the managed
  auto-merge already uses: `agentBusy` and `systemTurnInProgress` on the
  session's runner (req 6).

## Known limit

Req 2's "no further turn" half is served by the PR-status poller, and polling is
gated (`PollingGlobalGate`) on a viewer being attached or ShipIt owning a pending
merge. A branch stranded in a session nobody has open, with no armed merge, does
not heal until someone opens it — which is also the first moment it matters. The
alternative is an activity-independent repair loop over every session with a
remote, and that is a platform primitive this requirement does not ask for.
