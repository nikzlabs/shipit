import zlib from "node:zlib";

/**
 * Whether a package's published tarball carries an install-time build, read from the bytes the
 * orchestrator has already digest-verified (docs/276-shared-package-cache-integrity plan.md
 * section 5, "Inputs and verification"; planning#604).
 *
 * The trigger set is pnpm's OWN `pkgRequiresBuild` (`building/pkg-requires-build`, read out of
 * the pnpm 11.22.0 bundle and matched against the `binding.gyp` / `.hooks` literals pnpm
 * 12.5.1's native binary carries): a truthy `preinstall`, `install` or `postinstall` script, a
 * `binding.gyp` at the package root, or any file under the package's `.hooks/`. Lockfile v9 no
 * longer records `requiresBuild`, so the tarball is the only place the answer is.
 *
 * A package holding one is PRUNED from the published base (`pnpm-base-prune.ts`), rather than
 * costing the whole candidate its base. The builder installs with `--ignore-scripts`, so a base
 * carrying such a package carries it unbuilt; the session's own install then reports the
 * lockfile up to date and nothing pending and exits 0 with the approved build never performed,
 * and neither repair works as the session's uid — `pnpm rebuild` and `pnpm install --force`
 * both fail to chmod, because overlay copy-up preserves the lower's owner (measured 2026-09-21,
 * planning#604). Removing the package from the tree and from the tree's carried lockfile makes
 * the session import and build its own copy instead.
 *
 * A tarball this cannot read is reported as unreadable rather than as scriptless: one it cannot
 * prove has no build must not become one it assumed had none.
 */

const TAR_BLOCK = 512;

/** Bounds the decompressed bytes one tarball is scanned over; past it the answer is unreadable. */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

/** The root `package.json` is the one entry whose data is buffered, so it carries its own bound. */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_EXTENSION_BYTES = 64 * 1024;

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

export type TarballBuildScan =
  | { kind: "requires-build"; trigger: string }
  | { kind: "scriptless" }
  | { kind: "unreadable"; detail: string };

export async function scanTarballForBuildTriggers(
  tarball: Buffer,
  opts: { maxUnpackedBytes?: number } = {},
): Promise<TarballBuildScan> {
  const scanner = new TarScanner(opts.maxUnpackedBytes ?? MAX_UNPACKED_BYTES);
  const gunzip = zlib.createGunzip();
  gunzip.end(tarball);

  let verdict: TarballBuildScan | null = null;
  try {
    for await (const chunk of gunzip) {
      verdict = scanner.push(chunk as Buffer);
      if (verdict) break;
    }
  } catch (err) {
    // A verdict already reached outranks the error: breaking out of the loop destroys the
    // stream, and a teardown that then throws must not turn a named trigger into "unreadable".
    return verdict ?? { kind: "unreadable", detail: `could not decompress: ${message(err)}` };
  }
  return verdict ?? scanner.finish();
}

type EntryKind = "skip" | "longname" | "pax" | "manifest";

/**
 * A block-at-a-time tar reader over the gunzip stream. It buffers only the entry it has to
 * parse (the root `package.json`, a long-name or pax header), so a package of any size is
 * scanned in constant memory.
 */
class TarScanner {
  private pending: Buffer = Buffer.alloc(0);
  private dataLeft = 0;
  private capture: Buffer[] | null = null;
  private captureLeft = 0;
  private entryKind: EntryKind = "skip";
  private longName: string | null = null;
  private paxPath: string | null = null;
  private paxSize: number | null = null;
  private sawManifest = false;
  private sawEntry = false;
  private ended = false;
  private unpacked = 0;

  constructor(private readonly maxUnpacked: number) {}

