#!/usr/bin/env bash
#
# local-specifier-spike.sh — how pnpm materializes `workspace:` / `link:` / `file:`, and what
#   that means for a verified base built from manifests alone (checklist: "Settle `workspace:` /
#   `link:` / `file:` — a candidate, not yet an admission"; planning#414).
#
# The question the admission turns on is not "is the target in the repo" but "does pnpm COPY it".
# The builder stages the committed manifests, the lockfile, `pnpm-workspace.yaml`, the `.npmrc`
# and the patch files — never package source — so a protocol that copies its target into the tree
# publishes whatever the snapshot happened to carry, while a protocol that symlinks publishes a
# link the consuming session follows into its OWN checkout.
#
# Cells (hard-asserted; exits non-zero on any failure):
#   A. what each of the three protocols resolves to in the lockfile, and what lands on disk.
#   B. the builder's own flags over a manifests-only snapshot: does it succeed, and what does a
#      `file:` dependency contain afterwards.
#   C. `injected`, both spellings — which resolution pnpm records for it.
#   D. containment: an escaping `link:`, an absolute `link:`, an out-of-root workspace project.
#   E. `excludeLinksFromLockfile` — what it removes from the lockfile, and whether a config that
#      disagrees with the lockfile can reach a successful frozen install.
#   F. a workspace member's `.bin` shim — which tree its chmod target lives in.
#
# Runs in a session container: it needs pnpm and a reachable registry, not Docker. The overlay
# and distinct-uid cells are a separate harness (`ineligible-sharing-host-spike.sh`).
set -uo pipefail

ok(){ echo -e "    \033[32m$1\033[0m"; }; bad(){ echo -e "    \033[31m$1\033[0m"; }
hdr(){ echo -e "\n\033[1m$1\033[0m"; }
PASS=0; FAIL=0
pass(){ ok "$1"; PASS=$((PASS+1)); }
fail(){ bad "FAIL: $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then pass "$1 = $2"; else fail "$1: expected '$3', got '$2'"; fi; }
contains(){ case "$2" in *"$3"*) pass "$1";; *) fail "$1: '$2' does not contain '$3'";; esac; }

command -v pnpm >/dev/null || { echo "pnpm not found"; exit 2; }
PNPM_VERSION=$(pnpm --version 2>/dev/null | tail -1)
echo "pnpm $PNPM_VERSION"

R=$(mktemp -d -t local-spec-spike-XXXXXX)
trap 'rm -rf "$R"' EXIT
PNPM="pnpm --ignore-scripts"

manifest(){ printf '{"name":"%s","version":"1.0.0","main":"index.js"%s}\n' "$1" "${2:-}"; }

# ---------------------------------------------------------------- A: materialization
hdr "A. what each protocol resolves to, and what lands on disk"
mkdir -p "$R/a"/{packages/lib,vendor/linked,vendor/filed}
cd "$R/a" || exit 2
cat > package.json <<'EOF'
{"name":"root","version":"1.0.0","private":true,
 "dependencies":{"lib":"workspace:*","linked":"link:./vendor/linked","filed":"file:./vendor/filed","lodash":"4.17.21"}}
EOF
printf 'packages:\n  - packages/*\n' > pnpm-workspace.yaml
manifest lib > packages/lib/package.json;        echo 'module.exports="LIB"'    > packages/lib/index.js
manifest linked > vendor/linked/package.json;    echo 'module.exports="LINKED"' > vendor/linked/index.js
manifest filed > vendor/filed/package.json;      echo 'module.exports="FILED"'  > vendor/filed/index.js
$PNPM install >/dev/null 2>&1 || { echo "cell A install failed"; exit 2; }

lock_version(){ sed -n "/^      $1:/,/version:/p" pnpm-lock.yaml | sed -n 's/.*version: //p' | head -1; }
check "workspace: resolves to" "$(lock_version lib)"    "link:packages/lib"
check "link: resolves to"      "$(lock_version linked)" "link:vendor/linked"
check "file: resolves to"      "$(lock_version filed)"  "file:vendor/filed"
check "workspace: on disk"     "$(readlink node_modules/lib)"    "../packages/lib"
check "link: on disk"          "$(readlink node_modules/linked)" "../vendor/linked"
# The one that is NOT a link into the checkout: pnpm copies the directory into the virtual store.
contains "file: on disk points into the virtual store" "$(readlink node_modules/filed)" ".pnpm/filed@file+vendor+filed"
FILED_REAL="node_modules/.pnpm/filed@file+vendor+filed/node_modules/filed"
if [ -f "$FILED_REAL/index.js" ]; then pass "file: target's source is COPIED into the tree"
else fail "file: target's source is not in the tree"; fi
# `file:` also gets a `packages:` entry, which is how the digest check already refuses it.
contains "file: gets a directory-resolution packages entry" \
  "$(sed -n '/^packages:/,$p' pnpm-lock.yaml | tr '\n' ' ')" "resolution: {directory: vendor/filed, type: directory}"

