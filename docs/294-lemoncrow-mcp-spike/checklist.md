# LemonCrow MCP-only spike — checklist

- [x] Verify the global-mode premise against `scripts/install_claude.sh` before
      building on it (req 2).
- [x] Re-test blocker 1 (branch guard) against the additive shape (req 3).
- [x] Re-test blocker 2 (transcript rendering) against the additive shape (req 3).
- [x] Re-test blocker 3 (writes into the clone) empirically, with
      `git add -A --dry-run` (req 3).
- [x] Build the tokenizer cache offline so tiktoken works without egress.
- [x] Port docs/291's six tasks, gold sets and keywords into a three-arm harness
      (req 4).
- [x] Reproduce docs/291's ripwire total as a check that the method matches.
- [x] Measure process shape, memory, disk, latency, egress and telemetry (req 7).
- [x] Re-check project age, contributors and licence.
- [x] Write `requirements.md` before `plan.md`, and cite requirements from it.
- [x] Cross-link planning#332 and create a tracker issue for this doc.
- [x] Get an independent review (`shipit agent run --role reviewer`).

Fixes the review found, all applied and re-measured:

- [x] Expand brace notation before scoring, on both arms.
- [x] Score `positioned` from a line number rather than a marker position, so an
      error string containing a gold filename cannot score.
- [x] Stop drawing follow-up files from the gold set — draw only from what each
      arm's own answer named, so no oracle knowledge enters.
- [x] Charge ripwire the same follow-up policy instead of only LemonCrow.
- [x] Measure each follow-up's success rather than asserting it.
- [x] Narrow the headline denominator to response text, and show the
      schema-inclusive figure alongside it.
- [x] Drop the inherited "the baseline is a floor" claim; state both of its
      biases instead.
- [x] Record `SERVER_INSTRUCTIONS` — the MCP server steers toward substitution
      with no plugin installed.
- [x] Record that enabled MCP servers are account-wide, not per-session.
- [x] Test `LEMONCROW_HIDE_TOOLS`, including whether it blocks a direct call.
- [x] Correct four over-claims: `--print-only` does print the plugin install; the
      default-agent write is conditional; PostHog needs a key; egress is
      avoidable with a pre-seeded cache.
- [x] Pin LemonCrow to an exact SHA rather than mutable `main`.

Remaining:

- [ ] **Blocked on two open questions.** Whether ShipIt needs per-server MCP tool
      authorization is held in `docs/291-ripwire-context-map/requirements.md`
      § "Open questions", with all of ShipIt's MCP adoption gates. What "must not
      change an existing session" requires is still in
      [requirements.md](requirements.md). No implementation code until both are
      answered (req 6, req 8).
- [ ] An agent-in-the-loop trial. Everything measured here is tool responses;
      whether a steered model actually keeps using native `Edit`/`Bash` — and so
      whether inline diffs and the branch guard survive — cannot be settled
      without running a real session and reading the transcript.
