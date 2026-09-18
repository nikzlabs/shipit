
import { createHash } from "node:crypto";

export function derivePresentId(sessionId: string, resolvedPath: string): string {
  const digest = createHash("sha1").update(`${sessionId}\0${resolvedPath}`).digest("hex");
  return `pres_${digest.slice(0, 32)}`;
}

export interface PresentMeta {
  presentId: string;
  resolvedPath: string;
  filePath: string;
  mimeType: string;
  title?: string;
  createdAt: string;
  inline?: boolean;
}

export class PresentRegistry {
  private readonly entries = new Map<string, PresentMeta>();

  get size(): number {
    return this.entries.size;
  }

  put(
    presentId: string,
    input: {
      resolvedPath: string;
      filePath: string;
      mimeType: string;
      title?: string;
      createdAt: string;
      inline?: boolean;
    },
  ): PresentMeta {
    // Keep an existing transcript card when a later presentation omits inline.
    const inline = input.inline || this.entries.get(presentId)?.inline || false;
    const meta: PresentMeta = {
      presentId,
      resolvedPath: input.resolvedPath,
      filePath: input.filePath,
      mimeType: input.mimeType,
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdAt: input.createdAt,
      ...(inline ? { inline: true } : {}),
    };
    this.entries.set(presentId, meta);
    return meta;
  }

  get(presentId: string): PresentMeta | undefined {
    return this.entries.get(presentId);
  }

  delete(presentId: string): boolean {
    return this.entries.delete(presentId);
  }

  clear(): void {
    this.entries.clear();
  }
}
