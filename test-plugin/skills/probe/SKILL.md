---
name: probe
description: How to run the test-plugin probe and read its report — which field verifies which part of the docs/262 plugin usage contract.
---

# The probe report

This skill ships with ShipIt's test plugin (docs/262). If you can read this
text through your skill listing, skills materialization (req 22) works: the
file was copied from the plugin checkout into your backend's discovery root
under a `plugins--<alias>--probe` namespace.

Run `probe` in the project workspace. It prints one JSON report and mutates
nothing. Flags: `--bump` increments the shared counter before reporting;
`--host-check` also tests HTTPS egress to the declared host (example.com).

| Field | Verifies |
|---|---|
| `cwd` | CLI runs with cwd = the project workspace (req 21) |
| `mode` / `env.SHIPIT_PLUGIN_COMMIT` | the self/consumer discriminator: a consumer generation carries its exact commit; `repo: self` runs the live tree, no commit (reqs 15, 27) |
| `credential.set` | `PROBE_TOKEN` injected for this command only (req 23) |
| `settings.greeting` | the validated settings file (req 26) |
| `project.readable` | the workspace handle (req 21) |
| `state.counter` | shared state with the probe service — `probe --bump`, then reload its page: same number (reqs 17, 18) |
| `checkout.writable` | a raw observation of this surface's mount only — a consumer CLI sees the writable layer, so this is deliberately NOT the self/consumer signal; that layer writes never reach the checkout is a slice-2 guard test (req 7) |
| `install.matchesActiveCommit` | install ran for the active generation; `null` under self-use, which has no generations (req 7) |

The probe service renders the same report from the service surface at its
preview URL, with a counter button and an Agent Interface SDK section: it
awaits `window.shipit.ready`, checks `embedded`, and its "Send counter to
agent" button exercises the browser-to-agent path (req 3).
