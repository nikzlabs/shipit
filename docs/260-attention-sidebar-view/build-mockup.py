#!/usr/bin/env python3
"""Generate mockup.html for docs/260-attention-sidebar-view.

The candidate glyphs are drawn from the REAL Phosphor path data in
node_modules/@phosphor-icons/react, so the mock shows the icons that would
actually ship rather than hand-drawn approximations. Regenerate with:

    python3 docs/260-attention-sidebar-view/build-mockup.py

Committed alongside the output so the mock stays reproducible. Needs
`npm install` to have run; it reads the icon defs straight out of node_modules.
"""
import pathlib
import re

HERE = pathlib.Path(__file__).resolve()
REPO = HERE.parents[2]
DEFS = REPO / "node_modules" / "@phosphor-icons" / "react" / "dist" / "defs"
OUT = HERE.with_name("mockup.html")

CANDIDATE_NAMES = ["Chats", "Tray", "HandWaving", "Funnel", "Target"]


def load_icon(name: str) -> dict:
    """Pull the `regular` and `fill` path data out of a Phosphor def module."""
    src = (DEFS / f"{name}.es.js").read_text()
    icon = {}
    for part in re.split(r'\n  \[\n    "', src)[1:]:
        weight = part[: part.index('"')]
        if weight in ("regular", "fill"):
            icon[weight] = re.search(r'd:\s*"([^"]+)"', part).group(1)
    return icon


ICONS = {n: load_icon(n) for n in CANDIDATE_NAMES}


def glyph(name: str, weight: str, size: int = 15) -> str:
    d = ICONS[name][weight]
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 256 256" '
            f'fill="currentColor"><path d="{d}"/></svg>')


SW_OFF = f'<span class="sw">{glyph("Chats", "regular")}<span class="n">{{n}}</span></span>'
SW_ON = f'<span class="sw on">{glyph("Chats", "fill")}<span class="n">{{n}}</span></span>'
SW_ON_ZERO = f'<span class="sw on">{glyph("Chats", "fill")}</span>'
SW_OFF_ZERO = f'<span class="sw">{glyph("Chats", "regular")}</span>'

# --- small decorative header icons (approximations; not the subject of the mock)
I_SIDEBAR = ('<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
             'stroke-width="1.3"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2"/>'
             '<line x1="6" y1="2.6" x2="6" y2="13.4"/></svg>')
I_PLUS = ('<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
          'stroke-width="1.5"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>')
I_BOLT = ('<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
          'stroke-width="1.3"><path d="M9 1.5 3.5 9h4l-1 5.5L13 7H9z"/></svg>')
I_BOLT_MIC = ('<span style="position:relative;display:inline-flex">' + I_BOLT +
              '<svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor" '
              'style="position:absolute;right:-3px;bottom:-1px">'
              '<rect x="5.5" y="2" width="5" height="8" rx="2.5"/>'
              '<path d="M3.5 8a4.5 4.5 0 0 0 9 0h-1.4a3.1 3.1 0 0 1-6.2 0z"/></svg></span>')
I_GH = '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6.4"/></svg>'
I_PR = ('<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
        'stroke-width="1.6"><circle cx="4.5" cy="12" r="2"/><circle cx="4.5" cy="4" r="2"/>'
        '<path d="M4.5 6v4M11.5 4.5v5"/><circle cx="11.5" cy="11.5" r="2"/></svg>')
# SessionStatusDot vocabulary, unchanged from the All view
D_CI_FAIL = ('<span class="sd" style="color:var(--error)"><svg width="11" height="11" viewBox="0 0 16 16" '
             'fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.4"/>'
             '<path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg></span>')
D_CI_PASS = ('<span class="sd" style="color:var(--success)"><svg width="11" height="11" viewBox="0 0 16 16" '
             'fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.4"/>'
             '<path d="M5.2 8.2 7.2 10.2l3.6-4"/></svg></span>')
D_RUN = '<span class="sd run"></span>'


def hdr(active: bool, count, extra_left: str = "") -> str:
    """The sidebar top bar. The switch sits on the LEFT, beside the collapse
    button — both are controls for the sidebar itself. The right-hand cluster is
    the create/act group (new session, quick session, voice, repo)."""
    if count is None:
        sw = SW_ON_ZERO if active else SW_OFF_ZERO
    else:
        sw = (SW_ON if active else SW_OFF).format(n=count)
    return (f'<div class="hdr"><span class="ico">{I_SIDEBAR}</span>{sw}{extra_left}'
            f'<span class="sp"></span>'
            f'<span class="ico">{I_PLUS}</span><span class="ico">{I_BOLT}</span>'
            f'<span class="ico">{I_BOLT_MIC}</span><span class="ico">{I_GH}</span></div>')


def hdr_mobile(active: bool, count) -> str:
    """The mobile sessions panel's own bar. It has no collapse control (Sessions
    is a mode of the bottom tab bar, so you switch away rather than close), and
    quick-session/voice/new live in that tab bar — so the left slot is empty and
    the switch lands in the same place as on desktop."""
    sw = (SW_ON if active else SW_OFF).format(n=count)
    return (f'<div class="hdr">{sw}<span class="sp"></span>'
            f'<span class="ico">{I_PLUS}</span><span class="ico">{I_GH}</span></div>')


