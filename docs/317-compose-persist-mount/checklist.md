# 317 — checklist

- [x] Parse and validate `persist`, `persist/<sub>` and the long form (`compose-generator.ts`)
- [x] Rewrite the mounts and declare the bind-backed `persist` volume in the override
- [x] Prepare `/persist` and its subdirectories as the session identity before every `up` (`compose-persist.ts`, `service-manager.ts`)
- [x] Translate the scratch directory to the daemon's path in the volume-backed deployment
- [x] Plugin fragments refuse `persist`
- [x] Tests: generator, directory preparation, daemon path, ServiceManager, plugin refusal
- [x] Agent docs: compose.md, environment.md, plugins.md, plugin-authoring.md
- [x] Wiki: how-shipit-works.md, installing-and-updating.md, sessions.md
