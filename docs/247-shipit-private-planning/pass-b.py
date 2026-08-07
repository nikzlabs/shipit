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


WRITE_SLEEP = 8.0        # ~450 writes/hour, under GitHub's secondary limit
BACKOFF = 900            # 15 min, on a secondary-rate-limit 403
MAX_RETRIES = 8


def sh(args, stdin=None):
    r = subprocess.run(args, capture_output=True, text=True, input=stdin)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def sh_retry(args, stdin=None):
    """A write that survives GitHub's secondary rate limit.

    The shim reports a secondary-limit 403 as "the repository either does not
    exist or the credential cannot access it" — the same text it uses for a
    genuinely missing repo. The two are distinguishable only by the fact that
    reads keep working, so this retries rather than trusting the message.
    """
    for attempt in range(MAX_RETRIES):
        try:
            return sh(args, stdin=stdin)
        except RuntimeError as e:
            if "403" not in str(e) or attempt == MAX_RETRIES - 1:
                raise
            print(f"  … 403 (rate limit); backing off {BACKOFF // 60} min "
                  f"[{attempt + 1}/{MAX_RETRIES - 1}]", flush=True)
            time.sleep(BACKOFF)


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

    first_of_run = True
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

        # The done-file records an issue only once ALL its comments land, but a
        # failure happens mid-issue — so the first issue of a resumed run may be
        # partially written. Everything after it was never touched, so this read
        # is needed exactly once per run. Matching on the rendered body makes the
        # skip idempotent rather than trusting a count.
        already = set()
        if first_of_run:
            first_of_run = False
            cur = json.loads(sh(["shipit", "issue", "view", ref, "--comments", "--json"]))
            already = {(c.get("body") or "").strip() for c in (cur.get("comments") or [])}
            if already:
                print(f"  resuming {key}: {len(already)} comments already posted", flush=True)

        if new_body != body:
            sh_retry(["shipit", "issue", "edit", ref, "--body-file", "-"], stdin=new_body)
            time.sleep(WRITE_SLEEP)
        if title_changed:
            sh_retry(["shipit", "issue", "edit", ref, "--title", new_title])
            time.sleep(WRITE_SLEEP)
        for r in rendered:
            if r.strip() in already:
                continue
            sh_retry(["shipit", "issue", "comment", ref, "--body-file", "-"], stdin=r)
            time.sleep(WRITE_SLEEP)
        with open(DONE, "a") as f:
            f.write(f"{key}\t{num}\t{len(rendered)}\n")
        print(f"{key} -> {ref}: {len(rendered) - len(already & {r.strip() for r in rendered})} comments"
              f"{', title' if title_changed else ''}", flush=True)

    if not only:
        print(f"\ncomments {'to replay' if dry else 'replayed'}: {ncomments}")
        print(f"titles rewritten: {ntitles}")
        print(f"rewrites — SHI-N keys: {tot['key']}, linear.app issue URLs: {tot['url']}, "
              f"bare #N: {tot['num']}")


if __name__ == "__main__":
    main()
