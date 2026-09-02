/**
 * docs/265 — what an infinite CSS animation is allowed to be.
 *
 * ONE RULE: an infinite animation may animate `opacity`, and nothing else.
 *
 * A live IntersectionObserver target — ShipIt always has some — makes Chrome
 * recompute intersections through the full main-thread rendering lifecycle. A
 * `transform` animation moves geometry, so every frame it produces drags that
 * lifecycle behind it; an `opacity` animation moves none, so it produces the
 * same compositor frames and wakes the main thread not at all. Measured A/B on
 * identical pages — re-run with `node scripts/measure-spinner-cost.mjs`:
 *
 *   transform, steps(10)        10 main frames/s,  6.0 ms/s
 *   transform, linear           60 main frames/s, 27.8 ms/s
 *   opacity,   linear            0 main frames/s,  2.0 ms/s
 *
 * So the rule needs no step-rate band: smooth opacity is cheaper than the
 * stepped transform the previous rule prescribed, and it is not choppy.
 *
 * The rule this replaced allowed a stepped `transform`, and that was wrong
 * twice: a 10 fps spinner is visibly choppy, and steps() did not even hold the
 * rate, because step boundaries run from each animation own start time. Twelve
 * stepped transforms mounted 7 ms apart measured 49.8 main frames/s against 10
 * for one. Opacity has no such union problem — twelve unaligned smooth opacity
 * animations still measure 0.
 *
 * A finite animation is exempt: it stops, so it costs nothing in the steady
 * state, and it is the only way to animate a property this rule forbids.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every stylesheet the client ships — not just `index.css`. */
function clientStylesheets(dir = here, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) clientStylesheets(full, out);
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

/** Comments stripped so a commented-out rule is not treated as a live one. */
const stripCss = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, "");

const cssFiles = clientStylesheets().map((p) => ({ path: p, text: stripCss(fs.readFileSync(p, "utf8")) }));
const css = cssFiles.find((c) => c.path.endsWith("index.css"))!.text;
// Tailwind's own theme is the second source of truth: `--animate-pulse` is
// overridden in index.css but `@keyframes pulse` is declared there, so the
// property rule can only be checked against both.
const tailwindCss = fs.readFileSync(path.join(here, "../../node_modules/tailwindcss/theme.css"), "utf8");
const allCss = cssFiles.map((c) => c.text).join("\n");

/**
 * The only property an infinite animation may touch. `transform` is a compositor
 * property too, and it is still banned: compositing is not what this is about —
 * geometry is. See the header.
 */
const FREE_WHILE_INFINITE = new Set(["opacity"]);

/**
 * Ways a component can reach a forever-running transform animation without
 * touching a stylesheet at all. The first three are Tailwind utilities whose
 * keyframes rotate, scale or translate; the rest are the escape hatches that
 * bypass `index.css` — an arbitrary-value utility, an arbitrary property, and an
 * inline style object.
 */
