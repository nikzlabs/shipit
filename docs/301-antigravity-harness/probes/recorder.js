// Records what the Antigravity CLI sends to a redirected GOOGLE_GEMINI_BASE_URL.
// One JSON summary line per request on stderr; the full body under /tmp/agy-body-N.json.
import http from "node:http";
import fs from "node:fs";

let n = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const headers = { ...req.headers };
    for (const k of Object.keys(headers)) {
      // Never print a key; record only that it was present and where.
      if (/key|auth|token/i.test(k)) headers[k] = `<${String(headers[k]).length} chars>`;
    }
    const file = `/tmp/agy-body-${++n}.json`;
    fs.writeFileSync(file, body);
    process.stderr.write(JSON.stringify({
      method: req.method, url: req.url, headers, bodyBytes: body.length, file,
    }) + "\n");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"candidates":[{"content":{"parts":[{"text":"pong"}],"role":"model"},"finishReason":"STOP"}],'
      + '"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}\n\n',
    );
  });
});
server.listen(Number(process.argv[2] || 8799), "127.0.0.1", () => {
  process.stderr.write(`listening ${JSON.stringify(server.address())}\n`);
});
