---
issue: planning#551
title: Propose work in another repository as a card — design
description: A transcript card the agent writes when work belongs in a different repository; one click starts an independent session there with the prompt already sent.
---

# Propose work in another repository as a card — design

Implements [`requirements.md`](requirements.md). Requirements are cited as
`(req N)`.

## The moment this exists for

The agent is working in repo A and concludes that a change belongs in repo B —
the API contract it consumes, the shared library, the infrastructure repo. Today
it writes the instruction into chat as prose, and the user copies it, switches
repos in the sidebar, makes a session by hand, and pastes it in. The prompt is
already written; every step after it is transport.

## The shape

A new agent-authored transcript card. The agent names the target repository, a
session title, and the first message (req 1, 2, 7). The user clicks once and
ShipIt starts the session and sends the prompt (req 3, 4).

The card is **not** a `propose_actions` card. `propose_actions` composes a
message back into *this* session; this card creates a session somewhere else.
Same click, different actor: `propose_actions` declares intent for the local
agent, this one performs a session creation the user would otherwise do by hand.

### Why the new session is independent

`spawnChildSession(..., { detached: true, repoUrlOverride, noRole })` — a detached spawn
writes no `parentSessionId` / `rootSessionId`, so the new session does not nest
in the sidebar (req 6). That is deliberate and user-stated: a nested session
renders inside its parent's repo group, so a nested cross-repo session would be
filed under the wrong repository.

The consequence is accepted, not overlooked: the proposing session gets no
`wait` / `message` / `notify-on-merge` handle on the session it started. The card
itself is the only link, and it is enough — it carries the new session's id and
opens it.

### Why nothing new reads the repository list

The agent names the repository from the conversation (req 7); ShipIt resolves the
name. No agent-facing repo-list API is added — the user ruled one out, on the
ground that the GitHub token they gave ShipIt already reaches their
repositories.

**Resolution happens at emit time, not at click time.** The tool call verifies
the repository before the card is written, so a repository the agent got wrong
fails back to the *agent*, which can correct itself in the same turn, rather than
failing under the user's click. Three checks, in order:

1. The name resolves to a repository **identity** (`repoId`). `owner/repo`
   shorthand and github.com URLs both resolve.
2. That identity is not this session's own repository. That call is a mistake,
   not a proposal — the agent should do the work here.
3. ShipIt's GitHub connection can **reach** it. Reach, not write: req 8 makes any
   repository the user's token can see a valid target, and a read-only checkout is
   still a valid session. A read-only target is accepted and the card says the
   session will not be able to open a pull request.

A repository ShipIt has never seen is a valid target and passes all three.

**Every URL is built from the identity, never from the text the agent typed.**
`parseGitHubRemote` is unanchored, so `https://attacker.example/github.com/acme/api.git`
reads as `acme/api`: a card that displays and authorizes one repository while
cloning from another host, approved by a user's single click. `repoId` is the
anchored parser and also folds https/ssh/case together, so the own-repository
guard cannot be stepped around by respelling the remote. Display, authorization,
registration and cloning all use the one identity.

**The target starts with no role.** A spawn inherits the proposing session's role
by default, and `spawnChildSession` joins that role's standing instructions onto
the prompt — so a session running a reviewer role would start the target as a
reviewer told not to edit, on text the user never saw on the card. The spawn
passes `noRole: true`, keeping the harness/model inheritance and dropping the
brief.

### Registering an unseen repository happens on the click

`claimSession` refuses a repository that is not registered and `ready`, so a
target ShipIt has never cloned must be added first. `ensureRepoReady()` (moved
out of `services/shipit-source.ts`, where it was already doing exactly this for
Ops fix sessions under the name `ensureShipitSourceRepoReady`) adds the repo and
clones the bare cache synchronously, then the spawn proceeds.

This runs on the click rather than at emit time because it is slow and because
it has a user-visible side effect — the repository appears in the sidebar. The
card says so before the click when the target is not yet registered, so the
sidebar never gains a repository the user did not agree to.

