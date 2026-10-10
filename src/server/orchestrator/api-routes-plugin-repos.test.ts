import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { ApiDeps } from "./api-routes.js";
import { registerPluginRepoRoutes } from "./api-routes-plugin-repos.js";
import type { PluginCliRequest, PluginCliResult } from "./plugin-cli-run.js";

const SESSION = "s-1";
const EXEC = `/api/sessions/${SESSION}/plugin/exec`;
const STDIN = `${EXEC}/stdin`;
// More than a stream buffers before it asks the writer to wait.
const LARGE = "x".repeat(200 * 1024);

type Run = (request: PluginCliRequest) => Promise<PluginCliResult>;

async function readAll(stdin: PluginCliRequest["stdin"]): Promise<string> {
  if (typeof stdin === "string" || stdin === undefined) return stdin ?? "";
  const chunks: Buffer[] = [];
  for await (const chunk of stdin as Readable) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

// As a command that reads its stdin to the end and prints it.
const cat: Run = async (request) => ({ exitCode: 0, stdout: await readAll(request.stdin), stderr: "" });

describe("the plugin exec routes — stdin", () => {
  let app: FastifyInstance;
  let run: Run;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    run = cat;
    await registerPluginRepoRoutes(app, {
      sessionManager: { get: (id: string) => (id === SESSION ? { workspaceDir: "/ws" } : undefined) },
      runPluginCommandForSession: (_id: string, _dir: string, request: PluginCliRequest) => run(request),
    } as unknown as ApiDeps);
  });

  afterEach(async () => {
    await app.close();
  });

  const exec = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: EXEC, payload: { alias: "reqs", command: "reqs", ...payload } });
  const part = (payload: Record<string, unknown>, url = STDIN) =>
    app.inject({ method: "POST", url, payload });

  it("runs the command with the stdin that came with the call", async () => {
    const res = await exec({ stdin: "all of it\n", stdinId: "ignored" });

    expect(res.json()).toMatchObject({ exitCode: 0, stdout: "all of it\n" });
  });

  it("gives a running command the input its caller sends after the call", async () => {
    const running = exec({ stdinId: "call-1" });

    expect((await part({ id: "call-1", seq: 0, data: "one\n" })).json()).toEqual({ accepted: true });
    expect((await part({ id: "call-1", seq: 1, data: "two\n", end: true })).json()).toEqual({ accepted: true });

    expect((await running).json()).toMatchObject({ exitCode: 0, stdout: "one\ntwo\n" });
  });

  it("gives the command a part that arrived before the call", async () => {
    const early = part({ id: "call-2", seq: 0, data: "early\n", end: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await exec({ stdinId: "call-2" });

    expect(res.json()).toMatchObject({ stdout: "early\n" });
    expect((await early).json()).toEqual({ accepted: true });
  });

  it("refuses the input a command did not take when the command exits", async () => {
    let exit: () => void = () => undefined;
    run = async () => {
      await new Promise<void>((resolve) => { exit = resolve; });
      return { exitCode: 0, stdout: "did not read\n", stderr: "" };
    };
    const running = exec({ stdinId: "call-3" });
    const unread = part({ id: "call-3", seq: 0, data: LARGE });
    await new Promise((resolve) => setTimeout(resolve, 20));

    exit();

    expect((await running).json()).toMatchObject({ stdout: "did not read\n" });
    expect((await unread).json()).toEqual({ accepted: false });
  });

  it("answers an error, not an end of input, for a part that it did not deliver", async () => {
    const running = exec({ stdinId: "call-4" });

    const skipped = await part({ id: "call-4", seq: 3, data: "not the next part\n" });
    expect(skipped.statusCode).toBe(409);
    expect(skipped.json()).toEqual({ error: "Part 3 of this input arrived before part 0." });

    await part({ id: "call-4", seq: 0, data: "", end: true });
    expect((await running).json()).toMatchObject({ stdout: "" });
  });

  it("does not run a call again that it has, while the command runs and after, and leaves the first its input", async () => {
    const running = exec({ stdinId: "call-5" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await exec({ stdinId: "call-5" });
    expect(second.statusCode).toBe(409);

    await part({ id: "call-5", seq: 0, data: "for the first\n", end: true });
    expect((await running).json()).toMatchObject({ stdout: "for the first\n" });

    let runs = 0;
    run = async () => {
      runs += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect((await exec({ stdinId: "call-5" })).statusCode).toBe(409);
    expect(runs).toBe(0);
  });

  it("answers for a session that does not exist, and for a part with no id or no number", async () => {
    const missing = await part({ id: "call-6", seq: 0, data: "x" }, "/api/sessions/nope/plugin/exec/stdin");
    expect(missing.statusCode).toBe(404);

    expect((await part({ seq: 0, data: "x" })).statusCode).toBe(400);
    expect((await part({ id: "call-6", data: "x" })).statusCode).toBe(400);
    expect((await part({ id: "call-6", seq: -1, data: "x" })).statusCode).toBe(400);
  });
});
