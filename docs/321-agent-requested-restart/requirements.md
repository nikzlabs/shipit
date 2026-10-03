---
title: Agent-requested container restart
description: The agent restarts its agent container itself, after its turn, so the user never has to find a restart button.
---

# 321 — Agent-requested container restart: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

Background, in the user's words: "sometimes shipit or the agent says 'restart container' but it is not clear for the user how to do it." PR #3040 renamed the buttons and made every message name the button and where it is. This feature removes the need to click one when the agent is the one that knows a restart is needed.

1. When a change made in a session takes effect only after the session container restarts, the agent can make that restart happen itself. The user does not have to find or click a restart control.
2. The restart happens after the agent's turn ends, so it does not cut off the turn that asked for it. It also happens when the turn ended because the user pressed **Stop**.
3. The agent can ask only for a restart of the agent container — what **Restart agent container** does. **Restart all** stays a user action. The agent already restarts single preview services itself (`shipit service restart`).
4. The restart needs no click from the user. The agent says in chat what it restarts and why. The workspace, `/persist` and the committed work are kept.
5. After the restart, the agent continues on its own: it gets a new turn on the new container, with a note that it wrote before the restart.

## Resolved questions

- 2026-09-30 — Which restarts can the agent ask for: only **Restart agent container**, or also **Restart all**? Chosen: agent container only; the agent can already restart preview services. Requirement 3 added.
- 2026-09-30 — Must the user confirm before the restart? Chosen: no click — the agent says in chat what it restarts and why, and the workspace, `/persist` and committed work are kept. Requirement 4 added.
- 2026-09-30 — After the restart, does the agent continue on its own, or wait for the user's next message? Chosen: it continues — it gets a new turn on the new container, with a note that it wrote before the restart. Requirement 5 added.
- 2026-09-30 — Must pressing **Stop** cancel a restart that the agent asked for? Chosen: no — "restart is kind of an abstraction that we try to hide, so restart after hitting stop seems fine." Requirement 2 changed; requirement 5 applies after Stop as well.
