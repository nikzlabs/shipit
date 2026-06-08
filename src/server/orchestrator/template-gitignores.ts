// ---------------------------------------------------------------------------
// One comprehensive .gitignore for every template
// ---------------------------------------------------------------------------
//
// ShipIt scaffolds many stacks (Vite, Next.js, Astro, plain Node backends,
// Python) and the user can switch package managers freely (npm/yarn/pnpm/bun)
// since corepack is enabled in the session image. Rather than ship a different
// per-framework ignore — which always drifts and leaves gaps the moment a repo
// adopts a tool its template didn't anticipate — every template uses this single
// union. Extra patterns for a tool a given project doesn't use are harmless
// (they simply never match), so the cost of over-covering is zero and the
// benefit is that no template ever commits a `node_modules`, a `.env`, a build
// cache, or an editor turd. Keep this sorted into clearly-labeled sections so
// it stays easy to extend.
export const UNIVERSAL_GITIGNORE = `# ---- Dependencies ----
node_modules/
.pnp
.pnp.*
jspm_packages/

# ---- Package manager internals ----
# npm
.npm
# yarn (Berry) — ignore the cache but keep the committed tooling
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/sdks
!.yarn/versions
.yarn-integrity
# pnpm
.pnpm-store/
# bun
.bun/

# ---- Logs ----
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
.pnpm-debug.log*
lerna-debug.log*

# ---- Build output ----
dist/
dist-ssr/
build/
out/
*.tsbuildinfo

# ---- Framework caches / generated files ----
.vite/
.cache/
.parcel-cache/
.turbo/
.next/
out/
next-env.d.ts
.nuxt/
.svelte-kit/
.astro/
.docusaurus/
.vercel
.netlify
.output/

# ---- Testing / coverage ----
/coverage
.nyc_output
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/

# ---- Python ----
__pycache__/
*.py[cod]
*$py.class
*.egg
*.egg-info/
.Python
.venv/
venv/
env/
ENV/

# ---- Environment files ----
.env
.env.*
!.env.example
*.local

# ---- Editor directories and files ----
.vscode/*
!.vscode/extensions.json
.idea/
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?

# ---- OS files ----
.DS_Store
Thumbs.db

# ---- Misc ----
*.pem

# ---- ShipIt ----
.shipit
`;
