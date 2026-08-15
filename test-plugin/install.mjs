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

// req 28 — produce the declared dependency directory (the manifest declares
// none, so the default `[node_modules]` applies, resolved at the CHECKOUT
// ROOT). Without it there is nothing for the dep store to promote: no base is
// ever published, so no later commit can adopt one, and every commit pays a
// cold install. The store's whole mechanism is then invisible to this fixture —
// which is what real-instance-e2e.md step 2 asks it to show, and which that
// doc asserted as a PASS this fixture could not produce until Run 2 found it.
// The content is the stamp again, so a run can tell an adopted base (stamp
// absent from the layer, marker present) from a cold install (both present).
fs.mkdirSync(path.join("node_modules", ".e2e-probe"), { recursive: true });
fs.writeFileSync(path.join("node_modules", ".e2e-probe", "marker.json"), JSON.stringify(stamp, null, 2));

console.log(`test-plugin install: stamped ${stamp.commit ?? "(no commit env)"}`);
