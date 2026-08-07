---
issue: planning#171
title: Secret-scan guard — requirements
description: What the commit-time credential guard must do, in the human's terms.
---

# Requirements — secret-scan guard in post-turn auto-commit

Written retroactively (2026-08-04) when the feature was materially reworked to
make a block visible and actionable. Requirements 1–4 restate the original
docs/213 intent; 5–8 come from the rework. See `plan.md` for how they are built.

## Requirements

1. A credential introduced by an agent turn must never reach a commit or a push.
   The guard runs at commit time, server-side, on every repo edited in ShipIt.

2. When a credential is found, the user's work is not destroyed. Nothing is
   committed, and the change stays in the working tree.

3. The warning must name where the credential is (file, line, which rule matched)
   without re-printing the credential itself.

4. There must be a way through for a false positive that does not require
   disabling the guard.

5. **The user must not be able to miss that commits have stopped.** The original
   design surfaced a block as a single chat message; in practice it scrolled out
   of view under later agent turns and went unnoticed for an extended period.
   Whatever surfaces the block has to still be visible after unrelated turns have
   come and gone.

6. **The user must be able to see that the stoppage is not limited to the
   offending change.** While a credential sits in the working tree, no turn on
   that session commits anything — including later, unrelated work.

7. **The agent must be told that its work did not land**, so that the party who
   wrote the credential is asked to remove it, rather than continuing to build on
   a branch that can no longer commit.

8. **The agent must not be able to resolve a block by silencing the scanner.**
   Deciding that a matched credential is fake is the user's call, not the agent's.

## Open questions

_None._

## Resolved questions

- **2026-08-04 — How should a secret-blocked commit surface?** The block had been
  reported only as a chat notice, which the user found by accident long after the
  fact, with every intervening turn having silently failed to commit. Offered:
  (a) a sticky banner plus an agent-facing remediation turn, (b) a sticky banner
  only, (c) an agent-facing turn only. **Nik chose (a).** Recorded as requirements
  5–7. Raised at the same time, and accepted as part of (a): a remediation turn
  gives the agent an incentive to append `gitleaks:allow` rather than remove the
  credential, so the prompt must forbid it — recorded as requirement 8.
