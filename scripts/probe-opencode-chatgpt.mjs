import { generateSessionName } from "../src/server/orchestrator/session-namer.ts";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { killProcessTree } from "../src/server/shared/kill-child.ts";
import {
  opencodeAccountConfig,
  prepareOpenCodeAccountEnv,
} from "../src/server/shared/opencode-spawn-shaping.ts";
import { ensureManagedOpenCodeData } from "../src/server/shared/opencode-account.ts";
import { compactOpencodeSession } from "../src/server/session/agents/opencode/compaction.ts";
// Run with: node --import tsx scripts/probe-opencode-chatgpt.mjs
// All credentials are synthetic. The local proxy NEVER forwards requests.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-chatgpt-probe-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    root + "/key.pem",
    "-out",
    root + "/cert.pem",
    "-subj",
    "/CN=chatgpt.com",
    "-addext",
    "subjectAltName=DNS:chatgpt.com,DNS:auth.openai.com",
  ],
  { stdio: "ignore" },
);
const home = fs.mkdtempSync(root + "/home-");
let data = home + "/.local/share";
fs.mkdirSync(data + "/opencode", { recursive: true });
const token = (tag) =>
  "eyJhbGciOiJub25lIn0." +
  Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      tag,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "synthetic-account",
      },
    }),
  ).toString("base64url") +
  ".synthetic";
const auth = (tag) =>
  fs.writeFileSync(
    data + "/opencode/auth.json",
    JSON.stringify({
      openai: {
        type: "oauth",
        access: token(tag),
        refresh: "",
        expires: Date.now() + 3600000,
        accountId: "synthetic-account",
      },
    }),
  );
