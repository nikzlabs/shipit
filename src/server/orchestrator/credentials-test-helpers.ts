import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Host-side fixture root: literal /credentials would modify the running agent's credentials.
export const TEST_CREDENTIALS_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "shipit-test-credentials-dir-"),
);

process.on("exit", () => {
  try {
    fs.rmSync(TEST_CREDENTIALS_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});
