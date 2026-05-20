# Secrets in docker-compose.yml

ShipIt injects environment variables into compose services from a per-repo
secret store. Declare what each service needs in its compose definition with
`x-shipit-secrets` — the same `x-shipit-*` extension pattern as
`x-shipit-preview`. Users configure the actual values once per repo in the
**Settings → Secrets** panel; the values are then auto-loaded into every
session for that repo and survive container restarts.

## Why declare secrets?

- **Self-describing projects.** When you list `STRIPE_KEY` in the compose
  file, the user sees a placeholder for it in the secrets panel — they don't
  have to guess what env vars your app needs.
- **Per-service scoping.** Secrets are only injected into the services that
  declare them. A `web` frontend doesn't get the `db` password.
- **Missing-secret banner.** Required secrets that lack values surface as a
  banner above the preview pane with a one-click jump to the configure UI.
- **Auto-restart on save.** When the user saves a value, ShipIt rewrites
  the env files and runs `docker compose up -d`, recreating affected
  containers automatically.

## Quick start (string shorthand)

The simplest form — just list env var names:

```yaml
services:
  web:
    image: node:20
    command: npm run dev
    ports: ["5173:5173"]
    x-shipit-secrets:
      - STRIPE_PUBLISHABLE_KEY

  api:
    image: node:20
    command: npm start
    ports: ["3000:3000"]
    x-shipit-secrets:
      - DATABASE_URL
      - REDIS_URL
      - STRIPE_SECRET_KEY

  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev    # not a secret — dev-only default
```

Each name must be a valid env var identifier
(`^[A-Za-z_][A-Za-z0-9_]*$`). Invalid names cause compose start to fail
with a clear error.

## Extended form (descriptions, required, agent, source)

Use the object form to add metadata. Mix and match with strings in the same
list:

```yaml
services:
  api:
    image: node:20
    x-shipit-secrets:
      # Simple shorthand
      - SENTRY_DSN

      # With description — shown in the secrets panel as a placeholder
      - name: STRIPE_SECRET_KEY
        description: Stripe API key (starts with sk_live_ or sk_test_)

      # Required — surfaces a "Configure secrets to run" banner if missing
      - name: DATABASE_URL
        description: PostgreSQL connection string
        required: true

      # Also exposed inside the agent container (Phase 3 — for migrations,
      # codegen, tests that need to talk to the running stack)
      - name: DATABASE_URL
        agent: true

      # Resolved from a platform credential — user doesn't fill this in
      - name: ANTHROPIC_API_KEY
        source: platform:claude_oauth
      - name: GITHUB_TOKEN
        source: platform:github_token
```

### Platform credential sources

When `source: platform:*` is set, ShipIt resolves the value from
orchestrator-level credentials instead of the user-saved secret store. The
user doesn't see (or need to configure) these — they're inherited from
the outer ShipIt session's auth state. Lookup is performed on every
compose reconcile, so token rotation is picked up automatically.

| Source | Resolves to |
|--------|-------------|
| `platform:claude_oauth` | The orchestrator's `ANTHROPIC_API_KEY` env var, falling back to the Claude CLI's OAuth access token from `~/.claude/.credentials.json`. Returns empty if neither is configured. |
| `platform:github_token` | The GitHub PAT the user configured via Settings → GitHub. Returns empty if no token is configured. |
| `platform:linear_oauth` | The Linear access token from a Settings → MCP Servers → "Connect Linear" OAuth flow. Returns empty until connected. |
| `platform:notion_oauth` | The Notion access token from a Settings → MCP Servers → "Connect Notion" OAuth flow. Returns empty until connected. |

> **MCP OAuth providers auto-register their client.** Hosted MCP servers that
> publish RFC 8414 metadata + an RFC 7591 registration endpoint (Notion today)
> are connected with a single click — ShipIt discovers the provider's OAuth
> endpoints and dynamically registers a public PKCE client on first connect, so
> there is **no `<PROVIDER>_OAUTH_CLIENT_ID` prerequisite** for the operator.
> Providers that don't support dynamic registration (Linear today) still need
> the operator to set `<PROVIDER>_OAUTH_CLIENT_ID`. The connected token is
> exposed to declared MCP servers via the `$platform:<id>` placeholder (e.g.
> `$platform:notion_oauth`), resolved from the `MCP_PLATFORM_<ID>` env var.

If the platform source returns empty, ShipIt falls back to the user-saved
secret store for the same name — this means a project that declares
`source: platform:github_token` will still pick up a manually-pasted
`GITHUB_TOKEN` secret if no platform token is available.

