import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureOpencodeDataDir } from "./opencode-data-dir.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-data-dir-"));
  roots.push(root);
  return root;
}

/** The image layout: `<home>/.local/share/opencode` is a symlink into /credentials. */
function linkedHome(root: string): { home: string; target: string } {
  const home = path.join(root, "home");
  const target = path.join(root, "credentials", ".local", "share", "opencode");
  fs.mkdirSync(path.join(home, ".local", "share"), { recursive: true });
  fs.symlinkSync(target, path.join(home, ".local", "share", "opencode"));
  return { home, target };
}

describe("ensureOpencodeDataDir", () => {
  // THE regression guard. `mkdir(2)` returns EEXIST for a path that exists as a
  // dangling symlink, and OpenCode's Bun runtime surfaces that raw errno, so the
  // agent process died at startup with
  // `EEXIST: file already exists, mkdir '/home/shipit/.local/share/opencode'`.
  // A helper that merely called mkdir on the link would reproduce the bug, not
  // fix it — so this asserts the LINK RESOLVES afterwards, which is the property
  // OpenCode actually needs.
  it("creates the target of a DANGLING symlink, not the link", () => {
    const { home, target } = linkedHome(tempRoot());
    const link = path.join(home, ".local", "share", "opencode");
    expect(fs.existsSync(link)).toBe(false); // dangling: exists as a link, resolves to nothing

    expect(ensureOpencodeDataDir(home)).toBe(target);

    expect(fs.statSync(target).isDirectory()).toBe(true);
    // The link is still a link — we created what it points at, we did not
    // replace it with a real directory and strand the credentials volume.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(link)).toBe(true);
  });

  it("is idempotent once the target exists", () => {
    const { home, target } = linkedHome(tempRoot());
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "auth.json"), "{}");

    expect(ensureOpencodeDataDir(home)).toBe(target);

    // A warm dir is left exactly as it was — the credentials in it are the whole
    // reason the path is a symlink into the volume.
    expect(fs.readFileSync(path.join(target, "auth.json"), "utf8")).toBe("{}");
  });

  it("creates a plain directory when the home holds no symlink", () => {
    // Local/dogfood mode, and any home the CLI owns outright.
    const home = path.join(tempRoot(), "home");
    fs.mkdirSync(home, { recursive: true });

    const created = ensureOpencodeDataDir(home);

    expect(created).toBe(path.join(home, ".local", "share", "opencode"));
    expect(fs.statSync(created!).isDirectory()).toBe(true);
  });

  it("reports failure instead of throwing, so a naming run is never taken down", () => {
    // Naming is fire-and-forget; a throw here would surface as an unhandled
    // rejection rather than the derived-title fallback.
    const root = tempRoot();
    const home = path.join(root, "home");
    // A FILE where the data dir must go — mkdir cannot win.
    fs.mkdirSync(path.join(home, ".local", "share"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "share", "opencode"), "not a dir");

    expect(ensureOpencodeDataDir(home)).toBeNull();
  });
});
