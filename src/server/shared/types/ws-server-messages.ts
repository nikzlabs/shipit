// Facade: this module was split by domain into `ws-server-messages/` as Phase P1
// of the large-file refactor (docs/201, SHI-131). The public export surface is
// unchanged — every `Ws*` server-message type and the `WsServerMessage` union
// are re-exported from the domain modules via the directory barrel, so no
// import site changes. See `ws-server-messages/index.ts` for the re-assembled
// union and the per-domain files (auth, agent, git, service, files, preview,
// session, repo, rollback, spawn, present, cards, misc).
export * from "./ws-server-messages/index.js";
