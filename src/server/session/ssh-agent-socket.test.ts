import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SshAgentSocket, type SshAgentIdentity } from "./ssh-agent-socket.js";
import {
  SshReader,
  SESSION_BIND_EXTENSION,
  SSH_AGENT_EXTENSION_FAILURE,
  SSH_AGENT_FAILURE,
  SSH_AGENT_IDENTITIES_ANSWER,
  SSH_AGENT_SIGN_RESPONSE,
  SSH_AGENT_SUCCESS,
  SSH_AGENTC_EXTENSION,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_SIGN_REQUEST,
  frame,
  sshByte,
  sshString,
  u32,
} from "../shared/ssh-wire.js";

const KEY_BLOB = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 7))]);

let dir: string;
let socketPath: string;
let agent: SshAgentSocket;
let identities: SshAgentIdentity[];
let signCalls: { keyBlob: string; data: string; bind?: string }[];
let signResult: string | null;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-agent-"));
  socketPath = path.join(dir, "agent.sock");
  identities = [{ publicKeyBlob: KEY_BLOB.toString("base64"), comment: "prod (deploy@prod)" }];
  signCalls = [];
  signResult = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(64, 3))]).toString("base64");
  agent = new SshAgentSocket({
    socketPath,
    identities: () => Promise.resolve(identities),
    sign: (request) => {
      signCalls.push(request);
      return Promise.resolve(signResult);
    },
  });
  await agent.start();
});

afterEach(async () => {
  await agent.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One request, one framed reply, on a connection the caller can keep open. */
function open(): {
  send: (payload: Buffer) => Promise<Buffer>;
  close: () => void;
} {
  const socket = net.createConnection(socketPath);
  let buffered = Buffer.alloc(0);
  const waiters: ((reply: Buffer) => void)[] = [];
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const len = buffered.readUInt32BE(0);
      if (buffered.length < 4 + len) return;
      const payload = buffered.subarray(4, 4 + len);
      buffered = buffered.subarray(4 + len);
      waiters.shift()?.(Buffer.from(payload));
    }
  });
  return {
    send: (payload) =>
      new Promise<Buffer>((resolve, reject) => {
        waiters.push(resolve);
        socket.on("error", reject);
        socket.write(frame(payload));
      }),
    close: () => socket.destroy(),
  };
}

