# Checklist

- [ ] Add an orchestrator-private service env-file root with `SHIPIT_SERVICE_ENV_DIR` override.
- [ ] Teach the secret resolver to write service env files outside the workspace.
- [ ] Sweep stale `.shipit/.env.<service>` files while preserving `.shipit/.env.agent`.
- [ ] Pass per-service env-file paths into compose override generation.
- [ ] Add regression coverage for dogfood platform secrets staying out of `.shipit/.env.dev`.
- [ ] Update ShipIt secrets documentation.
