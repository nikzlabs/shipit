---
title: Local install — network exposure and Tailscale access
description: What the local install binds to, and how a user reaches it (with previews) from another device over Tailscale.
---

# Requirements — local install network exposure and Tailscale access

Scope: the **local install** (`deployment/local/` + `docker/local/prod/compose.yml`), the
one a user puts on their own laptop. This is *not* `RUNTIME_MODE=local` (the
dogfooding-inside-a-container mode of docs/118, which removes the Preview tab
entirely) — the two are unrelated despite the shared word.

The VPS install is explicitly out of scope: it already binds `127.0.0.1` and is
fronted by Caddy plus Cloudflare Zero Trust or the Tailscale forwarder, so it has
no exposed port to harden.

## Requirements

1. A user who installs ShipIt locally and only ever browses it on that same
   machine gets, out of the box, the behaviour they get today: ShipIt is reachable
   at `http://localhost:4123`, and previews work.

2. That default install is **not** reachable from other devices on whatever
   network the machine is attached to. A laptop that joins untrusted wifi does not
   thereby expose an unauthenticated agent with shell and repository access.

3. Nothing about the default install path requires Tailscale, mentions Tailscale,
   or behaves differently depending on whether Tailscale is present. Users who
   don't use Tailscale are unaffected by everything below.

4. A user who wants to reach their local ShipIt from another device — a phone —
   over Tailscale can opt in and get it, and **previews work** on that device, not
   just the app shell.

5. Opting in to Tailscale access does not make ShipIt fail to start when Tailscale
   is unavailable. If Tailscale is not installed, not connected, or simply hasn't
   come up yet after a reboot, ShipIt still starts and is still reachable locally.
   The tailnet binding is best-effort: it is never a precondition for starting, and
   it is restored at the next start once Tailscale is back, with no user edit.

   *Amended 2026-08-06 (agent, not human input): this originally read "recovers on
   its own once Tailscale is back", which is not achievable — a published Docker
   port binding cannot be added to a running container, so restoring it requires
   recreating the container either way. The requirement now states the strongest
   behaviour that is actually possible. Flagged to the human rather than quietly
   reworded; if live recovery is genuinely wanted, it needs a supervisor process
   (what the VPS does with socat) and is a different feature.*

6. A user who has opted in and whose tailnet address later changes does not have to
   hand-edit anything for access to keep working.

7. Documentation states what is actually true about local network exposure, and the
   local install's remote-access story is written down rather than being something a
   user has to derive.

8. When previews cannot work because of the hostname ShipIt is being browsed at, the
   UI says so and names a hostname that would actually work for that user.

9. Opting in to any of this does not break `update.sh`. A user who has set operator
   preferences can still update.

## Open questions

_None._

## Resolved questions

**2026-08-06 — What should the local install bind to by default?**
Human answered: `127.0.0.1`. Chosen in preference to keeping the current `0.0.0.0`
even though it is a breaking change for anyone reaching their local ShipIt across
the LAN today, on the grounds that there is no authentication in front of it.
This makes `SECURITY-MODEL.md`'s existing claim true rather than something we
merely correct in prose. → requirements 1, 2.

**2026-08-06 — If Tailscale isn't connected when ShipIt starts, what should happen?**
Human answered: *"some users will not have Tailscale, and it needs to work
seamlessly for them. That's my requirement. If the user has Tailscale, then still
start."* Two distinct constraints: the no-Tailscale path must be untouched
(→ requirement 3), and an opted-in user must not be blocked from starting by
Tailscale being down (→ requirement 5). Note this rules out writing a fixed tailnet
address into the compose file: Docker fails the *whole* container when any single
published binding can't be bound, so the tailnet binding has to be resolved at
start time and omitted when unavailable. → requirements 3, 5, 6.

## Requirement provenance

Requirements 1–7 and 9 trace to the human's instructions in this session: the
opening question about reaching a laptop install from a phone over Tailscale, the
instruction to *"implement the security feature that you suggested"*, and the two
answers recorded above. Requirement 8 traces to the human approving the follow-up
card, narrowed after review found `PreviewFrame.tsx` already explains the
wildcard-DNS constraint — so the requirement is about naming a *concrete usable
host*, not about adding an explanation that already exists.

Requirement 9 was **not** requested. It was added after implementation review found
that `.shipit.env` — the existing operator-preferences file this feature needs to
extend — is untracked but not git-ignored, while `shipit_sync_checkout` refuses to
run when `git status --porcelain` is non-empty. The egress opt-out already writes
that file, so the bug predates this work; it is in scope only because this feature
would otherwise inherit and widen it.
