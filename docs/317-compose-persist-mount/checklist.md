# 317 — checklist

- [x] Parse and validate `persist`, `persist/<sub>` and the long form (`compose-generator.ts`)
- [x] Rewrite the mounts and declare the bind-backed `persist` volume in the override
- [x] Prepare `/persist` and its subdirectories as the session identity before every `up` (`compose-persist.ts`, `service-manager.ts`)
- [x] Translate the scratch directory to the daemon's path in the volume-backed deployment
- [x] Plugin fragments refuse `persist`
- [x] Tests: generator, directory preparation, daemon path, ServiceManager, plugin refusal
- [x] Agent docs: compose.md, environment.md, plugins.md, plugin-authoring.md
- [x] Wiki: how-shipit-works.md, installing-and-updating.md, sessions.md
- [x] Docker Desktop: mount all of `/persist` as a subpath of the workspace volume, on every daemon (`rewritePersistMount`)
- [x] Docker Desktop: refuse `persist/<sub>` and a project's `./sub` before anything is prepared, with a message that names the whole mount (`dockerDesktopCheck`, `dockerDesktopRefusal`)
- [x] Correct the daemon-namespace claim in this plan and in docs/318; compose.md and the troubleshooting wiki page
- [x] Docker Desktop: withhold a self plugin repository's services when one mounts a subdirectory, as a plugin issue (`selfSubdirectoryMount`); plugin-authoring.md
