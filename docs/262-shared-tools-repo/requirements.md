---
issue: planning#355
title: Shared tools repository for multi-repo projects
description: A repo declares a common tools repository; its sessions get the tools' files and live services with no deploy step.
---

# Shared tools repository — requirements

Human-owned. Numbered statements are what the feature must do, in the user's
terms — observable outcomes, never mechanism. Gaps the agent had to fill live
under **Open questions** until a human answers them.

## Context, in the user's words

The user builds games with ShipIt. Every game lives in its own repository —
that part is convenient and stays. A couple of tools — for requirements
management, for image generation, and so on — live in one common repository.
ShipIt gives no convenient way to access that repository and the services
inside it from a game session.

Hosting the tools behind deployed endpoints (e.g. as remote MCP servers) was
considered and rejected by the user: a tool change would mean edit in the tools
repo → test with fake data → deploy somewhere with proper authentication. The
user wants the integration that same-repo services already have: the services
run in the session, the agent can send data to the preview, and the agent
receives data when the player clicks buttons.

## Requirements

1. Games each stay in their own repository. The common tools stay in their own
   repository. The feature must not require merging them or copying tool code
   into game repos.
2. A game repository declares the common tools repository once. After that,
   every session on that game repository has the tools repository's files
   available in its workspace.
3. The tool services from the common repository run live inside the game
   session, as first-class services: they appear in the session's service list,
   they can be previewed, the agent can interact with them (send data, call
   them), and interactions in their pages (e.g. a player clicking a button)
   reach the agent — the same integration same-repo services have today.
4. A change to a tool is testable against the real game, in the game session,
   immediately — with no publish step, no deploy step, and no separate
   authentication setup.
5. Wiring the tools into a new game costs one declaration. No per-game copies
   of service definitions or install boilerplate that must be kept in sync
   across game repos.
6. This works when the repositories are private.

## Requirement provenance

Requirements 1–4 restate what the user said directly (two voice messages,
2026-08-11). Requirement 5 generalizes the user's stated friction ("ShipIt
doesn't provide a convenient way") to the multi-game case; the "one
declaration" bar is the agent's proposal. Requirement 6 is inferred from the
repositories being private today; the credential-mode question it raises is
open below.

## Open questions

- **Writable or read-only tools checkout?** May a game session edit the tools
  checkout and push the change back to the common repository, or is the tools
  repo edited only in its own sessions? The user's no-deploy loop (req 4)
  suggests fixing a tool right where the real game data is.
- **Freshness.** When does a game session's tools checkout update — does it
  track a branch of the tools repo automatically, or is it pinned per game repo
  and bumped explicitly?
- **Service instances.** Do tool services run per-session (each game session
  gets its own instance) or shared (one instance serves all sessions)?
- **Where does the declaration live?** Per game repo in `shipit.yaml` (like
  `issues.trackers`), or once at account/project level so all repos get it?
- **Credential modes.** Must this work under GitHub App credentials, whose
  tokens are minted per-repo, or is PAT-mode support enough for now?
- **MCP scope.** Are MCP-style tool declarations (the tools repo shipping an
  MCP server the agent gets automatically) in scope, or out of scope for v1?

## Resolved questions

(None yet.)