auth("first");
const model = "gpt-5.5";
const config = { ...opencodeAccountConfig(model), permission: "allow" };
fs.writeFileSync(home + "/config.json", JSON.stringify(config));
fs.writeFileSync(
  home + "/opencode.json",
  JSON.stringify({
    model: "wrong/model",
    small_model: "wrong/model",
    provider: { openai: { options: { baseURL: "https://wrong.invalid/v1" } } },
  }),
);
fs.writeFileSync(
  home + "/pixel.png",
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=",
    "base64",
  ),
);
let naming = false;
let count = 0;
let mainCount = 0;
const records = [];
const upstream = https.createServer(
  {
    key: fs.readFileSync(root + "/key.pem"),
    cert: fs.readFileSync(root + "/cert.pem"),
  },
  (req, res) => {
    let body = "";
    req.on("data", (x) => (body += x));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {}
      records.push({
        host: req.headers.host,
        path: req.url,
        token:
          req.headers.authorization ===
          `Bearer ${token(count ? "second" : "first")}`
            ? "expected"
            : req.headers.authorization
              ? "other"
              : "absent",
        account: req.headers["chatgpt-account-id"],
        model: parsed?.model,
        reasoning: parsed?.reasoning,
        image: String(JSON.stringify(parsed?.input)).includes("input_image"),
        tools: parsed?.tools?.map((x) => x.name),
      });
      // token strings include stable expiry within this short probe; record only the synthetic tag as a robust comparison.
      if (req.headers.authorization) {
        try {
          records.at(-1).tokenTag = JSON.parse(
            Buffer.from(
              req.headers.authorization.split(".")[1],
              "base64url",
            ).toString(),
          ).tag;
        } catch {}
      }
      if (!req.url.includes("/responses")) {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      const n = count++;
      const index = parsed?.tools?.length ? mainCount++ : -1;
      const tool = index === 0 || index === 1;
      const item = tool
        ? {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: index === 0 ? "read" : "bash",
            arguments: JSON.stringify(
              index === 0
                ? { filePath: home + "/pixel.png" }
                : {
                    command:
                      'test "$(git config user.name)" = "Synthetic Probe" && echo synthetic-probe',
                    description: "Local synthetic check",
                  },
            ),
            status: "completed",
          }
        : {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: naming ? JSON.stringify({slug:"account-test",title:"Account Test"}) : "Synthetic check complete.",
                annotations: [],
              },
            ],
            status: "completed",
          };
      const response = {
        id: "resp_" + n,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model,
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let seq = 0;
      const send = (type, data) =>
        res.write(
          "event: " +
            type +
            "\ndata: " +
            JSON.stringify({ type, sequence_number: seq++, ...data }) +
            "\n\n",
        );
      send("response.created", {
        response: { ...response, status: "in_progress", output: [] },
      });
      send("response.output_item.added", {
        output_index: 0,
        item: tool
          ? { ...item, arguments: "", status: "in_progress" }
          : { ...item, content: [], status: "in_progress" },
      });
      if (tool) {
        send("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        });
        send("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: 0,
          arguments: item.arguments,
        });
        auth("second");
      } else {
        send("response.content_part.added", {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        send("response.output_text.delta", {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: item.content[0].text,
        });
        send("response.output_text.done", {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: item.content[0].text,
        });
      }
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", { response });
      res.end();
    });
  },
);
const proxy = http.createServer((req, res) => {
  records.push({ unexpected: req.url });
  res.writeHead(502);
  res.end();
});
proxy.on("connect", (req, socket, head) => {
  records.push({ connect: req.url });
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length) socket.unshift(head);
  upstream.emit("connection", socket);
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyUrl = "http://127.0.0.1:" + proxy.address().port;
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_DATA_HOME: data,
  XDG_CONFIG_HOME: home + "/config",
  XDG_CACHE_HOME: home + "/cache",
  PWD: home,
  OPENCODE_CONFIG: home + "/config.json",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_SHARE: "1",
  HTTPS_PROXY: proxyUrl,
  HTTP_PROXY: proxyUrl,
  NODE_EXTRA_CA_CERTS: root + "/cert.pem",
  NO_PROXY: "127.0.0.1,localhost",
};
fs.writeFileSync(home + "/gitconfig", "[user]\n  name = Synthetic Probe\n");
env.GIT_CONFIG_GLOBAL = home + "/gitconfig";
env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
prepareOpenCodeAccountEnv(env);
async function run(extra = [], expectedFailure = false) {
  const child = spawn(
    "opencode",
    [
      "run",
      "--format",
      "json",
      "--auto",
      "--model",
      "openai/" + model,
      "--variant",
      "high",
      ...extra,
      "Use bash once to echo synthetic-probe, then finish.",
    ],
    { cwd: home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (x) => (stdout += x));
  child.stderr.on("data", (x) => (stderr += x));
  const timer = setTimeout(() => killProcessTree(child), 30000);
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timer);
  assert.match(
    stdout,
    expectedFailure ? /Token refresh failed: 400/ : /Synthetic check complete/,
    stderr.slice(-2000),
  );
  return stdout;
}
try {
  const stdout = await run();
  assert.ok(stdout.includes("synthetic-probe\\n"));
  const session = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((e) => e.sessionID)?.sessionID;
  assert.ok(session);
  // Migrate the real CLI database, then resume from the managed XDG root.
  data = ensureManagedOpenCodeData(home);
  auth("second");
  env.XDG_DATA_HOME = data;
  await run(["-s", session]);
  let modelMetadata;
  await compactOpencodeSession({
    sessionId: session,
    modelId: model,
    providerId: "openai",
    cwd: home,
    env,
    spawnFn: spawn,
    onServerSpawned(proc) {
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk;
        const address = output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address && !modelMetadata)
          modelMetadata = fetch(address + "/provider", {
            signal: AbortSignal.timeout(10000),
          }).then((response) => response.json());
      });
    },
  });
  const providers = await modelMetadata;
  const native = providers?.all?.find((provider) => provider.id === "openai");
  assert.deepEqual(Object.keys(native.models), [model]);
  assert.deepEqual(native.models[model].limit, {
    context: 400000,
    input: 272000,
    output: 128000,
  });
  const calls = records.filter((r) => r.path?.endsWith("/responses"));
  assert.ok(calls.length >= 5);
  assert.ok(
    calls.every(
      (r) =>
        r.host === "chatgpt.com" &&
        r.path === "/backend-api/codex/responses" &&
        r.account === "synthetic-account" &&
        r.model === model,
    ),
  );
  assert.ok(
    calls.some((r) => r.tokenTag === "first") &&
      calls.some((r) => r.tokenTag === "second"),
  );
  assert.ok(calls.some((r) => r.reasoning?.effort === "high"));
  assert.ok(!records.some((r) => r.host === "auth.openai.com"));
  assert.ok(
    calls.some((r) => r.image),
    stdout,
  );
  const expired = JSON.parse(
    fs.readFileSync(data + "/opencode/auth.json", "utf8"),
  );
  expired.openai.expires = Date.now() - 1000;
  fs.writeFileSync(data + "/opencode/auth.json", JSON.stringify(expired));
  await run([], true);
  assert.equal(
    records.filter((r) => r.path?.endsWith("/responses")).length,
    calls.length,
  );
  assert.ok(records.some((r) => r.host === "auth.openai.com"));
  naming = true;
  const source = path.join(home, "source/.codex");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source,"auth.json"), JSON.stringify({tokens:{access_token:token("second"),refresh_token:"synthetic-source-only"}}));
  const keys = ["HTTPS_PROXY","HTTP_PROXY","NO_PROXY","NODE_EXTRA_CA_CERTS"];
  const previous = Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    for (const key of keys) process.env[key]=env[key];
    const result = await generateSessionName("test", {harnessId:"opencode", model, credentialRoot:path.dirname(source), serviceRouting:{serviceId:"openai",serviceName:"OpenAI",billingMode:"sub",style:"openai-responses",baseUrl:"https://api.openai.com/v1",credentialTarget:{kind:"openai-chatgpt",accountId:"synthetic-route"}}});
    assert.deepEqual(result.name,{slug:"account-test",title:"Account Test"},result.failure);
  } finally { for(const key of keys) { if(previous[key]===undefined) delete process.env[key]; else process.env[key]=previous[key]; } }
  console.log(
    JSON.stringify(
      {
        passed: true,
        requests: calls.length,
        checks: [
          "ChatGPT endpoint and identity",
          "tool loop and git environment",
          "live access-token replacement",
          "config precedence",
          "reasoning",
          "database migration and resume",
          "native provider compaction",
          "model whitelist and effective context limits",
          "image payload",
          "production naming path",
          "expired token fails without API fallback",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  proxy.closeAllConnections();
  proxy.close();
  upstream.closeAllConnections();
  fs.rmSync(root, { recursive: true, force: true });
}
