---
issue: planning#456
title: Agent-driven install
description: The local installer asks which agent CLIs to install, and both installers describe themselves so an agent can run the install for the user
---

# Requirements — agent-driven install

Two asks, made together on 2026-08-20:

- "CLI selection should be asked on local install, too."
- "There should be an agentic-friendly mode that doesn't require to pick options
  manually. I.e. the user says 'install shipit' and an agent discovers available
  modes/parameters and presents to the user, then does the required actions on
  user's behalf."

## Requirements

### Harness selection on the local install

1. The local installer asks which agent CLIs (harnesses) to install.
2. It asks the question in the same way the VPS installer asks it: the same
   options, the same preselected set, and the same keyboard list (arrow keys
   move, the space bar toggles, Enter confirms).
3. The answer applies to this install and stays applied. A later update does not
   change the set the person selected.

### An agent installs ShipIt for the user

4. A person can install ShipIt with one instruction to an agent ("install
   ShipIt"). The person answers the agent's questions in a chat. The person does
   not read the install documentation, and does not operate a terminal picker.
5. The agent finds the questions from the installer itself: which questions an
   install asks, the options for each question, which option is the default, and
   what each option does.
6. The agent can do this before anything on the machine changes. The discovery
   step installs nothing, writes no file, and does not need root permission.
7. Every question that an install asks can be answered in advance. An install
   that has all its answers does not stop to ask, and does not stop because
   there is no terminal.
8. The agent shows the choices to the person and gets a decision before the
   install starts. The agent does not make the choice for the person.
9. The local install and the VPS install describe themselves in the same format,
   so one agent procedure is sufficient for both.

### The questions an agent must be able to answer

10. Every answer the Cloudflare setup needs — the domain, the account ID, the API
    token, and the allowed email — can be given in advance. An agent-run install
    that selects Cloudflare completes without a stop.
11. The API token is a secret. The install must not write it to a log, a
    committed file, or the agent's own transcript.
12. On a host that cannot contain the agent network, an agent may answer the
    security question in advance, but only with an explicit answer that the
    person gave. With no answer given, the install keeps containment on. It never
    assumes the downgrade.
13. The description tells the agent that remote access over Tailscale is
    available for a local install, so the agent can offer it and set it up.

### Behaviour that must not change

14. A person who installs by hand sees no change: the same one-line commands,
    the same questions, and the same defaults.
15. A pre-set answer (for example `SHIPIT_HARNESSES`) continues to skip its
    question and is used as given.
16. An install with no terminal continues with the defaults. It does not stop
    and it does not fail.

## Out of scope

- A new **question** about remote access in the hand-run local installer. The
  local install binds to localhost, and `docs/254-local-bind-and-tailnet-access`
  req 3 keeps Tailscale out of the default local path on purpose. Req 13 makes it
  visible to an agent, which is a different surface.
- A change to what the installers do after each answer.

## Open questions

None.

## Resolved questions

**2026-08-20 — must agent mode cover the Cloudflare answers?** Nik: yes, cover
them. Requirements 10 and 11 record this. The consequence he was shown with the
question: the agent then handles a Cloudflare API token, which is a secret — so
req 11 states where it must not end up.

**2026-08-20 — may an agent answer the egress-containment question?** Nik: yes,
with an explicit answer. Requirement 12 records both halves: the person decides
and the answer is passed explicitly, and an install with no answer keeps
containment on rather than assuming the downgrade.

**2026-08-20 — is Tailscale for a local install a parameter the agent may
present?** Nik: yes, the agent may offer it. Requirement 13 records this. The
hand-run installer still asks nothing about it, so docs/254 req 3 is unchanged.
