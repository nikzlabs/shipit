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
    image: node:24-slim
    command: npm run dev
    ports: ["5173:5173"]
    x-shipit-secrets:
      - STRIPE_PUBLISHABLE_KEY

  api:
    image: node:24-slim
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

## Extended form (descriptions, required, agent)

Use the object form to add metadata. Mix and match with strings in the same
list:

```yaml
services:
  api:
    image: node:24-slim
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
```

### Compose services receive user-supplied secrets

Every value injected into a compose service comes from the **per-repo secret
store** — values the user entered in **Settings → Secrets**, keyed by the
declared `name`. To give a service a credential, the user sets a secret of the
same name.

> **MCP OAuth tokens reach the agent through a separate path.** Connecting
> Linear / Notion under Settings → MCP Servers wires the token into the
> *agent's* MCP servers via the `$platform:<id>` placeholder (resolved from the
> `MCP_PLATFORM_<ID>` env var). That is the user wiring an MCP server into their
> own agent — distinct from compose-service secret resolution.

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| `name` | string (required) | Env var name. Must match `^[A-Za-z_][A-Za-z0-9_]*$`. |
| `description` | string | Free-form description shown to the user in the secrets panel. Helps them know what to configure. |
| `required` | boolean | If true, the orchestrator surfaces a "Configure secrets" banner when no value is set. The compose stack still attempts to start — the banner is informational, not a hard block. |
| `agent` | boolean | Also inject this env var into the agent container. Use for connection strings the agent needs when running CLI tools (`prisma migrate`, `bun test`, codegen). **Treat any `agent: true` value as exfiltratable**: it lands in the agent container's environment, and the agent can run arbitrary shell, so a prompt injection can read and POST it anywhere (agent containers currently have unrestricted network egress — see the security note below). Avoid for true secrets — the agent doesn't usually need API keys. |

Unknown fields on the object are ignored. The same secret declared by
multiple services merges its metadata: `required` and `agent` are OR'd, the
first non-empty `description` wins, and the consumer-services list is the
union.

## How it lands in the container

ShipIt supports two delivery modes for service secrets:

### env-file mode (default)

For each service that declares secrets, ShipIt writes a per-service env file
and references it via `env_file:` in the generated compose override:

```yaml
# .shipit/compose.override.yml (generated, containerized mode)
services:
  api:
    env_file: [/workspace/service-env/<sessionId>/.env.api]
    # ... other override fields
```

```
# .env.api (generated)
DATABASE_URL=postgres://...
REDIS_URL=redis://...
STRIPE_SECRET_KEY=sk_test_...
```

**Service-only env files are NOT in your workspace.** In containerized runtime
ShipIt writes them to an orchestrator-private directory *outside* the workspace
(`<stateDir>/service-env/<sessionId>/.env.<service>`, overridable with
`SHIPIT_SERVICE_ENV_DIR`). The agent container mounts only the session's
workspace subpath of the shared volume, so it cannot read these files even
though they sit on the same volume. This keeps a service-only secret (a
database URL, a third-party API key) out of the agent's reach unless you
explicitly mark it `agent: true`. Only `.shipit/.env.agent` — which holds
`agent: true` values and MCP credentials — lives in the workspace.

The files are rewritten on every session activation and on every secrets save.
Marking an entry `agent: true` is the supported way to expose its value to the
agent; everything else stays service-only.

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
