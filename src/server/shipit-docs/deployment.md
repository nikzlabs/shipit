# Deployment

ShipIt can deploy projects to cloud platforms directly from the UI.

## Supported targets

### Vercel

Deploys using the Vercel CLI. Supports static sites, Next.js, and other
Vercel-compatible frameworks.

**Prerequisites**: Vercel API token configured in ShipIt settings.

### Cloudflare Pages

Deploys static assets to Cloudflare Pages.

**Prerequisites**: Cloudflare API token configured in ShipIt settings.

## How deployment works

1. **Build**: ShipIt runs the project's build command (detected from
   `package.json` or configured in the deploy target).
2. **Deploy**: Build output is pushed to the selected platform.
3. **Status**: Deployment progress streams to the UI in real time.

## Framework detection

ShipIt auto-detects the project framework (Next.js, Vite, Create React App,
etc.) to configure the correct build command and output directory. You can
override these in the deploy settings if needed.

## Notes

- Deployment is triggered by the user from the UI, not by the agent.
- Each deploy creates a new deployment on the target platform.
- Deploy credentials are stored per-user and persist across sessions.
