# A completed sign-in was reported as a failure — measured on 1.1.27 (2026-09-16)

The pty fix (`signin-stdin-shape.md`) let the CLI start an interactive login, and
the first human to finish one still saw the account fail. The exchange worked;
ShipIt's reading of the exit did not.

## What node-pty reports

`orchestrator/agents/antigravity/auth-manager.ts` completed a sign-in on
`exitCode === 0 && signal === undefined && tokenExistsAt(home)`. **node-pty never
reports `signal: undefined`.** Spawned through the repo's own `node-pty` and read
back verbatim:

| process | `onExit` payload |
|---|---|
| `node -e "process.exit(0)"` | `{ exitCode: 0, signal: 0 }` |
| `node -e "process.exit(3)"` | `{ exitCode: 3, signal: 0 }` |
| SIGTERM (recorded in `signin-stdin-shape.md`) | `{ exitCode: 0, signal: 15 }` |

So the success branch was unreachable: **every** completed Antigravity sign-in
fell through to the failure path and the user was told the run had been stopped
or had exited without starting a sign-in. The account was in fact connected — the
token file was on disk — which is why `isConfigured()` then disagreed with the
failure the user had just been shown.

`0` is "not signalled" and a number is always present, so the test is
`signal !== 0`, never `signal !== undefined`.

## What the CLI actually does, end to end

Same spawn ShipIt uses (`-p … --output-format text --dangerously-skip-permissions`
on a pty, fresh `HOME`, no `GEMINI_API_KEY`), timestamps relative to spawn:

```
[+0.1s] Authentication required. Please visit the URL to log in:
          https://accounts.google.com/o/oauth2/auth?…&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&…
        Waiting for authentication (timeout 60s)...
        Or, paste the authorization code here and press Enter:
[+60.1s] Error: authentication timed out.
         Error: authentication failed or timed out
[+60.2s] EXIT { exitCode: 1, signal: 0 }
```

And with a syntactically plausible but invalid code pasted at +1.1s:

```
[+1.2s] Error: authentication failed: token exchange failed: oauth2: "invalid_grant" "Bad Request"
        Error: authentication failed or timed out
[+1.2s] EXIT { exitCode: 1, signal: 0 }   token written: false
```

Three things follow, and the fix rests on all three:

1. **The window is 60 seconds from the moment the link is printed**, and it
   covers the user's entire Google consent round trip. The CLI says so on the
   terminal; ShipIt did not, so the panel now carries the deadline.
2. **A failure the CLI can explain, it does explain** — every observed one
   arrives as an `Error:` line, which `antigravityStderrErrorText` already
   relays. A generic ShipIt sentence is therefore the case where the CLI said
   nothing, which is worth keeping rare and accurate.
3. **The exit code reports the print run, not the credential** — reasoned from
   the shape of the flow, **not measured**: no probe here captures a successful
   exchange followed by a non-zero exit, because completing one needs a real
   Google account. The sign-in is a side effect of a prompt that runs afterwards,
   so a prompt that fails for its own reasons (quota, a blocked host) should not
   discard a credential that is fine — a user who cannot connect a working
   account is stranded, since every retry ends the same way. Completion is
   therefore keyed on the token file changing since the flow started, with a
   clean exit over an unchanged token still counting (a run on an
   already-signed-in home never rewrites it).

   **A sentence from the CLI outranks the token, though.** The eligibility check
   runs *after* the exchange, so an ineligible account gets a good token and then
   `Error: Eligibility check failed…`. Completing there would discard the only
   explanation the user gets (req 4) and leave an account whose every turn fails.
   And the token is read as a *credential*, not as bytes — a save that died
   part-way moves the mtime like any other write, and the completion claim is
   that a run signed in. `isConfigured` keeps the looser size test on purpose:
   it reports what the account **has**, not what a run just **did**.

## Why the tests were green

`FakePty.emitExit(exitCode, signal?)` omitted `signal` entirely on a clean exit,
so the fake alone produced the one payload shape node-pty cannot. The fake now
defaults it to `0`, and with that the three completion cases fail against the
shipped condition. The same blind spot is recorded in `signin-stdin-shape.md`
one layer down: an injected fake cannot see a property of the real spawn.
