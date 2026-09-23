#!/usr/bin/env bash
# Measurements for the PRUNED verified base (docs/276 plan.md section 5, planning#604/#414).
#
# `ineligible-sharing-spike.sh` cells F and K designed the prune against a hand-rolled removal;
# this harness measures the SHIPPED one — it calls `prunePnpmBase` (`pnpm-base-prune.ts`) itself
# through tsx — over the shapes that design left unmeasured, each of which gates the mechanism:
#
#   A  a real multi-hundred-package tree classifies end to end (every virtual-store directory is
#      identified from its own manifest, none ambiguous), and a prune of nothing removes nothing.
#   B  peer-qualified duplicates: ONE package at one version in several virtual-store
#      directories, whose names pnpm mangles. All instances go, and so do the peer-suffixed
#      lockfile keys.
#   C  an `npm:` alias: the importer edge names the ALIAS, never the package, so an edge check
#      keyed on the dependency's own name leaves it behind.
#   D  an optional, platform-skipped package: pinned by the lockfile, absent from the tree. It
#      must leave the carried lockfile, and its absence from the tree is not a failure.
#   E  a consumer whose lockfile DIFFERS from the publisher's commit: the base is built at one
#      lockfile and installed over at another.
#   F  `.modules.yaml` still naming a pruned package in `pendingBuilds`: harmless on BOTH the
#      bare and the frozen install, or not — the prune does not rewrite that file.
#   G  pnpm's CARRIED INSTALL STATE, which short-circuits an install before it reads the carried
#      lockfile at all. Found here, with a control; the prune drops it.
#
# The overlay/uid half — upper and store cost, distinct uids, kernel copy-up — is
# `pruned-base-host-spike.sh` on the services host; a session container cannot run it.
#
# Usage: bash pruned-base-spike.sh    (needs network for the registry packages)

set -u
ROOT=${ROOT:-/tmp/pruned-base-spike}
REPO=${REPO:-/workspace}
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3 ($1)"; else bad "$3: expected '$2', got '$1'"; fi; }

command -v pnpm >/dev/null || { echo "pnpm is required"; exit 1; }
echo "pnpm $(pnpm --version)  node $(node --version)"

rm -rf "$ROOT"; mkdir -p "$ROOT"

# ---------------------------------------------------------------- the shipped prune, as a CLI
# Calls the production module, so every cell below measures what the builder runs rather than a
# bash restatement of it. A restatement is what cells F and K of `ineligible-sharing-spike.sh`
# measured, and it is exactly what a shipped implementation can drift from.
# QUOTED heredocs, with the repo path substituted afterwards. An unquoted one expands the
# JavaScript template literals and `${...}` below in the SHELL, which silently turns
# `out.push(\`${section}/${key}\`)` into `out.push()` — measured, and it made cell B's and D's
# lockfile assertions pass without inspecting a single reference.
cat > "$ROOT/prune.ts" <<'EOF'
import { prunePnpmBase } from "__REPO__/src/server/orchestrator/pnpm-base-prune.js";
const [depDir, ...keys] = process.argv.slice(2);
const packages = keys.map((key) => {
  const at = key.lastIndexOf("@");
  return { key, name: key.slice(0, at), version: key.slice(at + 1) };
});
const result = prunePnpmBase(depDir, packages);
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
EOF
prune(){ (cd "$REPO" && npx tsx "$ROOT/prune.ts" "$@"); }

# The carried lockfile's package/snapshot keys and importer edges. A raw grep is the wrong
# instrument: a retained package's dependency EDGE on a pruned one deliberately survives (pnpm
# relinks it), so grepping the file reports a pass as a failure.
cat > "$ROOT/keys.ts" <<'EOF'
import fs from "node:fs";
// By absolute path: the script lives outside the repo, so a bare specifier does not resolve.
import { parse } from "__REPO__/node_modules/yaml/dist/index.js";
const doc = parse(fs.readFileSync(process.argv[2], "utf-8")) as Record<string, any>;
const out: string[] = [];
for (const section of ["packages", "snapshots"]) {
  for (const key of Object.keys(doc[section] ?? {})) out.push(`${section}/${key}`);
}
for (const [dir, imp] of Object.entries<any>(doc.importers ?? {})) {
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, e] of Object.entries<any>(imp?.[group] ?? {})) {
      out.push(`${dir}/${group}/${name}=${typeof e === "string" ? e : e?.version}`);
    }
  }
}
console.log(out.join("\n"));
EOF
sed -i "s#__REPO__#$REPO#g" "$ROOT/prune.ts" "$ROOT/keys.ts"

