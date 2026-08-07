#!/usr/bin/env python3
"""Pass A — create every exported Linear issue in the planning repository.

Renders exactly the format signed off at human gate 1 (docs/247 plan.md → "The
copy format, as piloted"), in ascending key order (req 12), strictly sequential,
halting on the first failure rather than skipping it.

Cross-references are deliberately left in their original `SHI-N` form; Pass B
rewrites them once this pass has produced the mapping.

  --dry-run   render and validate everything, write nothing
  --limit N   stop after N issues (for a bounded live run)

The mapping is appended one line at a time as each number comes back, so an
interrupted run leaves a truthful partial mapping rather than nothing.
"""
import json, glob, os, re, subprocess, sys, time

EXPORT = "/persist/linear-export/raw"
MAPPING = "/persist/pilot/mapping.tsv"
TRACKER = "planning"

# Linear workflow state type -> GitHub open/closed. Req 8 lets these collapse.
CLOSED_TYPES = {"completed", "canceled", "duplicate"}
OPEN_TYPES = {"backlog", "unstarted", "started"}

PRIORITY_LABEL = {"Urgent": "priority: urgent", "High": "priority: high",
                  "Medium": "priority: medium", "Low": "priority: low"}


def sh(args, stdin=None):
    r = subprocess.run(args, capture_output=True, text=True, input=stdin)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def issue_keys():
    ps = glob.glob(f"{EXPORT}/SHI-*.json")
    return sorted(ps, key=lambda p: int(re.search(r"SHI-(\d+)", os.path.basename(p)).group(1)))


def render(d):
    """The gate-1 format: one header line, a rule, then the body verbatim."""
    key = d["identifier"].split("#")[-1]
    created = d["createdAt"][:10]
    header = f"> Migrated from Linear **{key}**, created {created}."
    parent = d.get("parentIdentifier")
    if parent:
        header += f" Sub-issue of {parent.split('#')[-1]}."
    body = (d.get("description") or "").strip()
    # 27 issues have no description at all. Emitting the rule anyway leaves a
    # header followed by a dangling divider and nothing under it.
    return f"{header}\n\n---\n\n{body}" if body else header


def labels_for(d):
    out = [l["name"] for l in (d.get("labels") or [])]
    pr = d.get("priority") or {}
    lab = PRIORITY_LABEL.get(pr.get("label") if isinstance(pr, dict) else pr)
    if lab:
        out.append(lab)
    return out


def valid_labels():
    j = json.loads(sh(["shipit", "issue", "labels", "--tracker", TRACKER, "--json"]))
    ls = j if isinstance(j, list) else j.get("labels", j)
    return {l["name"].lower() for l in ls}


def main():
    dry = "--dry-run" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    known = valid_labels()
    done = set()
    if os.path.exists(MAPPING):
        done = {l.split("\t")[0] for l in open(MAPPING) if l.strip()}
        print(f"resuming — {len(done)} already created")

    paths = issue_keys()
    problems = []
    n = 0
    for p in paths:
        d = json.load(open(p))
        key = d["identifier"].split("#")[-1]
        if key in done:
            continue
        body = render(d)
        labs = labels_for(d)
        st = d["status"]["type"]

        # Validate before writing anything.
        if not d["title"].strip():
            problems.append(f"{key}: empty title")
        for l in labs:
            if l.lower() not in known:
                problems.append(f"{key}: unknown label {l!r}")
        if st not in CLOSED_TYPES | OPEN_TYPES:
            problems.append(f"{key}: unmapped status type {st!r}")
        if not body.startswith("> Migrated from Linear **" + key):
            problems.append(f"{key}: header malformed")

        n += 1
        if dry:
            if limit and n <= 3:
                print(f"--- {key} ({st}, labels={labs}) ---\n{body[:220]}\n")
            if limit and n >= limit:
                break
            continue

        args = ["shipit", "issue", "create", "--tracker", TRACKER,
                "--title", d["title"], "--body-file", "-"]
        for l in labs:
            args += ["--label", l]
        out = sh(args, stdin=body)
        m = re.search(r"created planning#(\d+)", out)
        if not m:
            raise RuntimeError(f"{key}: could not read the new number from:\n{out}")
        num = int(m.group(1))
        with open(MAPPING, "a") as f:          # append as it comes back
            f.write(f"{key}\t{num}\n")
        if st in CLOSED_TYPES:
            sh(["shipit", "issue", "status", f"{TRACKER}#{num}", "completed"])
        print(f"{key} -> planning#{num}{' (closed)' if st in CLOSED_TYPES else ''}", flush=True)
        time.sleep(1.0)                        # pacing, see plan.md
        if limit and n >= limit:
            break

    print(f"\n{'validated' if dry else 'created'}: {n}")
    if problems:
        print(f"PROBLEMS ({len(problems)}):")
        for x in problems[:40]:
            print("  ", x)
        sys.exit(1)
    print("no problems")


if __name__ == "__main__":
    main()