## Flow

```
agent: propose_repo_session({ repo, title, prompt })
  → worker  POST /agent-ops/propose-repo-session
  → orch    POST /api/sessions/:sessionId/propose-repo-session   (containerAccessible)
            validate → resolve identity, reject own repo, check reachability
            emitChatCard(repo_session_proposal_card)             ← persisted

user clicks "Start in owner/repo", or "Trust and start in owner/repo" (req 12)
  → POST    /api/sessions/:sessionId/repo-session-proposals/:cardId/start   { trust: true }?
            (NOT container-accessible: the agent proposes, the user starts)
  → handler patch state=starting  (emit + persist)
            ensureRepoReady(repoUrl)
            grantRepoTrust(repoUrl)   only with { trust: true }, and only if not trusted yet
            spawnChildSession(thisSession, { detached: true, noRole, repoUrlOverride, prompt, title })
              └ on the claim: persist pendingSessionId on the card, before the prompt is sent
            patch state=started + startedSessionId   (emit + persist)
            …or state=failed + errorMessage, and the card offers a retry
```

Every state lands in persisted chat history, not only on the wire — `started` is
terminal state a user expects to still be there tomorrow, which is the dividing
line in `CLAUDE.md`'s transcript-persistence rule (req 9).

## Trusting the target from the card (req 12)

No agent turn can start in a repository the user has not trusted
(docs/243-agent-messaging-trust-gate), and a repository the click adds starts
untrusted. So the card carries the consent itself.

**The card knows before the click.** It reads the browser's repository list
through `useRepoTrust`, the lookup the two other Trust surfaces use. The target
needs the consent when the list has it as untrusted, or does not have it at all:
a repository the click adds starts untrusted, whether ShipIt never had it or the
user removed it after the card was written. A notice then says what the consent
grants — the agent can work there, and ShipIt runs
the repository's setup commands and services — and that it is remembered for
the repository.

**One button, and it names both acts.** The button reads "Trust and start in
owner/repo". There is no start without trust to choose, so a separate Trust
click would add a step and no decision; req 4 says one click starts the session,
and docs/243-agent-messaging-trust-gate req 4 says the Trust action is the
consent, so the one click must be recognisably that action. After a failed start
the button keeps that label: a bare "Try again" must never grant trust.

**The grant is the existing one, made on the server after registration.** The
click sends `{ trust: true }`. The start route registers the repository first,
because only a registered repository can hold the grant, then calls
`grantRepoTrust` (`services/repos.ts`) — what `POST /api/repos/trust` calls —
and then spawns. A click without the flag grants nothing. Trust that was granted
stays granted when the spawn then fails for another reason: it describes the
repository, not one start.

**Only the user can send it.** The start route is not container-accessible
(verified at `api-container-guard.ts`: a request from a session container is
refused unless the route sets `containerAccessible`), so an agent can propose a
card and cannot give the consent for it. What the user reads before the click is
ShipIt's: the repository label comes from the resolved identity and the notice
is fixed text. The title and the prompt are the agent's, as on every card.

**The server stays the authority.** A start without the flag on an untrusted
target answers `403` with code `repository_untrusted`, before a session exists,
and the card's `failed` reason points at the card's own button. The card treats
that code as "needs the consent" whatever its repository list says, so a list
that still shows a trusted entry — the repository was removed and added again,
and the update did not arrive — corrects itself on the first refusal. The
override lasts until the next start settles; after that the list decides again.

## A start that did not finish

A start has three moments: the target session is allocated, its prompt is sent,
and the card is told. The card used to learn the session's id only at the third.
An orchestrator that stopped before then, or a card write that failed, left a
session the card did not know: the card stayed retryable, and the retry started
a second session on the same work.

**The card records the session when it is allocated.** `spawnChildSession`
calls `onChildClaimed` when the claim returns, before graduation and before
the dispatch, and the start route persists the id as `pendingSessionId`, then
reads it back. If the write fails, or the card is no longer in the history, the
spawn fails and the session is removed. So a session never receives its prompt
without a card that names it.