# Absolute: the helper runs from the repo, so a relative path would resolve against it. Its
# output is REQUIRED to be non-empty — a helper that dies must not take the "no references
# survive" branch.
keys(){ local f out; f=$(readlink -f "$1")
  out=$( (cd "$REPO" && npx tsx "$ROOT/keys.ts" "$f") ) || { echo "KEYS_HELPER_FAILED"; return; }
  [ -n "$out" ] && echo "$out" || echo "KEYS_HELPER_EMPTY"; }
# A negative assertion over that output, refusing to conclude anything from a failed helper.
no_key(){ local out; out=$(keys "$1")
  case "$out" in KEYS_HELPER_*) bad "$3: the lockfile helper produced nothing ($out)"; FAIL=$FAIL; return;; esac
  echo "$out" | grep -q "$2" && bad "$3" || ok "$3 — none of $(echo "$out" | grep -c .) entries names it"; }

# `copy` is what a session container sets, so the trees here import the way a real one does.
export PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy

echo; echo "== A. a real tree classifies end to end =="
mkdir -p "$ROOT/a" "$ROOT/astore"; cd "$ROOT/a"
echo '{"name":"a","version":"1.0.0","dependencies":{"vite":"5.4.11","typescript":"5.6.3","eslint":"9.14.0"}}' > package.json
PNPM_CONFIG_STORE_DIR="$ROOT/astore" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
DIRS=$(ls node_modules/.pnpm | grep -v '^node_modules$' | grep -v '^lock.yaml$' | wc -l)
OUT=$(prune "$ROOT/a/node_modules" "no-such-package@1.0.0" 2>&1); RC=$?
check "$RC" "0" "a $DIRS-package tree classifies with no ambiguous virtual-store entry"
echo "$OUT" | grep -q '"removedDirs":\[\]' && ok "a prune of nothing removes nothing" \
  || bad "a prune of nothing changed the tree: $OUT"
REMAIN=$(echo "$OUT" | sed 's/.*"remainingPackages":\([0-9]*\).*/\1/')
check "$REMAIN" "$DIRS" "every virtual-store directory is accounted for"

echo; echo "== B. peer-qualified duplicates of ONE package =="
# A workspace is the cheapest way to make pnpm resolve one package under two peer sets. The
# shape is what is under test, not the workspace's own eligibility.
rm -rf "$ROOT/b" "$ROOT/bstore"; mkdir -p "$ROOT/b/packages/x" "$ROOT/b/packages/y"; cd "$ROOT/b"
printf 'packages:\n  - packages/*\n' > pnpm-workspace.yaml
echo '{"name":"root","version":"1.0.0","private":true}' > package.json
echo '{"name":"x","version":"1.0.0","dependencies":{"react":"17.0.2","use-sync-external-store":"1.2.2"}}' > packages/x/package.json
echo '{"name":"y","version":"1.0.0","dependencies":{"react":"18.2.0","use-sync-external-store":"1.2.2"}}' > packages/y/package.json
PNPM_CONFIG_STORE_DIR="$ROOT/bstore" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
INSTANCES=$(ls node_modules/.pnpm | grep -c '^use-sync-external-store@1.2.2')
if [ "$INSTANCES" -ge 2 ]; then ok "pnpm produced $INSTANCES peer-qualified instances of one package"
else bad "only $INSTANCES instance(s); this cell measures nothing"; fi
echo "        $(ls node_modules/.pnpm | grep '^use-sync-external-store@1.2.2' | tr '\n' ' ')"
OUT=$(prune "$ROOT/b/node_modules" "use-sync-external-store@1.2.2" 2>&1); RC=$?
check "$RC" "0" "the prune verifies${RC:+ ($OUT)}"
LEFT=$(ls node_modules/.pnpm | grep -c '^use-sync-external-store@1.2.2' || true)
check "$LEFT" "0" "every peer-qualified instance is removed"
no_key node_modules/.pnpm/lock.yaml 'use-sync-external-store' \
  "no peer-suffixed lockfile key and no importer edge survives"
# Not a dry run: the retained peer packages are still there.
[ -d node_modules/.pnpm/react@18.2.0 ] && ok "the retained peers survive" || bad "react@18.2.0 went too"