# ---------------------------------------------------------------- contrast
def _lin(c: float) -> float:
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def ratio(fg: str, bg: str, *, small_text: bool) -> str:
    """Formatted ratio + pass/fail. WCAG AA wants 4.5:1 for small text and
    3:1 for a non-text UI component."""
    r = contrast(fg, bg)
    need = 4.5 if small_text else 3.0
    ok = r >= need
    cls = "ok" if ok else "fail"
    mark = "✓" if ok else "✕"
    return f'<span class="ratio {cls}">{r:.2f}:1 {mark}</span>'


def row(title, *, pr=False, dot="", repo=None, when="", attn=False, sel=False,
        settled=False, indent=False, cls="") -> str:
    c = "it"
    if attn:
        c += " attn"
    if sel:
        c += " sel"
    if settled:
        c += " settled"
    if indent:
        c += " child"
    if cls:
        c += " " + cls
    meta = dot
    if repo:
        meta += f'<span class="repo">{repo}</span>'
    meta += f'<span class="when">{when}</span>'
    badge = f'<span class="prico">{I_PR}</span>' if pr else '<span class="prico none"></span>'
    return (f'<div class="{c}">{badge}<span class="body"><span class="ttl">{title}</span>'
            f'<span class="meta">{meta}</span></span></div>')


def grp(label, count, color):
    return f'<div class="grp" style="--gc:var(--repo-{color})">{label} <span class="c">{count}</span></div>'


# ---------------------------------------------------------------- candidates
CANDIDATES = [
    ("Chats", True,
     "A session <em>is</em> a chat. The glyph names the objects being listed, not a fault in them — and "
     "the singular <code>ChatCircle</code> already means “conversation” elsewhere in the app, so the "
     "plural reads as “several of those”."),
    ("Tray", False,
     "The inbox metaphor: a tray you work down to empty. Says <em>triage</em> rather than <em>sessions</em>, "
     "and pairs naturally with the “Nothing needs you” empty state."),
    ("HandWaving", False,
     "Sessions waving for your attention. Unused anywhere in the app and instantly recognisable — but the "
     "busiest of the five at 15 px, and it can read as “hello”."),
    ("Funnel", False,
     "Honest and generic: this is a filter. It says a filter is applied but nothing about <em>which</em> one, "
     "and it would be another grey outline glyph among grey outline glyphs."),
    ("Target", False,
     "“Needs attention” as a bullseye. Legible at any size, but vague — it could equally mean goals, focus "
     "mode, or a build target."),
]

cand_html = ""
for name, pick, why in CANDIDATES:
    tag = ' &nbsp;<span class="tag">chosen</span>' if pick else ""
    cand_html += f'''
  <div class="swcell{' pick' if pick else ''}">
    <div class="tile"><span class="z" style="display:inline-flex;gap:8px;align-items:center">
      <span class="sw">{glyph(name, "regular")}<span class="n">4</span></span>
      <span class="sw on">{glyph(name, "fill")}<span class="n">4</span></span>
    </span></div>
    <h4>{name}{tag}</h4>
    <p>{why}</p>
  </div>'''

# ---------------------------------------------------------------- light themes
# Every light theme defines --color-attention as #d97706 (amber-600); only the
# surfaces differ. The proposed small-text value is amber-700.
AMBER_LIGHT = "#d97706"
AMBER_LIGHT_TEXT = "#b45309"
LIGHT_THEMES = [
    ("light", "#ffffff", "#f3f4f6", "#111827", "#9ca3af", "#e5e7eb"),
    ("warm-light", "#fdf8f0", "#ede4d4", "#2c2416", "#a89878", "#e4d8c4"),
    ("solarized-light", "#fdf6e3", "#e4ddc8", "#073642", "#93a1a1", "#e0d8c0"),
]


def light_cell(theme, bg, chip, text1, text3, border, count_color) -> str:
    sw_off = (f'<span class="sw" style="color:{text3}">{glyph("Chats", "regular")}'
              f'<span class="n" style="color:{count_color}">4</span></span>')
    sw_on = (f'<span class="sw on" style="color:{AMBER_LIGHT};background:{chip}">'
             f'{glyph("Chats", "fill")}<span class="n" style="color:{count_color}">4</span></span>')
    sample_row = (
        f'<div style="position:relative;margin:0 4px;padding:6px 8px;border-radius:5px;'
        f'font-size:12px;box-shadow:inset -3px 0 0 {AMBER_LIGHT};'
        f'background-image:linear-gradient(90deg,transparent 62%,{AMBER_LIGHT}33)">'
        f'<span style="display:block;color:{text1};font-size:12px">Repo group separation</span>'
        f'<span style="display:block;color:{text3};font-size:10px;margin-top:3px">shipit · 14m</span>'
        f'</div>')
    return f'''
  <div class="lt">
    <div class="ltframe" style="background:{bg};border-color:{border}">
      <div class="ltbar" style="border-color:{border}">{sw_off}{sw_on}</div>
      {sample_row}
    </div>
    <h4>{theme}</h4>
    <p>count on surface {ratio(count_color, bg, small_text=True)}<br>
       count on chip {ratio(count_color, chip, small_text=True)}<br>
       marker edge {ratio(AMBER_LIGHT, bg, small_text=False)}</p>
  </div>'''


# Pick, per theme, the LIGHTEST amber on the Tailwind ramp that clears AA (4.5:1)
# against that theme's pressed chip — the harder of the two surfaces. One shared
# shade does not work: the cream chips in warm-/solarized-light are darker than
# the neutral one, so they need a deeper amber.
AMBER_RAMP = [("amber-600", "#d97706"), ("amber-700", "#b45309"),
              ("amber-800", "#92400e"), ("amber-900", "#78350f")]