**The next click asks what the last one left** (`unfinishedStart`,
`api-routes-propose-repo-session.ts`), before it does anything else:

- **The card's prompt is in the session's transcript:** it *is* the started
  session. The card goes to `started` with that id and nothing new is created.
- **The prompt is not there, and a turn runs or waits in that session:** the
  prompt can still be on its way, in a turn that has not written its message or
  in the queue behind another turn. The click answers "already starting" and
  changes nothing. This is checked before any "not this card's" verdict.
- **Anything else:** the click starts a new session. That covers a recorded
  session that is gone, one that sits idle and empty, and an idle one that
  someone used for other work.

The evidence is the prompt itself because of when a turn writes it. A dispatched
turn persists its user message when the executor begins the turn, before the
agent runs (verified at `dispatched-turn.ts`, which passes `isNewSession:
false`, and at `turn-executor.ts`, `persistUserMessageOnce`). A session without
it never began the prompt. A session with it can have lost that turn to the
restart; it is still the session the card started, in the state of any session
that a restart interrupts. Any other message proves nothing about this card,
which is why "some user message" is not the test.

**Recovery never removes a session.** An earlier design deleted a leftover that
had no prompt. The leftover is a session the user can see and open, so deleting
it safely needs a guard that activation and dispatch both respect, for the whole
of the teardown. That is a platform primitive for a cosmetic gain, so the
leftover stays (see Known limitations).

**Decline asks too.** "No session was started" is what the card and the
next-turn notice say for a decline. A session that has the card's prompt turns
the card to `started` and refuses the decline.

**Once the session has its prompt, the card write cannot fail the start.** A
`started` write that throws is logged and the route still answers with the
session. The card keeps `pendingSessionId`, so the next click finds it.

## Declining, and telling the agent (reqs 10, 11)

```
user clicks "Decline"
  → POST    /api/sessions/:sessionId/repo-session-proposals/:cardId/decline
            refused while a start is in flight, or once started
            patch state=declined + declinedAt   (emit + persist)

next turn of the proposing session (any kind but compaction)
  → prepareRepoSessionOutcomeNotice: cards whose state is started / failed /
    declined and differs from agentNotifiedState
  → "[ShipIt] Since your last turn, the user acted on a card you posted…"
  → on the agent's result: agentNotifiedState = the state the notice carried
```

**Declined is terminal.** The start route refuses a declined card, and the card
offers nothing more. A user who changes their mind asks the agent, which
proposes again.

**The notice follows the settings notice, not the bug-report one.** Both prefix
the next turn and neither starts one: a click on a card is not a reason to wake
an idle session. The bug-report notice is marked when the prompt is assembled,
so a turn that never reaches the agent loses it; this one is marked through the
turn's `NoticeDelivery` receipt, only once the agent produced a result for that
prompt (the argument is in docs/299-agent-settings-access `plan.md`).

**A failed start is reported too.** Req 11 says "starts or declines", and a user
who clicked Start accepted the work whether or not the spawn succeeded. The
notice says the start failed and that the card offers a retry. That is why the
card records `agentNotifiedState` — the last state the agent heard — and not a
flag: a retry that then starts the session is a second thing to tell. The mark
writes the state the notice CARRIED, not the card's state at mark time, so a card
that moved on during the turn is reported on the next one.

**What reaches the agent in ShipIt's voice.** The repository label (built from
the resolved identity), the started session's id, and fixed text. The title the
agent wrote and a failure reason are quoted as data, flattened to one line, with
their quote and bracket characters stripped. The prompt is never carried.

## Key files

