#!/usr/bin/env bash
# Measurements for "Sharing for ineligible repos" (docs/276 plan.md section 5, planning#414).
#
# Runs entirely INSIDE a session container: every cell here is about what pnpm itself does,
# which needs no Docker and no overlayfs. The overlay/uid half — that a chmod on a base file
# EPERMs for the session's own uid — is `build-cost-spike.sh` on the services host; this
# harness names the files pnpm chmods so the two can be read together.
#
# Cells, each hard-asserted:
#   A  pnpm chmods a bin target UNCONDITIONALLY, even when the mode already matches.
#   B  a true base hit chmods nothing.
#   C  `pnpm add` over a base hit chmods BASE files (the req 9 exposure).
#   D  an edit inside a base package plus an install chmods nothing (req 11 is safe).
#   E  a hole in the base tree alone is NOT refilled — pnpm reports "Already up to date".
#   F  pruning the tree AND the carried `.pnpm/lock.yaml` gives a TARGETED re-import, and the
#      pruned package's install script RUNS.
#   G  `--ignore-pnpmfile` suppresses a `.pnpmfile.mjs` body and hook.
#   H  a `workspace:` edge resolves under `--frozen-lockfile --offline` with only manifests staged.
#   I  `patchedDependencies` applies under `--ignore-scripts --ignore-pnpmfile`.
#   J  pnpm links (and chmods) executables from `directories.bin` with NO `bin` field — so a
#      seed list built from `bin` alone misses them.
#   K  a RETAINED package that depends on a PRUNED one still reconciles: the graph case most
#      likely to break the prune.
#
# Usage: bash ineligible-sharing-spike.sh    (needs network for the registry packages)

set -u
ROOT=${ROOT:-/tmp/ineligible-sharing-spike}
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3 ($1)"; else bad "$3: expected '$2', got '$1'"; fi; }

command -v pnpm >/dev/null || { echo "pnpm is required"; exit 1; }
command -v gcc  >/dev/null || { echo "gcc is required (the chmod interposer)"; exit 1; }
echo "pnpm $(pnpm --version)  node $(node --version)"

rm -rf "$ROOT"; mkdir -p "$ROOT"
export PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy

# ---------------------------------------------------------------- chmod interposer
# pnpm 12's installer is a native binary, so the call is measured rather than read. It is
# dynamically linked, so LD_PRELOAD reaches its libc chmod/fchmodat.
cat > "$ROOT/chmodspy.c" <<'EOF'
#define _GNU_SOURCE
#include <stdio.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdlib.h>
static FILE *out(void){ static FILE *f; if(!f){ const char*p=getenv("CHMOD_LOG"); f=fopen(p?p:"/dev/null","a"); } return f; }
int chmod(const char *path, mode_t mode){
  static int (*real)(const char*, mode_t); if(!real) real=dlsym(RTLD_NEXT,"chmod");
  struct stat st; int had=(stat(path,&st)==0); int rc=real(path,mode);
  FILE*f=out(); if(f){ fprintf(f,"%s %04o %04o %d\n", path, mode&07777, had?(st.st_mode&07777):0, rc); fflush(f);} return rc; }
int fchmodat(int fd, const char *path, mode_t mode, int flags){
  static int (*real)(int,const char*,mode_t,int); if(!real) real=dlsym(RTLD_NEXT,"fchmodat");
  struct stat st; int had=(fstatat(fd,path,&st,0)==0); int rc=real(fd,path,mode,flags);
  FILE*f=out(); if(f){ fprintf(f,"%s %04o %04o %d\n", path, mode&07777, had?(st.st_mode&07777):0, rc); fflush(f);} return rc; }
EOF
gcc -shared -fPIC -o "$ROOT/chmodspy.so" "$ROOT/chmodspy.c" -ldl 2>/dev/null || { echo "interposer build failed"; exit 1; }
SPY="$ROOT/chmodspy.so"

# ---------------------------------------------------------------- a base, built the builder's way
# One store PATH string throughout: pnpm records storeDir in .modules.yaml and a different path
# makes it recreate the tree, which would confound every cell below.
STORE="$ROOT/store"
MANIFEST='{"name":"probe","version":"1.0.0","dependencies":{"semver":"7.6.3","rimraf":"5.0.10"}}'
mkdir -p "$ROOT/base" "$STORE"; cd "$ROOT/base"
echo "$MANIFEST" > package.json
PNPM_CONFIG_STORE_DIR="$STORE" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
cp pnpm-lock.yaml "$ROOT/lock.yaml"
mv "$STORE" "$ROOT/basestore"; mkdir -p "$STORE"   # the session's private store starts EMPTY