The flagship use case is **ShipIt-in-ShipIt** — running the orchestrator
inside a ShipIt session so you can develop ShipIt itself. The inner
orchestrator service needs Claude OAuth (to spawn its own agents) and a
GitHub token (to push). Without forwarding, you'd have to copy-paste your
personal credentials into the inner session.

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| `name` | string (required) | Env var name. Must match `^[A-Za-z_][A-Za-z0-9_]*$`. |
| `description` | string | Free-form description shown to the user in the secrets panel. Helps them know what to configure. |
| `required` | boolean | If true, the orchestrator surfaces a "Configure secrets" banner when no value is set. The compose stack still attempts to start — the banner is informational, not a hard block. |
| `agent` | boolean | Also inject this env var into the agent container. Use for connection strings the agent needs when running CLI tools (`prisma migrate`, `bun test`, codegen). **Treat any `agent: true` value as exfiltratable**: it lands in the agent container's environment, and the agent can run arbitrary shell, so a prompt injection can read and POST it anywhere (agent containers currently have unrestricted network egress — see the security note below). Avoid for true secrets — the agent doesn't usually need API keys. |
| `source` | string | Resolve from a platform credential instead of user-configured secrets. Recognized values: `platform:claude_oauth`, `platform:github_token`, and the MCP OAuth providers `platform:linear_oauth` / `platform:notion_oauth`. Falls back to the user-saved secret if the platform source is empty. Useful for ShipIt-in-ShipIt and other meta-tooling. |

Unknown fields on the object are ignored. The same secret declared by
multiple services merges its metadata: `required` and `agent` are OR'd, the
first non-empty `description` and `source` win, and the consumer-services
list is the union.

## How it lands in the container

ShipIt supports two delivery modes for service secrets:

### env-file mode (default)

For each service that declares secrets, ShipIt writes
`.shipit/.env.<service>` and references it via `env_file:` in the
generated compose override:

```yaml
# .shipit/compose.override.yml (generated)
services:
  api:
    env_file: [.shipit/.env.api]
    # ... other override fields
```

```
# .shipit/.env.api (generated)
DATABASE_URL=postgres://...
REDIS_URL=redis://...
STRIPE_SECRET_KEY=sk_test_...
```

The env files live under `.shipit/` (gitignored). They are rewritten on
every session activation and on every secrets save.

### Docker-secrets mode (opt-in)

When the orchestrator is started with `SHIPIT_SECRETS_INTERNAL_DIR` set,
secrets are delivered via Docker Compose's native `secrets:` mechanism
instead of `env_file:`. Each value is written to a per-secret file outside
the workspace volume; compose mounts it as a tmpfs file at
`/run/secrets/shipit-<NAME>` inside only the service containers that
declared the secret. A small entrypoint wrapper baked into the
orchestrator image (`secrets-entrypoint.sh`) reads those files and
exports them as env vars before exec'ing the original command.

Required environment variables on the orchestrator:

| Variable | Purpose |
|----------|---------|
| `SHIPIT_SECRETS_INTERNAL_DIR` | Orchestrator-side directory where secret files are written (e.g. `/var/shipit/secrets`). |
| `SHIPIT_SECRETS_HOST_DIR` | Host-side path the Docker daemon sees for the same directory. Required when the orchestrator runs in a container; omit for orchestrator-on-host setups. |
| `SHIPIT_SECRETS_ENTRYPOINT` | Path to `secrets-entrypoint.sh` inside the orchestrator image. Defaults to `/usr/local/share/shipit/secrets-entrypoint.sh`. |

Tradeoff: the agent loses the ability to casually `cat .shipit/.env.<svc>`
to read secrets. Exfiltration via agent-authored code (writing
`process.env` to a workspace file, logging it to stdout, etc.) is still
possible — Docker secrets isolate the values from the *file system*, not
from the *code that runs in the service container*. See the plan in
`docs/087-reusable-preview-secrets/plan.md` under "Security" for the full
threat model.

## Security note: agent-container egress

Agent containers currently have **unrestricted outbound network access** and no
egress allowlist or proxy chokepoint. Any value reachable from inside the agent
container — `agent: true` secrets, MCP tokens, the agent's own CLI OAuth — can
be POSTed to an arbitrary host by code the agent runs (including code injected
via a malicious dependency README, fetched web page, or repo content). The
GitHub PAT is the one credential deliberately kept *out* of the container
(brokered via `gh` and `shipit-git-credential`; see `github.md`), but the rest
live in-container by design. This is a documented, accepted risk
(`docs/088-security-audit` finding #6); the mitigation is to scope `agent: true`
to non-sensitive values. A future orchestrator-managed forward proxy with a
host allowlist would shrink this exposure.

## When secrets change

Saving a secret in the UI:

1. Stores the value in the per-repo secret store.
2. Rewrites `.shipit/.env.<service>` for every active session backed by
   that repo.
3. Runs `docker compose up -d` for each session — Compose detects the env
   file change and recreates the affected containers.

No manual restart is needed. Manual services that the user explicitly
started are not auto-restarted.

## Optional vs required

Optional secrets (no `required: true`) silently start with the env var
unset if no value is configured. The service is responsible for handling
"unset" gracefully (defaulting to a no-op, falling back to local mode,
etc.).

Required secrets (`required: true`) trigger a banner above the preview
pane: "*N* required secrets are missing — Configure". The banner clears
automatically once all required values are saved.

## Custom (undeclared) secrets

Users can also add ad-hoc env vars in the secrets panel that aren't
declared in any compose service. Those are kept in the per-repo secret
store but are NOT injected anywhere — declaring them in
`x-shipit-secrets` is what wires them up. This keeps services scoped to
exactly what they asked for.
