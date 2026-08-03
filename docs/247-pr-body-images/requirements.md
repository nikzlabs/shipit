---
title: Images in pull request bodies
description: Let the agent publish a screenshot it produced so it renders inline in a pull request body or comment.
---

# 247 — Images in pull request bodies: requirements

Source: [nikzlabs/shipit#1912](https://github.com/nikzlabs/shipit/issues/1912) — "let the agent attach images to a PR body via the gh shim".

The design that implements these requirements will be in `plan.md`. It does not exist yet: this feature has open questions, so no design and no implementation work has started.

## Requirements

1. When the agent has produced an image during a session — a browser screenshot, a rendered mockup, a diagram — it can publish that image so that it renders inline for anyone reading the pull request.

2. The same works for a comment on a pull request, not only for the pull request body.

3. The agent never handles a GitHub token to do this. Publishing is brokered through the orchestrator, exactly like the pull-request operations the agent already has.

4. Publishing an image does not pollute the project with the image. It never appears in the pull request's file diff, in the project's branch history, or in a checkout of the repository.

5. A published image keeps rendering after the session that produced it is gone.

6. The agent knows up front whether images in a pull request are possible for the repository it is working in. Its platform documentation says so, so an agent asked for before/after screenshots plans for it at the start rather than discovering the gap when it is finishing the work.

7. When publishing is not possible, the agent is told why, in terms it can act on. A pull request never ships a broken image.

## Requirement provenance

Requirements 1, 2, 3, 4, 6 and 7 restate the issue. Requirement 5 is inferred: the issue asks that the image render "for every reviewer", which reviewers do days after the session container is destroyed. It is stated separately so it can be struck if it is not wanted.

## Open questions

- **Private repositories.** GitHub has no token-authenticated way to produce an image URL that renders inline. The only URL form that renders regardless of repository visibility (`github.com/user-attachments/assets/…`) is produced by the browser drag-and-drop flow, which authenticates with a logged-in `user_session` cookie and rejects a PAT or OAuth token; there is no REST or GraphQL equivalent, and the request for one is open and unanswered by GitHub. For a **public** repository an image committed to a side branch renders through its raw URL, because GitHub's image proxy can fetch it unauthenticated. For a **private** repository that same proxy cannot authenticate, so the image renders broken. So the feature is deliverable for public repositories only. Options:
  - (a) Ship it for public repositories; on a private repository the command refuses with a clear message naming the reason, and the documentation says so up front (satisfies requirements 6 and 7 for the private case).
  - (b) Ship only requirements 6 and 7 — no publishing at all, just documentation stating that images in a pull request body are not possible.
  - (c) Have ShipIt host the image itself at a public URL. Considered and rejected in analysis, not offered as a real option: ShipIt deployments sit behind Cloudflare Zero Trust by default and self-hosted ones are not publicly reachable at all, so GitHub's image proxy cannot fetch the image; and the URL would stop working when the instance goes away, breaking requirement 5.

- **Where the bytes live.** For the public-repository case the image has to be a blob GitHub will serve. Options:
  - (a) A dedicated branch in the same repository (for example `shipit-assets`), never merged. Costs nothing to set up and is durable, but the branch is visible in the repository's branch list and the blobs are in its object store — a weaker reading of requirement 4 than "not in the repository at all".
  - (b) A separate repository owned by the user, created once (for example `shipit-assets`), holding review images for every project. Keeps each project repository untouched, but ShipIt has to create a repository and it must be public.

- **What the agent calls.** Options:
  - (a) `--attach <path>` on `gh pr create` / `pr edit` / `pr comment`, which uploads the file and rewrites a placeholder in the markdown body.
  - (b) A single `shipit upload <path>` that prints a URL, which the agent then writes into any markdown it is composing — a pull request body, a pull request comment, an issue comment.
  - (c) Both.

## Resolved questions

_None yet._
