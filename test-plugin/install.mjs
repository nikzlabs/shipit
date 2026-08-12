// docs/262 — the test plugin's `install` command (manifest: `install: node
// test-plugin/install.mjs`). Runs with cwd = the plugin's checkout root inside
// its writable layer (plan §1b), so this stamp must land in the layer for a
// consumer checkout — never in the read-only checkout, never in the project —
// and in the live working tree (gitignored) under `repo: self`.
//
// The probe report's `install` field verifies the stamp exists and carries the
// active generation's commit, which is how the fixture proves install re-ran
// on refresh (req 7).

import fs from "node:fs";
import path from "node:path";

const stamp = {
  commit: process.env.SHIPIT_PLUGIN_COMMIT ?? null,
  node: process.version,
  installedAt: new Date().toISOString(),
};

fs.writeFileSync(path.join("test-plugin", ".install-stamp.json"), JSON.stringify(stamp, null, 2));
console.log(`test-plugin install: stamped ${stamp.commit ?? "(no commit env)"}`);