def pick_amber(chip: str) -> tuple[str, str]:
    for name, value in AMBER_RAMP:
        if contrast(value, chip) >= 4.5:
            return name, value
    return AMBER_RAMP[-1]


PICKED = {t[0]: pick_amber(t[2]) for t in LIGHT_THEMES}

light_asis = "".join(light_cell(*t, AMBER_LIGHT) for t in LIGHT_THEMES)
light_fixed = "".join(
    light_cell(*t, PICKED[t[0]][1]).replace(
        f"<h4>{t[0]}</h4>",
        f'<h4>{t[0]} &nbsp;<span class="tok">{PICKED[t[0]][0]}</span></h4>')
    for t in LIGHT_THEMES)
dark_ref = (f'<div class="lt"><div class="ltframe" style="background:#030712;border-color:#1f2937">'
            f'<div class="ltbar" style="border-color:#1f2937">{SW_OFF.format(n=4)}{SW_ON.format(n=4)}</div>'
            f'<div style="position:relative;margin:0 4px;padding:6px 8px;border-radius:5px;font-size:12px;'
            f'box-shadow:inset -3px 0 0 #f59e0b;'
            f'background-image:linear-gradient(90deg,transparent 62%,rgba(245,158,11,.2))">'
            f'<span style="display:block;color:#f3f4f6;font-size:12px">Repo group separation</span>'
            f'<span style="display:block;color:#6b7280;font-size:10px;margin-top:3px">shipit · 14m</span>'
            f'</div></div><h4>dark (reference)</h4>'
            f'<p>count on surface {ratio("#f59e0b", "#030712", small_text=True)}<br>'
            f'count on chip {ratio("#f59e0b", "#1f2937", small_text=True)}<br>'
            f'marker edge {ratio("#f59e0b", "#030712", small_text=False)}</p></div>')

# ---------------------------------------------------------------- the two views
ALL_ROWS = (
    grp("shipit", 5, 6)
    + row("Repo group separation", pr=True, dot=D_CI_FAIL, when="14m", attn=True)
    + row("Queued message visibility", dot=D_RUN, when="now")
    + row("↳ Fixture cleanup", dot=D_RUN, when="now", indent=True)
    + row("Mobile composer overflow", when="1h", attn=True)
    + row("Preview path display", pr=True, dot=D_CI_PASS, when="2d")
    + grp("android-overlay", 2, 9)
    + row("Snapshot diff viewer", pr=True, dot=D_CI_PASS, when="3h", attn=True)
    + row("Gradle cache warmup", dot=D_RUN, when="now")
    + grp("docs-site", 1, 3)
    + row("Bump vite to 7.1.4", when="2d", attn=True)
)

NEEDS_ROWS = (
    row("Repo group separation", pr=True, dot=D_CI_FAIL, repo="shipit", when="14m", attn=True, sel=True)
    + row("Mobile composer overflow", repo="shipit", when="1h", attn=True)
    + row("Snapshot diff viewer", pr=True, dot=D_CI_PASS, repo="android-overlay", when="3h", attn=True)
    + row("Bump vite to 7.1.4", repo="docs-site", when="2d", attn=True)
)

SETTLED_ROWS = (
    row("Repo group separation", pr=True, dot=D_CI_FAIL, repo="shipit", when="14m", attn=True, sel=True)
    + row("Mobile composer overflow", dot=D_RUN, repo="shipit", when="now", settled=True)
    + row("Snapshot diff viewer", pr=True, dot=D_CI_PASS, repo="android-overlay", when="3h", attn=True)
    + row("Bump vite to 7.1.4", repo="docs-site", when="2d", attn=True)
)

LONG_ROWS = (
    row("Issue tracker filters", repo="shipit", when="2m", attn=True)
    + row("Repo group separation", pr=True, dot=D_CI_FAIL, repo="shipit", when="14m", attn=True)
    + row("Mobile composer overflow", repo="shipit", when="1h", attn=True)
    + row("Snapshot diff viewer", pr=True, dot=D_CI_PASS, repo="android-overlay", when="3h", attn=True)
    + row("Chat history paging", repo="shipit", when="5h", attn=True)
    + row("Landing page hero", repo="marketing", when="1d", attn=True)
    + row("Bump vite to 7.1.4", repo="docs-site", when="2d", attn=True)
    + row("Emulator boot flake", pr=True, repo="android-overlay", when="3d", attn=True)
    + row("Ops inventory table", repo="shipit", when="6d", attn=True)
)

HTML = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sidebar "Needs you" view — mock (docs/260)</title>
<!--
  GENERATED — edit build-mockup.py, not this file.

  Static, self-contained visual reference for docs/260-attention-sidebar-view.
  Nothing is wired up; it exists so the layout decisions survive next to
  requirements.md instead of only in an ephemeral Present-tab artifact.

  The candidate glyphs use the real path data from @phosphor-icons/react, and
  the colors are the real ShipIt `dark` theme values (src/client/themes/dark.css)
  plus the repo-identity palette (src/client/index.css, --repo-color-N).
