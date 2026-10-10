import { describe, it, expect } from "vitest";
import { redactStage1, redactCredentials, redact, REDACTION_PLACEHOLDER } from "./redaction.js";

describe("redactStage1 (deterministic floor)", () => {
  it("scrubs an inline GitHub PAT", () => {
    const { text } = redactStage1("here is my token ghp_ABCDEFGHIJKLMNOP1234567890abcd and done");
    expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOP");
    expect(text).toContain(REDACTION_PLACEHOLDER);
  });

  it("scrubs a fine-grained PAT", () => {
    const { text } = redactStage1("github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789");
    expect(text).not.toContain("github_pat_11ABCDEFG");
    expect(text).toBe(REDACTION_PLACEHOLDER);
  });

  it("scrubs an OpenAI-style key and an Anthropic key", () => {
    const open = redactStage1("key sk-abcdefghijklmnopqrstuvwx here");
    expect(open.text).not.toContain("sk-abcdefghijklmnop");
    const ant = redactStage1("key sk-ant-abcdefghijklmnop here");
    expect(ant.text).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("scrubs an email address", () => {
    const { text } = redactStage1("contact me at jane.doe@example.com please");
    expect(text).not.toContain("jane.doe@example.com");
    expect(text).toContain(REDACTION_PLACEHOLDER);
  });

  it("scrubs a bearer token", () => {
    const { text } = redactStage1("Authorization: Bearer abcdef1234567890XYZ");
    expect(text).not.toContain("abcdef1234567890XYZ");
  });

  it("scrubs a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4";
    const { text } = redactStage1(`token=${jwt}`);
    expect(text).not.toContain(jwt);
  });

  it("scrubs a credentialed git remote URL", () => {
    const { text } = redactStage1(
      "remote https://x-access-token:ghp_secrettoken12345678@github.com/acme/secret-project.git",
    );
    expect(text).not.toContain("github.com/acme/secret-project");
    expect(text).not.toContain("ghp_secrettoken");
  });

  it("scrubs an absolute workspace path that leaks a project name", () => {
    const { text } = redactStage1("error in /workspace/my-secret-app/src/index.ts at line 5");
    expect(text).not.toContain("/workspace/my-secret-app/src/index.ts");
    expect(text).toContain(REDACTION_PLACEHOLDER);
  });

  it("scrubs a home-directory path", () => {
    const { text } = redactStage1("config at /home/jane/.ssh/id_rsa");
    expect(text).not.toContain("/home/jane/.ssh/id_rsa");
  });

  it("leaves benign prose untouched", () => {
    const input = "The preview pane wouldn't reload after I edited a file.";
    const { text, redactedCount } = redactStage1(input);
    expect(text).toBe(input);
    expect(redactedCount).toBe(0);
  });

  it("finds a match that starts where the one before it ended, and one that starts later in a run", () => {
    const R = REDACTION_PLACEHOLDER;
    const jwt = ["eyJabcdefg", "hijklmnop", "qrstuvwx"].join(".");
    const cases: [string, string, number][] = [
      ["a@b.cc.d@e.ff", `${R}${R}`, 2],
      ["a@b.cc-d@e.ff.g@h.ii", `${R}${R}${R}`, 3],
      ["u@h:a.git.x@h:b.git", `${R}${R}`, 2],
      ["..a@b.cc", `..${R}`, 1],
      [`x-${jwt}`, `x-${R}`, 1],
      [`eyJ-x-${jwt} ${jwt}`, `${R} ${R}`, 2],
    ];
    for (const [input, expected, count] of cases) {
      expect(redactStage1(input), input).toEqual({ text: expected, redactedCount: count });
    }
  });

  it("replaces an scp-style remote that the e-mail pattern takes in part, or that has no .git (planning#681, planning#682)", () => {
    const R = REDACTION_PLACEHOLDER;
    const cases: [string, string, number][] = [
      ["git@github.com:acme/app.git", R, 1],
      ["origin\tgit@github.com:acme/app.git (fetch)", `origin\t${R} (fetch)`, 1],
      ["git clone git@gitlab.example.org:group/sub/app.git into x", `git clone ${R} into x`, 1],
      // With `ssh-remote` before `email`, `jane+` stays.
      ["jane+work@github.com:acme/app.git", R, 1],
      // The generic sweep takes a long name first.
      [`git@github.com:acme/${"a".repeat(45)}.git`, R, 2],
      [`git@myhost:acme/${"a".repeat(45)}`, R, 2],
      // The e-mail pattern takes only a part of these hosts.
      ["git@github.com.:acme/app.git", R, 1],
      ["git@code.acme-internal:team/app.git", R, 1],
      ["git@example.xn--p1ai:acme/app.git", R, 1],
      ["git clone git@github.com:acme/app", `git clone ${R}`, 1],
      ["origin\tgit@myhost:acme/app (fetch)", `origin\t${R} (fetch)`, 1],
      ["scp build.tar deploy@prod-1:/srv/app/releases/", `scp build.tar ${R}`, 1],
      // A shell prompt has the same shape.
      ["user@host:/srv/app$ npm test", `${R}$ npm test`, 1],
      ["git@github.com:acme/app.git/info/refs", R, 1],
      ["git@myhost:app.git", R, 1],
    ];
    for (const [input, expected, count] of cases) {
      expect(redactStage1(input), input).toEqual({ text: expected, redactedCount: count });
    }
  });

  it("leaves a port, a time and a word after a colon, which are not the path of a remote", () => {
    const R = REDACTION_PLACEHOLDER;
    const commit = "a090492d".repeat(5);
    const cases: [string, string][] = [
      ["ssh root@10.0.0.5:22 failed", "ssh root@10.0.0.5:22 failed"],
      ["relay jane@example.com:587 refused", `relay ${R}:587 refused`],
      ["mail from jane@example.com:10:42:07", `mail from ${R}:10:42:07`],
      ["jane@example.com:thanks and root@box:ok", `${R}:thanks and root@box:ok`],
      ["write to jane@example.com: the file a/app.git", `write to ${R}: the file a/app.git`],
      ["jane@example.com and repo:acme/app.git", `${R} and repo:acme/app.git`],
      [`git show ${commit}:README.md`, `git show ${R}:README.md`],
      [`ghcr.io/acme/app@sha256:${"ab12".repeat(16)}`, `ghcr.io/acme/app@sha256:${R}`],
      ["listening on db.internal:5432, see src/index.ts:12:3", "listening on db.internal:5432, see src/index.ts:12:3"],
      ["git@myhost:app", "git@myhost:app"],
      ["root@box:~/project$ npm test", "root@box:~/project$ npm test"],
    ];
    for (const [input, expected] of cases) expect(redactStage1(input).text, input).toBe(expected);
  });

  it("replaces the remote in a line that git prints, which has no user (planning#684)", () => {
    const R = REDACTION_PLACEHOLDER;
    const hidden: [string, string][] = [
      ["To github.com:acme/app.git\n ! [rejected]        main -> main", `To ${R}\n ! [rejected]        main -> main`],
      ["From github.com:acme/app\n * branch            main       -> FETCH_HEAD", `From ${R}\n * branch            main       -> FETCH_HEAD`],
      ["Pushing to github.com:acme/app.git", `Pushing to ${R}`],
      ["error: failed to push some refs to 'github.com:acme/app.git'", `error: failed to push some refs to '${R}'`],
      ["To work:acme/app.git", `To ${R}`],
      ["From git.corp.example:/srv/git/team/app", `From ${R}`],
      ["To myhost:app.git", `To ${R}`],
      ["From git.example.org:2fa/app", `From ${R}`],
      [String.raw`{"stderr":"To github.com:acme/app.git\n ! [rejected]"}`, String.raw`{"stderr":"To ` + R + String.raw`\n ! [rejected]"}`],
      // In JSON, a written `\n` is before the phrase: the letter `n` and no word boundary.
      [String.raw`{"stderr":"Counting objects: 5\nTo github.com:acme/app.git\nDone"}`, String.raw`{"stderr":"Counting objects: 5\nTo ` + R + String.raw`\nDone"}`],
      [String.raw`"remote: done\r\nFrom github.com:acme/app\n * branch"`, String.raw`"remote: done\r\nFrom ` + R + String.raw`\n * branch"`],
      ["> To github.com:acme/app.git", `> To ${R}`],
    ];
    for (const [input, expected] of hidden) {
      expect(redactStage1(input), input).toEqual({ text: expected, redactedCount: 1 });
    }
    for (const visible of [
      "To localhost:3000/api/x the request fails",
      "pull registry.example.com:5000/team/app:1.2",
      "package.json:scripts/build and README.md:intro/usage",
      "From: jane and To: ops",
      "From src/server/index.ts:12:3",
      "From myhost:app",
      "To D:/proj/x and From v:a/b",
      "UpTo github.com:acme/app and xnTo github.com:acme/app",
      "the path to data:image/png and from gs:bucket/dir/file",
    ]) {
      expect(redactStage1(visible), visible).toEqual({ text: visible, redactedCount: 0 });
    }
  });

  // The three last steps of Stage 1 as scans. A path is the longest text of path characters,
  // `/` and placeholders: it must have a `/` in it, or, where `gitEnd` is set, end in `.git`
  // at a word boundary.
  const R = REDACTION_PLACEHOLDER;
  const isIn = (set: RegExp, text: string, at: number): boolean => at < text.length && set.test(text[at]);
  const pathEnd = (text: string, from: number, gitEnd: boolean): number => {
    let end = from;
    let slash = false;
    let git = -1;
    for (let items = 1; ; items++) {
      if (text.startsWith(R, end)) end += R.length;
      else if (isIn(/[A-Za-z0-9._/-]/, text, end)) {
        if (text[end] === "/") slash = true;
        end++;
      } else break;
      if (items > 4 && text.slice(end - 4, end) === ".git" && !isIn(/\w/, text, end)) git = end;
    }
    if (slash) return end;
    return gitEnd ? git : -1;
  };
  const scpRemotes = (text: string): { text: string; added: number } => {
    let out = "";
    let at = 0;
    let added = 0;
    for (let i = 0; i < text.length; ) {
      const atBoundary = isIn(/\w/, text, i) !== (i > 0 && isIn(/\w/, text, i - 1));
      if (!atBoundary || !isIn(/[A-Za-z0-9._-]/, text, i)) {
        i++;
        continue;
      }
      let run = i;
      while (isIn(/[A-Za-z0-9._-]/, text, run)) run++;
      let host = run + 1;
      while (text[run] === "@" && isIn(/[A-Za-z0-9.-]/, text, host)) host++;
      const end = text[run] === "@" && host > run + 1 && text[host] === ":" ? pathEnd(text, host + 1, false) : -1;
      if (end < 0) {
        i = run;
        continue;
      }
      out += `${text.slice(at, i)}${R}`;
      at = i = end;
      added++;
    }
    return { text: out + text.slice(at), added };
  };
  const extendOverScpPath = (text: string): string => {
    let out = "";
    let at = 0;
    for (let start = text.indexOf(R); start >= 0; start = text.indexOf(R, at)) {
      let host = start + R.length;
      while (isIn(/[A-Za-z0-9.-]/, text, host)) host++;
      const end = text[host] === ":" ? pathEnd(text, host + 1, true) : -1;
      out += end < 0 ? text.slice(at, start + R.length) : `${text.slice(at, start)}${R}`;
      at = end < 0 ? start + R.length : end;
    }
    return out + text.slice(at);
  };

  const gitOutputRemotes = (text: string): { text: string; added: number } => {
    let out = "";
    let at = 0;
    let added = 0;
    for (let i = 0; i < text.length; i++) {
      const afterWrittenLineEnd = i > 1 && text[i - 2] === "\\" && "nrt".includes(text[i - 1]);
      if (i > 0 && isIn(/\w/, text, i - 1) && !afterWrittenLineEnd) continue;
      const phrase = ["To ", "From ", "Pushing to ", "refs to "].find((words) => text.startsWith(words, i));
      if (phrase === undefined) continue;
      const host = i + phrase.length + (text[i + phrase.length] === "'" ? 1 : 0);
      let colon = host;
      while (isIn(/[A-Za-z0-9.-]/, text, colon)) colon++;
      if (colon - host < 2 || text[colon] !== ":") continue;
      let digits = colon + 1;
      while (isIn(/[0-9]/, text, digits)) digits++;
      if (digits > colon + 1 && text[digits] === "/") continue;
      const end = pathEnd(text, colon + 1, true);
      if (end < 0) continue;
      out += `${text.slice(at, host)}${R}`;
      at = end;
      i = end - 1;
      added++;
    }
    return { text: out + text.slice(at), added };
  };

  // Each of the three shapes is tried once in a run. The expected text is from one global
  // pattern for each, which is what Stage 1 had, and then the three last steps. The strings are
  // shorter than 40 characters, and their parts cannot start a URL, a key, a scheme or a
  // home path: no other step can match.
  it("replaces an e-mail address, an SSH remote and a JWT exactly where a global pattern matches one", () => {
    const globalPatterns = [
      /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+\.git\b/g,
    ];
    const parts: Record<string, string[]> = {
      "e-mail": ["a", "bc", "x1", "_", ".", "-", "%", "+", "@", "@", " ", "cc", ".cc", "a@b.cc", "["],
      "ssh remote": ["a", "git", ".git", ".git", ".", "-", "_", "@", "@", ":", ":", "p/q", " ", "h", "u@h:p.git", "x1"],
      jwt: ["eyJ", "eyJ", "abcdef", "abcdefg", "-", "-", "_", ".", ".", " ", "x", ["eyJabcdef", "ghijkl", "mnopqr"].join(".")],
      "scp path": ["a@b.cc:", "a@b.cc:", "a@b.cc-x:", "a@b.cc.:p", "a@b.cc", ":", "p/q", ".git", ".git", ".git", "a", "-", "_", ".", " ", "x1", "u@h:p.git"],
      "remote with no .git": ["u@h:", "u@h:", "u@h", "@", ":", ":", "p/q", "p", "/", "a", "-", "_", ".", " ", "x1", "a@b.cc", ".git"],
      "git output": ["To h.x:", "From ab:", "refs to 'ab:", "Pushing to ab:", "To a:", "To ", "to ab:", "'", ":", "p/q", "p/q", "p", "/", ".git", "22/", "22", " ", "x1", "u@h:", "a@b.cc:", "h.x:", "\\n", "\\", "n"],
    };
    for (const [shape, from] of Object.entries(parts)) {
      let seed = 1;
      const below = (n: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return Math.floor((seed / 2 ** 32) * n);
      };
      const different: string[] = [];
      let withMatch = 0;
      let withRemote = 0;
      let withScpPath = 0;
      let withGitOutput = 0;
      for (let i = 0; i < 4000; i++) {
        let input = "";
        for (let n = 1 + below(12); n > 0; n--) {
          const part = from[below(from.length)];
          if (input.length + part.length < 40) input += part;
        }
        let shapes = input;
        let count = 0;
        for (const re of globalPatterns) {
          shapes = shapes.replace(re, () => {
            count++;
            return REDACTION_PLACEHOLDER;
          });
        }
        const remotes = scpRemotes(shapes);
        const extended = extendOverScpPath(remotes.text);
        const printed = gitOutputRemotes(extended);
        if (count > 0) withMatch++;
        if (remotes.added > 0) withRemote++;
        if (extended !== remotes.text) withScpPath++;
        if (printed.added > 0) withGitOutput++;
        const result = redactStage1(input);
        if (result.text !== printed.text || result.redactedCount !== count + remotes.added + printed.added) {
          different.push(input);
        }
      }
      expect(different, shape).toEqual([]);
      // A generator that makes no match compares nothing.
      if (shape !== "git output") expect(withMatch, shape).toBeGreaterThan(500);
      if (shape === "scp path") expect(withScpPath, shape).toBeGreaterThan(200);
      if (shape === "remote with no .git") expect(withRemote, shape).toBeGreaterThan(200);
      if (shape === "git output") expect(withGitOutput, shape).toBeGreaterThan(200);
    }
  });

  it("stays linear on a report body that was written to make a pattern slow", () => {
    const hostile: Record<string, (size: number) => string> = {
      "e-mail starts": (n) => "a.".repeat(n / 2),
      "e-mail starts of every kind": (n) => "a.b-c%d+e_".repeat(n / 10),
      "e-mail starts, then an @ and no domain": (n) => `${"a.".repeat(n / 2)}@b`,
      "e-mail starts, then a real tail": (n) => `${"a.".repeat(n / 2)}a@b.cc`,
      "e-mail one-letter domains": (n) => "a@a.".repeat(n / 4),
      "e-mail long domain of one-letter labels": (n) => `a@${"b.".repeat(n / 2)}`,
      "e-mail addresses in one run": (n) => "a@b.cc.".repeat(n / 7),
      "a@ pairs": (n) => "a@".repeat(n / 2),
      "ssh starts": (n) => "a-".repeat(n / 2),
      "ssh starts, then a real tail": (n) => `${"a-".repeat(n / 2)}u@h:p.git`,
      "ssh long path with no .git": (n) => `a@b:${"c/".repeat(n / 2)}`,
      "ssh remotes with no .git": (n) => "a@b:c ".repeat(n / 6),
      "ssh remotes in one run": (n) => "a@b:c.git.".repeat(n / 10),
      "jwt starts": (n) => "eyJ-".repeat(n / 4),
      "jwt starts, then a real tail": (n) => `${"eyJ-".repeat(n / 4)}.aaaaaa.bbbbbb`,
      "jwt starts, then a tail that fails": (n) => `${"eyJ-".repeat(n / 4)}.aaaaaa.b`,
      "jwt segments": (n) => "eyJaaaaaa.".repeat(n / 10),
      "jwt long second segment with starts": (n) => `eyJaaaaaa.${"eyJ-".repeat(n / 4)}`,
      "sweep boundaries, then hyphens": (n) => `${"a-".repeat(20)}${"-".repeat(n)}`,
      "sweep letters": (n) => "a".repeat(n),
      "scheme spaces": (n) => `Bearer${" ".repeat(n)}x`,
      "path starts": (n) => "/home/".repeat(n / 6),
      "path long user": (n) => `/home/${"x".repeat(n)}`,
      "url starts": (n) => "http:/".repeat(n / 6),
      "url long host": (n) => `http://${"a.".repeat(n / 2)}`,
      "url host of many different characters": (n) =>
        `http://${Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + (i % 20_000))).join("")}`,
      "scp path of slashes": (n) => `a@b.cc:${"c/".repeat(n / 2)}`,
      "scp path with no slash and no .git": (n) => `a@b.cc:${"c.".repeat(n / 2)}`,
      "scp path with no slash, then a real tail": (n) => `a@b.cc:${"c.".repeat(n / 2)}git`,
      "remote path with no slash": (n) => `a@b:${"c.".repeat(n / 2)}`,
      "remote path of written placeholders": (n) => `a@b:${REDACTION_PLACEHOLDER.repeat(n / 10)}`,
      "remotes with no slash in one run": (n) => "a@b:c.".repeat(n / 6),
      "remotes with a slash": (n) => "a@b:c/d ".repeat(n / 8),
      "remote starts, then a real tail": (n) => `${"a.".repeat(n / 2)}u@h:p/q`,
      "git phrases": (n) => "To From refs to 'Pushing to ".repeat(n / 28),
      "git phrase, then a long host with no colon": (n) => `To ${"a.".repeat(n / 2)}`,
      "git phrase, then a path with no slash": (n) => `To ab:${"c.".repeat(n / 2)}`,
      "git phrases, each with a port": (n) => "From ab:123/x ".repeat(n / 14),
      "git phrases after a written line end": (n) => String.raw`\nTo ab:c `.repeat(n / 10),
      "git phrase, then a path of slashes": (n) => `To ab:${"c/".repeat(n / 2)}`,
      "git lines": (n) => "To ab:c/d\n".repeat(n / 10),
      "git phrases with a host and no path": (n) => "To ab: ".repeat(n / 7),
      "scp path of addresses": (n) => `a@b.cc:${"c@d.ee/".repeat(n / 7)}`,
      "scp path of .git that a letter follows": (n) => `a@b.cc:${".gitx".repeat(n / 5)}`,
      "addresses before a colon": (n) => "a@b.cc:".repeat(n / 7),
      "address, then a long host with no colon": (n) => `a@b.cc${"-a".repeat(n / 2)}`,
      "addresses with a host tail before a colon": (n) => "a@b.cc-x:".repeat(n / 9),
      "written placeholders with a host tail": (n) => `${REDACTION_PLACEHOLDER}a`.repeat(n / 11),
      "addresses before a colon and a letter": (n) => "a@b.cc:x".repeat(n / 8),
      "written placeholders before a colon": (n) => `${REDACTION_PLACEHOLDER}:`.repeat(n / 11),
      "written placeholder starts": (n) => "[REDACTED".repeat(n / 9),
    };
    // One match is all of the text: a limit on the length of a shape would show here.
    const whole = [
      "e-mail starts, then a real tail",
      "ssh starts, then a real tail",
      "jwt starts, then a real tail",
      "ssh long path with no .git",
      "scp path of slashes",
      "scp path with no slash, then a real tail",
      "remote starts, then a real tail",
    ];
    for (const [name, make] of Object.entries(hostile)) {
      // Up to the size limit of an HTTP request, 1 MiB. The route refuses a report body above
      // 60,000 characters, but that is a second protection and not what makes Stage 1 safe.
      // Smallest first: a quadratic pattern fails at a small size, after seconds. At the full
      // size it needs many minutes, and no timeout can stop a synchronous call.
      for (const size of [16_000, 64_000, 256_000, 1_024_000]) {
        const input = make(size);
        const started = performance.now();
        const result = redactStage1(input);
        expect(performance.now() - started, `${name}, ${size} characters`).toBeLessThan(3_000);
        if (whole.includes(name)) {
          // Not `toBe` on the text: a failure would print all of it.
          expect(result.text === REDACTION_PLACEHOLDER && result.redactedCount === 1, `${name}, ${size} characters`).toBe(true);
        }
      }
    }
  }, 60_000);
});

describe("redact (two-stage)", () => {
  it("runs Stage 1 only when no model runner is provided", async () => {
    const result = await redact("token ghp_ABCDEFGHIJKLMNOP1234567890abcd");
    expect(result.stage2Ran).toBe(false);
    expect(result.body).not.toContain("ghp_ABCDEFGHIJKLMNOP");
  });

  it("applies Stage-2 spans returned by the model (deletions only)", async () => {
    const run = async () => JSON.stringify({ spans: ["Acme Corp", "Jane Smith"] });
    const result = await redact("Reported by Jane Smith at Acme Corp during the demo.", { run });
    expect(result.stage2Ran).toBe(true);
    expect(result.body).not.toContain("Jane Smith");
    expect(result.body).not.toContain("Acme Corp");
    expect(result.body).toContain(REDACTION_PLACEHOLDER);
  });

  it("ignores model 'spans' that are not verbatim substrings (no injection)", async () => {
    const run = async () => JSON.stringify({ spans: ["TOTALLY NEW INJECTED TEXT"] });
    const input = "The build crashed on startup.";
    const result = await redact(input, { run });
    expect(result.stage2Ran).toBe(true);
    expect(result.body).toBe(input);
    expect(result.body).not.toContain("INJECTED");
  });

  it("degrades to the Stage-1 floor + flag when the model call fails", async () => {
    const run = async () => {
      throw new Error("CLI timed out");
    };
    const result = await redact("token ghp_ABCDEFGHIJKLMNOP1234567890abcd and name Jane Smith", { run });
    expect(result.stage2Ran).toBe(false);
    expect(result.body).not.toContain("ghp_ABCDEFGHIJKLMNOP");
    expect(result.body).toContain("Jane Smith");
  });

  it("degrades when the model output is unparseable", async () => {
    const run = async () => "I'm sorry, I cannot do that.";
    const result = await redact("hello world", { run });
    expect(result.stage2Ran).toBe(false);
    expect(result.body).toBe("hello world");
  });
});

describe("redactCredentials (docs/326-ops-session-transcript req 3)", () => {
  const R = REDACTION_PLACEHOLDER;
  // Built from parts: the commit secret scan reads this file, and these are not secrets.
  const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4"].join(".");
  const keyLine = (edge: "BEGIN" | "END", kind = ""): string => `-----${edge} ${kind}PRIVATE KEY-----`;

  it("replaces the listed credential shapes", () => {
    for (const secret of [
      "ghp_ABCDEFGHIJKLMNOP1234567890abcd",
      ["github_pat_", "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789"].join(""),
      "sk-ant-abcdefghijklmnop",
      "sk-abcdefghijklmnopqrstuvwx",
      ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
      ["xoxb-", "123456789012-abcdef"].join(""),
      JWT,
    ]) {
      const { text, redactedCount } = redactCredentials(`before ${secret} after`);
      expect(text, secret).toBe(`before ${R} after`);
      expect(redactedCount, secret).toBe(1);
    }
  });

  it("replaces the value of an authorization scheme, and leaves prose about tokens alone", () => {
    const cases: [string, string][] = [
      ["Authorization: Bearer abcdef1234567890XYZ", `Authorization: Bearer ${R}`],
      // After the header, any value: this one is `user:pass`, short and with no digit.
      ["Authorization: Basic dXNlcjpwYXNz", `Authorization: Basic ${R}`],
      ['{"Authorization": "Bearer abc"}', `{"Authorization": "Bearer ${R}"}`],
      ["Proxy-Authorization: token abcdefgh", `Proxy-Authorization: token ${R}`],
      // With no header: a digit, or 32 characters.
      ["curl -H 'X-Auth: Bearer abcdef1234567890XYZ'", `curl -H 'X-Auth: Bearer ${R}'`],
      ["token abcdefghijklmnopqrstuvwxyzABCDEFGH", `token ${R}`],
    ];
    for (const [input, expected] of cases) expect(redactCredentials(input).text, input).toBe(expected);
    for (const prose of [
      "[Token documentation](https://example.com)",
      "Use token authentication for the API.",
      "Bearer authentication is the default.",
      "Basic configuration follows.",
    ]) {
      expect(redactCredentials(prose).text, prose).toBe(prose);
    }
  });

  it("finds each shape in the original text, so one replacement cannot hide a larger credential", () => {
    const cases: [string, string][] = [
      ["Bearer ghp_ABCDEFGHIJKLMNOP.secret123", `Bearer ${R}`],
      ["eyJabcdefg.sk-abcdefghijklmnop.qrstuvwx", R],
      ["TOKEN=x://u:'a@h b' rest", `TOKEN=${R} rest`],
      [String.raw`{"out":"TOKEN=\"ghp_ABCDEFGHIJKLMNOP\"def"}`, `{"out":"TOKEN=${R}"}`],
    ];
    for (const [input, expected] of cases) {
      const result = redactCredentials(input);
      expect(result.text, input).toBe(expected);
      expect(result.redactedCount, input).toBe(1);
    }
  });

  it("matches a JWT exactly where the Stage 1 pattern matches one", () => {
    const stage1Jwt = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
    for (const input of [
      `token=${JWT}`,
      `x-${JWT}`,
      `a-b-${JWT} c`,
      `under_${JWT}`,
      `first.${JWT}.more`,
      `eyJ-${JWT}`,
      `${JWT}-${JWT}`,
      `${JWT} ${JWT}`,
      "eyJabc.eyJdefghij.klmnopqr",
      "eyJabcdefg.short.klmnopqr",
      "eyJabcdefg.hijklmnop",
      "abc-eyJ.abcdefgh.ijklmnop",
      `-eyJ-eyJabcdefg.hijklmnop.qrstuvwx`,
    ]) {
      expect(redactCredentials(input).text, input).toBe(input.replace(stage1Jwt, R));
    }
  });

  it("replaces all of a URL password, also one with an @ in it, and keeps the rest of the URL", () => {
    expect(redactCredentials("postgres://app:s3cr3t-pw@db.internal:5432/main").text)
      .toBe(`postgres://app:${R}@db.internal:5432/main`);
    expect(redactCredentials("https://user:abc@def@example.com/x").text).toBe(`https://user:${R}@example.com/x`);
    expect(redactCredentials("https://:tokenvalue@host/x").text).toBe(`https://:${R}@host/x`);
  });

  it("leaves a URL with no password as it is, also inside JSON", () => {
    for (const text of [
      "http://localhost:3000/a@b",
      ["https://example.com:443", "?email=jane@example.net"].join(""),
      "https://example.com:443/path?x=a@b#c@d",
      "http://[::1]:3000/a@b",
      "ssh://git@github.com/acme/app.git",
      '{"url":"https://example.com:443","email":"jane@example.net"}',
      '{"url":"http://[::1]:3000","email":"a@example.net"}',
      "<https://example.com:443> jane@example.net",
      "const c={url:'http://localhost:3000',email:'dev@example.com'};",
    ]) {
      expect(redactCredentials(text).text, text).toBe(text);
    }
  });

  it("replaces the whole value of an environment-style secret assignment", () => {
    const cases: [string, string][] = [
      ["DB_PASSWORD=hunter2", `DB_PASSWORD=${R}`],
      ["TOKEN=abc123 next", `TOKEN=${R} next`],
      ["STRIPE_API_KEY_LIVE=sk_live_abc next", `STRIPE_API_KEY_LIVE=${R} next`],
      ['export STRIPE_SECRET_KEY="whsec_plain"', `export STRIPE_SECRET_KEY=${R}`],
      ['DB_PASSWORD="two words here" rest', `DB_PASSWORD=${R} rest`],
      ["DB_PASSWORD='two words' rest", `DB_PASSWORD=${R} rest`],
      // An escaped quote, and a line end, inside the quotes.
      [String.raw`DB_PASSWORD="abc\"def" rest`, `DB_PASSWORD=${R} rest`],
      ['API_KEY="first\nsecond" rest', `API_KEY=${R} rest`],
      // One shell word made of quoted and bare parts, and an escaped space.
      [`PASSWORD='ab'"'"'cd' rest`, `PASSWORD=${R} rest`],
      [String.raw`PASSWORD=one\ two rest`, `PASSWORD=${R} rest`],
      // A quoted value that starts with a comma or a line end.
      ['TOKEN=",secret" rest', `TOKEN=${R} rest`],
      ['TOKEN="\r\nsecret" rest', `TOKEN=${R} rest`],
      // A backslash before a letter is part of the value.
      [String.raw`TOKEN=one\two rest`, `TOKEN=${R} rest`],
      // A quote that never closes hides the rest: too much is safer than too little.
      ['A_TOKEN="abc def', `A_TOKEN=${R}`],
      ['X_TOKEN=abc"def rest', `X_TOKEN=${R}`],
      ['echo "set A_TOKEN="', `echo "set A_TOKEN=${R}`],
      // As `docker inspect` prints an environment, spaced and compact.
      [`"Env": ["API_KEY=abc123", "PATH=/usr/bin"]`, `"Env": ["API_KEY=${R}", "PATH=/usr/bin"]`],
      [`{"env":["API_KEY=abc123","PATH=/usr/bin"]}`, `{"env":["API_KEY=${R}","PATH=/usr/bin"]}`],
      // As JSON prints a shell value: the quotes escaped, an escaped quote escaped twice, a
      // part after the closing quote, and an escaped space.
      [String.raw`{"env": "FOO_TOKEN=\"abc def\""}`, `{"env": "FOO_TOKEN=${R}"}`],
      [String.raw`{"env":"DB_PASSWORD=\"abc\\\"def\""}`, `{"env":"DB_PASSWORD=${R}"}`],
      [String.raw`{"out":"TOKEN=\"abc\"def"}`, `{"out":"TOKEN=${R}"}`],
      [String.raw`{"out":"TOKEN=one\\ two"}`, `{"out":"TOKEN=${R}"}`],
      // As JSON prints two lines: the written-out line end closes the first value.
      [String.raw`{"out":"A_TOKEN=abc\nNEXT=1"}`, String.raw`{"out":"A_TOKEN=` + R + String.raw`\nNEXT=1"}`],
      // A secret inside the quoted value of a name that is not a secret.
      ['OPTS="--user x DB_PASSWORD=hunter2 --fast"', `OPTS="--user x DB_PASSWORD=${R} --fast"`],
    ];
    for (const [input, expected] of cases) {
      expect(redactCredentials(input).text, input).toBe(expected);
    }
  });

  it("leaves an assignment that holds no secret as it is", () => {
    for (const input of [
      // A token COUNT is not a token.
      "MAX_OUTPUT_TOKENS=32000",
      // A lower-case assignment is code, not an environment.
      "const token = getToken();",
      "password=hunter2",
      // A name that ends in a word for a fact about the secret.
      "TOKEN_FILE=/workspace/token",
      "CREDENTIAL_HELPER_URL=https://github.com/acme/app",
      "PRIVATE_KEY_PATH=/home/jane/.ssh/id_ed25519",
      "env:\n  - TOKEN_TTL=3600\n  - SECRET_NAME=billing-prod",
      "PATH=/usr/bin",
      // No value.
      "A_TOKEN=\nnext line",
      // A tokenizer is not a token, and `==` is a comparison.
      "TOKENIZERS_PARALLELISM=false",
      "if TOKEN==expected: pass",
    ]) {
      expect(redactCredentials(input).text, input).toBe(input);
    }
  });

  it("counts a credential once when two shapes match it", () => {
    for (const input of [
      "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOP1234567890abcd",
      'GITHUB_TOKEN="ghp_ABCDEFGHIJKLMNOP1234567890abcd"',
    ]) {
      const { text, redactedCount } = redactCredentials(input);
      expect(text, input).not.toContain("ghp_");
      expect(redactedCount, input).toBe(1);
    }
  });

  it("replaces a private key block, also one that is cut off before its end", () => {
    const body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAMwAAAAtzc2gtZWQyNTUxOQAAACD";
    const key = `${keyLine("BEGIN", "OPENSSH ")}\n${body}\n${keyLine("END", "OPENSSH ")}`;
    expect(redactCredentials(`key:\n${key}\ndone`).text).toBe(`key:\n${R}\ndone`);
    // Cut off: it ends where the key text ends.
    expect(redactCredentials(`${keyLine("BEGIN", "RSA ")}\n${body}`).text).toBe(R);
    expect(redactCredentials(`${keyLine("BEGIN", "RSA ")}\n${body}\n(truncated)`).text).toBe(`${R}(truncated)`);
    // As JSON prints it, on one line.
    const oneLine = [keyLine("BEGIN"), body.replace("\n", String.raw`\n`), keyLine("END"), ""].join(String.raw`\n`);
    expect(redactCredentials(`{"key":"${oneLine}"}`).text).toBe(String.raw`{"key":"` + R + String.raw`\n"}`);
    // With the legacy encryption header.
    const legacy = [keyLine("BEGIN", "RSA "), "Proc-Type: 4,ENCRYPTED", "DEK-Info: AES-256-CBC,0A1B", "", body, keyLine("END", "RSA ")];
    expect(redactCredentials(legacy.join("\n")).text).toBe(R);
    // With the line ends of Windows.
    expect(redactCredentials(`${key.replaceAll("\n", "\r\n")}\r\ndone`).text).toBe(`${R}\r\ndone`);
    // With lines of eight characters, which a key parser accepts.
    const narrow = [keyLine("BEGIN"), "MC4CAQAw", "BQYDK2Vw", "BCIEICVj", "3OV0+b6w", keyLine("END")].join("\n");
    expect(redactCredentials(narrow).text).toBe(R);
  });

  it("leaves source code that only names the key marker as it is", () => {
    const source = `const PEM_HEADER = "${keyLine("BEGIN")}";\nconst path = "/workspace/a.ts";`;
    expect(redactCredentials(source).text).toBe(source);
    const prose = `The file starts with ${keyLine("BEGIN")} and then the key follows.`;
    expect(redactCredentials(prose).text).toBe(prose);
  });

  it("stays linear on text that another session wrote to make a pattern slow", () => {
    const size = 2_000_000;
    const longName = `TOKEN_${"A".repeat(1018)}`;
    const hostile: Record<string, string> = {
      "jwt starts": "eyJ-".repeat(size / 4),
      "jwt starts, then a real tail": `${"eyJ-".repeat(size / 4)}.aaaaaa.bbbbbb`,
      "jwt hyphen groups, then a real tail": `${"ab-".repeat(size / 3)}.aaaaaa.bbbbbb`,
      "jwt segments": "eyJaaaaaa.".repeat(size / 10),
      "url scheme runs": "a.".repeat(size / 2),
      "url colons": `a://${"b:".repeat(size / 2)}`,
      "url password with no @": `a://u:${"x".repeat(size)}`,
      "url password of @": `a://u:${"x@".repeat(size / 2)}`,
      "assignment keyword run": "TOKEN".repeat(size / 5),
      "assignment keyword run, then = and no value": `${"TOKEN_".repeat(size / 6)}=`,
      "assignment long names, then = and no value": `${longName.repeat(size / 1024)}=`,
      "assignment metadata run": `${"A_FILE_".repeat(size / 7)}=x`,
      "assignment starts": "A_TOKEN ".repeat(size / 8),
      "assignments with no value": "A_TOKEN= ".repeat(size / 9),
      "open quotes": 'A_TOKEN="x '.repeat(size / 11),
      "open escaped quotes": String.raw`A_TOKEN=\"x `.repeat(size / 12),
      "backslashes in quotes": `A_TOKEN="${"\\".repeat(size)}`,
      "backslashes in escaped quotes": `A_TOKEN=\\"${"\\".repeat(size)}`,
      "quotes before spaces": `A_TOKEN=${'" '.repeat(size / 2)}`,
      "key block ends": `${keyLine("BEGIN")}\n${"A".repeat(16)}${"-----END A".repeat(size / 10)}`,
      "key block with no end": `${keyLine("BEGIN")}\n${"A".repeat(size)}`,
      "key block starts": `${keyLine("BEGIN")} `.repeat(size / 28),
      dashes: "-".repeat(size),
      "scheme spaces": `Bearer${" ".repeat(size)}x`,
      "scheme words": "Token abcdefghijkl ".repeat(size / 19),
    };
    for (const [name, input] of Object.entries(hostile)) {
      const started = performance.now();
      redactCredentials(input);
      // A pattern that scans a run again from each of its positions needs minutes for this size.
      expect(performance.now() - started, name).toBeLessThan(3_000);
    }
  });

  it("keeps what an investigation needs: URLs, paths, e-mail addresses, commit hashes", () => {
    const input = [
      "https://github.com/acme/app/pull/3120",
      "/workspace/src/index.ts and /home/jane/.config",
      "jane.doe@example.com",
      "git@github.com:acme/app.git",
      "a090492df34eda2d2896d7ade860d166507d113a",
    ].join("\n");
    const { text, redactedCount } = redactCredentials(input);
    expect(text).toBe(input);
    expect(redactedCount).toBe(0);
  });
});
