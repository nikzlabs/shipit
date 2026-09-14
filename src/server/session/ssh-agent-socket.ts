/**
 * The worker's SSH agent socket (docs/305-ssh-hosts).
 *
 * It speaks just enough of the agent protocol for `ssh` to authenticate, and it
 * holds NO key: identities and signatures both come from the orchestrator. It
 * enforces nothing either — the session container is the agent's own territory,
 * so every check lives in the orchestrator's signer. This is routing
 * convenience, not a boundary.
 *
 * Three messages are answered and everything else gets `SSH_AGENT_FAILURE`:
 * REQUEST_IDENTITIES, the `session-bind@openssh.com` extension (held for the
 * life of the connection, one per `ssh` process), and SIGN_REQUEST (relayed with
 * that bind). Refusing the rest is what keeps `ssh-add -d`, key loading, and
 * lock/unlock from reaching a store the agent must not touch.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  SshReader,
  SESSION_BIND_EXTENSION,
  SSH_AGENT_FAILURE,
  SSH_AGENT_SUCCESS,
  SSH_AGENT_EXTENSION_FAILURE,
  SSH_AGENT_IDENTITIES_ANSWER,
  SSH_AGENT_SIGN_RESPONSE,
  SSH_AGENTC_EXTENSION,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_SIGN_REQUEST,
  frame,
  sshByte,
  sshString,
  u32,
} from "../shared/ssh-wire.js";

/** A framed agent message cannot legitimately exceed this; OpenSSH uses 256 KiB. */
const MAX_MESSAGE_BYTES = 256 * 1024;

export interface SshAgentIdentity {
  publicKeyBlob: string;
  comment: string;
}

export interface SshAgentSocketDeps {
  socketPath: string;
  identities: () => Promise<SshAgentIdentity[]>;
  /** base64 signature blob, or null when the orchestrator refused. */
  sign: (request: { keyBlob: string; data: string; bind?: string }) => Promise<string | null>;
}

export class SshAgentSocket {
  private server: net.Server | null = null;

  constructor(private readonly deps: SshAgentSocketDeps) {}

  async start(): Promise<void> {
    const dir = path.dirname(this.deps.socketPath);
    fs.mkdirSync(dir, { recursive: true });
    // A socket left by a previous container start would refuse the bind.
    fs.rmSync(this.deps.socketPath, { force: true });

    const server = net.createServer((socket) => this.handleConnection(socket));
    server.on("error", (err) => {
      console.error("[ssh-agent] socket server error:", err instanceof Error ? err.message : String(err));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.deps.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Only the worker uid may talk to it; /run/shipit is already worker-owned.
    try {
      fs.chmodSync(this.deps.socketPath, 0o600);
    } catch {
      // A socket whose mode cannot be tightened is still same-uid only.
    }
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(this.deps.socketPath, { force: true });
  }

  private handleConnection(socket: net.Socket): void {
    // One bind per connection: `ssh` opens its own socket per process.
    let bind: string | undefined;
    let buffered = Buffer.alloc(0);
    let draining = false;

    const fail = () => socket.write(frame(sshByte(SSH_AGENT_FAILURE)));

    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        for (;;) {
          if (buffered.length < 4) return;
          const length = buffered.readUInt32BE(0);
          if (length === 0 || length > MAX_MESSAGE_BYTES) {
            socket.destroy();
            return;
          }
          if (buffered.length < 4 + length) return;
          const payload = buffered.subarray(4, 4 + length);
          buffered = buffered.subarray(4 + length);
          const next = await this.handleMessage(payload, bind);
          if (next.bind !== undefined) bind = next.bind;
          if (socket.destroyed) return;
          socket.write(next.reply);
        }
      } catch (err) {
        console.error("[ssh-agent] request failed:", err instanceof Error ? err.message : String(err));
        if (!socket.destroyed) fail();
      } finally {
        draining = false;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      void drain();
    });
    socket.on("error", () => socket.destroy());
  }

  private async handleMessage(
    payload: Buffer,
    bind: string | undefined,
  ): Promise<{ reply: Buffer; bind?: string }> {
    const reader = new SshReader(payload);
    const type = reader.readByte();

    if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
      const identities = await this.deps.identities();
      const body = [sshByte(SSH_AGENT_IDENTITIES_ANSWER), u32(identities.length)];
      for (const id of identities) {
        body.push(sshString(Buffer.from(id.publicKeyBlob, "base64")), sshString(id.comment));
      }
      return { reply: frame(Buffer.concat(body)) };
    }

    if (type === SSH_AGENTC_EXTENSION) {
      const name = reader.readText();
      if (name !== SESSION_BIND_EXTENSION) {
        return { reply: frame(sshByte(SSH_AGENT_EXTENSION_FAILURE)) };
      }
      return {
        reply: frame(sshByte(SSH_AGENT_SUCCESS)),
        bind: reader.readRest().toString("base64"),
      };
    }

    if (type === SSH_AGENTC_SIGN_REQUEST) {
      const keyBlob = reader.readString().toString("base64");
      const data = reader.readString().toString("base64");
      const signature = await this.deps.sign({ keyBlob, data, ...(bind ? { bind } : {}) });
      if (!signature) return { reply: frame(sshByte(SSH_AGENT_FAILURE)) };
      return {
        reply: frame(Buffer.concat([
          sshByte(SSH_AGENT_SIGN_RESPONSE),
          sshString(Buffer.from(signature, "base64")),
        ])),
      };
    }

    return { reply: frame(sshByte(SSH_AGENT_FAILURE)) };
  }
}
