import zlib from "node:zlib";

/**
 * Builds the gzipped tar an npm registry publishes, so a test of the install-script scan
 * (`pnpm-install-scripts.ts`) and of the staging that calls it runs over real archive bytes
 * rather than a stand-in the scanner would read as unreadable.
 */

const BLOCK = 512;

export interface TarballEntry {
  /** Package-relative, e.g. `package.json` or `.hooks/install`. */
  path: string;
  content: string;
  /** Tar type flag; `5` for a directory, `2` for a symlink. Defaults to a regular file. */
  type?: "0" | "5" | "2";
}

export interface TarballSpec {
  manifest?: Record<string, unknown> | null;
  files?: TarballEntry[];
  /** The archive's root directory. npm always packs `package`; a few older tarballs do not. */
  root?: string;
  /** Forces every path through a pax `path` record, as node-tar does past 100 bytes. */
  usePaxPaths?: boolean;
  /** Forces every path through a GNU `L` long-name entry, as GNU tar does past 100 bytes. */
  useGnuLongNames?: boolean;
  /** Prefixes every path with `/`, which a tar reader must not take as the root segment. */
  absolutePaths?: boolean;
  /**
   * GNU's own header format: magic `ustar  \0`, and atime/ctime where POSIX ustar puts
   * `prefix`. A reader that takes those bytes as a prefix invents a directory out of
   * timestamps and stops recognising the entry.
   */
  gnuFormat?: boolean;
}

export function makeNpmTarball(spec: TarballSpec = {}): Buffer {
  const root = spec.root ?? "package";
  const entries: TarballEntry[] = [
    ...(spec.manifest === null
      ? []
      : [{ path: "package.json", content: JSON.stringify(spec.manifest ?? { name: "x", version: "1.0.0" }) }]),
    ...(spec.files ?? []),
  ];

  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const full = `${spec.absolutePaths ? "/" : ""}${root}/${entry.path}`;
    const body = Buffer.from(entry.content, "utf8");
    if (spec.usePaxPaths) {
      const record = paxRecord("path", full);
      blocks.push(header("PaxHeader/x", record.length, "x", spec), ...payload(record));
    }
    if (spec.useGnuLongNames) {
      const name = Buffer.from(`${full}\0`, "utf8");
      blocks.push(header("././@LongLink", name.length, "L", spec), ...payload(name));
    }
    blocks.push(header(full, body.length, entry.type ?? "0", spec), ...payload(body));
  }
  blocks.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** A gzip stream whose payload is not a tar archive at all. */
export function makeNonTarball(text = "not a tar archive"): Buffer {
  return zlib.gzipSync(Buffer.from(text.padEnd(BLOCK * 2, " "), "utf8"));
}

/**
 * Block-level assembly, for the archive shapes `makeNpmTarball` deliberately cannot produce:
 * a repeated entry, a pax record set that contradicts the header it precedes, a stream that
 * stops before its end-of-archive marker.
 */
export function tarEntry(
  name: string,
  content: string,
  opts: { type?: string; declaredSize?: number } = {},
): Buffer[] {
  const body = Buffer.from(content, "utf8");
  const declared = opts.declaredSize ?? body.length;
  return [header(name, declared, opts.type ?? "0"), ...payload(body)];
}

/** One pax extended header carrying the given records verbatim, in order. */
export function paxEntry(records: [string, string][]): Buffer[] {
  const body = Buffer.concat(records.map(([key, value]) => paxRecord(key, value)));
  return [header("PaxHeader/x", body.length, "x"), ...payload(body)];
}

export function gzipTar(blocks: Buffer[], opts: { terminate?: boolean } = {}): Buffer {
  const all = opts.terminate === false ? blocks : [...blocks, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)];
  return zlib.gzipSync(Buffer.concat(all));
}

function payload(body: Buffer): Buffer[] {
  const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
  return pad === 0 ? [body] : [body, Buffer.alloc(pad)];
}

/** ustar splits a path over 100 bytes at a `/`, prefix first — the shape node-tar writes. */
function splitUstarPath(full: string): { name: string; prefix: string } {
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: "" };
  for (let i = full.indexOf("/"); i !== -1; i = full.indexOf("/", i + 1)) {
    const prefix = full.slice(0, i);
    const name = full.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  return { name: full.slice(-100), prefix: "" };
}

function header(fullName: string, size: number, type: string, spec: TarballSpec = {}): Buffer {
  const { name, prefix } = splitUstarPath(fullName);
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name, 0, "utf8");
  block.write("0000644\0", 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write("00000000000\0", 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  if (spec.gnuFormat) {
    block.write("ustar  \0", 257, "ascii");
    block.write("14567123456\0", 345, "ascii");
  } else {
    block.write("ustar\0", 257, "ascii");
    block.write("00", 263, "ascii");
    if (prefix !== "") block.write(prefix, 345, "utf8");
  }

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i];
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return Buffer.from(`${len}${body}`, "utf8");
}
