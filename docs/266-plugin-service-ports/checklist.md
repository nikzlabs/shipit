# Checklist — plugin service ports

- [x] `PluginServiceOverride.port` + `KNOWN_SERVICE_OVERRIDE_KEYS` + validation (req 2)
- [x] `ports` out of `ALLOWED_SERVICE_KEYS`; `readPorts` and the fragment's `port` deleted (reqs 1, 6)
- [x] `resolvePreview` defaults from the consumer's port; previewability rides the port itself (req 9)
- [x] `SHIPIT_PLUGIN_PORT` in `plugin-contract.ts`, injected into the service env (reqs 3, 8)
- [x] Plugin-vs-plugin port collision refuses the import, naming both (req 7)
- [x] Plugin-vs-project collision refuses the plugin service in `ServiceManager`, naming both (req 7)
- [x] A running plugin service not listening on its port is reported (req 8)
- [x] `plugin-ports.ts` + `plugin-ports.json` + `publishedPort` deleted; `resolvePreviewTarget` one pass (req 10)
- [x] Wire sites stop projecting `publishedPort ?? port`
- [x] `shipit-docs/plugins.md` — new author contract, collision note retired
- [x] `docs/262-plugins/plan.md` — record what this deleted
- [x] Tests: schema validation, fragment refusal, previewability, collisions, routing
- [x] `npm run typecheck` + `npm run lint:dev`
- [x] Independent review against every numbered requirement — all ten confirmed
      implemented; four findings acted on (probe false-positive + sticky verdict,
      refused row startable from the UI, healthy services re-probed forever,
      probe outliving dispose/container replacement), plus a silent drop of a
      fragment's `x-shipit-preview`, three stale doc sites, and dead code
