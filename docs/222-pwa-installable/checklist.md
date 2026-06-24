# Checklist

- [x] Cache-free service worker (`public/service-worker.js`)
- [x] Service worker registration helper + wire into `main.tsx`
- [x] `no-store` cache headers for shell + worker (`app-assembly.ts`)
- [x] PNG icons (192/512 + apple-touch-icon) generated full-bleed
- [x] Manifest references PNG icons; `apple-touch-icon` points at PNG
- [x] Server test: shell/SW `no-store`, assets not
- [x] Client test: registration helper
- [x] Typecheck + lint:dev clean
