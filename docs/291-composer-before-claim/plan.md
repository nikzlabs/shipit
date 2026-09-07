---
title: The composer works before the session is warmed up — design
issue: planning#516
description: How the role and the other composer settings, and a first message, survive the window before /{repo}/new has a session.
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

## Two independent halves

### 1. A settings pick does not need a socket (reqs 1, 2)

`disabled` means two different things depending on whether a session is bound, and the
composer already holds the fact that distinguishes them: `sessionId` is `undefined` on
`/new` until the claim lands (`wsSessionId` in `App.tsx`).

- **Session bound** — a pick has to reach *that session* over its socket (`set_role`,
  `set_agent`, …). `disabled` carries `status !== "open"`, so barring the pick is right;
  nothing would receive it.
- **No session bound** — the pick is written to the seed slots (`saveRoleName`,
  `applyRoleSeeds`, the model/reasoning slots) and applied by the server from the WS
  **connect URL** (`useSessionWebSocket`, `role=` / `model=` / `reasoning=`). It is
  delivered *by being made*. There is no socket to miss.

So the composer computes one value:

```ts
const settingsLocked = isLoading || (disabled && !!sessionId);
```

`isLoading` stays unconditional — a running turn pins the parameters whether or not a
socket is involved. Quick Capture reaches the same state for the same reason (no session,
`disabled` while its repo clones) and gains the same behaviour, which is what its own
docstring already says it wants.

Nothing new is needed to make req 4 hold: the seed path is the one docs/272 req 12 built,
and `pendingRole` already makes the seed *the display* before a session exists.

### 2. A first message can be held (reqs 3, 5)

`useConnectionSync`'s flush has always filled the session id in from the store at the
moment it writes the frame:

```ts
if (send({ ...pending, sessionId } as WsClientMessage)) …
```

So a frame stashed with **no** `sessionId` was already deliverable; the only reason
nothing produced one is that Send was barred until an id existed. `holdFirstUserMessage`
produces one. It is `sendUserMessage` with the stash as its dispatch — same optimistic
bubble, same request id, a different activity label ("Starting session…", because nothing
is thinking yet).

`App` then drops the claim clause from `disabled`, and graduates the URL to
`/session/{id}` when the id arrives with a message still held — the same transition
`handleSend` makes for itself when a session is already bound.

**Giving it back (req 5).** A held frame carries no session identity, so it belongs to
whichever claim is currently being waited for, and there are two ways to stop waiting:

| Event | Where | What happens |
|---|---|---|
| The claim fails | both `claimSession` call sites in `useSessionActivation` | `discardHeldFirstMessage` — bubble, spinner and stash undone, toast |
| The user moves to another repo's `/new` | the route-key branch of the URL-sync effect | same, with wording that names the navigation |
| The user switches to an existing session | `resumeSessionInternal` | same |
| The claim succeeds | — | nothing; the flush sends it |

The last two are not "stranded message" cases but **misdelivery** cases, and that is what
makes them load-bearing: the flush addresses a stashed frame from the STORE, so a stash
left in place is sent into whatever session the store then holds. `resumeSessionInternal`
did not clear it — already a latent hole for the stash the
already-claimed-but-still-connecting path writes, in a window a few hundred milliseconds
wide, which this feature widens to a whole cold clone. The discard sits *after* that
function's "a session resuming itself is not a switch" early return, because the URL
graduation above lands on exactly that case and would otherwise drop the message a moment
before the flush sends it.

### The bubble had to survive the history install

`loadSessionHistory` installs the persisted transcript with a **wholesale replace**, and
both it and the flush fire on the same `open`. The history request therefore goes out
before the message has been sent, comes back without it, and would take the user's own
bubble off the screen a second after they sent it. The server's `system_user_message`
echo cannot repair that: it reconciles against the very bubble the install is about to
delete, so it no-ops first and then there is nothing left.

`carryHeldMessage` closes it, keyed on the **stash** rather than on "has a
`clientRequestId`". Every optimistic bubble has one of those, including delivered ones the
server is merely slow to persist, and carrying those would resurrect rows a rewind had
removed. Exactly one message can be held at a time; this carries exactly that one, and
only while the payload does not already contain it.

## What was deliberately not changed

- **A bound session still bars picks on a closed socket.** The fix is a distinction, not
  a removal.
- **`networkSaving` still bars Send**, before the claim as much as after. docs/285 test
  2e is explicit that a pre-claim network pick holds Send until its write lands, because
  the container's topology is decided by that write and a first turn dispatched early
  runs under the mode the user is replacing. Nothing here weakens it.
- **The first turn still locks the role** (docs/272 req 4). This is about the window
  *before* the first turn, not after it.

## Key files

| File | Role |
|---|---|
| `src/client/components/MessageInput/MessageInput.tsx` | `settingsLocked` — the one place both layouts read |
| `src/client/App.tsx` | the composer's `disabled`, the held-message send, the URL graduation |
| `src/client/utils/send-user-message.ts` | `holdFirstUserMessage` |
| `src/client/stores/actions/session-actions.ts` | `discardHeldFirstMessage` |
| `src/client/hooks/useSessionActivation.ts` | the two claim call sites and the route-key branch that discard |
| `src/client/utils/session-data.ts` | `carryHeldMessage` — the held bubble survives the transcript install |
| `src/client/hooks/useConnectionSync.ts` | unchanged; its flush already addressed an id-less frame |

## Where the tests go

1. **The four selectors are live with no session bound and dead with one** —
   `MessageInputBeforeClaim.test.tsx`. Both directions, or the fix reads as "ungate
   everything".
2. **`holdFirstUserMessage` stashes without a `sessionId`** and tags the frame with the
   bubble's request id — `send-user-message.test.ts`. A `sessionId` here would be the id
   of a session the message was not typed for.
3. **Discard on claim failure and on a repo switch, and NOT on success** —
   `useSessionActivation.test.tsx`. The success case is the one a careless fix breaks.
   The repo-switch test's claim never settles, so the failure path cannot be what passes it.
4. **The held bubble survives the transcript install**, an unheld one does not, and a
   payload that already contains it does not duplicate — `session-data.test.ts`.