-->
<style>
  :root{{
    --bg-primary:#030712; --bg-secondary:#111827; --bg-tertiary:#1f2937;
    --text-1:#f3f4f6; --text-2:#9ca3af; --text-3:#6b7280;
    --border-1:#1f2937; --border-2:#374151;
    --success:#22c55e; --error:#ef4444; --attention:#f59e0b; --pr:#a78bfa;
    --repo-6:#6cc4dd; --repo-9:#a99ad8; --repo-3:#a8c46a; --repo-11:#e08aa0;
    --page:#0b0d13;
  }}
  *{{box-sizing:border-box}}
  html,body{{margin:0}}
  body{{background:var(--page);color:var(--text-1);
    font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;padding:32px 24px 64px}}
  h1{{font-size:20px;margin:0 0 4px;font-weight:600;letter-spacing:-.01em}}
  h2{{font-size:14px;margin:40px 0 4px;font-weight:600}}
  .lede{{color:var(--text-2);max-width:960px;margin:0 0 8px}}
  .note{{color:var(--text-3);font-size:12px;max-width:960px;margin:0 0 18px}}
  .note code,.legend code,.swcell code{{background:var(--bg-secondary);border:1px solid var(--border-1);
    border-radius:4px;padding:0 4px;font-size:11px}}
  .row{{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}}
  .cap{{color:var(--text-3);font-size:11px;margin:0 0 8px;max-width:264px}}
  .cap b{{color:var(--text-2);font-weight:600}}
  .cap.after{{margin:8px 0 0}}

  /* ---- sidebar shell ---- */
  .side{{width:264px;background:var(--bg-primary);border:1px solid var(--border-1);
    border-radius:8px;overflow:hidden;box-shadow:0 14px 44px rgba(0,0,0,.5);
    min-height:470px;display:flex;flex-direction:column}}
  .hdr{{display:flex;align-items:center;gap:4px;padding:0 8px;height:41px;
    border-bottom:1px solid var(--border-1)}}
  .hdr .sp{{flex:1}}
  .ico{{width:26px;height:26px;border-radius:5px;display:grid;place-items:center;color:var(--text-3)}}
  .scroll{{flex:1;padding:4px 0;overflow:hidden}}

  /* ---- the switch ----
     A PILL, not an icon wearing a badge: glyph and count sit side by side, so
     the count can never occlude the glyph. Pressed state follows the house
     pattern for a toggled ghost button (IssuesViewer.tsx) — glyph to `fill`
     weight, accent color, quiet chip — not a saturated amber button. */
  .sw{{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 6px;
    border-radius:6px;color:var(--text-3)}}
  .sw .n{{font-size:10px;font-weight:700;line-height:1;color:var(--attention)}}
  .sw.on{{background:var(--bg-tertiary);color:var(--attention)}}
  .sw svg{{display:block}}

  /* ---- repo group header (All view only) ---- */
  .grp{{display:flex;align-items:center;gap:6px;padding:5px 10px 5px 12px;font-size:11px;
    font-weight:600;color:var(--text-2);position:relative}}
  .grp::before{{content:"";position:absolute;left:0;top:2px;bottom:2px;width:3px;
    border-radius:0 2px 2px 0;background:var(--gc,var(--repo-6))}}
  .grp .c{{margin-left:auto;color:var(--text-3);font-weight:500;font-size:10px}}

  /* ---- session row — IDENTICAL in both views (SessionItem.tsx) ---- */
  .it{{display:flex;align-items:flex-start;gap:6px;margin:0 4px;padding:6px 8px;border-radius:5px;
    position:relative;font-size:12px;color:var(--text-2)}}
  .it.sel{{background:var(--bg-secondary);color:var(--text-1)}}
  .it .ttl{{display:block;color:var(--text-1);line-height:1.3;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}}
  .it .meta{{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:10px;
    color:var(--text-3);white-space:nowrap;overflow:hidden}}
  .it .body{{min-width:0;flex:1}}
  .it .repo{{min-width:0;overflow:hidden;text-overflow:ellipsis}}
  .it .when{{margin-left:auto;padding-left:4px;color:var(--text-3);flex:0 0 auto}}
  .it .prico{{color:var(--pr);flex:0 0 auto;margin-top:1px}}
  .it .prico.none{{opacity:0}}
  .it.child{{margin-left:20px}}
  .sd{{display:inline-flex;flex:0 0 auto}}
  .sd.run{{width:8px;height:8px;border-radius:50%;background:var(--success)}}
  /* docs/187 attention marker — unchanged, and kept INSIDE the view */
  .it.attn{{box-shadow:inset -3px 0 0 var(--attention);
    background-image:linear-gradient(90deg,transparent 62%,rgba(245,158,11,.2))}}
  /* settled: the marker simply goes away. No new styling. */
  .it.settled{{opacity:.6}}

  .tip{{position:absolute;left:26px;top:100%;margin-top:2px;z-index:5;
    background:var(--bg-tertiary);border:1px solid var(--border-2);border-radius:5px;
    padding:3px 7px;font-size:10px;color:var(--text-1);white-space:nowrap;
    box-shadow:0 6px 18px rgba(0,0,0,.5)}}
  .it.hov{{background:rgba(255,255,255,.05)}}

  .empty{{display:flex;flex-direction:column;align-items:center;gap:8px;padding:52px 22px;text-align:center}}
  .empty p{{margin:0;font-size:12px;color:var(--text-2)}}
  .empty small{{color:var(--text-3);font-size:11px}}

  /* ---- anatomy ---- */
  .anat{{width:596px;background:var(--bg-primary);border:1px solid var(--border-1);
    border-radius:8px;padding:22px 26px 18px;overflow:hidden}}
  .anat .zoom{{transform:scale(2);transform-origin:left top;width:264px}}
  .anat .pad{{height:78px}}
  .anat ol{{margin:0;padding-left:18px;color:var(--text-2);font-size:12px;line-height:1.75}}
  .anat ol b{{color:var(--text-1);font-weight:600}}

  /* ---- boards ---- */
  .swdemo{{display:flex;gap:16px;flex-wrap:wrap}}
  .swcell{{width:158px}}
  .swcell .tile{{height:104px;background:var(--bg-primary);border:1px solid var(--border-1);
    border-radius:8px;display:grid;place-items:center;overflow:hidden}}
  .swcell .z{{transform:scale(3)}}
  .swcell h4{{margin:8px 0 2px;font-size:11px;font-weight:600;color:var(--text-1)}}
  .swcell p{{margin:0;font-size:11px;color:var(--text-3);line-height:1.5}}
  .swdemo.wide .swcell{{width:214px}}
  .swdemo.wide .tile{{height:96px}}
  .swdemo.wide .z{{transform:scale(2.4)}}
  .swcell.pick .tile{{border-color:rgba(34,197,94,.45)}}
  .swcell.bad .tile{{border-color:rgba(239,68,68,.4)}}
  .swcell.bad h4{{color:var(--error)}}
  .swcell .tag{{font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
    color:var(--success);background:rgba(34,197,94,.14);border-radius:8px;padding:1px 5px}}

  /* ---- header placement board ---- */
  .hb{{width:420px}}
  .hb .frame{{background:var(--bg-primary);border:1px solid var(--border-1);border-radius:8px;
    padding:16px 0;overflow:hidden}}
  .hb .z{{transform:scale(1.5);transform-origin:left center;width:264px;margin-left:14px}}
  .hb .side{{min-height:0;box-shadow:none}}
  .hb .scroll{{display:none}}
  .hb h4{{margin:10px 0 2px;font-size:11px;font-weight:600;color:var(--text-1)}}
  .hb p{{margin:0;font-size:11px;color:var(--text-3);line-height:1.55;max-width:420px}}
  .hb.bad h4{{color:var(--error)}}
  .hb.bad .frame{{border-color:rgba(239,68,68,.4)}}
  .hb.pick .frame{{border-color:rgba(34,197,94,.45)}}

  /* ---- light-theme contrast board ---- */
  .lt{{width:214px}}
  .ltframe{{border:1px solid;border-radius:8px;padding-bottom:8px;overflow:hidden}}
  .ltbar{{display:flex;align-items:center;gap:6px;height:41px;padding:0 8px;
    border-bottom:1px solid;margin-bottom:8px}}
  .lt h4{{margin:8px 0 2px;font-size:11px;font-weight:600;color:var(--text-1)}}
  .lt p{{margin:0;font-size:11px;color:var(--text-3);line-height:1.7}}
  .ratio{{font-variant-numeric:tabular-nums;font-weight:600}}
  .ratio.ok{{color:var(--success)}}
  .ratio.fail{{color:var(--error)}}
  .tok{{font-size:9px;font-weight:700;letter-spacing:.03em;color:var(--attention);
    background:rgba(245,158,11,.14);border-radius:8px;padding:1px 5px}}

  /* ---- rejected thumbnails ---- */
  .thumbs{{display:flex;gap:16px;flex-wrap:wrap}}
  .th{{width:190px}}
  .th .side{{width:190px;min-height:0;opacity:.5;filter:saturate(.7)}}
  .th .scroll{{padding:3px 0}}
  .th .it{{font-size:10px;padding:4px 6px}}
  .th .it .meta{{font-size:9px;margin-top:2px}}
  .th .band{{display:flex;align-items:center;gap:6px;padding:6px 8px 3px;font-size:9px;
    font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3)}}
  .th .band.blocked{{color:var(--attention)}} .th .band.broken{{color:var(--error)}}
  .th .band hr{{flex:1;border:0;border-top:1px solid var(--border-1);margin:0}}
  .th .seg{{display:flex;gap:2px;margin:5px 6px;padding:2px;background:var(--bg-secondary);border-radius:6px}}
  .th .seg span{{flex:1;text-align:center;font-size:9px;font-weight:600;color:var(--text-3);
    padding:3px;border-radius:4px}}
  .th .seg span.sel{{background:var(--bg-tertiary);color:var(--text-1)}}
  .th .mode{{padding:4px 8px;font-size:9px;font-weight:700;text-transform:uppercase;
    color:var(--attention);background:rgba(245,158,11,.08);
    border-bottom:1px solid rgba(245,158,11,.22)}}
  .th p{{color:var(--text-3);font-size:11px;margin:8px 0 0;line-height:1.5}}
  .th p b{{color:var(--text-2)}}

  .legend{{max-width:960px;color:var(--text-2);font-size:12px;line-height:1.65;margin-top:10px}}
  .legend p{{margin:0 0 10px}}
  .legend b{{color:var(--text-1)}}
