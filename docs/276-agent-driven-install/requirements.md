---
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

### Behaviour that must not change

10. A person who installs by hand sees no change: the same one-line commands,
    the same questions, and the same defaults.
11. A pre-set answer (for example `SHIPIT_HARNESSES`) continues to skip its
    question and is used as given.
12. An install with no terminal continues with the defaults. It does not stop
    and it does not fail.

## Out of scope

- A new question about remote access in the local installer. The local install
  binds to localhost, and `docs/254-local-bind-and-tailnet-access` req 3 keeps
  Tailscale out of the default local path on purpose.
- A change to what the installers do after each answer.

## Open questions

- **Cloudflare answers.** The Cloudflare setup asks for a domain, an account ID,
  an API token, and an allowed email. None of them can be given in advance
  today, so an agent that selects Cloudflare cannot complete the install. Must
  agent mode cover these too?
- **The egress-containment question.** On a host that cannot run the containment
  sidecar, the installer asks the person to accept a security downgrade. May an
  agent answer this question in advance, on behalf of the person?
- **Local remote access.** Tailscale access for a local install is a separate
  script today. Must the agent see it as a parameter it can present, or is it
  outside agent mode?

## Resolved questions

None yet.
