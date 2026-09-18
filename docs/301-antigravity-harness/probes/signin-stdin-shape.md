# The sign-in refuses on a pipe — measured on 1.1.27 (2026-09-14)

The shipped Antigravity sign-in could never complete. It was not a version
difference, a credential problem or a missing terminal: the CLI decides whether
it may start an interactive login from **the file type of stdin**, and ShipIt
gave it a pipe.

## The measurement

Same binary (pinned 1.1.27), same flags, same freshly-created `HOME`, stdout and
stderr both redirected to files in both runs. `GEMINI_API_KEY` unset, so neither
run could authenticate silently. The **only** difference is what stdin is:

```
antigravity -p "Reply with the single word pong." \
  --output-format text --dangerously-skip-permissions
```

| stdin | the CLI's own log | what the user gets |
|---|---|---|
| `/dev/null` (a character device) | `printmode.go:387] Print mode: triggering interactive OAuth` | `Authentication required. Please visit the URL to log in:` + the Google URL |
| a pipe | `printmode.go:382] Print mode: not logged in and no controlling terminal; cannot complete interactive login` | `Error: authentication required. Run 'antigravity' to log in, then retry.` |

Both runs log `Print mode: not authenticated, trying silent auth` and then
`silent auth failed` first, so they reach the same decision point and diverge
only on this check.

**A real controlling terminal is not what it wants**, despite the message. The
`/dev/null` run had none — `/dev/tty` could not be opened in that shell at all —
and running it under `setsid`, which guarantees no controlling terminal, still
reached `triggering interactive OAuth`. A character device on stdin is
sufficient; a pipe is not.

## Why this shipped

Phase 0 probed the sign-in with `probe.sh`, which runs the CLI straight from a
shell, so stdin was inherited and interactive. ShipIt's auth manager spawned it
with `stdio: ["pipe", "pipe", "pipe"]` — and a pipe on stdin is not incidental
there, it is the only channel ShipIt has for delivering the authorization code
the user pastes back. So the very mechanism the flow needs is the one that made
the CLI refuse to start it.

The probe and production differed in invocation *shape*, not in version or
environment, and nothing in the Phase 0 evidence could have shown it.

## The fix, and how it was confirmed

The sign-in spawns on a pty (`node-pty`), as
`orchestrator/agents/claude/auth-manager.ts` already does. A pty master is a
character device, so the check passes, and ShipIt can still write the code. It
is sent as a carriage return because that is what a terminal sends when the user
presses Enter, and the line discipline maps it to a newline — not because a
newline would fail; review measured that either is accepted.

Confirmed twice. Directly: the same command spawned through `node-pty` prints
the URL, where the piped spawn refuses. And end to end, through ShipIt's real
sign-in path in the dogfood instance — before the fix the account failed with
`error authentication required. Run 'antigravity' to log in, then retry.`;
after it, the account's own CLI log reads `Print mode: triggering interactive
OAuth` and the flow ends only at `error authentication timed out`, because no
human pasted a code.

**A claim this write-up first got wrong, corrected by review.** It said a wide
`cols` was needed because a pty hard-wraps at the column count. It does not: a
pty master carries the bytes the process writes, and wrapping is a rendering
concern of whatever draws them. Measured — at **`cols: 20`** the 704-character
sign-in URL still arrives intact on one line. So the terminal is an ordinary
80×40 and the width is not load-bearing. The original claim was assumed from the
Claude manager's unwrapping logic and never tested; the test that asserted a
wide `cols` was guarding nothing.

## What the completed sign-in then showed (2026-09-14)

A human completed the flow in the dogfood instance and the account went `ready`.
Three further defects fell out of the first real account credential and the first
real account turn, none of which key mode could have reached:

- **The token file is nested.** It is `{auth_method, token: {access_token,
  token_type, refresh_token, expiry}}` — the credential fields sit one level
  down. Both readers looked at the top level, so `readAntigravityTokenFreshness`
  returned `null` for every real token. The sync path fails safe rather than
  destructively, but it logged `token-freshness=unorderable
  outcome=stranded-rotation` and never published a refreshed token back.
- **There is no `id_token`.** A `consumer` sign-in's `access_token` is opaque
  (258 characters, not a JWT), so nothing in the file names the account and the
  row shows no email or external id. That is now recorded as honest absence
  rather than left looking like a reader that works.
- **The account-mode host was wrong in the egress allowlist.** Every
  `loadCodeAssist` and `streamGenerateContent` went to
  `daily-cloudcode-pa.googleapis.com`; the bare `cloudcode-pa.googleapis.com`
  taken from the binary's compiled hosts appeared nowhere in the turn. Allowlist
  entries are exact unless they begin with a dot, so the bare entry did not cover
  the prefixed host and account mode would have been blocked wherever egress is
  enforced.

The committed freshness fixture was the reason the first of these could not have
been caught earlier: `token-freshness-guard.test.ts` already asserts "orders the
real captured credential file" and "drives both sync guards without an
unorderable reading", and both pass trivially against a fixture that was
reconstructed rather than captured. With the real shape committed, reverting the
fix turns all three of that file's antigravity cases red.

## A regression the pty introduced, caught by review

`node-pty` reports a SIGTERM'd process as **`{exitCode: 0, signal: 15}`**
(measured). The first version of this fix read only `exitCode`, so cancelling a
sign-in on a home that already held an OLD token announced a completed sign-in
that never happened — the `child_process` path it replaced reported a null exit
code and could not. The callback now carries `signal` and refuses to complete
when one is present.

The tests had the same blind spot the shipped defect did: every case injected a
fake process, so swapping the production spawn back to a pipe left them all
green. One case now drives the **real** spawn against a stub that reports
`fstat(0).isCharacterDevice()`, and reverting to a piped `child_process.spawn`
turns it red with `STDIN=other`.