echo; echo "== C. an npm: alias =="
rm -rf "$ROOT/c" "$ROOT/cstore"; mkdir -p "$ROOT/c"; cd "$ROOT/c"
echo '{"name":"c","version":"1.0.0","dependencies":{"pad":"npm:left-pad@1.3.0","semver":"7.6.3"}}' > package.json
PNPM_CONFIG_STORE_DIR="$ROOT/cstore" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
[ -L node_modules/pad ] && ok "the alias link exists before the prune" || bad "no alias link to remove"
OUT=$(prune "$ROOT/c/node_modules" "left-pad@1.3.0" 2>&1); RC=$?
check "$RC" "0" "the prune verifies"
# -L as well as -e: `-e` follows the link, so a SURVIVING dangling link reads as absent.
{ [ -e node_modules/pad ] || [ -L node_modules/pad ]; } && bad "the alias link survives" \
  || ok "the alias link is removed, not left dangling"
grep -q 'left-pad' node_modules/.pnpm/lock.yaml && bad "the carried lockfile still names left-pad" \
  || ok "the aliased importer edge and package entry are gone"
[ -d node_modules/.pnpm/semver@7.6.3 ] && ok "the unrelated dependency survives" || bad "semver went too"
# And the session's own install restores it under the alias.
mkdir -p "$ROOT/cpriv"; OUT=$(PNPM_CONFIG_STORE_DIR="$ROOT/cpriv" pnpm install --ignore-scripts 2>&1); RC=$?
check "$RC" "0" "a bare install over the pruned tree succeeds"
[ -e node_modules/pad/package.json ] && ok "the alias is restored by the session's own install" \
  || bad "the alias was not restored"

echo; echo "== D. an optional, platform-skipped package =="
rm -rf "$ROOT/d" "$ROOT/dstore"; mkdir -p "$ROOT/d"; cd "$ROOT/d"
echo '{"name":"d","version":"1.0.0","dependencies":{"esbuild":"0.21.5"}}' > package.json
PNPM_CONFIG_STORE_DIR="$ROOT/dstore" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
SKIPPED=$(grep -o '@esbuild/darwin-arm64@[0-9.]*' pnpm-lock.yaml | head -1)
if [ -n "$SKIPPED" ] && [ ! -d "node_modules/.pnpm/$(echo "$SKIPPED" | tr '/' '+')" ]; then
  ok "the lockfile pins $SKIPPED and the tree does not carry it"
else bad "no platform-skipped package in this tree; the cell measures nothing"; fi
OUT=$(prune "$ROOT/d/node_modules" "$SKIPPED" 2>&1); RC=$?
check "$RC" "0" "pruning a package with no tree entry verifies"
echo "$OUT" | grep -q '"removedDirs":\[\]' && ok "nothing was removed from the tree" \
  || bad "a tree directory was removed for a package that had none: $OUT"
no_key node_modules/.pnpm/lock.yaml 'darwin-arm64' "its lockfile keys are gone"
# Its incoming edge from esbuild's own snapshot survives on purpose: pnpm relinks those.
grep -q 'darwin-arm64' node_modules/.pnpm/lock.yaml \
  && ok "esbuild's own optional edge to it is left for pnpm to reconcile" \
  || bad "the edge was cut, which would mean pruning transitively"
mkdir -p "$ROOT/dpriv"; PNPM_CONFIG_STORE_DIR="$ROOT/dpriv" pnpm install --ignore-scripts >/dev/null 2>&1
check "$?" "0" "a bare install over it still succeeds"

echo; echo "== E/F. a pruned build-bearing package, both install flags, a drifted consumer =="
# core-js is a real registry package with a postinstall, so this runs pnpm's own build-approval
# path. The base is built the builder's way: whole tree, --ignore-scripts.
rm -rf "$ROOT/e" "$ROOT/estore"; mkdir -p "$ROOT/e"; cd "$ROOT/e"
BASE_MANIFEST='{"name":"probe","version":"1.0.0","dependencies":{"semver":"7.6.3","core-js":"3.39.0"}}'
echo "$BASE_MANIFEST" > package.json
printf 'allowBuilds:\n  core-js@3.39.0: true\n' > pnpm-workspace.yaml
PNPM_CONFIG_STORE_DIR="$ROOT/estore" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
cp pnpm-lock.yaml "$ROOT/baselock.yaml"
PENDING_BEFORE=$(grep -c 'core-js' node_modules/.modules.yaml || true)
STATE=$(ls -a node_modules | grep '^\.pnpm-workspace-state' | head -1)
[ -n "$STATE" ] && cp "node_modules/$STATE" "$ROOT/state.json"
OUT=$(prune "$ROOT/e/node_modules" "core-js@3.39.0" 2>&1); RC=$?
check "$RC" "0" "the prune verifies"
PENDING_AFTER=$(grep -c 'core-js' node_modules/.modules.yaml || true)
if [ "$PENDING_BEFORE" -gt 0 ] && [ "$PENDING_AFTER" -eq "$PENDING_BEFORE" ]; then
  ok "cell F premise: .modules.yaml still names the pruned package ($PENDING_AFTER line(s))"