</style>
</head>
<body>

<h1>Sidebar view switch — “Needs you”</h1>
<p class="lede">A second sidebar view that drops the repo tree and lists only the sessions whose ball is in the user’s court. It introduces <b>no new row UI and no new signal</b>: the rows are the existing <code>SessionItem</code> with its <code>repoLabel</code> set — the same thing <code>AllSessionsDialog</code> already renders for its cross-repo list — and membership is <code>computeAttentionReason()</code>, which already drives the amber marker, the row tooltip and notifications.</p>

<h2>Where the switch sits</h2>
<p class="note">The header has two natural groups. On the left sits the control for <em>the sidebar itself</em>; on the right, a cluster of four <em>create/act</em> controls (new session, quick session, voice quick session, repo). The view switch belongs to the first group, so it goes beside the collapse button. Dropped into the right-hand cluster it becomes the fifth small glyph in a row of small glyphs, and its count reads as decoration on a toolbar.</p>
<div class="row">
  <div class="hb pick">
    <div class="frame"><div class="z"><div class="side">{hdr(False, 4)}</div></div></div>
    <h4>Beside the collapse button &nbsp;<span class="tag" style="font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--success);background:rgba(34,197,94,.14);border-radius:8px;padding:1px 5px">chosen</span></h4>
    <p>Both controls change what the sidebar shows, so they sit together and read as a pair. The switch gets clear space on both sides, and the amber count is the only amber in the bar — nothing competes with it.</p>
  </div>
  <div class="hb bad">
    <div class="frame"><div class="z"><div class="side"><div class="hdr"><span class="ico">{I_SIDEBAR}</span><span class="sp"></span>{SW_OFF.format(n=4)}<span class="ico">{I_PLUS}</span><span class="ico">{I_BOLT}</span><span class="ico">{I_BOLT_MIC}</span><span class="ico">{I_GH}</span></div></div></div></div>
    <h4>Rejected · in the right-hand cluster</h4>
    <p>Five glyphs in a row, four of which create something. A view switch among them is a category error, and the count competes with the icons on either side instead of standing out.</p>
  </div>
  <div class="hb">
    <div class="frame"><div class="z"><div class="side">{hdr_mobile(False, 4)}</div></div></div>
    <h4>Mobile · same slot (req 15)</h4>
    <p>The mobile session list has no collapse control — Sessions is a mode of the bottom tab bar, so you switch away rather than close it — and new/quick/voice live in that tab bar. The left slot is therefore empty, and the switch lands in the same place as on desktop.</p>
  </div>