const BANNED_IN_COMPONENTS: { pattern: RegExp; what: string }[] = [
  { pattern: /["'`\s:]animate-spin["'`\s]/, what: "animate-spin" },
  { pattern: /["'`\s:]animate-ping["'`\s]/, what: "animate-ping" },
  { pattern: /["'`\s:]animate-bounce["'`\s]/, what: "animate-bounce" },
  { pattern: /animate-\[/, what: "an arbitrary-value animate-[…] utility" },
  { pattern: /\[animation(-[a-z]+)?:/, what: "an arbitrary [animation:…] property" },
  { pattern: /\banimation(Name|IterationCount)?\s*:\s*["'`]/, what: "an inline animation style" },
];

/**
 * The properties a `@keyframes` block touches. Read from the stylesheet rather
 * than assumed from the animation's name: `preview-art-march` sounds like
 * movement and animates `stroke-dashoffset`.
 */
function keyframeProperties(name: string): string[] {
  // Match the name EXACTLY. A substring search finds `@keyframes spinner-fade`
  // when asked for `spin` and then reports opacity for a rotation — a wrong
  // answer in the safe direction, which is the kind that passes.
  const at = (s: string) => s.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  const source = [allCss, tailwindCss].find((s) => at(s) !== -1);
  if (!source) return [];
  // Brace-count rather than regex to the closing brace — a @keyframes body
  // contains nested blocks, so `[^}]*` stops at the first inner one and reports
  // an almost-empty property list. That failure is silent and passes.
  const start = at(source);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) { end = i; break; }
  }
  return [...new Set([...source.slice(open + 1, end).matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))];
}

interface Reference { keyframes: string; decl: string; file: string }

/**
 * Every `@keyframes` reference that can run forever.
 *
 * An animation is unbounded exactly when its declaration says `infinite` — the
 * CSS default is one iteration, so silence means finite and `preview-line-flash`
 * is correctly exempt without stating a count.
 *
 * That reading has one hole: the cascade can split a single animation across
 * rules, setting `animation-name` in one and `animation-iteration-count:
 * infinite` in another, and neither rule alone looks unbounded. The hole is
 * closed by forbidding those two longhands outright (see the guard below) rather
 * than by trying to resolve the cascade here — every animation is written as one
 * self-describing shorthand, so this function can read one declaration at a time.
 */
function unboundedAnimations(): Reference[] {
  const out: Reference[] = [];
  // Tailwind declares its own (`pulse`, `spin`, …) and ShipIt references them by
  // name from `@theme`, so both sources have to be known or such a reference
  // resolves to nothing and is checked against an empty property list.
  const declared = new Set([...allCss.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])
    .concat([...tailwindCss.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])));
  for (const { path: file, text } of cssFiles) {
    // The shorthand, plus the `--animate-*` theme values, which become exactly
    // such a shorthand at every `animate-…` call site.
    for (const m of text.matchAll(/(?:animation|--animate-[\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
      // Split a comma-separated list at the TOP level only, so the commas inside
      // `cubic-bezier(0.4, 0, 0.6, 1)` do not chop a declaration into nonsense.
      let depth = 0;
      let current = "";
      const parts: string[] = [];
      for (const ch of m[1]) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "," && depth === 0) { parts.push(current); current = ""; }
        else current += ch;
      }
      parts.push(current);
      for (const raw of parts) {
        const decl = raw.replace(/\s+/g, " ").trim();
        if (!/\binfinite\b/.test(decl)) continue;
        const keyframes = [...declared].find((k) => new RegExp(`(^|\\s)${k}(\\s|$)`).test(decl));
        out.push({ keyframes: keyframes ?? "", decl, file: path.relative(here, file) });
      }
    }
  }
  return out;
}

/** Scan a directory of TS/TSX for the component-side escape hatches. */
function scanComponents(dir: string): string[] {
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // This file names the utilities in code; its own control covers it.
      if (entry.name === "index.animation-policy.test.ts") continue;
      // Comments stripped: the files that explain the rule must be able to name
      // what they forbid.
      const body = fs.readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      for (const { pattern, what } of BANNED_IN_COMPONENTS) {
        if (pattern.test(body)) offenders.push(`${path.relative(dir, full)} → ${what}`);
      }
    }
  };
  walk(dir);
  return offenders;
}

describe("infinite animation stays cheap", () => {
  it("finds the animations it is meant to be checking", () => {
    // Without this the whole file passes vacuously the day the syntax or the
    // file layout changes. docs/265 hit that failure with four separate
    // instruments before anyone noticed. Named rather than counted: a count is
    // satisfied by any N, and this set is small enough to write down.
    const names = [...new Set(unboundedAnimations().map((a) => a.keyframes))].sort();
    expect(names).toEqual([
      "pulse",
      "spinner-breathe",
      "spoke-0", "spoke-1", "spoke-10", "spoke-11", "spoke-2", "spoke-3",
      "spoke-4", "spoke-5", "spoke-6", "spoke-7", "spoke-8", "spoke-9",
    ]);
    // Every one of them resolved to a real @keyframes block. An unmatched name
    // would otherwise be checked against an empty property list and pass.
    for (const a of unboundedAnimations()) {
      expect(a.keyframes, `could not match \`${a.decl}\` in ${a.file} to a @keyframes block`)
        .not.toBe("");
    }
  });

  it("can read the properties out of a @keyframes block", () => {
    // Positive control for `keyframeProperties`: a helper that always returned
    // [] would pass the property rule for everything. Both of these are
    // keyframes this file must be able to REJECT, so reading them correctly is
    // the thing worth proving.
    expect(keyframeProperties("spin")).toEqual(["transform"]);
    expect(keyframeProperties("preview-art-march")).toContain("stroke-dashoffset");
  });

  it("forbids the two longhands that would let the cascade hide an infinite animation", () => {
    // `unboundedAnimations` reads one declaration at a time. Splitting
    // `animation-name` and `animation-iteration-count: infinite` across two
    // rules would defeat that, so neither longhand is allowed anywhere — the
    // shorthand says everything in one place. This is the guard that makes the
    // simple parser above sound rather than merely convenient.
    for (const { path: file, text } of cssFiles) {
      expect(/animation-(name|iteration-count)\s*:/.test(text),
        `${path.relative(here, file)} uses an animation-name/animation-iteration-count `
        + `longhand. Write the whole animation as one \`animation:\` shorthand instead, `
        + `so a rule states its own iteration count.`).toBe(false);
    }
  });

  it("treats a finite animation as exempt and an uncounted one as unbounded", () => {
    // Positive control for `unboundedAnimations`'s one exemption. The rocket
    // scene states `9` iterations and must be exempt; the spinner states no
    // count at all and must NOT be. Without this, an exemption that swallowed
    // everything would look exactly like compliance.
    const unbounded = unboundedAnimations().map((a) => a.keyframes);
    expect(unbounded).not.toContain("twinkle");
    expect(unbounded).not.toContain("preview-art-march");
    // `preview-line-flash` states no count at all and is finite by the CSS
    // default — the exemption must not require an explicit `1`.
    expect(unbounded).not.toContain("preview-line-flash");
    expect(unbounded).toContain("spoke-0");
  });

  it.each(unboundedAnimations())("$file: $decl", ({ decl, keyframes }) => {
    const banned = keyframeProperties(keyframes).filter((p) => !FREE_WHILE_INFINITE.has(p));
    expect(banned, `\`${decl}\` animates ${banned.join(", ")}. An animation that can `
      + `run forever may animate opacity and nothing else: anything that moves geometry `
      + `forces Chrome to recompute every live IntersectionObserver, which costs a full `
      + `main-thread rendering pass per frame — measured at 60 main frames/s against 0 `
      + `for the same animation on opacity. Animate opacity instead, or give the `
      + `animation a finite iteration count so it stops.`).toEqual([]);
  });

  it("does not step its unbounded animations", () => {
    // The inverse of the rule this file used to enforce, and it is here because
    // that rule is the regression being undone: an opacity animation costs the
    // same at display rate as at 10 Hz, so stepping one buys nothing and spends
    // the smoothness. A `steps()` here means someone re-applied it.
    for (const { decl } of unboundedAnimations()) {
      expect(decl, `\`${decl}\` is stepped. Stepping an opacity animation saves `
        + `nothing (it already costs 0 main-thread frames/s) and makes it choppy.`)
        .not.toMatch(/\bsteps\(/);
    }
  });

  it("phases the spinner in its keyframes, not in animation-delay", () => {
    // Twelve spokes sharing one phase behave as one animation; twelve phases do
    // not. Measured in the live app: the delay spelling costs 50 main-thread
    // frames/s where the keyframe spelling costs 5.6, for identical pixels. The
    // delay spelling is the one anyone would write, so it is worth a guard.
    const spinnerRules = /\.spinner > i[\s\S]*?(?=\n@media|\n\/\*|$)/.exec(css)?.[0] ?? "";
    expect(spinnerRules, "the .spinner rules moved — this guard is now checking nothing")
      .toContain("animation: spoke-0 ");
    expect(spinnerRules, "a staggered animation-delay puts every spoke on its own phase, "
      + "which measured 9x the main-thread cost of phasing them in the keyframes")
      .not.toMatch(/animation-delay/);
  });

  it("pins Tailwind's `pulse` and leaves the transform utilities undeclared", () => {
    // `pulse` animates opacity, so Tailwind's own smooth default is free. It is
    // re-declared to pin that. `spin` / `ping` / `bounce` animate transform, so
    // there is deliberately no ShipIt value for them — the component scan is
    // what stops anyone reaching for Tailwind's.
    expect(/--animate-pulse:[^;]+;/.exec(css)?.[0], "--animate-pulse must be pinned in @theme")
      .toBeDefined();
    for (const name of ["spin", "ping", "bounce"]) {
      expect(new RegExp(`--animate-${name}:`).test(css),
        `--animate-${name} must NOT be declared: ${name} animates transform, and no `
        + `unbounded use of it is affordable. Re-declaring it implies one is.`).toBe(false);
    }
  });

  it("Spinner.tsx renders exactly as many spokes as index.css styles", () => {
    // The component's spoke count and the stylesheet's `:nth-child` rules are two
    // halves of one thing, and a mismatch is silent in both directions: an extra
    // spoke renders unstyled and unanimated, a missing one leaves a gap in the
    // ring. This is the same shape as the bug where a component kept a class
    // whose animation had been deleted — everything renders, nothing moves.
    const component = fs.readFileSync(path.join(here, "components/Spinner.tsx"), "utf8");
    const spokes = /const SPOKES = \[([^\]]*)\]/.exec(component)?.[1].split(",").length;
    const styled = [...css.matchAll(/\.spinner > i:nth-child\((\d+)\)/g)].length;
    expect(spokes, "could not read SPOKES out of Spinner.tsx").toBeGreaterThan(0);
    expect(styled, `Spinner.tsx renders ${spokes} spokes but index.css styles ${styled}. `
      + `An unstyled spoke renders as a static dot in the middle of the ring.`).toBe(spokes);
  });

  it("no component reaches a transform animation around the stylesheet", () => {
    // The property rule above sees stylesheets. Tailwind still defines
    // `animate-spin`/`ping`/`bounce`, and a component can also inline an
    // animation or use an arbitrary-value utility — none of which touch a .css
    // file. That is exactly how ~50 rotating spinners existed.
    expect(scanComponents(here), `these can animate transform forever, costing a `
      + `main-thread rendering pass per frame. Use <Spinner /> `
      + `(components/Spinner.tsx) for an in-flight indicator, or animate-pulse for a `
      + `breathing one.`).toEqual([]);
  });

  it("the component scan finds each escape hatch it claims to cover", () => {
    // Positive control for `scanComponents` as a whole — file discovery, comment
    // stripping and every pattern — not for one regex against one string. A scan
    // that silently found nothing is indistinguishable from compliance, and the
    // previous version of this control could not have told the difference.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anim-policy-"));
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "a.tsx"), `<Icon className="animate-spin text-x" />`);
    fs.writeFileSync(path.join(dir, "b.tsx"), `<Icon className="motion-safe:animate-ping" />`);
    fs.writeFileSync(path.join(dir, "nested/c.tsx"), `<div className="animate-[spin_1s_linear_infinite]" />`);
    fs.writeFileSync(path.join(dir, "nested/d.tsx"), `<div className="[animation:spin_1s_linear_infinite]" />`);
    fs.writeFileSync(path.join(dir, "e.tsx"), `<div style={{ animation: "spin 1s linear infinite" }} />`);
    fs.writeFileSync(path.join(dir, "f.tsx"), `<div className="animate-bounce" />`);
    // Must NOT be flagged: a comment naming the rule, and the allowed utility.
    fs.writeFileSync(path.join(dir, "ok.tsx"), `// never use animate-spin\n<div className="animate-pulse" />`);
    const found = scanComponents(dir).map((o) => o.split(" → ")[0]).sort();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(found).toEqual(["a.tsx", "b.tsx", "e.tsx", "f.tsx",
      path.join("nested", "c.tsx"), path.join("nested", "d.tsx")].sort());
  });
});