| File | Role |
|---|---|
| `src/server/shared/repo-session-proposal-validation.ts` | Shared field validation (lengths, required fields), used by the tool and the route so the two cannot drift. |
| `src/server/session/mcp-tools/propose-repo-session.ts` | The MCP tool: schema, agent-facing description, worker relay. |
| `src/server/session/agent-ops-routes.ts` | Worker relay `/agent-ops/propose-repo-session`. |
| `src/server/orchestrator/api-routes-propose-repo-session.ts` | The routes: the agent's emit, the user's start (ensure repo ready, detached spawn, card state transitions) and the user's decline; `unfinishedStart`. |
| `src/server/orchestrator/services/child-sessions.ts` | `spawnChildSession` and its `onChildClaimed` hook. |
| `src/server/orchestrator/services/repo-session-outcome-notice.ts` | The next-turn notice and its delivery receipt (req 11). |
| `src/server/orchestrator/services/repos.ts` | `ensureRepoReady()` — register + bare-clone a repository synchronously. |
| `src/client/components/RepoSessionProposalCard.tsx` | The card: proposed / starting / started / failed, and the trust notice (req 12). |
| `src/client/hooks/useRepoTrust.ts` | Whether the target is in the repository list, and trusted there. |
| `src/server/shared/types/domain-types/chat.ts` | `RepoSessionProposalCard` type. |
| `src/server/orchestrator/chat-history.ts` | `repo_session_proposal` column, find/update, rehydration. |

## What this does not do

- **No repo picker on the card.** The agent names the target (req 7). A wrong
  name is caught at emit time and the agent corrects it; it is not the user's
  step.
- **No follow-up channel to the started session.** Independent means
  independent (req 6). If the two changes must land together, that is a
  different feature and it starts with a different requirement. The next-turn
  notice (req 11) says the session started and names it; it reports nothing the
  started session does after that.

## Known limitations

Named because a reviewer found them and they were judged out of scope, not
because they are unknown.

- **A hanging clone has no deadline.** `ensureRepoReady` is the same helper the
  Ops fix-session path uses and carries the same property: a git clone that hangs
  rather than failing leaves the request and the card on `starting`. A clone that
  *fails* is handled — the card goes to `failed` with the reason and a retry. The
  deadline belongs on the shared helper, for both callers, not on this route.
- **Repository preparation is not serialized by identity.** Two cards targeting
  the same never-seen repository can enter `ensureBareCache` together, ahead of
  the claim service's per-repository lock. Also pre-existing and shared with the
  Ops path.
- **A start that an orchestrator stop interrupts can leave an empty session.**
  A stop after the target was graduated and before its turn began leaves a
  titled session with no message. The card's next start makes a new session and
  does not remove the empty one; the user archives it. Nothing duplicates the
  work.
- **"Already starting" lasts as long as the recorded session is busy.** A
  session whose runner stays busy and never writes the prompt keeps the card on
  that answer. No ordinary path does that; stopping the turn in that session
  releases the card. A timeout was rejected: it would start the second session
  this design exists to prevent.
- **Nothing settles an interrupted card without a click.** After a restart, or
  after a `started` write that failed, the card reads as retryable until the
  user acts on it, and the proposing agent hears the outcome only then.
- **The `started` write precedes the prompt's.** The route records `started`
  when the spawn returns, and the turn writes its user message a moment later.
  An orchestrator that stops in between leaves a `started` card that opens a
  session without the prompt. Closing it needs the card write to follow an
  acknowledgement from the turn, which the dispatch does not give its caller.
- **A card posted in a turn that a restart adopts can be lost whole,** and
  `pendingSessionId` with it. This is not specific to this card: planning#676.
- **A second failed start is not reported again.** The notice compares the
  card's state with the last state the agent heard, so failed → retry → failed
  reads as nothing new. The agent already knows the start failed and that a retry
  is possible, and it is still told when the card finally starts or is declined;
  an attempt counter was judged more mechanism than that case is worth.
- **A card left `starting` by a crashed orchestrator is retryable, deliberately.**
  The process-local in-flight set is what refuses a genuine double-start; a
  persisted `starting` that no process is working on is treated as a leftover, on
  both sides. The retry first looks at the session the dead start recorded ("A
  start that did not finish"), so it starts a second one only when that session
  does not hold the card's prompt and has no work under way.
