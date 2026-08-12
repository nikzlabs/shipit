---
name: probe
description: How to run the test-plugin probe and read its report — which field verifies which part of the docs/262 plugin usage contract.
---

# The probe report

This skill ships with ShipIt's test plugin (docs/262). If you can read this
text through your skill listing, skills materialization (req 22) works: the
file was copied from the plugin checkout into your backend's discovery root
under a `plugins--<alias>--probe` namespace.

Run `probe` in the project workspace. It prints one JSON report. Add
`--host-check` to also test HTTPS egress to the declared host (example.com).

| Field | Verifies |
|---|---|
| `cwd` | CLI runs with cwd = the project workspace (req 21) |
| `env.SHIPIT_PLUGIN_COMMIT` | the active generation's exact commit (req 15) |
| `credential.set` | `PROBE_TOKEN` injected for this command only (req 23) |
| `settings.greeting` | the validated settings file (req 26) |
| `project.readable` | the workspace handle (req 21) |
| `state.counter` | shared state with the probe service — reload its page and the number matches (reqs 17, 18) |
| `checkout.writable` | `false` for a consumer checkout, `true` under `repo: self` (reqs 7, 27) |
| `install.matchesActiveCommit` | install ran for the active generation (req 7) |

The probe service renders the same report from the service surface at its
preview URL, plus a shared-counter button and a `window.shipit` presence line.
