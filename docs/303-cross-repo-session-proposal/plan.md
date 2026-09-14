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

user clicks "Start in owner/repo"
  → POST    /api/sessions/:sessionId/repo-session-proposals/:cardId/start
            (NOT container-accessible: the agent proposes, the user starts)
  → handler patch state=starting  (emit + persist)
            ensureRepoReady(repoUrl)
            spawnChildSession(thisSession, { detached: true, noRole, repoUrlOverride, prompt, title })
            patch state=started + startedSessionId   (emit + persist)
            …or state=failed + errorMessage, and the card offers a retry
```

Every state lands in persisted chat history, not only on the wire — `started` is
terminal state a user expects to still be there tomorrow, which is the dividing
line in `CLAUDE.md`'s transcript-persistence rule (req 9).

## Key files

| File | Role |
|---|---|
| `src/server/shared/repo-session-proposal-validation.ts` | Shared field validation (lengths, required fields), used by the tool and the route so the two cannot drift. |
| `src/server/session/mcp-tools/propose-repo-session.ts` | The MCP tool: schema, agent-facing description, worker relay. |
| `src/server/session/agent-ops-routes.ts` | Worker relay `/agent-ops/propose-repo-session`. |
| `src/server/orchestrator/api-routes-propose-repo-session.ts` | Both routes: the agent's emit and the user's start (ensure repo ready, detached spawn, card state transitions). |
| `src/server/orchestrator/services/repos.ts` | `ensureRepoReady()` — register + bare-clone a repository synchronously. |
| `src/client/components/RepoSessionProposalCard.tsx` | The card: proposed / starting / started / failed. |
| `src/server/shared/types/domain-types/chat.ts` | `RepoSessionProposalCard` type. |
| `src/server/orchestrator/chat-history.ts` | `repo_session_proposal` column, find/update, rehydration. |

## What this does not do

- **No repo picker on the card.** The agent names the target (req 7). A wrong
  name is caught at emit time and the agent corrects it; it is not the user's
  step.
- **No follow-up channel to the started session.** Independent means
  independent (req 6). If the two changes must land together, that is a
  different feature and it starts with a different requirement.

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
- **A start interrupted after the target session was created can leave an
  orphan.** The target is created before environment preparation finishes, and
  its id reaches the card only when the spawn returns. If preparation fails, the
  card says `failed` while a session exists, and a retry creates a second one. The
  duplicate is visible in the sidebar and archivable; persisting the card→target
  association at allocation is the real fix.
- **A card left `starting` by a crashed orchestrator is retryable, deliberately.**
  The process-local in-flight set is what refuses a genuine double-start; a
  persisted `starting` that no process is working on is treated as a leftover, on
  both sides. The trade is a possible duplicate over a spinner with no exit.
