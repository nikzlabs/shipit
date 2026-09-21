/**
 * Docker decodes request bodies with Go's `encoding/json`, which matches an object key to a struct
 * field case-insensitively when no exact match exists. Every check in `docker-proxy-sanitize.ts`
 * and in the body-reading routes of `docker-proxy.ts` reads exact JavaScript property names, so a
 * key the proxy cannot see — `"privileged"`, `"binds"`, `"driveropts"` — is still honoured by the
 * daemon. That is a full host escape, so the proxy refuses such a body (planning#607).
 *
 * Refusing rather than normalising keeps the request the proxy checked and the request the daemon
 * decodes the same object. A canonical client (the Docker CLI, Compose, every SDK) emits canonical
 * casing, so nothing legitimate is refused.
 */

/**
 * Every field a proxy check reads, rewrites, or deletes — an alias of any of them changes what
 * Docker does without changing what the proxy sees. Derived from the code, not from a list:
 * `sanitizeContainerCreate` for the container-create fields, and the `/volumes/create`,
 * `/networks/create` and `/networks/{id}/(dis)connect` routes for the rest. **Add a field here
 * the moment a check starts depending on it.**
 */
const GUARDED_FIELDS: readonly string[] = [
  // sanitizeContainerCreate: fields a refusal depends on.
  "HostConfig",
  "Privileged",
  "CapAdd",
  "NetworkMode",
  "NetworkingConfig",
  "EndpointsConfig",
  "PidMode",
  "IpcMode",
  "UTSMode",
  "Devices",
  "DeviceCgroupRules",
  "DeviceRequests",
  "Binds",
  "Mounts",
  "Type",
  "Source",
  "VolumeOptions",
  "DriverConfig",
  "Options",
  // RestartPolicy.Name and DriverConfig.Name are both read by a refusal; a `name` alias would skip
  // it. Every client spells this one canonically, and the refusal names the spelling it wants.
  "Name",
  "VolumesFrom",
  // sanitizeContainerCreate: fields it rewrites. A later alias wins over the value we wrote,
  // because Go's decoder takes the last key that matches a field.
  "CapDrop",
  "Labels",
  "Memory",
  "CpuQuota",
  "CpuPeriod",
  "CpuShares",
  "PidsLimit",
  // sanitizeContainerCreate: fields it deletes. An alias survives the delete.
  "SecurityOpt",
  "CgroupParent",
  "Sysctls",
  "UsernsMode",
  "CgroupnsMode",
  "Runtime",
  "ReadonlyPaths",
  "MaskedPaths",
  "GroupAdd",
  // Restart re-resolves mounts with no request the proxy sees, which is why planning#601 refuses
  // a restart policy on a host-bound container.
  "RestartPolicy",
  "VolumeDriver",
  // POST /volumes/create.
  "Driver",
  "DriverOpts",
  // POST /networks/{id}/connect and /disconnect: the container the ownership check reads.
  "Container",
];

/**
 * Fields whose object is a Go `map[string]…`, not a struct: label names, sysctl names, container
 * paths, port specs, network names. Go never case-folds a map key, so an odd spelling there is
 * data rather than an alias — and a container label legitimately named `type` must not be refused.
 * Only that one key layer is exempt; the values below it are checked normally.
 */
const FREE_FORM_KEY_MAPS = new Set([
  "Labels",
  "Annotations",
  "Sysctls",
  "StorageOpt",
  "DriverOpts",
  "Options",
  // LogConfig.Config holds log-driver options, and the json-file driver takes one called `labels`.
  // IPAM.Config is an array, whose elements are structs and are checked as usual.
  "Config",
  "EndpointsConfig",
  // IPAM.Config[].AuxiliaryAddresses is keyed by host name.
  "AuxiliaryAddresses",
  "AuxAddress",
  "ExposedPorts",
  "PortBindings",
  "Volumes",
]);

/**
 * Go compares field names with `bytes.EqualFold` (Unicode simple folding), not with ASCII
 * lowercasing: U+212A KELVIN SIGN folds to `k` and U+017F LATIN SMALL LETTER LONG S to `s`, which
 * are the only two non-ASCII runes that fold onto an ASCII letter. `toLowerCase` alone leaves both
 * unchanged, so `Bindſ` would walk past an ASCII-only comparison and still reach `Binds`.
 */
function goFold(name: string): string {
  return name.replace(/K/g, "k").replace(/ſ/g, "s").normalize("NFKC").toLowerCase();
}

const CANONICAL_BY_FOLD = new Map(GUARDED_FIELDS.map((field) => [goFold(field), field]));

interface Frame {
  value: unknown;
  path: string;
  /** This object's own keys are map keys, so they are data rather than field names. */
  keysAreData: boolean;
}

/** The refusal reason for the first ambiguously-spelled field, or undefined when the body is clean. */
export function findAmbiguousFieldCasing(body: unknown): string | undefined {
  const stack: Frame[] = [{ value: body, path: "", keysAreData: false }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { value } = frame;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        stack.push({ value: value[i], path: `${frame.path}[${i}]`, keysAreData: false });
      }
      continue;
    }

    if (value === null || typeof value !== "object") continue;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = frame.path ? `${frame.path}.${key}` : key;

      if (!frame.keysAreData) {
        const canonical = CANONICAL_BY_FOLD.get(goFold(key));
        if (canonical !== undefined && canonical !== key) {
          return `Ambiguous field casing "${childPath}" — Docker matches JSON field names ` +
            `case-insensitively, so only the canonical spelling "${canonical}" is accepted`;
        }
      }

      stack.push({
        value: child,
        path: childPath,
        keysAreData: !frame.keysAreData && FREE_FORM_KEY_MAPS.has(key),
      });
    }
  }

  return undefined;
}