</div>

<h2>Light themes — does the amber hold up?</h2>
<p class="note">All six light themes define <code>--color-attention</code> as <code>{AMBER_LIGHT}</code> (amber-600); only the surfaces differ, so three of them cover the range. Ratios are computed, not eyeballed: WCAG AA wants <b>4.5:1</b> for small text like the count, and <b>3:1</b> for a non-text UI element like the edge marker.</p>
<p class="note"><b>Finding: the marker is fine everywhere, the count is not.</b> The 10 px count in <code>--color-attention</code> lands near 3:1 on a light surface and drops below it on the pressed chip — readable, but under AA for text. Dark themes have no such problem, so this is a light-theme-only fix.</p>
<div class="swdemo">{light_asis}{dark_ref}</div>
<p class="note" style="margin-top:18px"><b>Proposed fix — a small-text amber, chosen per theme.</b> The count takes a deeper amber while the glyph and the marker keep <code>--color-attention</code> unchanged. One shared shade does not work: amber-700 clears AA on the neutral chip but not on the cream chips in <code>warm-light</code> and <code>solarized-light</code>, which are darker. So the value is picked per theme — the lightest amber on the ramp that clears 4.5:1 against that theme's chip — which is exactly what a per-theme token is for, and the pattern <code>--color-attention</code> itself already follows. Same hue, still obviously the attention color.</p>
<p class="note"><b>One red square is left, and it is not ours.</b> On <code>solarized-light</code> the docs/187 edge marker itself measures 2.95:1 against that theme's cream surface — a hair under the 3:1 a non-text element wants. That is the existing row marker on an existing theme, unchanged by this view and visible in the All view today, so it is a separate fix; it is recorded here because this board is what surfaced it.</p>
<div class="swdemo">{light_fixed}</div>

<h2>Which glyph?</h2>
<p class="note">The first draft used a warning circle. Wrong twice over: <code>WarningCircleIcon</code> already appears about forty times across the client for genuine warnings, and “something is broken” is not what the switch means — most of the list is an agent quietly waiting for you. Five candidates from the pack we already ship (<code>@phosphor-icons/react</code>), each drawn from its real path data, off state then on state. None of the five is used anywhere else in the client.</p>
<div class="swdemo wide">{cand_html}
</div>

