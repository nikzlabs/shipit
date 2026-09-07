import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  provisionOpenCodeAccount,
  revokeOpenCodeAccount,
  restoreOpenCodeAccount,
} from "./openai-account-delivery.js";
import {
  managedOpenCodeDataHome,
  readOpenCodeAccount,
  openCodeAccountFile,
} from "../shared/opencode-account.js";

const roots: string[] = [];
const consumers: string[] = [];
afterEach(() => {
  for (const p of consumers.splice(0)) revokeOpenCodeAccount(p);
  for (const p of roots.splice(0))
    {fs.rmSync(p, { recursive: true, force: true });}
});
function root() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "openai-delivery-"));
  roots.push(p);
  return p;
}
function source(p: string, identity: string, tag: string) {
  fs.mkdirSync(path.join(p, ".codex"), { recursive: true });
  const access_token = `e30.${Buffer.from(JSON.stringify({ tag, exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: identity } })).toString("base64url")}.test`;
  const file = path.join(p, ".codex/auth.json");
  fs.writeFileSync(
    `${file}.tmp`,
    JSON.stringify({ tokens: { access_token, refresh_token: "source-only" } }),
  );
  fs.renameSync(`${file}.tmp`, file);
  return access_token;
}
it("updates every consumer during a run without copying or publishing a refresh token", async () => {
  const src = root();
  source(src, "a", "first");
  const a = root();
  const b = root();
  consumers.push(a, b);
  provisionOpenCodeAccount(src, a, "route-a");
  provisionOpenCodeAccount(src, b, "route-a");
  const next = source(src, "a", "second");
  await vi.waitFor(() => {
    expect(readOpenCodeAccount(managedOpenCodeDataHome(a)).access).toBe(next);
    expect(readOpenCodeAccount(managedOpenCodeDataHome(b)).access).toBe(next);
  });
  expect(readOpenCodeAccount(managedOpenCodeDataHome(a)).refresh).toBe("");
  expect(fs.readFileSync(path.join(src, ".codex/auth.json"), "utf8")).toContain(
    "source-only",
  );
});
it("does not let an old account event overwrite a new route or restore revoked auth", async () => {
  const a = root();
  const b = root();
  const dest = root();
  consumers.push(dest);
  source(a, "a", "old");
  const current = source(b, "b", "current");
  provisionOpenCodeAccount(a, dest, "route-a");
  provisionOpenCodeAccount(b, dest, "route-b");
  source(a, "a", "late");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(readOpenCodeAccount(managedOpenCodeDataHome(dest)).access).toBe(
    current,
  );
  revokeOpenCodeAccount(dest);
  source(b, "b", "late-after-revoke");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(
    fs.existsSync(openCodeAccountFile(managedOpenCodeDataHome(dest))),
  ).toBe(false);
});
it("removes access if the source unexpectedly changes account identity", async () => {
  const src = root();
  const dest = root();
  consumers.push(dest);
  source(src, "a", "first");
  provisionOpenCodeAccount(src, dest, "route-a");
  source(src, "b", "wrong-account");
  await vi.waitFor(() =>
    expect(
      fs.existsSync(openCodeAccountFile(managedOpenCodeDataHome(dest))),
    ).toBe(false),
  );
});

it("restores a persisted binding after restart and receives the next renewal", async () => {
  const src = root();
  const dest = root();
  consumers.push(dest);
  source(src, "a", "first");
  provisionOpenCodeAccount(src, dest, "route-a");
  const data = managedOpenCodeDataHome(dest);
  const marker = fs.readFileSync(
    path.join(data, ".shipit-openai-account.json"),
  );
  revokeOpenCodeAccount(dest);
  fs.writeFileSync(path.join(data, ".shipit-openai-account.json"), marker);
  restoreOpenCodeAccount(dest, (id) => {
    expect(id).toBe("route-a");
    return src;
  });
  const next = source(src, "a", "renewed");
  await vi.waitFor(() => expect(readOpenCodeAccount(data).access).toBe(next));
});

it("keeps the consumer during a partial or expired source rewrite", async () => {
  const src = root();
  const dest = root();
  consumers.push(dest);
  const original = source(src, "a", "first");
  provisionOpenCodeAccount(src, dest, "route-a");
  fs.writeFileSync(path.join(src, ".codex/auth.json"), "{");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(readOpenCodeAccount(managedOpenCodeDataHome(dest)).access).toBe(
    original,
  );
  const expired = `e30.${Buffer.from(JSON.stringify({ exp: 1, "https://api.openai.com/auth": { chatgpt_account_id: "a" } })).toString("base64url")}.test`;
  fs.writeFileSync(
    path.join(src, ".codex/auth.json"),
    JSON.stringify({ tokens: { access_token: expired } }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(readOpenCodeAccount(managedOpenCodeDataHome(dest)).access).toBe(
    original,
  );
  const next = source(src, "a", "renewed");
  await vi.waitFor(() =>
    expect(readOpenCodeAccount(managedOpenCodeDataHome(dest)).access).toBe(
      next,
    ),
  );
});