else bad "expected .modules.yaml to keep naming core-js (before=$PENDING_BEFORE after=$PENDING_AFTER)"; fi
cp -a node_modules "$ROOT/pruned-base"

# Never cd's the caller: every assertion below names "$D" explicitly, because `OUT=$(consume ...)`
# runs in a subshell and a cd inside it would leave the checks reading the previous directory.
#
# And it installs against the store path the BASE RECORDS, emptied — which is what production has
# (`BUILD_STORE_DIR === PNPM_STORE_CONTAINER_PATH`, so a session's own private store sits where
# `.modules.yaml` says). A store at a different path is a mismatch pnpm recovers from by
# recreating the whole tree, and every assertion here would then pass on a full reinstall rather
# than on selective repair (independent review, 2026-09-21).
consume(){ # $1 dir  $2 lockfile  $3 manifest  $4... install flags
  local dir=$1 lock=$2 manifest=$3; shift 3
  rm -rf "$dir"; mkdir -p "$dir"
  rm -rf "$ROOT/estore"; mkdir -p "$ROOT/estore"
  echo "$manifest" > "$dir/package.json"; cp "$lock" "$dir/pnpm-lock.yaml"
  printf 'allowBuilds:\n  core-js@3.39.0: true\n' > "$dir/pnpm-workspace.yaml"
  cp -a "$ROOT/pruned-base" "$dir/node_modules"
  retained_ino "$dir" > "$dir.ino"
  (cd "$dir" && PNPM_CONFIG_STORE_DIR="$ROOT/estore" pnpm install "$@" 2>&1)
}
# The retained package's own file, by inode: "shared" has to mean these bytes survived the
# install, not that a directory of the same name exists after a full reinstall.
retained_ino(){ stat -c %i "$1/node_modules/.pnpm/semver@7.6.3/node_modules/semver/package.json" 2>/dev/null || echo none; }

echo "-- F1. a BARE install over the pruned base"
D="$ROOT/f1"; OUT=$(consume "$D" "$ROOT/baselock.yaml" "$BASE_MANIFEST"); RC=$?
check "$RC" "0" "rc"
[ -d "$D/node_modules/.pnpm/core-js@3.39.0" ] && ok "the pruned package is re-imported" || bad "still missing"
node -e "require('$D/node_modules/core-js/package.json')" 2>/dev/null \
  && ok "it resolves from the importer view" || bad "the importer link was not restored"
echo "$OUT" | grep -qi 'core-js.*postinstall\|postinstall.*core-js' && ok "its install script RAN" \
  || bad "its install script did not run"
echo "$OUT" | grep -qi 'pendingBuilds' && bad "pnpm complained about pendingBuilds" \
  || ok "the stale pendingBuilds entry drew no error"
[ -d "$D/node_modules/.pnpm/semver@7.6.3" ] && ok "the shared remainder survives" || bad "the base was recreated"
BEFORE_INO=$(cat "$D.ino"); AFTER_INO=$(retained_ino "$D")
if [ "$BEFORE_INO" != none ] && [ "$BEFORE_INO" = "$AFTER_INO" ]; then
  ok "the retained package was neither downloaded nor replaced (same inode; store now $(find "$ROOT/estore" -type f 2>/dev/null | wc -l) files)"
else bad "the retained package was rewritten ($BEFORE_INO -> $AFTER_INO): this was a reinstall, not selective repair"; fi

echo "-- F2. a FROZEN install over the same pruned base"
D="$ROOT/f2"; OUT=$(consume "$D" "$ROOT/baselock.yaml" "$BASE_MANIFEST" --frozen-lockfile); RC=$?
check "$RC" "0" "rc"
[ -d "$D/node_modules/.pnpm/core-js@3.39.0" ] && ok "the pruned package is re-imported" || bad "still missing"
echo "$OUT" | grep -qi 'pendingBuilds' && bad "pnpm complained about pendingBuilds" \
  || ok "the stale pendingBuilds entry drew no error under --frozen-lockfile too"
echo "$OUT" | grep -qi 'core-js.*postinstall\|postinstall.*core-js' && ok "its install script RAN here too" \
  || bad "the frozen install did not run the script"

