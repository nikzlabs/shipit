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

6. The options preselected when the list first appears are:
   - **Access:** Tailscale, and only Tailscale.
   - **Harnesses:** Claude Code, Codex, and OpenCode.
7. The default harness set is approved by a human, not derived. A harness added
   to ShipIt is offered in the list straight away, but stays **unchecked** until
   someone adds it to the approved set.

## Requirements that preserve existing behaviour

These are not new asks. They record what the installer already does, so that
changing the prompt does not change the install. (Requirements 6 and 7 above
deliberately do change it — see the resolved questions.)

8. An install with no terminal to prompt on proceeds with those defaults instead
   of hanging or failing — the `curl | bash` and CI paths stay non-interactive.

   The harness question already worked this way. The access question did **not**:
   it read unconditionally, so at EOF `set -e` killed the script, and under
   `curl | bash` the read swallowed the script's own next line as the answer and
   died on "choose 1, 2, 3, or 4". This requirement is therefore a fix there, not
   a preservation.
9. A pre-set `SHIPIT_HARNESSES` still skips the harness question and is used
   as-is — including the mixed-case and spaced forms the image build accepts
   (`Claude, Codex`).
10. The installer needs nothing installed on the host to draw the list. It runs on
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

**2026-08-17 — what should the defaults be?** Nik: "For access, make Tailscale
the only default. For harnesses, all should be enabled by default, even when we
add more." Requirement 6 was rewritten from the previous defaults (Cloudflare;
Claude Code and Codex) to say this.

One consequence he was told about rather than asked: the harness default is
everywhere, not only in the VPS picker. An unanswered question falls through to
the image build's own default, so leaving that at `claude,codex` would have made
the new default true only for operators who saw the prompt.

That reverses **docs/268 req 3**, which put OpenCode outside the default set when
it was new. Recorded there too; this instruction is the later one and wins.

**2026-08-17 — does a newly added harness become default-on by itself?** No.
Nik: "today's default is 'claude code, codex, opencode', but when we add a new
harness, it doesn't become the new default until I approve it." Requirement 7
records this.

The first implementation had derived the default from the list of *known*
harnesses, so adding one turned it on for everybody. That is now two separate
lists — what is offered, and what is preselected — and only the first is pinned
to the catalogue. A new harness is therefore visible and installable at once, and
unchecked until the approved list names it.
