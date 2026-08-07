#!/usr/bin/env python3
"""Pass B — replay comments and rewrite every reference, from Pass A's mapping.

Three distinct rewrites, applied to issue bodies, comment bodies and the five
titles that carry a reference (docs/247 plan.md → Pass B):

  1. Linear issue references  ->  planning#M, from the mapping
     - `[SHI-31](https://linear.app/ws/issue/SHI-31/slug)`  as a UNIT (the key
       appears in both the label and the URL; rewriting them independently
       yields a live link to a dead system wearing the right name)
     - a bare `https://linear.app/ws/issue/SHI-31/slug` URL
     - a bare `SHI-31`
  2. Bare `#1354`  ->  `nikzlabs/shipit#1354`, because inside the planning repo
     a bare number points here rather than at the source repo.
  3. Nothing else. Non-issue linear.app URLs (uploads, docs, Slack, design
     reviews) have no key to map and are left alone.

Two things are deliberately NOT rewritten:
  - the body's migration header, whose own `SHI-N` is the origin marker req 9
    requires. Rewriting it would point the issue at itself.
  - anything inside fenced or inline code, where `#1354` is usually a shell
    comment or a literal, not a reference.

  --dry-run   compute every rewrite and print a summary, write nothing
  --diff KEY  show the before/after for one issue's body and comments
"""
import json, glob, os, re, subprocess, sys, time

EXPORT = "/persist/linear-export/raw"
MAPPING = "/persist/pilot/mapping.tsv"
DONE = "/persist/pilot/pass-b-done.tsv"
TRACKER = "planning"
SOURCE_REPO = "nikzlabs/shipit"

MD_LINK = re.compile(r"\[([^\]]*)\]\((https://linear\.app/[^/\s]+/issue/([A-Z]+-\d+)[^\s)]*)\)")
BARE_URL = re.compile(r"(?<!\()https://linear\.app/[^/\s]+/issue/([A-Z]+-\d+)[^\s)]*")
BARE_KEY = re.compile(r"(?<![\w-])(SHI-\d+)(?![\w-])")
BARE_NUM = re.compile(r"(?<![\w/#])#(\d+)(?![\w])")
CODE = re.compile(r"```.*?```|`[^`\n]*`", re.S)


def sh(args, stdin=None):
    r = subprocess.run(args, capture_output=True, text=True, input=stdin)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def load_mapping():
    m = {}
    for line in open(MAPPING):
        if line.strip():
            k, v = line.split("\t")
            m[k] = int(v)
    return m


def rewrite(text, mapping):
    """Apply all three rewrites outside code spans. Returns (text, counts)."""
    counts = {"key": 0, "url": 0, "num": 0}

    def apply(seg):
        def md(m):
            n = mapping.get(m.group(3))
            if n is None:
                return m.group(0)
            counts["url"] += 1
            return f"{TRACKER}#{n}"
        seg = MD_LINK.sub(md, seg)

        def url(m):
            n = mapping.get(m.group(1))
            if n is None:
                return m.group(0)
            counts["url"] += 1
            return f"{TRACKER}#{n}"
        seg = BARE_URL.sub(url, seg)

        def num(m):
            counts["num"] += 1
            return f"{SOURCE_REPO}#{m.group(1)}"
        seg = BARE_NUM.sub(num, seg)

        def key(m):
            n = mapping.get(m.group(1))
            if n is None:
                return m.group(0)
            counts["key"] += 1
            return f"{TRACKER}#{n}"
        return BARE_KEY.sub(key, seg)

    out, last = [], 0
    for m in CODE.finditer(text):          # leave code spans untouched
        out.append(apply(text[last:m.start()]))
        out.append(m.group(0))
        last = m.end()
    out.append(apply(text[last:]))
    return "".join(out), counts


def rewrite_body(body, mapping):
    """Same, but the migration header is preserved verbatim (req 9)."""
    if "\n\n---\n\n" not in body:
        return body, {"key": 0, "url": 0, "num": 0}   # header-only, no body
    head, rest = body.split("\n\n---\n\n", 1)
    new, counts = rewrite(rest, mapping)
    return f"{head}\n\n---\n\n{new}", counts


def keys_in_order():
    ps = glob.glob(f"{EXPORT}/SHI-*.json")
    return sorted(ps, key=lambda p: int(re.search(r"SHI-(\d+)", os.path.basename(p)).group(1)))


def main():
    dry = "--dry-run" in sys.argv
    only = None
    if "--diff" in sys.argv:
        only = sys.argv[sys.argv.index("--diff") + 1]

    mapping = load_mapping()
    print(f"mapping: {len(mapping)} entries")
    done = set()
    if os.path.exists(DONE):
        done = {l.split("\t")[0] for l in open(DONE) if l.strip()}
        print(f"resuming — {len(done)} issues already replayed")

    tot = {"key": 0, "url": 0, "num": 0}
    ncomments = ntitles = 0
    for p in keys_in_order():
        d = json.load(open(p))
        key = d["identifier"].split("#")[-1]
        if key in done or (only and key != only):
            continue
        num = mapping.get(key)
        if num is None:
            print(f"  !! {key} missing from the mapping — halting")
            sys.exit(1)
        ref = f"{TRACKER}#{num}"

        created = d["createdAt"][:10]
        header = f"> Migrated from Linear **{key}**, created {created}."
        if d.get("parentIdentifier"):
            header += f" Sub-issue of {d['parentIdentifier'].split('#')[-1]}."
        body = (d.get("description") or "").strip()
        body = f"{header}\n\n---\n\n{body}" if body else header
        new_body, c = rewrite_body(body, mapping)
        for k in tot:
            tot[k] += c[k]

        new_title, tc = rewrite(d["title"], mapping)
        title_changed = new_title != d["title"]
        if title_changed:
            ntitles += 1
            for k in tot:
                tot[k] += tc[k]

        # Linear returns comments newest-first; replay in conversation order.
        comments = list(reversed(d.get("comments") or []))
        rendered = []
        for cm in comments:
            t, cc = rewrite(cm.get("body") or "", mapping)
            for k in tot:
                tot[k] += cc[k]
            rendered.append(f"> _Originally posted {cm['createdAt'][:10]}._\n\n{t}")
        ncomments += len(rendered)

        if only:
            print(f"=== {key} -> {ref} ===")
            print("--- title ---"); print(d["title"]); print("  =>"); print(new_title)
            print("--- body ---"); print(new_body[:1200])
            for r in rendered[:2]:
                print("--- comment ---"); print(r[:600])
            break
        if dry:
            continue

        if new_body != body:
            sh(["shipit", "issue", "edit", ref, "--body-file", "-"], stdin=new_body)
        if title_changed:
            sh(["shipit", "issue", "edit", ref, "--title", new_title])
        for r in rendered:
            sh(["shipit", "issue", "comment", ref, "--body-file", "-"], stdin=r)
            time.sleep(1.0)
        with open(DONE, "a") as f:
            f.write(f"{key}\t{num}\t{len(rendered)}\n")
        print(f"{key} -> {ref}: {len(rendered)} comments"
              f"{', title' if title_changed else ''}", flush=True)
        time.sleep(0.5)

    if not only:
        print(f"\ncomments {'to replay' if dry else 'replayed'}: {ncomments}")
        print(f"titles rewritten: {ntitles}")
        print(f"rewrites — SHI-N keys: {tot['key']}, linear.app issue URLs: {tot['url']}, "
              f"bare #N: {tot['num']}")


if __name__ == "__main__":
    main()
