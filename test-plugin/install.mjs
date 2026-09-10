import fs from "node:fs";
import path from "node:path";

const stamp = {
  commit: process.env.SHIPIT_PLUGIN_COMMIT ?? null,
  node: process.version,
  installedAt: new Date().toISOString(),
};

fs.writeFileSync(path.join("test-plugin", ".install-stamp.json"), JSON.stringify(stamp, null, 2));

// The dependency-store marker survives base adoption; the checkout stamp does not.
fs.mkdirSync(path.join("node_modules", ".e2e-probe"), { recursive: true });
fs.writeFileSync(path.join("node_modules", ".e2e-probe", "marker.json"), JSON.stringify(stamp, null, 2));

console.log(`test-plugin install: stamped ${stamp.commit ?? "(no commit env)"}`);
