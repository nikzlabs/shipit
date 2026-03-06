// ---------------------------------------------------------------------------
// Shared .gitignore content — matches official scaffolder output
// ---------------------------------------------------------------------------

// From: create-vite (identical across all Vite templates)
export const VITE_GITIGNORE = `# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

node_modules
dist
dist-ssr
*.local

# ShipIt
.shipit

# Vite
.vite

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
`;

// From: create-next-app
export const NEXTJS_GITIGNORE = `# dependencies
/node_modules
/.pnp
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/versions

# testing
/coverage

# next.js
/.next/
/out/

# production
/build

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# env files
.env*

# vercel
.vercel

# typescript
*.tsbuildinfo
next-env.d.ts

# ShipIt
.shipit
`;

// From: create-astro (basics template)
export const ASTRO_GITIGNORE = `# build output
dist/

# generated types
.astro/

# dependencies
node_modules/

# logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# environment variables
.env
.env.production

# macOS-specific files
.DS_Store

# ShipIt
.shipit
`;

// For backend APIs and CLI tools (no canonical scaffolder)
export const NODE_GITIGNORE = `node_modules
dist

# env files
.env
.env.local
.env.production

# logs
*.log
npm-debug.log*
yarn-debug.log*
pnpm-debug.log*

# misc
.DS_Store

# ShipIt
.shipit
`;
