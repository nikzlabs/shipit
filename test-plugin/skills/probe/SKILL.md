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
| `checkout.writable` | this surface's own mount — not the self/consumer signal (read `mode`), but it does check the rule directly: the plugin's tree is writable exactly when it is the project, so a consumer generation reports `false` and `repo: self` reports `true` (reqs 7, 15, 27). On the service surface it measures this fragment's own `.:/app`, which ShipIt forces read-only for a tracked generation and leaves as declared under `repo: self` |
| `install.matchesActiveCommit` | install ran for the active generation; `null` under self-use, which has no generations (req 7) |
| `dependency.project` / `.plugin` | a real dependency loads from each mount of the tree, reported per root because `/plugin` and `/project` are separate mounts even when they are one tree. Under `repo: self` the CLI must show both `resolved: true, used: true` — the working tree's own `agent.install` prepares the tree the CLIs and services run out of (req 27); the service shows `plugin: resolved false`, since its fragment mounts only its own directory at `/app`. This is the one field that would have caught nikzlabs/shipit#2298 (`test-plugin/README.md` has the full table) |

The probe service renders the same report from the service surface at its
preview URL, with a counter button and an Agent Interface SDK section: it
awaits `window.shipit.ready`, checks `embedded`, and its "Send counter to
agent" button exercises the browser-to-agent path (req 3).
