import path from "node:path";
import fs from "node:fs/promises";
import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";
import { scanFileTree } from "../file-tree.js";
import { findMarkdownFiles } from "../markdown.js";

type WsGetFileContent = Extract<WsClientMessage, { type: "get_file_content" }>;
type WsGetDoc = Extract<WsClientMessage, { type: "get_doc" }>;

export async function handleGetFileTree(ctx: HandlerContext): Promise<void> {
  try {
    const dir = ctx.getActiveDir();
    const tree = await scanFileTree(dir);
    ctx.send({ type: "file_tree", tree });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to scan file tree: ${getErrorMessage(err)}` });
  }
}

export async function handleGetFileContent(ctx: HandlerContext, msg: WsGetFileContent): Promise<void> {
  try {
    const dir = ctx.getActiveDir();
    const safePath = path.resolve(dir, msg.path);
    if (!safePath.startsWith(dir + "/")) {
      ctx.send({ type: "error", message: "Invalid path" });
      return;
    }
    // Guard against large files (>1 MB)
    const stat = await fs.stat(safePath);
    if (stat.size > 1_048_576) {
      ctx.send({
        type: "file_content",
        path: msg.path,
        content: `File is too large to display (${(stat.size / 1_048_576).toFixed(1)} MB). Maximum supported size is 1 MB.`,
        isBinary: true,
      });
      return;
    }
    // Read raw bytes to detect binary content
    const buf = await fs.readFile(safePath);
    const hasNullByte = buf.includes(0);
    if (hasNullByte) {
      ctx.send({
        type: "file_content",
        path: msg.path,
        content: "Binary file — cannot display.",
        isBinary: true,
      });
      return;
    }
    ctx.send({ type: "file_content", path: msg.path, content: buf.toString("utf-8") });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to read file: ${getErrorMessage(err)}` });
  }
}

export async function handleListDocs(ctx: HandlerContext): Promise<void> {
  try {
    const dir = ctx.getActiveDir();
    const files = await findMarkdownFiles(dir);
    ctx.send({ type: "doc_list", files });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to list docs: ${getErrorMessage(err)}` });
  }
}

export async function handleGetDoc(ctx: HandlerContext, msg: WsGetDoc): Promise<void> {
  try {
    const dir = ctx.getActiveDir();
    const safePath = path.resolve(dir, msg.path);
    if (!safePath.startsWith(dir + "/")) {
      ctx.send({ type: "error", message: "Invalid path" });
      return;
    }
    const content = await fs.readFile(safePath, "utf-8");
    ctx.send({ type: "doc_content", path: msg.path, content });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to read doc: ${getErrorMessage(err)}` });
  }
}
