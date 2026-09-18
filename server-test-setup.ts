import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach } from "vitest";
import { credentialStorageEnvNames } from "./src/server/shared/catalogue/index.js";
import { CREDENTIAL_ROUTE_ENV_PREFIX } from "./src/server/shared/types/domain-types/credential-route.js";
import { installShipitConfigFixtureGuard } from "./src/server/shared/shipit-config-test-guard.js";

// Redirect before imports: unsetting this would fall back to the session's /credentials.
const testGitConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-test-gitconfig-"));
process.env.GIT_CONFIG_GLOBAL = path.join(testGitConfigDir, ".gitconfig");
process.on("exit", () => {
  try {
    fs.rmSync(testGitConfigDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

// Host-injected git settings take precedence over the isolated global config.
const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "", 10);
const keysToClear = ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"];
if (Number.isInteger(count)) {
  for (let i = 0; i < count; i += 1) {
    keysToClear.push(`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`);
  }
}
for (const key of keysToClear) {
  Reflect.deleteProperty(process.env, key);
}

// Container fixtures have no real egress sidecar.
if (process.env.SESSION_EGRESS_ENFORCE === undefined) {
  process.env.SESSION_EGRESS_ENFORCE = "0";
}

Reflect.deleteProperty(process.env, "SHIPIT_WORKER_TOKEN");
Reflect.deleteProperty(process.env, "SHIPIT_AGENT_DEPTH");

if (process.env.GIT_ALLOW_PROTOCOL === undefined) {
  process.env.GIT_ALLOW_PROTOCOL = "file";
}
if (process.env.GIT_TERMINAL_PROMPT === undefined) {
  process.env.GIT_TERMINAL_PROMPT = "0";
}

// Strip before imports and each test: API tests also write credentials into process.env.
function stripCredentialEnv(): void {
  for (const name of credentialStorageEnvNames()) {
    Reflect.deleteProperty(process.env, name);
  }
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(CREDENTIAL_ROUTE_ENV_PREFIX)) Reflect.deleteProperty(process.env, name);
  }
}

stripCredentialEnv();
beforeEach(stripCredentialEnv);

// Invalid fixtures can silently disable production checks that catch config errors.
installShipitConfigFixtureGuard();
