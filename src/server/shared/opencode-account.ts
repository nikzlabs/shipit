/** ChatGPT access-only credentials consumed by OpenCode (docs/295). */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export const OPENCODE_MANAGED_DIR = ".local/share/opencode/shipit-data";
export const OPENCODE_ACCOUNT_MARKER = ".shipit-openai-account.json";
const MIGRATED = ".shipit-state-ready";

export interface OpenCodeAccountToken {
  type: "oauth";
  access: string;
  refresh: "";
  expires: number;
  accountId: string;
}

/** Only accept real expiry and identity; never copy a refresh token. */
export function openCodeAccessToken(
  auth: unknown,
  now = Date.now(),
): OpenCodeAccountToken {
  const value = auth as {
    tokens?: { access_token?: unknown; account_id?: unknown };
    access_token?: unknown;
  } | null;
  const access = value?.tokens?.access_token ?? value?.access_token;
  if (typeof access !== "string")
    {throw new Error(
      "ChatGPT access token is missing. Reconnect the OpenAI account.",
    );}
  let claims: {
    exp?: unknown;
    "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
  };
  try {
    claims = JSON.parse(
      Buffer.from(access.split(".")[1], "base64url").toString("utf8"),
    ) as typeof claims;
  } catch {
    throw new Error(
      "ChatGPT access token is unreadable. Reconnect the OpenAI account.",
    );
  }
  const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  const expires = typeof claims.exp === "number" ? claims.exp * 1000 : NaN;
  if (
    typeof accountId !== "string" ||
    !accountId.trim() ||
    !Number.isFinite(expires) ||
    expires <= now
  ) {
    throw new Error(
      "ChatGPT access token is expired or has no account identity. Reconnect the OpenAI account.",
    );
  }
  if (
    value?.tokens?.account_id !== undefined &&
    value.tokens.account_id !== accountId
  ) {
    throw new Error("ChatGPT credential account identity does not match.");
  }
  return { type: "oauth", access, refresh: "", expires, accountId };
}

export function managedOpenCodeDataHome(home: string): string {
  return path.join(home, OPENCODE_MANAGED_DIR);
}

export function openCodeAccountFile(dataHome: string): string {
  return path.join(dataHome, "opencode", "auth.json");
}

/** A separate XDG root prevents a terminal login overwriting managed auth. */
export function ensureManagedOpenCodeData(
  home: string,
  sourceHome = home,
): string {
  const dataHome = managedOpenCodeDataHome(home);
  const dest = path.join(dataHome, "opencode");
  const marker = path.join(dataHome, MIGRATED);
  if (fs.existsSync(marker)) return dataHome;
  fs.mkdirSync(dest, { recursive: true });
  const old = path.join(sourceHome, ".local", "share", "opencode");
  const sourceDb = path.join(old, "opencode.db");
  const destDb = path.join(dest, "opencode.db");
  if (fs.existsSync(sourceDb) && !fs.existsSync(destDb)) {
    const temp = `${destDb}.${randomUUID()}.tmp`;
    const db = new Database(sourceDb, { readonly: true });
    try {
      // SQLite provides a consistent snapshot even when the source has a WAL.
      db.prepare("VACUUM INTO ?").run(temp);
      fs.renameSync(temp, destDb);
    } finally {
      db.close();
      fs.rmSync(temp, { force: true });
    }
  }
  // Legacy session storage and snapshots carry resume state, never auth.
  for (const name of ["storage", "snapshot"]) {
    const source = path.join(old, name);
    if (fs.existsSync(source) && !fs.existsSync(path.join(dest, name))) {
      const temporary = path.join(dest, `${name}.${randomUUID()}.tmp`);
      try {
        fs.cpSync(source, temporary, { recursive: true, dereference: false });
        fs.renameSync(temporary, path.join(dest, name));
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }
  }
  fs.writeFileSync(marker, "1\n", { mode: 0o600 });
  return dataHome;
}

export function writeOpenCodeAccount(
  dataHome: string,
  token: OpenCodeAccountToken,
): void {
  const file = openCodeAccountFile(dataHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ openai: token }), { mode: 0o600 });
    const owner = fs.statSync(path.dirname(file));
    fs.chownSync(temp, owner.uid, owner.gid);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function removeOpenCodeAccount(dataHome: string): void {
  fs.rmSync(openCodeAccountFile(dataHome), { force: true });
}

export function readOpenCodeAccount(
  dataHome: string,
  expectedAccountId?: string,
): OpenCodeAccountToken {
  try {
    if (expectedAccountId !== undefined) {
      const marker = JSON.parse(
        fs.readFileSync(path.join(dataHome, OPENCODE_ACCOUNT_MARKER), "utf8"),
      ) as { accountId?: string };
      if (marker.accountId !== expectedAccountId)
        {throw new Error("Account route does not match projection");}
    }
    const auth = JSON.parse(
      fs.readFileSync(openCodeAccountFile(dataHome), "utf8"),
    ) as { openai?: OpenCodeAccountToken };
    if (auth.openai?.refresh !== "" || auth.openai.type !== "oauth")
      {throw new Error("Invalid projection");}
    const checked = openCodeAccessToken({
      tokens: {
        access_token: auth.openai.access,
        account_id: auth.openai.accountId,
      },
    });
    if (checked.expires !== auth.openai.expires)
      {throw new Error("Invalid expiry");}
    return checked;
  } catch {
    throw new Error(
      "ChatGPT credentials for OpenCode are unavailable or expired.",
    );
  }
}