describe("SshAgentSocket", () => {
  it("answers REQUEST_IDENTITIES from the orchestrator's list", async () => {
    const conn = open();
    const reply = new SshReader(await conn.send(sshByte(SSH_AGENTC_REQUEST_IDENTITIES)));
    expect(reply.readByte()).toBe(SSH_AGENT_IDENTITIES_ANSWER);
    expect(reply.readUint32()).toBe(1);
    expect(reply.readString().toString("base64")).toBe(KEY_BLOB.toString("base64"));
    expect(reply.readText()).toBe("prod (deploy@prod)");
    conn.close();
  });

  it("answers an empty identity list without failing", async () => {
    identities = [];
    const conn = open();
    const reply = new SshReader(await conn.send(sshByte(SSH_AGENTC_REQUEST_IDENTITIES)));
    expect(reply.readByte()).toBe(SSH_AGENT_IDENTITIES_ANSWER);
    expect(reply.readUint32()).toBe(0);
    conn.close();
  });

  // The bind is what proves a real key exchange to the signer, and `ssh` sends
  // it once per process — so it has to be held for the life of THIS connection
  // and relayed with every sign request on it.
  it("holds the session bind per connection and relays it with each signature", async () => {
    const conn = open();
    const bindPayload = Buffer.from("bind-bytes");
    const accepted = await conn.send(Buffer.concat([
      sshByte(SSH_AGENTC_EXTENSION),
      sshString(SESSION_BIND_EXTENSION),
      bindPayload,
    ]));
    expect(accepted[0]).toBe(SSH_AGENT_SUCCESS);

    const data = Buffer.from("userauth-bytes");
    const reply = new SshReader(await conn.send(Buffer.concat([
      sshByte(SSH_AGENTC_SIGN_REQUEST),
      sshString(KEY_BLOB),
      sshString(data),
      u32(0),
    ])));
    expect(reply.readByte()).toBe(SSH_AGENT_SIGN_RESPONSE);
    expect(reply.readString().toString("base64")).toBe(signResult);
    expect(signCalls).toEqual([{
      keyBlob: KEY_BLOB.toString("base64"),
      data: data.toString("base64"),
      bind: bindPayload.toString("base64"),
    }]);
    conn.close();
  });

  it("does not carry a bind from one connection to another", async () => {
    const first = open();
    await first.send(Buffer.concat([
      sshByte(SSH_AGENTC_EXTENSION),
      sshString(SESSION_BIND_EXTENSION),
      Buffer.from("first-connection-bind"),
    ]));
    first.close();

    const second = open();
    await second.send(Buffer.concat([
      sshByte(SSH_AGENTC_SIGN_REQUEST),
      sshString(KEY_BLOB),
      sshString(Buffer.from("data")),
      u32(0),
    ]));
    expect(signCalls[0].bind).toBeUndefined();
    second.close();
  });

  it("fails the sign request when the orchestrator refuses", async () => {
    signResult = null;
    const conn = open();
    const reply = await conn.send(Buffer.concat([
      sshByte(SSH_AGENTC_SIGN_REQUEST),
      sshString(KEY_BLOB),
      sshString(Buffer.from("data")),
      u32(0),
    ]));
    expect(reply[0]).toBe(SSH_AGENT_FAILURE);
    conn.close();
  });

  it("refuses an unknown extension", async () => {
    const conn = open();
    const reply = await conn.send(Buffer.concat([
      sshByte(SSH_AGENTC_EXTENSION),
      sshString("query"),
    ]));
    expect(reply[0]).toBe(SSH_AGENT_EXTENSION_FAILURE);
    conn.close();
  });

  /**
   * Everything else gets SSH_AGENT_FAILURE. That is what keeps key loading,
   * deletion, and lock/unlock from reaching a store the agent must not touch —
   * the socket answers three messages and no more.
   */
  it.each([
    ["ADD_IDENTITY", 17],
    ["REMOVE_IDENTITY", 18],
    ["REMOVE_ALL_IDENTITIES", 19],
    ["LOCK", 22],
    ["UNLOCK", 23],
    ["ADD_SMARTCARD_KEY", 20],
    ["SSH1_REQUEST_IDENTITIES", 1],
  ])("refuses %s", async (_name, type) => {
    const conn = open();
    const reply = await conn.send(Buffer.concat([sshByte(type), sshString("payload")]));
    expect(reply[0]).toBe(SSH_AGENT_FAILURE);
    conn.close();
  });

  it("handles two requests arriving in one chunk", async () => {
    const socket = net.createConnection(socketPath);
    const replies: Buffer[] = [];
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
        const len = buffered.readUInt32BE(0);
        replies.push(Buffer.from(buffered.subarray(4, 4 + len)));
        buffered = buffered.subarray(4 + len);
      }
    });
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    socket.write(Buffer.concat([
      frame(sshByte(SSH_AGENTC_REQUEST_IDENTITIES)),
      frame(sshByte(SSH_AGENTC_REQUEST_IDENTITIES)),
    ]));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies.every((r) => r[0] === SSH_AGENT_IDENTITIES_ANSWER)).toBe(true);
    socket.destroy();
  });

  it("drops a connection that claims an impossible message length", async () => {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.write(Buffer.concat([u32(64 * 1024 * 1024), Buffer.from([1])]));
    await closed;
  });

  it("replaces a socket file left by a previous start", async () => {
    await agent.stop();
    fs.writeFileSync(socketPath, "stale");
    await agent.start();
    const conn = open();
    const reply = await conn.send(sshByte(SSH_AGENTC_REQUEST_IDENTITIES));
    expect(reply[0]).toBe(SSH_AGENT_IDENTITIES_ANSWER);
    conn.close();
  });
});