<h2>The switch, at 3×</h2>
<p class="note">The switch carries the whole mode on its own (req 10), so its four states have to be told apart at 26 px. It is a <b>pill</b>, not an icon wearing a badge: glyph and count sit side by side, so the count can never sit on top of the glyph.</p>
<div class="swdemo">
  <div class="swcell">
    <div class="tile"><span class="z">{SW_OFF.format(n=4)}</span></div>
    <h4>Off · 4 waiting</h4>
    <p>Grey glyph, amber count. The discovery state — the only amber in the All view’s header.</p>
  </div>
  <div class="swcell">
    <div class="tile"><span class="z">{SW_OFF_ZERO}</span></div>
    <h4>Off · nothing waiting</h4>
    <p>The count disappears and the pill shrinks to the glyph. No permanent amber mark in the header.</p>
  </div>
  <div class="swcell">
    <div class="tile"><span class="z">{SW_ON.format(n=4)}</span></div>
    <h4>On · 4 waiting</h4>
    <p>Filled glyph, amber, on a quiet chip. Weight, color and background change together, so the state reads without a label.</p>
  </div>
  <div class="swcell">
    <div class="tile"><span class="z">{SW_ON_ZERO}</span></div>
    <h4>On · inbox zero</h4>
    <p>Still lit — you are still in the view — but with no count. Pairs with the “Nothing needs you” empty state.</p>
  </div>
  <div class="swcell bad">
    <div class="tile"><span class="z"><span style="position:relative;display:inline-grid;place-items:center;width:26px;height:26px;border-radius:5px;background:var(--attention);color:#231a05">{glyph("Chats", "fill")}<span style="position:absolute;top:-1px;right:-2px;min-width:14px;height:14px;padding:0 3px;background:#2b1f05;color:#fde68a;border-radius:7px;font-size:9px;font-weight:700;line-height:14px;text-align:center;border:2px solid var(--attention)">4</span></span></span></div>
    <h4>Rejected · filled square + badge</h4>
    <p>The first attempt. The badge lands on the glyph and eats it, and a saturated fill is louder than anything else in the header.</p>
  </div>
</div>

<h2>The two views</h2>
<div class="row">
  <div>
    <p class="cap"><b>All sessions</b> — today’s view, unchanged except for the switch beside the collapse button.</p>
    <div class="side">{hdr(False, 4)}<div class="scroll">{ALL_ROWS}</div></div>
    <p class="cap after">Four marked rows scattered across three repo groups, two of them below the fold on a real workspace. That scatter is the problem.</p>
  </div>

  <div>
    <p class="cap"><b>Needs you</b> — the same four sessions, one flat list, and <b>nothing above it</b>. No repo headers, no child indent, no ops/sandbox pins, no mode band.</p>
    <div class="side">{hdr(True, 4)}<div class="scroll">{NEEDS_ROWS}</div></div>
    <p class="cap after">Order is <b>session creation time, newest first</b> — the same key the All view sorts on within a repo, and the only one in the model that never changes (req 7). A row holds its slot even as its reason changes.</p>
  </div>

  <div class="anat">
    <p class="cap"><b>Row anatomy</b> — shown at 2×. Every part of it already exists.</p>
    <div class="zoom">{row("Snapshot diff viewer", pr=True, dot=D_CI_PASS, repo="android-overlay", when="3h", attn=True)}</div>
    <div class="pad"></div>
    <ol>
      <li><b>PR state badge</b> — unchanged.</li>
      <li><b>Session title</b> — unchanged.</li>
      <li><b>Status dot</b> — unchanged <code>SessionStatusDot</code>: auto-fix, agent running, CI failed/pending/passed, and nothing at all when there is no CI. The same vocabulary as the All view, so a row looks the same in both.</li>
      <li><b>Repo name</b> — the <code>repoLabel</code> prop <code>SessionItem</code> already takes, which <code>AllSessionsDialog</code> already passes for its cross-repo list. Plain tertiary text, not a new chip.</li>
      <li><b>Relative time</b> — unchanged.</li>
      <li><b>The amber marker</b> — unchanged docs/187 treatment on the right edge, and deliberately kept inside this view: the row must not change appearance just because it is being listed somewhere else.</li>
    </ol>
    <p class="cap" style="max-width:none;margin-top:12px">The reason itself stays where it is today — in the row’s tooltip. No reason text is added to the row.</p>
    <div style="position:relative;height:84px;margin-top:6px;width:264px">
      {row("Snapshot diff viewer", pr=True, dot=D_CI_PASS, repo="android-overlay", when="3h", attn=True, cls="hov")}
      <span class="tip" style="top:46px">PR has merge conflicts</span>
    </div>
  </div>
</div>

<h2>States</h2>
<div class="row">
  <div>
    <p class="cap"><b>Settled in place</b> (req 8) — the second row’s agent picked the work back up while the list was open. It keeps its slot; the amber marker simply goes away and the status dot turns green, exactly as it would in the All view.</p>
    <div class="side">{hdr(True, 3)}<div class="scroll">{SETTLED_ROWS}</div></div>
    <p class="cap after">The switch count drops to 3 at once; the <em>list</em> still holds 4 rows. The settled row is dropped the next time the view is entered — never under the pointer. No “settled” styling had to be invented: losing the marker <em>is</em> the signal.</p>
  </div>

  <div>
    <p class="cap"><b>A long list</b> — keeping one shared definition of attention (req 9) means an idle agent on an open PR counts, so on a busy workspace the list gets long and most rows carry no status dot at all. Drawn honestly.</p>
    <div class="side">{hdr(True, 9)}<div class="scroll">{LONG_ROWS}</div></div>
    <p class="cap after">With no reason text, the amber edge is what makes it a list of problems, and the status dots pick out the broken ones.</p>
  </div>

  <div>
    <p class="cap"><b>Empty</b> — inbox zero. The count disappears from the switch, so the All view carries no permanent amber mark. The glyph stays lit, because you are still in the view.</p>
    <div class="side">{hdr(True, None)}
      <div class="empty">
        <span style="color:var(--success)"><svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6.6"/><path d="M4.8 8.3 7 10.5l4.2-4.6"/></svg></span>
        <p>Nothing needs you</p>
        <small>4 sessions are working. You’ll get a count here when one stops.</small>
      </div>
    </div>
  </div>
</div>