echo "-- E. a consumer whose lockfile DIFFERS from the publisher's commit"
# The realistic drift: the session's branch adds a dependency the base was never built with.
rm -rf "$ROOT/drift" "$ROOT/driftstore"; mkdir -p "$ROOT/drift" "$ROOT/driftstore"; cd "$ROOT/drift"
DRIFT_MANIFEST='{"name":"probe","version":"1.0.0","dependencies":{"semver":"7.6.3","core-js":"3.39.0","left-pad":"1.3.0"}}'
echo "$DRIFT_MANIFEST" > package.json
printf 'allowBuilds:\n  core-js@3.39.0: true\n' > pnpm-workspace.yaml
PNPM_CONFIG_STORE_DIR="$ROOT/driftstore" pnpm install --lockfile-only --no-frozen-lockfile >/dev/null 2>&1
cp pnpm-lock.yaml "$ROOT/driftlock.yaml"
D="$ROOT/e2"; OUT=$(consume "$D" "$ROOT/driftlock.yaml" "$DRIFT_MANIFEST"); RC=$?
check "$RC" "0" "a bare install with a drifted lockfile over the pruned base"
[ -d "$D/node_modules/.pnpm/core-js@3.39.0" ] && ok "the pruned package is re-imported" || bad "still missing"
echo "$OUT" | grep -qi 'core-js.*postinstall\|postinstall.*core-js' && ok "its install script RAN" \
  || bad "its install script did not run"
[ -d "$D/node_modules/.pnpm/left-pad@1.3.0" ] && ok "the added dependency installs" || bad "left-pad missing"
[ -d "$D/node_modules/.pnpm/semver@7.6.3" ] && ok "the shared remainder survives the drift" || bad "the base was recreated"

echo; echo "== G. the carried install state, which hides the prune entirely =="
# Found by this harness, not by the design: pnpm writes `.pnpm-workspace-state-v1.json` beside
# the tree and short-circuits on its `lastValidatedTimestamp` versus the project files' mtimes,
# BEFORE it reads the carried lockfile. The base carries the BUILDER's clock, so a session whose
# checkout predates the build gets "Already up to date" and keeps the hole. `prunePnpmBase`
# removes it; the control here is the same tree with it put back.
[ -n "$STATE" ] && ok "the builder's own tree carries $STATE" || bad "no install-state file to test"
PRUNED_STATE=$(ls -a "$ROOT/e/node_modules" | grep -c '^\.pnpm-workspace-state' || true)
check "$PRUNED_STATE" "0" "the prune removed it from the tree it publishes"

state_arm(){ # $1 dir  $2 "restore"|"drop"
  local dir=$1
  rm -rf "$dir" "${dir}store"; mkdir -p "$dir" "${dir}store"
  echo "$BASE_MANIFEST" > "$dir/package.json"; cp "$ROOT/baselock.yaml" "$dir/pnpm-lock.yaml"
  printf 'allowBuilds:\n  core-js@3.39.0: true\n' > "$dir/pnpm-workspace.yaml"
  cp -a "$ROOT/e/node_modules" "$dir/node_modules"
  if [ "$2" = restore ]; then
    # The production shape: the builder's project dir IS the session's (/workspace), so the
    # state file names the consuming project. Rewriting the key is what makes the control
    # faithful rather than generous — pnpm ignores a state file naming a foreign project.
    node -e "const fs=require('fs');const p='$dir/node_modules/$STATE';const s=JSON.parse(fs.readFileSync('$ROOT/state.json','utf8'));s.projects={['$dir']:Object.values(s.projects)[0]};fs.writeFileSync(p,JSON.stringify(s))"
  fi
  # The checkout predates the build, which is the whole condition.
  touch -d '1 hour ago' "$dir/package.json" "$dir/pnpm-lock.yaml" "$dir/pnpm-workspace.yaml"
  (cd "$dir" && PNPM_CONFIG_STORE_DIR="${dir}store" pnpm install 2>&1)
}

D="$ROOT/g-control"; OUT=$(state_arm "$D" restore)
if echo "$OUT" | grep -qi 'already up to date' && [ ! -d "$D/node_modules/.pnpm/core-js@3.39.0" ]; then
  ok "control: with the state file back, pnpm short-circuits and the hole SURVIVES"
else bad "control did not reproduce the short-circuit: $(echo "$OUT" | tail -2 | tr '\n' ' ')"; fi
D="$ROOT/g-fixed"; OUT=$(state_arm "$D" drop)
echo "$OUT" | grep -qi 'already up to date' && bad "the fixed arm still short-circuited" \
  || ok "with it dropped, the same tree and the same mtimes do the work"
[ -d "$D/node_modules/.pnpm/core-js@3.39.0" ] && ok "the pruned package is re-imported" || bad "still missing"
echo "$OUT" | grep -qi 'core-js.*postinstall\|postinstall.*core-js' && ok "its install script RAN" \
  || bad "its install script did not run"

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
