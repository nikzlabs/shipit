# Checklist — `gh` in the dogfood inner ShipIt

- [x] Confirm the risk before building: every `gh` endpoint in
      `agent-ops-routes.ts` is a pure `relay(...)`, and the orchestrator routes
      behind them work in local mode (a live `GET /actions/workflows` against
      the running inner orchestrator returned the real repo's workflow list).
- [x] `requirements.md` first, with the `shipit`-shim scope question asked and
      answered (`gh` only) and a dated receipt recorded.
- [x] `orchestrator/local-agent-ops.ts` — per-session loopback host, allowlist
      mapping, single-flight registry, fail-open start.
- [x] Await `ensureLocalAgentOpsHost` in `session-agent-env.ts`'s local branch,
      pre-spawn.
- [x] Merge `SHIPIT_AGENT_OPS_URL` into the spawn env (`local-agent-mcp.ts`),
      threaded from `app-lifecycle.ts`.
- [x] Close the host on runner disposal, with the rejection swallowed rather
      than `void`-ed — this runs inside `disposeAll()` on the shutdown path,
      where an escaping error reads like a shutdown failure.
- [x] Regression test that disposal actually closes the host, verified to fail
      when the teardown is disabled (the wiring broke transiently in the
      dogfood during development and nothing would have caught it).
- [x] Install the `gh` shim in `docker/Dockerfile.dogfood` at `/workspace`
      paths (not the worker images' `/app`).
- [x] Tests: mapping, session binding, body/querystring forwarding, 403 on a
      denied path, 502 naming an unreachable orchestrator, registry
      single-flight and teardown.
- [x] Drift guard: read `agent-shim/gh.ts` and assert every `/agent-ops/…` path
      it can emit is accepted here.
- [x] `npm run lint:dev` and `npm run typecheck` clean.
- [x] End-to-end against the running dogfood: the unmodified `gh` shim ran
      `pr status`, `workflow list` and `run list` through the host to the live
      local-mode orchestrator and returned real GitHub data.
- [x] Update `docs/118-shipit-ui-local` where it records this as unsupported.
- [x] Narrow SHI-303 to the worker-served tools.
- [ ] Confirm in a real dogfood **turn** that the agent picks `gh` up from
      `PATH` and that `SHIPIT_AGENT_OPS_URL` reaches the CLI's env. The image
      now installs the shim and the spawn env is unit-tested, but this has not
      been driven through an actual inner-UI turn.
- [ ] `gh pr create` against a real repository from a dogfood turn — deliberately
      not fired during development because it opens a real PR.
