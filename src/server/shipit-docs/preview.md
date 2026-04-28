# Preview System

The preview pane shows a live view of the running application. It updates
automatically as you edit files.

## How it works

1. ShipIt reads `shipit.yaml` for the compose file path (or auto-detects
   `docker-compose.yml` / `compose.yml` at the workspace root).
2. If `agent.install` commands are specified, they run in the agent container
   **in parallel** with compose services starting — install does not block previews.
3. Services defined in docker-compose.yml start as Docker Compose containers.
   Services marked as `auto` (or with `ports`) start automatically.
4. ShipIt detects when ports are ready and routes browser traffic through a
   reverse proxy.

## Service types

| `x-shipit-preview` | Behavior |
|---------------------|----------|
| `auto` (default for services with ports) | Starts automatically, shown in preview |
| `manual` (default for services without ports) | User clicks "Start" in UI |

## Multi-service

Define multiple services in docker-compose.yml. Each service with ports gets
its own preview tab:

```yaml
services:
  frontend:
    image: node:20
    command: npm run dev
    ports: ["5173:5173"]
    x-shipit-preview: auto

  api:
    image: node:20
    command: npm run api
    ports: ["3001:3001"]
    x-shipit-preview: auto

  db:
    image: postgres:16
    x-shipit-preview: manual
```

## Hot Module Replacement (HMR)

ShipIt patches dev-server WebSocket URLs so HMR works through the reverse
proxy. No configuration needed — Vite, Next.js, and other frameworks work
out of the box.

## Restart triggers

| Change | Effect |
|--------|--------|
| Source file edit | Hot reload (no restart) |
| `shipit.yaml` or compose file edit | Stack reconciliation (restart services) |
| Lockfile change | Install + restart (30s debounce) |

## Browser tools

You have headless Chrome available via Playwright MCP. Use these tools to
verify your work:

- **browser_navigate** — open the preview URL (provided in your system prompt)
- **browser_snapshot** — read page content as an accessibility tree (preferred
  for understanding layout)
- **browser_click** / **browser_type** — interact with elements
- **browser_take_screenshot** — capture a visual screenshot for layout/styling.
  Save screenshots to `/tmp/`, not `/workspace/`, to keep them out of git.

Use browser tools proactively after UI changes to catch issues early.

## Creating a compose file

If the project doesn't have a docker-compose.yml, see
[compose.md](compose.md) for how to create one for ShipIt.

## Troubleshooting

- **Preview not loading**: Check that docker-compose.yml has the correct
  command and port. Verify the service is running with
  `docker compose ps` from the terminal.
- **Port not detected**: Ensure `ports` is set in docker-compose.yml.
- **Connection refused**: The dev server may need a moment to start. Ensure it
  binds to `0.0.0.0` (set `HOST=0.0.0.0` in the compose environment).
- **HMR not working**: Ensure the dev server binds to `0.0.0.0`, not
  `127.0.0.1`. Add `HOST: "0.0.0.0"` to the service's environment.
