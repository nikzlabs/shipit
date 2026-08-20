---
issue: planning#456
title: Agent-driven install — design
description: A self-describing installer (--describe) plus a pre-answer variable for every question, and the harness picker on the local install
---

# Agent-driven install

Implements [requirements.md](./requirements.md).

Two changes that turn out to be one: the local installer gets the harness
question the VPS installer already asks (reqs 1–3), and **both** installers learn
to describe their own questions in JSON and to take every answer from a variable
(reqs 4–13). The second is only possible because the first removes the last
question that existed on one side and not the other.

## The shape of agent mode

There is no separate mode, and that is the point. An agent-run install is the
ordinary install with every answer supplied:

```bash
# 1. Discover — no root, no writes, no clone.
bash <(curl -fsSL …/deployment/local/setup.sh) --describe

# 2. The agent shows the questions to the person and collects the answers.

# 3. Install — the same command everyone else runs.
SHIPIT_HARNESSES=claude,codex bash <(curl -fsSL …/deployment/local/setup.sh)
```

A "mode" flag would have to be threaded through every question and would drift
from the path humans take. Instead: a question whose variable is set is never
asked, which is behaviour both installers already had for `SHIPIT_HARNESSES`
(req 15), and this doc extends to the rest.

### Why JSON from the script, and not a document

Req 5 says the agent learns the questions *from the installer*. A markdown page
is a second copy that drifts, and the drift is invisible: the agent still gets an
answer, just the wrong one. `--describe` renders from the same `HARNESS_ROWS`
array the picker draws, so a harness added to the list is offered to the agent in
the same commit — the same reasoning docs/271 used to put `--dry-run` inside the
installer rather than beside it.

Req 6 (discovery changes nothing) is what forces it to be a flag on the installer
rather than a file in the repo: on a bare VPS the repo is not there yet, and
cloning it is a change. `--describe` runs before the first `apt-get`, needs no
root, and writes nothing. `SHIPIT_DESCRIBE=1` does the same, for the
`bash -c "$(curl …)"` form that cannot pass an argument.

### How an agent finds `--describe`

A self-describing installer is worth nothing if the flag is never typed, and this
is the weakest link in the feature. Three paths, deliberately overlapping,
because an agent told "install ShipIt" may take any of them:

1. **The README.** "Let an agent install it" is the **first** item under
   Quickstart, ahead of both one-liners, and `deployment/README.md` carries the
   procedure and the full variable table. This is the path an agent takes when it
   searches for how to install ShipIt at all.
2. **`--help` on the installer itself.** An agent reaches for `--help` long
   before it reads a README, so both installers answer it with the flags, the
   answer variables, and a sentence saying what to do when you are installing for
   someone else. An unknown argument prints the same flag names, so a wrong guess
   also lands on the right answer.
3. **The installer says so when it is about to skip the questions.** No terminal
   and no answers supplied is exactly what an agent's shell looks like. Both
   installers print, *before* anything on the machine changes, that every
   question is about to take its default and that `--describe` is how to ask them
   instead.

What none of these do is *force* the issue: an agent that reads nothing still
gets a working install with the approved default set, and the person is simply
never asked. Closing that would mean a blind run with no answers **stopping**
rather than defaulting, which reverses req 16 and breaks the documented
`curl | bash` path, so it is not done here.

### The document

```jsonc
{
  "schema": "shipit.installer/1",
  "installer": "local",            // or "vps"
  "command": "bash <(curl …)",     // what to run once answered
  "needsRoot": false,
  "instructions": [ … ],           // req 8: show the person, do not choose
  "questions": [
    {
      "id": "harnesses",
      "variable": "SHIPIT_HARNESSES",
      "type": "multi_select",      // or "select", "text", "confirm"
      "default": "claude,codex,opencode",
      "askedWhen": "always",       // or a condition, in words
      "secret": false,
      "options": [ { "id": "claude", "label": "Claude Code", "summary": "…" } ]
    }
  ],
  "followUps": [ … ]               // req 13: local Tailscale access
}
```

Both installers emit the same schema (req 9), so one agent procedure serves both.
`askedWhen` carries the conditional questions honestly rather than hiding them:
the egress question appears only on a host that fails the sidecar probe, and the
Cloudflare questions only when the access answer includes Cloudflare. An agent
that reads `askedWhen` can collect those answers up front and never be stopped by
a question it could not have predicted (req 7).

`secret: true` marks the Cloudflare API token. `instructions` tells the agent it
must not print, log, or commit such a value (req 11), because the JSON is the
only thing an agent is guaranteed to read.

## What each installer changes

### Shared block, duplicated on purpose

