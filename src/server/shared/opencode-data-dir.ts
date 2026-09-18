import fs from "node:fs";
import path from "node:path";

/** Use an account-scoped home; credential-less spawns need scratch XDG_DATA_HOME. */
export function ensureOpencodeDataDir(home: string): string | null {
  const dir = path.join(home, ".local", "share", "opencode");

  // mkdir on a dangling symlink fails; inspect the link and create its target.
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  let target = dir;
  if (stat?.isSymbolicLink()) {
    try {
      target = path.resolve(path.dirname(dir), fs.readlinkSync(dir));
    } catch (err) {
      console.warn(`[opencode] could not read the symlink at ${dir}:`, err);
      return null;
    }
  }

  try {
    fs.mkdirSync(target, { recursive: true });
    return target;
  } catch (err) {
    console.warn(`[opencode] could not prepare the data dir ${target}:`, err);
    return null;
  }
}