newsess(){ rm -rf "$ROOT/$1"; mkdir -p "$ROOT/$1"; cd "$ROOT/$1"
  echo "$MANIFEST" > package.json; cp "$ROOT/lock.yaml" pnpm-lock.yaml
  cp -a "$ROOT/base/node_modules" ./node_modules; }
# How many of the chmod targets are files the BASE also has, i.e. overlay lower files.
lower_count(){ local log=$1 sess=$2 n=0
  [ -s "$log" ] || { echo 0; return; }
  while read -r f _; do rel=${f#"$ROOT/$sess/"}; [ -e "$ROOT/base/$rel" ] && n=$((n+1)); done \
    < <(awk '{print $1}' "$log" | sort -u | sed 's/$/ x/')
  echo $n; }

echo; echo "== A. is the bin chmod conditional on the mode? =="
newsess a; rm -f "$ROOT/a.log"
CHMOD_LOG="$ROOT/a.log" LD_PRELOAD=$SPY PNPM_CONFIG_STORE_DIR="$STORE" pnpm install --force --frozen-lockfile >/dev/null 2>&1
# A chmod whose recorded "was" mode equals its target mode is one pnpm did not need to make.
NOOP=$(awk '$2==$3' "$ROOT/a.log" 2>/dev/null | wc -l)
if [ "$NOOP" -gt 0 ]; then ok "chmod is UNCONDITIONAL: $NOOP call(s) set a mode the file already had"
else bad "no redundant chmod seen — the mode-matching repair may be viable after all"; fi

echo; echo "== B. a true base hit =="
newsess b; rm -f "$ROOT/b.log"; : > "$ROOT/b.log"
CHMOD_LOG="$ROOT/b.log" LD_PRELOAD=$SPY PNPM_CONFIG_STORE_DIR="$STORE" pnpm install --frozen-lockfile >/dev/null 2>&1
check "$(wc -l < "$ROOT/b.log")" "0" "base hit makes no chmod call"

echo; echo "== C. pnpm add over a base hit (req 9) =="
newsess c; : > "$ROOT/c.log"
PNPM_CONFIG_STORE_DIR="$STORE" pnpm install --frozen-lockfile >/dev/null 2>&1
CHMOD_LOG="$ROOT/c.log" LD_PRELOAD=$SPY PNPM_CONFIG_STORE_DIR="$STORE" pnpm add left-pad >/dev/null 2>&1
CN=$(awk '{print $1}' "$ROOT/c.log" | sort -u | wc -l); CL=$(lower_count "$ROOT/c.log" c)
if [ "$CL" -gt 0 ]; then ok "pnpm add chmods $CL of $CN targets that are BASE files — EPERM for a non-owner"
else bad "pnpm add chmodded no base file; the req 9 exposure does not reproduce"; fi
awk '{print $1}' "$ROOT/c.log" | sort -u | sed "s|$ROOT/c/|        |"

echo; echo "== D. an edit inside a base package, then install (req 11) =="
newsess d; : > "$ROOT/d.log"
PNPM_CONFIG_STORE_DIR="$STORE" pnpm install --frozen-lockfile >/dev/null 2>&1
echo "// edited" >> node_modules/.pnpm/semver@7.6.3/node_modules/semver/index.js
CHMOD_LOG="$ROOT/d.log" LD_PRELOAD=$SPY PNPM_CONFIG_STORE_DIR="$STORE" pnpm install --frozen-lockfile >/dev/null 2>&1
check "$(wc -l < "$ROOT/d.log")" "0" "an edit plus an install makes no chmod call"

echo; echo "== E. a hole in the tree alone is repaired only under --frozen-lockfile =="
# Both arms run in ONE directory, so the install flag is the only thing that differs.
newsess e; PNPM_CONFIG_STORE_DIR="$STORE" pnpm install --frozen-lockfile >/dev/null 2>&1
rm -rf node_modules/.pnpm/rimraf@5.0.10
OUT=$(PNPM_CONFIG_STORE_DIR="$STORE" pnpm install 2>&1)
if [ -d node_modules/.pnpm/rimraf@5.0.10 ]; then bad "a bare install repaired the hole — the flag does not decide it"
else ok "a bare install does NOT repair it ($(echo "$OUT" | grep -io 'already up to date' | head -1))"; fi
rm -rf node_modules/.pnpm/rimraf@5.0.10
PNPM_CONFIG_STORE_DIR="$STORE" pnpm install --frozen-lockfile >/dev/null 2>&1
[ -d node_modules/.pnpm/rimraf@5.0.10 ] && ok "--frozen-lockfile DOES repair it" || bad "--frozen-lockfile left the hole"
# A transitive-only package has no importer link, so it is the case a link check would miss.
rm -rf node_modules/.pnpm/glob@10.5.0
PNPM_CONFIG_STORE_DIR="$STORE" pnpm install --frozen-lockfile >/dev/null 2>&1
[ -d node_modules/.pnpm/glob@10.5.0 ] && ok "a transitive-only hole is repaired too" || bad "a transitive-only hole was left"

echo; echo "== F. tree AND carried lockfile pruned: targeted re-import + the script runs =="
# core-js is a real registry package carrying a postinstall, so this exercises pnpm's own
# build-approval path rather than a synthetic one.
FM='{"name":"probe","version":"1.0.0","dependencies":{"semver":"7.6.3","core-js":"3.39.0"}}'
rm -rf "$ROOT/fbase" "$ROOT/fstore" "$ROOT/f"; mkdir -p "$ROOT/fbase" "$ROOT/fstore"; cd "$ROOT/fbase"
echo "$FM" > package.json
PNPM_CONFIG_STORE_DIR="$ROOT/fstore" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
cp pnpm-lock.yaml "$ROOT/flock.yaml"
rm -rf node_modules/.pnpm/core-js@3.39.0 node_modules/core-js
node - "$ROOT/fbase/node_modules/.pnpm/lock.yaml" core-js <<'EOF'
const fs=require('fs'), YAML=require('/workspace/node_modules/yaml');
const [p,drop]=process.argv.slice(2); const d=YAML.parse(fs.readFileSync(p,'utf8'));
for(const imp of Object.values(d.importers||{}))
  for(const g of ['dependencies','devDependencies','optionalDependencies']) if(imp[g]) delete imp[g][drop];
for(const s of ['packages','snapshots'])
  for(const k of Object.keys(d[s]||{})) if(k.startsWith(drop+'@')) delete d[s][k];
fs.writeFileSync(p, YAML.stringify(d));
EOF
mkdir -p "$ROOT/f" "$ROOT/fpriv"; cd "$ROOT/f"
echo "$FM" > package.json; cp "$ROOT/flock.yaml" pnpm-lock.yaml
printf 'allowBuilds:\n  core-js@3.39.0: true\n' > pnpm-workspace.yaml
cp -a "$ROOT/fbase/node_modules" ./node_modules
BEFORE=$(find node_modules -type f | wc -l)
# A BARE `pnpm install` deliberately: that is what a repo's own `agent.install` usually is, and
# cell E showed a bare install short-circuits on a tree-only hole. A pruned CARRIED lockfile is
# what makes the delta visible to pnpm whatever flags the repo passes.
OUT=$(PNPM_CONFIG_STORE_DIR="$ROOT/fpriv" pnpm install 2>&1); RC=$?
check "$RC" "0" "the pruned-base install succeeds under a bare 'pnpm install'"
diff -q pnpm-lock.yaml "$ROOT/flock.yaml" >/dev/null \
  && ok "the session's own pnpm-lock.yaml is unchanged" || bad "the session's lockfile was rewritten"
[ -d node_modules/.pnpm/core-js@3.39.0 ] && ok "the pruned package is re-imported" || bad "the pruned package is still missing"
echo "$OUT" | grep -q "core-js postinstall" && ok "its install script RAN" || bad "its install script did not run"
[ -d node_modules/.pnpm/semver@7.6.3 ] && ok "the rest of the base survives (semver still present)" || bad "the base was recreated"
echo "        files $BEFORE -> $(find node_modules -type f | wc -l); private store $(find "$ROOT/fpriv" -type f 2>/dev/null | wc -l) files"

echo; echo "== G. .pnpmfile.mjs suppression =="
rm -rf "$ROOT/mjs" "$ROOT/mjsstore"; mkdir -p "$ROOT/mjs"; cd "$ROOT/mjs"
echo '{"name":"m","version":"1.0.0","type":"module","dependencies":{"is-odd":"3.0.1"}}' > package.json
cat > .pnpmfile.mjs <<EOF
import fs from 'node:fs';
fs.writeFileSync('$ROOT/MJS_BODY','1');
export const hooks = { readPackage(p){ fs.writeFileSync('$ROOT/MJS_HOOK','1'); return p; } };
EOF
rm -f "$ROOT/MJS_BODY" "$ROOT/MJS_HOOK"
PNPM_CONFIG_STORE_DIR="$ROOT/mjsstore" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
[ -f "$ROOT/MJS_BODY" ] && [ -f "$ROOT/MJS_HOOK" ] && ok "control: the .mjs body and hook DO run without the flag" \
  || bad "control failed — the hook never ran, so suppression below proves nothing"
rm -rf node_modules "$ROOT/mjsstore" pnpm-lock.yaml; rm -f "$ROOT/MJS_BODY" "$ROOT/MJS_HOOK"
PNPM_CONFIG_STORE_DIR="$ROOT/mjsstore" pnpm install --no-frozen-lockfile --ignore-scripts --ignore-pnpmfile >/dev/null 2>&1
[ ! -f "$ROOT/MJS_BODY" ] && [ ! -f "$ROOT/MJS_HOOK" ] && ok "--ignore-pnpmfile suppresses both" \
  || bad "--ignore-pnpmfile did not suppress the .mjs hook"

echo; echo "== H. a workspace: edge, manifests only, frozen + offline =="
rm -rf "$ROOT/ws" "$ROOT/wsstore"; mkdir -p "$ROOT/ws/packages/lib" "$ROOT/ws/packages/app"; cd "$ROOT/ws"
printf 'packages:\n  - packages/*\n' > pnpm-workspace.yaml
echo '{"name":"root","version":"1.0.0","private":true}' > package.json
echo '{"name":"@w/lib","version":"1.0.0","main":"index.js"}' > packages/lib/package.json
echo '{"name":"@w/app","version":"1.0.0","dependencies":{"@w/lib":"workspace:*","semver":"7.6.3"}}' > packages/app/package.json
# No packages/lib/index.js on purpose: the builder stages every package.json, never member source.
PNPM_CONFIG_STORE_DIR="$ROOT/wsstore" pnpm install --no-frozen-lockfile --ignore-scripts --ignore-pnpmfile >/dev/null 2>&1
rm -rf node_modules packages/app/node_modules packages/lib/node_modules
PNPM_CONFIG_STORE_DIR="$ROOT/wsstore" pnpm install --frozen-lockfile --offline --ignore-scripts --ignore-pnpmfile --registry http://127.0.0.1:1/ >/dev/null 2>&1
check "$?" "0" "frozen + offline install with a workspace: edge"
LNK=$(readlink packages/app/node_modules/@w/lib 2>/dev/null || echo MISSING)
case "$LNK" in /*) bad "the workspace link is ABSOLUTE ($LNK) — it would not move with the checkout";;
  MISSING) bad "the workspace link is missing";;
  *) ok "the workspace link is relative ($LNK), so it resolves in the consuming checkout";; esac
[ -d node_modules/.pnpm/semver@7.6.3 ] && ok "registry deps install alongside it" || bad "registry deps missing"

echo; echo "== I. patchedDependencies under the builder posture =="
rm -rf "$ROOT/pt" "$ROOT/ptedit" "$ROOT/ptstore"; mkdir -p "$ROOT/pt"; cd "$ROOT/pt"
echo '{"name":"p","version":"1.0.0","dependencies":{"is-odd":"3.0.1"}}' > package.json
PNPM_CONFIG_STORE_DIR="$ROOT/ptstore" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
PNPM_CONFIG_STORE_DIR="$ROOT/ptstore" pnpm patch is-odd@3.0.1 --edit-dir "$ROOT/ptedit" >/dev/null 2>&1
printf '// PATCHED MARKER\n' | cat - "$ROOT/ptedit/index.js" > "$ROOT/ptedit/index.js.n" && mv "$ROOT/ptedit/index.js.n" "$ROOT/ptedit/index.js"
PNPM_CONFIG_STORE_DIR="$ROOT/ptstore" pnpm patch-commit "$ROOT/ptedit" >/dev/null 2>&1
rm -rf node_modules "$ROOT/ptstore" pnpm-lock.yaml
PNPM_CONFIG_STORE_DIR="$ROOT/ptstore" pnpm install --no-frozen-lockfile --ignore-scripts --ignore-pnpmfile >/dev/null 2>&1
grep -rlq "PATCHED MARKER" node_modules/.pnpm/is-odd*/node_modules/is-odd/index.js 2>/dev/null \
  && ok "the committed patch is applied by the builder's own flags" || bad "the patch was not applied"
printf 'not a patch\n' > patches/is-odd@3.0.1.patch
rm -rf node_modules "$ROOT/ptstore"
# Assert WHICH check fired: a nonzero exit alone would also be produced by an unrelated failure.
OUT=$(PNPM_CONFIG_STORE_DIR="$ROOT/ptstore" pnpm install --no-frozen-lockfile --ignore-scripts --ignore-pnpmfile 2>&1); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -qi 'patch'; then ok "an unparseable patch fails the install closed, naming the patch"
else bad "expected a patch-named failure; rc=$RC, output: $(echo "$OUT" | tail -1)"; fi

echo; echo "== J. executables discovered through directories.bin =="
# Found by an independent review of the design and measured here: a seed list keyed on
# `package.json#bin` would skip these, and pnpm still chmods them when it links.
rm -rf "$ROOT/db"; mkdir -p "$ROOT/db/pkg/tools" "$ROOT/db/proj"; cd "$ROOT/db"
printf '{"name":"dirbin-probe","version":"1.0.0","directories":{"bin":"tools"}}\n' > pkg/package.json
printf '#!/usr/bin/env node\nconsole.log("hi")\n' > pkg/tools/dirbin-cmd; chmod 644 pkg/tools/dirbin-cmd
cd proj; echo '{"name":"p","version":"1.0.0","dependencies":{"dirbin-probe":"file:../pkg"}}' > package.json
: > "$ROOT/j.log"
CHMOD_LOG="$ROOT/j.log" LD_PRELOAD=$SPY PNPM_CONFIG_STORE_DIR="$ROOT/dbstore" \
  pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
[ -e node_modules/.bin/dirbin-cmd ] && ok "pnpm created a shim for a directories.bin executable" \
  || bad "no shim — pnpm does not honour directories.bin, and the seed list may key on bin alone"
grep -q 'tools/dirbin-cmd' "$ROOT/j.log" \
  && ok "and it CHMODS the package file, which a bin-only seed list would miss" \
  || bad "the directories.bin target was not chmodded"

echo; echo "== K. a retained package depending on a pruned one =="
# vite -> esbuild: the real shape planning#604's exclusion is widest on. esbuild is the GRAPH probe
# only — its binary ships in an optional dependency, so it is useless as a build probe.
rm -rf "$ROOT/vb" "$ROOT/vbs" "$ROOT/vs" "$ROOT/vpriv"
mkdir -p "$ROOT/vb" "$ROOT/vs"; cd "$ROOT/vb"
VM='{"name":"probe","version":"1.0.0","dependencies":{"vite":"5.4.11"}}'
echo "$VM" > package.json
PNPM_CONFIG_STORE_DIR="$ROOT/vbs" pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1
cp pnpm-lock.yaml "$ROOT/vlock.yaml"
ESB=$(ls -d node_modules/.pnpm/esbuild@* 2>/dev/null | head -1)
[ -n "$ESB" ] && ok "the base carries esbuild, which vite depends on" || bad "no esbuild in the tree"
rm -rf "$ESB" node_modules/.pnpm/node_modules/esbuild
node - "$ROOT/vb/node_modules/.pnpm/lock.yaml" esbuild <<'EOF'
const fs=require('fs'), YAML=require('/workspace/node_modules/yaml');
const [p,drop]=process.argv.slice(2); const d=YAML.parse(fs.readFileSync(p,'utf8'));
for(const i of Object.values(d.importers||{}))
  for(const g of ['dependencies','devDependencies','optionalDependencies']) if(i[g]) delete i[g][drop];
for(const s of ['packages','snapshots'])
  for(const k of Object.keys(d[s]||{})) if(k.startsWith(drop+'@')) delete d[s][k];
fs.writeFileSync(p, YAML.stringify(d));
EOF
EDGES=$(grep -c 'esbuild' node_modules/.pnpm/lock.yaml)
cd "$ROOT/vs"; echo "$VM" > package.json; cp "$ROOT/vlock.yaml" pnpm-lock.yaml
cp -a "$ROOT/vb/node_modules" ./node_modules
# Without an approval pnpm exits 1 on its "Ignored build scripts" notice — its own default, the
# same as a no-base install of this repo — so approve, or rc would measure that instead.
printf 'allowBuilds:\n  esbuild@0.21.5: true\n' > pnpm-workspace.yaml
PNPM_CONFIG_STORE_DIR="$ROOT/vpriv" pnpm install >/dev/null 2>&1
check "$?" "0" "a bare install over the pruned base succeeds ($EDGES incoming edges still name esbuild)"
[ -d "$(ls -d node_modules/.pnpm/esbuild@* 2>/dev/null | head -1)" ] && ok "esbuild re-imported" || bad "esbuild not restored"
LNK=$(readlink node_modules/.pnpm/vite@5.4.11/node_modules/esbuild 2>/dev/null || echo MISSING)
[ "$LNK" != MISSING ] && ok "the RETAINED vite has its edge to esbuild relinked ($LNK)" || bad "vite's edge to esbuild is dangling"
node -e "require('$ROOT/vs/node_modules/vite')" >/dev/null 2>&1 && ok "require('vite') loads" || bad "vite does not load"

echo; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