The picker, the harness rows, the validator and `resolve_harnesses` now sit
between `# --- BEGIN shipit-installer-common` and `# --- END
shipit-installer-common` in **both** `setup.sh` files, byte for byte. The
existing `shipit-picker` markers stay nested inside it, so
`installer-picker.test.ts` keeps extracting what it always did.

Duplication is the only option available, for the reason docs/271 records for the
picker and `agent-cli-install.test.ts` records for `HARNESS_DEFAULT`: the
question is asked, and now also *described*, while the script is a string piped
from `curl` with no repo to source a library from. `installer-describe.test.ts`
compares the two blocks byte for byte, so a fix applied to one and not the other
is a red build rather than a divergence nobody sees.

### Local (`deployment/local/setup.sh`)

- Asks the harness question after the clone and before the image build — the
  same list, the same preselection, the same keys (reqs 1–2).
- Persists the answer to `~/.shipit/.shipit.env` via the new
  `shipit_persist_env` in `lib.sh`, which `shipit_load_env_file` already sources
  before every build. So `update.sh` keeps the selected set (req 3).
  `disable_egress_containment` now uses that helper instead of its own copy.
- An **unanswered** question persists nothing, exactly as on the VPS: writing the
  default out would freeze this install against a later change to the approved
  set, and a re-run would clobber a narrower earlier choice.
- Neither installer reads the env file it writes, so **re-running `setup.sh`
  interactively asks again, preselecting the approved set rather than your
  current one**. That is the VPS behaviour too, and it is why req 3 is carried by
  `update.sh` — the update path never asks, so a selection survives every update.
  Loading the file first would instead make the question unaskable on a re-run,
  since a set variable is treated as an answer.
- `SHIPIT_EGRESS=on` joins the existing `off` as an explicit answer (req 12).

### VPS (`deployment/vps/setup.sh`)

- The egress question gains `SHIPIT_EGRESS` and a `[ -t 0 ]` guard. Its `read`
  was unconditional, so on a host that fails the probe a `curl | bash` install
  died at `set -e` — the same defect docs/271 req 8 fixed for the access
  question, in the one branch that runs only on the hosts least able to recover.
  With no answer and no terminal it keeps containment **on** (req 12).
- `--describe` beside the existing `--dry-run`.

### Early validation of the answers

Both installers validate `SHIPIT_ACCESS`, `SHIPIT_HARNESSES` and `SHIPIT_EGRESS`
**before** the first host-touching step. A typo used to fail where the answer was
consumed: on the VPS that is after Docker is installed and the repo cloned. An
agent that mistypes an option id should get its error in a second, on a host it
has not yet changed.

### Cloudflare (`deployment/vps/cloudflare.sh`)

Each of the four questions takes a variable — `SHIPIT_CF_DOMAIN`,
`SHIPIT_CF_API_TOKEN`, `SHIPIT_CF_ACCOUNT_ID`, `SHIPIT_CF_ALLOWED_EMAIL` (req
10). Without them nothing here could be answered in advance, so agent mode would
have stopped half way through exactly the path that produces a public HTTPS URL.

The token is read with `read -rs` for humans, never echoed, and never written to
`/etc/shipit/setup.conf` — an agent exports it for one command and it lives only
in that process's environment (req 11). It is **not** hidden from the process
table: the script has always passed it to `curl` as an `Authorization` header
argument, where `ps` on the same host can read it. That is unchanged here and
worth knowing; req 11 is about logs, files and transcripts.

### The shared block on macOS

The picker was VPS-only, so bash 3.2 — `/bin/bash` on macOS — is a **new**
platform for it. Bash 3.2 rejects a fractional `read -t` outright rather than
rounding it, which broke the arrow keys and printed the complaint into the list
being drawn. The timeout is now picked from `BASH_VERSINFO`, and a test rejects
any fractional literal in the block, since one line was a symptom of a class.

A missing answer with no terminal now fails with the variable's name instead of
`read` dying under `set -e`.

## Key files

| File | Role |
|---|---|
| `deployment/local/setup.sh` | Harness question, `--describe`, early validation |
| `deployment/local/lib.sh` | `shipit_persist_env` for the answer |
| `deployment/vps/setup.sh` | Shared block, `--describe`, `SHIPIT_EGRESS`, early validation |
| `deployment/vps/cloudflare.sh` | Four pre-answer variables |
| `deployment/README.md` | The agent procedure and every variable |
| `src/server/orchestrator/services/installer-describe.test.ts` | Schema, block identity, no-writes, early validation |
| `src/server/shared/agent-cli-install.test.ts` | Harness lists guarded in **both** installers |
