import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitIdentityStore } from "./git-identity-store.js";

describe("GitIdentityStore", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function createTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gitid-store-"));
    return tmpDir;
  }

  it("returns null when no identity file exists", () => {
    const dir = createTmpDir();
    const store = new GitIdentityStore(dir);
    expect(store.get()).toBeNull();
    expect(store.hasIdentity()).toBe(false);
  });

  it("loads identity from existing file", () => {
    const dir = createTmpDir();
    const shipitDir = path.join(dir, ".shipit");
    fs.mkdirSync(shipitDir, { recursive: true });
    fs.writeFileSync(
      path.join(shipitDir, "git-identity.json"),
      JSON.stringify({ name: "Jane Doe", email: "jane@example.com" }),
    );

    const store = new GitIdentityStore(dir);
    expect(store.get()).toEqual({ name: "Jane Doe", email: "jane@example.com" });
    expect(store.hasIdentity()).toBe(true);
  });

  it("handles corrupt JSON gracefully", () => {
    const dir = createTmpDir();
    const shipitDir = path.join(dir, ".shipit");
    fs.mkdirSync(shipitDir, { recursive: true });
    fs.writeFileSync(path.join(shipitDir, "git-identity.json"), "not json{{{");

    const store = new GitIdentityStore(dir);
    expect(store.get()).toBeNull();
    expect(store.hasIdentity()).toBe(false);
  });

  it("handles JSON with missing name", () => {
    const dir = createTmpDir();
    const shipitDir = path.join(dir, ".shipit");
    fs.mkdirSync(shipitDir, { recursive: true });
    fs.writeFileSync(
      path.join(shipitDir, "git-identity.json"),
      JSON.stringify({ email: "jane@example.com" }),
    );

    const store = new GitIdentityStore(dir);
    expect(store.get()).toBeNull();
  });

  it("handles JSON with empty name", () => {
    const dir = createTmpDir();
    const shipitDir = path.join(dir, ".shipit");
    fs.mkdirSync(shipitDir, { recursive: true });
    fs.writeFileSync(
      path.join(shipitDir, "git-identity.json"),
      JSON.stringify({ name: "  ", email: "jane@example.com" }),
    );

    const store = new GitIdentityStore(dir);
    expect(store.get()).toBeNull();
  });

  it("set() persists identity to disk", () => {
    const dir = createTmpDir();
    const store = new GitIdentityStore(dir);
    store.set("Alice", "alice@example.com");

    expect(store.get()).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(store.hasIdentity()).toBe(true);

    // Verify file was written
    const filePath = path.join(dir, ".shipit", "git-identity.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ name: "Alice", email: "alice@example.com" });
  });

  it("set() creates .shipit directory if missing", () => {
    const dir = createTmpDir();
    const shipitDir = path.join(dir, ".shipit");
    expect(fs.existsSync(shipitDir)).toBe(false);

    const store = new GitIdentityStore(dir);
    store.set("Bob", "bob@example.com");

    expect(fs.existsSync(shipitDir)).toBe(true);
    expect(store.get()).toEqual({ name: "Bob", email: "bob@example.com" });
  });

  it("new instance reads back what was previously saved", () => {
    const dir = createTmpDir();

    const store1 = new GitIdentityStore(dir);
    store1.set("Carol", "carol@example.com");

    const store2 = new GitIdentityStore(dir);
    expect(store2.get()).toEqual({ name: "Carol", email: "carol@example.com" });
  });
});