# ---------------------------------------------------------------- B: manifests-only snapshot
hdr "B. the builder's flags over a snapshot that stages manifests, not source"
mkdir -p "$R/b"
cd "$R/a" || exit 2
for f in package.json pnpm-lock.yaml pnpm-workspace.yaml packages/lib/package.json vendor/filed/package.json; do
  mkdir -p "$R/b/$(dirname "$f")"; cp "$f" "$R/b/$f"
done
# Deliberately NOT staged: vendor/linked/package.json, and every source file.
cd "$R/b" || exit 2
B_OUT=$($PNPM install --offline --frozen-lockfile --ignore-pnpmfile --registry http://127.0.0.1:1/ 2>&1)
B_RC=$?
check "manifests-only frozen offline install rc" "$B_RC" "0"
contains "it resolved the link whose target was never staged" "$(readlink node_modules/linked)" "../vendor/linked"
# The finding the admission turns on: the install SUCCEEDS and publishes a truncated package.
if [ -f "$R/b/$FILED_REAL/package.json" ] && [ ! -f "$R/b/$FILED_REAL/index.js" ]; then
  pass "file: dependency is published TRUNCATED, with rc=0 and no warning"
else
  fail "file: dependency was not truncated as expected (output: $(echo "$B_OUT" | tail -2))"
fi

# ---------------------------------------------------------------- C: injected
hdr "C. injected — which resolution pnpm records"
# $1 = extra pnpm-workspace.yaml lines; $2 = the app's lodash version. When it MATCHES what the
# member resolves, pnpm can dedupe the injected copy back to a link; when it differs, it cannot.
# Varying that is what separates "pnpm did not inject" from "pnpm deduped what it injected" —
# the first draft held it constant and drew the wrong conclusion (found by independent review).
inject_case(){
  rm -rf "$R/c"; mkdir -p "$R/c/packages"/{lib,app}; cd "$R/c" || exit 2
  echo '{"name":"root","version":"1.0.0","private":true}' > package.json
  printf 'packages:\n  - packages/*\n%s' "$1" > pnpm-workspace.yaml
  manifest lib ',"peerDependencies":{"lodash":"*"},"dependencies":{"lodash":"4.17.21"}' > packages/lib/package.json
  echo 'module.exports="LIB"' > packages/lib/index.js
  printf '{"name":"app","version":"1.0.0","dependencies":{"lib":"workspace:*","lodash":"%s"},"dependenciesMeta":{"lib":{"injected":true}}}\n' "$2" > packages/app/package.json
  $PNPM install >/dev/null 2>&1
  sed -n '/^  packages\/app:/,/^  packages\/lib:/p' pnpm-lock.yaml | sed -n 's/.*version: //p' | head -1
}
check "injected, peer dedupable" "$(inject_case '' 4.17.21)" "link:../lib"
# The two spellings that DO inject. Either is enough, which is why the refusal reads the
# resolution rather than enumerating the settings that produce it.
contains "injected alone, peer NOT dedupable, resolves as file:" \
  "$(inject_case '' 4.17.20)" "file:packages/lib"
contains "injectWorkspacePackages with dedupe off resolves as file:" \
  "$(inject_case 'injectWorkspacePackages: true
dedupeInjectedDeps: false
' 4.17.21)" "file:packages/lib"

# ---------------------------------------------------------------- C2: a registry snapshot link
hdr "C2. a REGISTRY package whose peer is a workspace member"
# Found by independent review: a snapshot edge can carry a `link:` under a package the digest
# check admits, so the snapshots loop cannot refuse the form outright. Its target is resolved
# against the PROJECT ROOT, and stays root-relative even from a nested importer.
rm -rf "$R/c2"; mkdir -p "$R/c2/packages"/{react,app}
cd "$R/c2" || exit 2
echo '{"name":"root","version":"1.0.0","private":true}' > package.json
printf 'packages:\n  - packages/*\n' > pnpm-workspace.yaml
manifest react > packages/react/package.json
sed -i 's/"version":"1.0.0"/"version":"18.2.0"/' packages/react/package.json
echo '{"name":"app","version":"1.0.0","dependencies":{"react-dom":"18.2.0","react":"workspace:*"}}' > packages/app/package.json
$PNPM install >/dev/null 2>&1
contains "the nested importer's own edge is importer-relative" \
  "$(sed -n '/^  packages\/app:/,/^  packages\/react:/p' pnpm-lock.yaml | tr '\n' ' ')" "link:../react"
contains "the snapshot edge is ROOT-relative" \
  "$(sed -n '/^snapshots:/,$p' pnpm-lock.yaml | tr '\n' ' ')" "react: link:packages/react"
contains "and the virtual-store link reaches the member" \
  "$(readlink "node_modules/.pnpm/$(ls node_modules/.pnpm | grep '^react-dom')/node_modules/react")" \
  "packages/react"

# ---------------------------------------------------------------- D: containment
hdr "D. targets outside the checkout"
rm -rf "$R/d"; mkdir -p "$R/d"/{repo,outside}
manifest out > "$R/d/outside/package.json"; echo 'module.exports="OUT"' > "$R/d/outside/index.js"
cd "$R/d/repo" || exit 2
cat > package.json <<EOF
{"name":"r","version":"1.0.0","private":true,
 "dependencies":{"rel":"link:../outside","abs":"link:$R/d/outside","filerel":"file:../outside"}}
EOF
$PNPM install >/dev/null 2>&1
check "an escaping link: resolves relative"  "$(lock_version rel)" "link:../outside"
# An absolute specifier is NORMALIZED to a relative resolution, so one containment check covers both.
check "an ABSOLUTE link: resolves relative"  "$(lock_version abs)" "link:../outside"
check "the escaping link on disk"            "$(readlink node_modules/rel)" "../../outside"
contains "an escaping file: copies out-of-checkout content in" "$(readlink node_modules/filerel)" ".pnpm/out@file+..+outside"

rm -rf "$R/d2"; mkdir -p "$R/d2"/{root,sibling/m}
manifest m > "$R/d2/sibling/m/package.json"
cd "$R/d2/root" || exit 2
echo '{"name":"root","version":"1.0.0","private":true,"dependencies":{"m":"workspace:*"}}' > package.json
printf 'packages:\n  - ../sibling/*\n' > pnpm-workspace.yaml
$PNPM install >/dev/null 2>&1
# pnpm accepts a workspace glob above the root, so importer containment is its own check.
contains "an out-of-root workspace project is accepted by pnpm" \
  "$(sed -n '/^importers:/,/^packages:/p' pnpm-lock.yaml | tr '\n' ' ')" "../sibling/m:"
check "and it links out of the checkout" "$(readlink node_modules/m)" "../../sibling/m"

# ---------------------------------------------------------------- E: excludeLinksFromLockfile
hdr "E. excludeLinksFromLockfile"
rm -rf "$R/e"; mkdir -p "$R/e/repo"/{vendor/l,packages/w}
manifest l > "$R/e/repo/vendor/l/package.json"
manifest w > "$R/e/repo/packages/w/package.json"
cd "$R/e/repo" || exit 2
echo '{"name":"r","version":"1.0.0","private":true,"dependencies":{"l":"link:./vendor/l","w":"workspace:*","lodash":"4.17.21"}}' > package.json
printf 'packages:\n  - packages/*\nexcludeLinksFromLockfile: true\n' > pnpm-workspace.yaml
$PNPM install >/dev/null 2>&1
if grep -q 'specifier: link:' pnpm-lock.yaml; then fail "the link: edge is still in the lockfile"
else pass "the link: edge is REMOVED from the lockfile"; fi
if grep -q 'specifier: workspace:' pnpm-lock.yaml; then pass "a workspace: edge is kept"
else fail "the workspace: edge was removed too"; fi
# The base still gets the symlink, which is why a hidden edge cannot simply be ignored.
check "the base would still carry the link" "$(readlink node_modules/l)" "../vendor/l"
contains "the lockfile records the setting" "$(sed -n '/^settings:/,/^$/p' pnpm-lock.yaml | tr -d ' \n')" "excludeLinksFromLockfile:true"
# Both directions of a config/lockfile disagreement, which is what makes the lockfile authoritative.
rm -f pnpm-workspace.yaml
contains "lockfile true + config absent fails frozen" \
  "$($PNPM install --frozen-lockfile 2>&1)" "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH"
rm -rf "$R/e2"; mkdir -p "$R/e2/vendor/l"; manifest l > "$R/e2/vendor/l/package.json"
cd "$R/e2" || exit 2
echo '{"name":"r","version":"1.0.0","private":true,"dependencies":{"l":"link:./vendor/l","lodash":"4.17.21"}}' > package.json
$PNPM install >/dev/null 2>&1
printf 'excludeLinksFromLockfile: true\n' > pnpm-workspace.yaml
contains "lockfile false + config true fails frozen" \
  "$($PNPM install --frozen-lockfile 2>&1)" "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH"

# ---------------------------------------------------------------- F: a member's .bin target
hdr "F. where a workspace member's .bin shim chmods"
rm -rf "$R/f"; mkdir -p "$R/f/packages/lib"
cd "$R/f" || exit 2
echo '{"name":"root","version":"1.0.0","private":true,"dependencies":{"lodash":"4.17.21"}}' > package.json
printf 'packages:\n  - packages/*\n' > pnpm-workspace.yaml
echo '{"name":"lib","version":"1.0.0","dependencies":{"semver":"7.6.3"}}' > packages/lib/package.json
$PNPM install >/dev/null 2>&1
# The shim's target resolves THROUGH the member's symlink into the ROOT virtual store, which is
# the tree the base publishes — so `resolvePnpmBinSeedSet` already covers it.
contains "the member's dependency links into the root virtual store" \
  "$(readlink packages/lib/node_modules/semver)" "../../../node_modules/.pnpm/semver@7.6.3"
contains "the member's shim names a target under that link" \
  "$(grep -o 'cmd-shim-target=.*' packages/lib/node_modules/.bin/semver | head -1)" \
  "packages/lib/node_modules/semver/bin"

hdr "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
