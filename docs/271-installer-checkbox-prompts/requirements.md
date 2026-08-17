---
issue: planning#419
title: Installer checkbox prompts
description: Arrow-key + space-bar selection for the VPS installer's access and harness choices
---

# Requirements — installer checkbox prompts

The ShipIt VPS installer asks the operator two multiple-choice questions: which
access path to set up (Cloudflare Tunnel, Tailscale) and which agent harnesses to
install. Today both are typed answers — a menu number for one, a comma-separated
list for the other. They should be a keyboard-driven checkbox list instead.

## Requirements

1. The installer's access-setup question is a list the operator moves through
   with the arrow keys, toggles with the space bar, and confirms with Enter.
2. The harness question is presented the same way.
3. Each row shows whether it is selected: `[*]` when selected, `[ ]` when not.

   ```
    [ ] Claude Code
    [*] Codex
   ```
4. Selecting both access options sets up both. Selecting neither installs ShipIt
   without exposing it — the operator can run `cloudflare.sh` or `tailscale.sh`
   later.
5. Everything the installer does after each answer is unchanged.

## Requirements that preserve existing behaviour

These are not new asks. They record what the installer already does, so that
changing the prompt does not change the install.

6. The options preselected when the list first appears are today's defaults:
   Cloudflare for access, Claude Code and Codex for harnesses.
7. An install with no terminal to prompt on proceeds with those defaults instead
   of hanging or failing — the `curl | bash` and CI paths stay non-interactive.

   The harness question already worked this way. The access question did **not**:
   it read unconditionally, so at EOF `set -e` killed the script, and under
   `curl | bash` the read swallowed the script's own next line as the answer and
   died on "choose 1, 2, 3, or 4". This requirement is therefore a fix there, not
   a preservation.
8. A pre-set `SHIPIT_HARNESSES` still skips the harness question and is used
   as-is — including the mixed-case and spaced forms the image build accepts
   (`Claude, Codex`).
9. The installer needs nothing installed on the host to draw the list. It runs on
   a bare Ubuntu box before Docker, `jq`, or the repo are there.

## Out of scope

- The local installer (`deployment/local/setup.sh`) asks none of these
  questions — it has no access choice and no harness choice — so there is
  nothing there to convert.
- The egress-containment question is a yes/no confirmation of a security
  downgrade, not a selection among options. It stays a typed `[y/N]`.
- The Cloudflare script's free-text questions (domain, account ID, allowed
  email) are not selections and are unchanged.

## Open questions

None.

## Resolved questions

None.
