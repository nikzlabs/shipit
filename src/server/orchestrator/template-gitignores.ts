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
`;