<h2>Considered and rejected</h2>
<p class="note">Kept at thumbnail size so the alternatives stay reviewable beside what was chosen. Each lost for the reason under it.</p>
<div class="thumbs">
  <div class="th">
    <div class="side">
      <div class="hdr" style="height:34px"><span class="ico" style="width:22px;height:22px">{I_SIDEBAR}</span><span class="sp"></span><span class="ico" style="width:22px;height:22px">{I_GH}</span></div>
      <div class="seg"><span class="sel">All</span><span>Needs you</span></div>
      <div class="scroll">{row("Repo group separation", when="14m")}{row("Mobile composer overflow", when="1h")}</div>
    </div>
    <p><b>Segmented control.</b> Costs ~30 px of list height on every session, forever, to state a mode the switch holds for free.</p>
  </div>

  <div class="th">
    <div class="side">
      <div class="hdr" style="height:34px"><span class="ico" style="width:22px;height:22px">{I_SIDEBAR}</span><span class="sp"></span><span class="ico" style="width:22px;height:22px">{I_GH}</span></div>
      <div class="mode">Needs you · 4 — show all</div>
      <div class="scroll">{row("Repo group separation", when="14m", attn=True)}{row("Bump vite to 7.1.4", when="2d", attn=True)}</div>
    </div>
    <p><b>A band above the list.</b> Same ~28 px cost, and everything on it was already on screen: the count is on the switch, the exit is a second click on it.</p>
  </div>

  <div class="th">
    <div class="side">
      <div class="hdr" style="height:34px"><span class="ico" style="width:22px;height:22px">{I_SIDEBAR}</span><span class="sp"></span><span class="ico" style="width:22px;height:22px">{I_GH}</span></div>
      <div class="scroll">
        <div class="band blocked">Blocked <span>1</span><hr/></div>
        {row("Issue tracker filters", when="2m", attn=True)}
        <div class="band broken">Broken <span>1</span><hr/></div>
        {row("Repo group separation", when="14m", attn=True)}
      </div>
    </div>
    <p><b>Bands by reason.</b> Trades one grouping for another — and a row jumps band the moment its reason changes, which is the instability req 7 rules out.</p>
  </div>

  <div class="th">
    <div class="side">
      <div class="hdr" style="height:34px"><span class="ico" style="width:22px;height:22px">{I_SIDEBAR}</span><span class="sp"></span><span class="ico" style="width:22px;height:22px">{I_GH}</span></div>
      <div class="scroll">
        <div class="it"><span class="body"><span class="ttl" style="color:var(--attention)">Approve a tool call</span><span class="meta">Issue tracker filters</span></span></div>
        <div class="it"><span class="body"><span class="ttl" style="color:var(--error)">CI fix failed ×3</span><span class="meta">Repo group separation</span></span></div>
      </div>
    </div>
    <p><b>Reason as the title.</b> Reads as a task inbox, and it restates in words what the row already says with a marker and a dot.</p>
  </div>

  <div class="th">
    <div class="side">
      <div class="hdr" style="height:34px"><span class="ico" style="width:22px;height:22px">{I_SIDEBAR}</span><span class="sp"></span><span class="ico" style="width:22px;height:22px">{I_GH}</span></div>
      <div class="scroll">{row("Repo group separation", pr=True, dot=D_CI_FAIL, when="14m", attn=True)}{row("Bump vite to 7.1.4", when="2d", attn=True)}</div>
    </div>
    <p><b>Yank the row immediately.</b> Always-correct list, hostile pointer: a row vanishes mid-hover. The sidebar already avoids exactly this by refusing to sort on <code>lastUsedAt</code>.</p>
  </div>
</div>

<h2>Notes carried by the drawings</h2>
<div class="legend">
  <p><b>The row does not change</b>. It is <code>SessionItem</code> with <code>repoLabel</code> set — the same call <code>AllSessionsDialog</code> already makes for its cross-repo list. No reason text, no new chip, no new colors, and the amber marker stays exactly as docs/187 drew it. A session must look the same wherever it is listed.</p>
  <p><b>Attention is not redefined</b> (req 9). The view filters on <code>computeAttentionReason() !== null</code> — the function that already drives the marker, the tooltip and notifications. The reason stays in the tooltip, where it lives today.</p>
  <p><b>Nothing sits above the list</b> (req 10). No band, no label, no separate exit. The switch is the whole mode indicator, which is what the state board has to earn.</p>
  <p><b>Repo identity comes from the name, not a color.</b> With the group headers gone the repo edge goes too; <code>repoLabel</code> carries the identity, exactly as it does in the All-sessions dialog today.</p>
  <p><b>Stability has two halves</b> (req 7–8): the sort key never changes, <em>and</em> a row that stops qualifying holds its slot until the view is re-entered. Either alone still lets the list move under the cursor.</p>
  <p><b>Parent/child nesting collapses.</b> A spawned child that needs you is a first-class row here; the tree relationship is a property of the All view.</p>
  <p><b>Ops, sandbox and hidden-repo sessions are ordinary rows.</b> Their pinned groups exist to give repo-less sessions a home in a repo tree — a problem this view does not have.</p>
  <p><b>Archived rows never appear</b> — <code>needsAttention</code> is already gated on <code>!isArchived</code> today.</p>
</div>

</body>
</html>
'''

OUT.write_text(HTML)
print(f"wrote {OUT} ({len(HTML)} bytes)")
