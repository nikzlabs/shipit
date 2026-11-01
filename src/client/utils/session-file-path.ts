import { CONTAINER_PERSIST_DIR } from "../../server/shared/fs-constants.js";

export function isPersistPath(filePath: string): boolean {
  return filePath.startsWith(`${CONTAINER_PERSIST_DIR}/`);
}

/**
 * A file path as the tail of a `/api/sessions/:id/files/…` or `/docs/…` URL. A
 * /persist path keeps its leading slash, encoded, so the server cannot read it as
 * a workspace folder named "persist".
 */
export function sessionFileUrlPath(filePath: string): string {
  if (!isPersistPath(filePath)) return filePath.startsWith("/") ? filePath.slice(1) : filePath;
  return `%2F${filePath.slice(1).split("/").map(encodeURIComponent).join("/")}`;
}