  push(chunk: Buffer): TarballBuildScan | null {
    this.unpacked += chunk.length;
    if (this.unpacked > this.maxUnpacked) {
      return { kind: "unreadable", detail: `unpacks past the ${this.maxUnpacked}-byte scan cap` };
    }
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    let offset = 0;
    while (!this.ended) {
      if (this.dataLeft > 0) {
        const take = Math.min(this.dataLeft, this.pending.length - offset);
        if (take === 0) break;
        if (this.captureLeft > 0 && this.capture) {
          const grab = Math.min(this.captureLeft, take);
          this.capture.push(this.pending.subarray(offset, offset + grab));
          this.captureLeft -= grab;
        }
        this.dataLeft -= take;
        offset += take;
        if (this.dataLeft === 0) {
          const verdict = this.endEntry();
          if (verdict) return verdict;
        }
        continue;
      }
      if (this.pending.length - offset < TAR_BLOCK) break;
      const verdict = this.header(this.pending.subarray(offset, offset + TAR_BLOCK));
      offset += TAR_BLOCK;
      if (verdict) return verdict;
    }

    // At the end-of-archive marker the answer is final, so stop rather than buffering the
    // trailing padding — which a hostile archive could make arbitrarily long.
    if (this.ended) return this.finish();
    this.pending = offset === 0 ? this.pending : this.pending.subarray(offset);
    return null;
  }

  finish(): TarballBuildScan {
    // An archive that stopped before its end-of-archive marker was cut off mid-stream, and what
    // was cut off is exactly where a trigger could have been.
    if (!this.ended) {
      return { kind: "unreadable", detail: "the tarball ends before its end-of-archive marker" };
    }
    if (!this.sawManifest) {
      return {
        kind: "unreadable",
        detail: this.sawEntry
          ? "the tarball carries no readable package.json at the package root"
          : "the tarball carries no tar entries",
      };
    }
    return { kind: "scriptless" };
  }

  private header(block: Buffer): TarballBuildScan | null {
    if (isZeroBlock(block)) {
      this.ended = true;
      return null;
    }
    if (!checksumOk(block)) {
      return { kind: "unreadable", detail: "a tar header failed its own checksum" };
    }
    const size = readNumericField(block, 124, 12);
    if (size === null) {
      return { kind: "unreadable", detail: "a tar header carries no readable size" };
    }
    const type = block[156] === 0 ? "0" : String.fromCharCode(block[156]);
    this.capture = null;
    this.captureLeft = 0;
    this.entryKind = "skip";

    // A GNU long name and a pax record set both describe the NEXT entry, so neither consumes the
    // override the previous one may have set.
    if (type === "L" || type === "x" || type === "X") {
      this.setDataLength(size);
      return this.beginCapture(type === "L" ? "longname" : "pax", size, MAX_HEADER_EXTENSION_BYTES);
    }
    if (type === "g" || type === "K") {
      this.setDataLength(size);
      return null;
    }

    const name = this.paxPath ?? this.longName ?? readEntryName(block);
    // pax may also override the SIZE, and it is the one that says where this entry's data ends.
    // Reading the header's instead walks into the payload looking for the next header, which is
    // how an archive hides everything after it.
    const dataSize = this.paxSize ?? size;
    this.setDataLength(dataSize);
    this.longName = null;
    this.paxPath = null;
    this.paxSize = null;
    this.sawEntry = true;

    // pnpm's file index is package-relative, so the archive's own root directory — `package/`
    // for anything npm packed, but not guaranteed to be called that — is stripped rather than
    // matched.
    const rel = packageRelative(name);
    if (rel === null) return null;
    // No type filter on the two triggers: a `binding.gyp` reached through a link still builds,
    // and a directory of that name cannot match — a directory entry keeps its trailing slash.
    if (rel === "binding.gyp") {
      return { kind: "requires-build", trigger: "a binding.gyp at its package root" };
    }
    if (/^\.hooks[\\/]/.test(rel)) {
      return { kind: "requires-build", trigger: "a file under its .hooks/ directory" };
    }
    // EVERY root manifest, not just the first: pnpm's file map keeps the LAST entry at a path,
    // so an archive holding a scriptless `package.json` followed by a scripted one builds.
    if ((type === "0" || type === "7") && rel === "package.json") {
      return this.beginCapture("manifest", dataSize, MAX_MANIFEST_BYTES);
    }
    return null;
  }

