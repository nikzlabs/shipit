# Preview System

The preview pane shows a live view of the running application. It updates
automatically as you edit files.

## How it works

1. ShipIt reads `shipit.yaml` (or falls back to `package.json` / `index.html`).
2. If an `install` command is specified, it runs first.
3. The preview command starts in a separate container with `HOST=0.0.0.0`.
4. ShipIt detects when the port opens and routes browser traffic to the
   container through a reverse proxy.

## Port detection

- **Explicit ports** (`ports: [5173]` in shipit.yaml): ShipIt polls until the
  port accepts connections.
- **Auto-detection**: If no ports specified, ShipIt scans stdout for
  `http://localhost:PORT` or `http://127.0.0.1:PORT` patterns.

## Multi-port

List multiple ports in `shipit.yaml` to expose several services:

```yaml
preview:
  command: >-
    npm run api &
    npm run frontend
  ports: [3001, 5173]
```

The user can switch between ports in the preview pane.

## Hot Module Replacement (HMR)

ShipIt patches dev-server WebSocket URLs so HMR works through the reverse
proxy. No configuration needed — Vite, Next.js, and other frameworks work
out of the box.

## Restart triggers

| Change | Effect |
|--------|--------|
| Source file edit | Hot reload (no restart) |
| `shipit.yaml` edit | Immediate preview restart |
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

## Troubleshooting

- **Preview not loading**: Check that `shipit.yaml` has the correct command and
  port. Verify with `curl http://localhost:PORT` from the terminal.
- **Port not detected**: Add explicit `ports` to `shipit.yaml`.
- **Connection refused**: The dev server may need a moment to start. If using
  auto-detection, ensure the server prints the URL to stdout.
- **HMR not working**: Ensure the dev server binds to `0.0.0.0`, not
  `127.0.0.1`. ShipIt injects `HOST=0.0.0.0` but some frameworks need explicit
  config.
