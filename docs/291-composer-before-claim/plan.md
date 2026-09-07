---
title: The composer works before the session is warmed up — design
issue: planning#516
description: How the role and the other composer settings survive the window before /{repo}/new has a session.
---

# The composer works before the session is warmed up

Implements [requirements.md](./requirements.md).

## The window this is about

`/{repo}/new` navigates instantly and claims its session in the background
(`useSessionActivation`, `claimSession`). How long that takes depends entirely on what
the warm pool has: `claim-session.ts` reports a `claimPath` of `reuse` | `warm` |
`waiting` | `slow-clone`, and the last of those is a full clone. So the window is
milliseconds when a warm session is waiting and tens of seconds when none is — which is
exactly the split the report names, and why the problem looked intermittent.

For that whole window the composer read

```ts
disabled = showNewSessionView ? status !== "open" && !sessionId : status !== "open"
```

— a condition that on `/new` says precisely *"the claim has not landed"*. Send was dead,
and so were the four selectors that read `disabled`: role, harness, model, reasoning.

The network control beside them was **not**, because docs/285 req 8 had already solved
this for one control: a pick made before the claim is held as a draft and written when
the claim lands. So the row was already inconsistent — one setting live, four dead, with
nothing to tell the user which was which.

## A settings pick does not need a socket (reqs 1, 2)

`disabled` means two different things depending on whether a session is bound, and the
composer already holds the fact that distinguishes them: `sessionId` is `undefined` on
`/new` until the claim lands (`wsSessionId` in `App.tsx`).

- **Session bound** — a pick has to reach *that session* over its socket (`set_role`,
  `set_agent`, …). `disabled` carries `status !== "open"`, so barring the pick is right;
  nothing would receive it.
- **No session bound** — the pick is written to the seed slots (`saveRoleName`,
  `applyRoleSeeds`, `persistHarnessPick`, `saveReasoning`) and applied by the server from
  the WS **connect URL** (`useSessionWebSocket`, `role=` / `model=` / `reasoning=`). It is
  delivered *by being made*. There is no socket to miss.

So the composer computes one value:

```ts
const settingsLocked = isLoading || (disabled && !!sessionId);
```

`isLoading` stays unconditional — a running turn pins the parameters whether or not a
socket is involved. Quick Capture reaches the same state for the same reason (no session,
`disabled` while its repo clones) and gains the same behaviour, which is what its own
docstring already says it wants.

**`App.tsx` is untouched.** The composer's `disabled` still carries the claim clause,
because Send genuinely cannot work without a session — see the open question in
[requirements.md](./requirements.md). This change is entirely about what *else* was
reading that flag.

## The seed has to agree with the row (req 4)

Making the controls live is only half of req 4, and the other half was already broken —
it just could not be reached from `/new`, because the controls were dead there.

`leavePendingRole` (the docs/272 req 15 rule: moving one of the three parameters leaves
the role) cleared only React state. `saveRoleName`'s slot survived, `useSessionWebSocket`
put it in the connect URL, and the server applies `role=` **last**, over the harness,
model and reasoning seeds. So: choose a role, adjust its model, start the session — and
the session ran the *role's* model, silently discarding the pick the user was looking at.
Nothing came to correct it, because the seed is normally cleared by the server's answer
(`model-selection-changed`) and there is no server to answer before a session exists.

`leavePendingRole` now clears the seed too, **only when no session is bound**. A bound
session keeps the existing rule: there the server decides whether a parameter actually
moved, and re-selecting the value a role already set is not a change.

## A stashed message is misdelivered, not merely stranded

Found while tracing the send path, and confirmed independently by review. It predates
this feature and is fixed here because it is small and the same code was under the lens.

`useConnectionSync`'s flush addresses a stashed frame from the **store**:

```ts
if (send({ ...pending, sessionId } as WsClientMessage)) …
```

`resumeSessionInternal` clears the transcript, the spinner and the queue on a session
switch — but not `pendingWsMessage`. So a message stashed because the socket was still
connecting, followed by a switch, is not lost: it is **sent into the session the user
switched to**. `discardHeldFirstMessage` now runs there, *after* that function's "a
session resuming itself is not a switch" early return.

## What was deliberately not changed

- **A bound session still bars picks on a closed socket.** The fix is a distinction, not
  a removal.
- **Send still waits for the claim on `/{repo}/new`** — see the open question.
- **The first turn still locks the role** (docs/272 req 4). This is about the window
  *before* the first turn, not after it.

## Known limit of req 4

An interactive claim may **reuse an ungraduated warm session from the same repository**
(`claim-session.ts` ~340), and the connect handler prefers such a session's *persisted*
harness/model/reasoning over the URL seeds, and refuses to seed a role onto a session that
already holds one (`route-registry.ts`). So a pre-claim pick can be ignored when the claim
returns a reused draft. That is a property of the seed model docs/272 built rather than
something this change introduces — but it is the one case where req 4 is not guaranteed,
and it is recorded here rather than assumed away.

## Key files

| File | Role |
|---|---|
| `src/client/components/MessageInput/MessageInput.tsx` | `settingsLocked` — the one place both layouts read; `leavePendingRole` clears the seed |
| `src/client/stores/actions/session-actions.ts` | `discardHeldFirstMessage`, called from `resumeSessionInternal` |
| `src/client/hooks/useSessionWebSocket.ts` | unchanged; the connect URL is what applies a pre-claim pick |

## Where the tests go

1. **The four selectors are live with no session bound and dead with one**, and dead
   mid-turn either way — `MessageInputBeforeClaim.test.tsx`. Both directions, or the fix
   reads as "ungate everything".
2. **Leaving a role clears the saved role, not just the displayed one**, with no session
   bound — and does *not* touch it for a bound session, where the server owns that call.
3. **A stashed message does not follow the user into the session they switch to**, and IS
   kept when a session resumes itself — `session-actions.test.ts`. The second is the one a
   careless fix breaks.