  private setDataLength(size: number): void {
    this.dataLeft = size + (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
  }

  /** Over the cap the entry is skipped, so the answer it could have carried is unknown. */
  private beginCapture(kind: EntryKind, size: number, cap: number): TarballBuildScan | null {
    if (size > cap) {
      return { kind: "unreadable", detail: `a ${kind} entry of ${size} bytes is past its cap` };
    }
    this.entryKind = kind;
    this.capture = [];
    this.captureLeft = size;
    return null;
  }

  private endEntry(): TarballBuildScan | null {
    const kind = this.entryKind;
    const data = this.capture ? Buffer.concat(this.capture) : null;
    this.entryKind = "skip";
    this.capture = null;
    if (!data) return null;
    if (kind === "longname") {
      this.longName = data.toString("utf8").replace(/\0.*$/, "");
      return null;
    }
    if (kind === "pax") {
      const records = paxRecords(data);
      if (records === null) {
        return { kind: "unreadable", detail: "a pax extended header is not parseable" };
      }
      if (records.path !== undefined) this.paxPath = records.path;
      if (records.size !== undefined) this.paxSize = records.size;
      return null;
    }
    if (kind === "manifest") {
      this.sawManifest = true;
      return manifestTrigger(data);
    }
    return null;
  }
}

function manifestTrigger(data: Buffer): TarballBuildScan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch (err) {
    return { kind: "unreadable", detail: `its package.json is not valid JSON: ${message(err)}` };
  }
  const scripts = isRecord(parsed) ? parsed.scripts : undefined;
  if (!isRecord(scripts)) return null;
  for (const name of INSTALL_SCRIPTS) {
    // pnpm's own test is a plain truthiness check, so an empty string is not a build and a
    // non-string value is.
    if (scripts[name]) return { kind: "requires-build", trigger: `a ${name} script` };
  }
  return null;
}

/**
 * The entry's path relative to the package, which is what pnpm's file index is keyed on: the
 * archive's own root directory is dropped, and `.` / `..` segments are resolved first, because
 * `package/lib/../binding.gyp` is the same file to pnpm and a different string to a matcher.
 * The trailing slash is kept, so a directory entry can never equal a file name.
 */
function packageRelative(entryPath: string): string | null {
  const out: string[] = [];
  for (const part of entryPath.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  if (out.length < 2) return null;
  return out.slice(1).join("/") + (entryPath.endsWith("/") ? "/" : "");
}

/**
 * The `prefix` field is POSIX ustar's; GNU's own format writes `ustar  \0` at the same magic
 * offset and puts atime/ctime where the prefix would be, so reading it unconditionally invents
 * a directory out of timestamps.
 */
function readEntryName(block: Buffer): string {
  const name = readString(block, 0, 100);
  if (block.subarray(257, 263).toString("latin1") !== "ustar\0") return name;
  const prefix = readString(block, 345, 155);
  return prefix === "" ? name : `${prefix}/${name}`;
}

function readString(block: Buffer, offset: number, len: number): string {
  const raw = block.subarray(offset, offset + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/** Octal, or GNU's base-256 form for a value the octal field cannot hold. */
function readNumericField(block: Buffer, offset: number, len: number): number | null {
  if ((block[offset] & 0x80) !== 0) {
    let value = block[offset] & 0x7f;
    for (let i = offset + 1; i < offset + len; i++) value = value * 256 + block[i];
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const text = block.subarray(offset, offset + len).toString("latin1").replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) return null;
  return parseInt(text, 8);
}

/**
 * The header's own checksum, which is what tells a tar header from arbitrary bytes. Both the
 * signed and unsigned sums are accepted: historic writers disagreed on whether the bytes are
 * signed, and a tar reader that takes only one rejects archives the other wrote.
 */
function checksumOk(block: Buffer): boolean {
  const declared = readNumericField(block, 148, 8);
  if (declared === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return declared === unsigned || declared === signed;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < TAR_BLOCK; i++) if (block[i] !== 0) return false;
  return true;
}

/**
 * pax records are `"<byte length> <key>=<value>\n"`, so the length is counted over bytes. A key
 * may repeat and the LAST occurrence is the one that applies, which is how an archive hides a
 * path behind a harmless one.
 */
function paxRecords(data: Buffer): { path?: string; size?: number } | null {
  const out: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1 || space <= offset) return null;
    const len = Number(data.subarray(offset, space).toString("latin1"));
    if (!Number.isInteger(len) || len <= 0 || offset + len > data.length) return null;
    const record = data.subarray(space + 1, offset + len);
    const eq = record.indexOf(0x3d);
    if (eq !== -1) {
      const key = record.subarray(0, eq).toString("latin1");
      const value = record.subarray(eq + 1).toString("utf8").replace(/\n$/, "");
      if (key === "path") out.path = value;
      if (key === "size") {
        const size = Number(value);
        if (!Number.isSafeInteger(size) || size < 0) return null;
        out.size = size;
      }
    }
    offset += len;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
