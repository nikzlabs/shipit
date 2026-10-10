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
      `github_pat_${"11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789"}`,
      "sk-ant-abcdefghijklmnop",
      "sk-abcdefghijklmnopqrstuvwx",
      `AKIA${"ABCDEFGHIJKLMNOP"}`,
      `xoxb-${"123456789012-abcdef"}`,
      JWT,
    ]) {
      const { text, redactedCount } = redactCredentials(`before ${secret} after`);
      expect(text, secret).toBe(`before ${R} after`);
      expect(redactedCount, secret).toBe(1);
    }
  });

  it("replaces the value of an authorization scheme, and leaves prose about tokens alone", () => {
    expect(redactCredentials("Authorization: Bearer abcdef1234567890XYZ").text).toBe(`Authorization: Bearer ${R}`);
    expect(redactCredentials("Authorization: Basic dXNlcjpodW50ZXIy").text).toBe(`Authorization: Basic ${R}`);
    expect(redactCredentials("Authorization: token abcdefghijklmnopqrstuvwxyzABCDEFGH").text)
      .toBe(`Authorization: token ${R}`);
    for (const prose of [
      "[Token documentation](https://example.com)",
      "Use token authentication for the API.",
      "Bearer authentication is the default.",
      "Basic configuration follows.",
    ]) {
      expect(redactCredentials(prose).text, prose).toBe(prose);
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
      // A quote that never closes hides the rest: too much is safer than too little.
      ['A_TOKEN="abc def', `A_TOKEN=${R}`],
      ['X_TOKEN=abc"def rest', `X_TOKEN=${R}`],
      // As `docker inspect` prints an environment, spaced and compact.
      [`"Env": ["API_KEY=abc123", "PATH=/usr/bin"]`, `"Env": ["API_KEY=${R}", "PATH=/usr/bin"]`],
      [`{"env":["API_KEY=abc123","PATH=/usr/bin"]}`, `{"env":["API_KEY=${R}","PATH=/usr/bin"]}`],
      // As JSON prints a quoted value: the quotes escaped, and an escaped quote escaped twice.
      [String.raw`"env": "FOO_TOKEN=\"abc def\"" rest`, `"env": "FOO_TOKEN=${R}" rest`],
      [String.raw`{"env":"DB_PASSWORD=\"abc\\\"def\""}`, `{"env":"DB_PASSWORD=${R}"}`],
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
      'echo "set A_TOKEN="',
      "A_TOKEN=\nnext line",
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
