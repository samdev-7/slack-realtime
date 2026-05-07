import { execSync } from "node:child_process";
import { readFileSync, readdirSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const SLACK_DIR = join(homedir(), "Library", "Application Support", "Slack");

export type Creds = { token: string; cookie: string; allTokens: string[] };

function getKeychainPassword(): string {
  // The Slack desktop app stores the cookie-encryption key in macOS Keychain.
  // Service "Slack Safe Storage", account "Slack Key".
  const out = execSync(
    `security find-generic-password -wa "Slack Key" -s "Slack Safe Storage"`,
    { encoding: "utf8" },
  );
  return out.trim();
}

function deriveKey(password: string): Buffer {
  // Chromium on macOS: PBKDF2-HMAC-SHA1, salt "saltysalt", 1003 iterations, 16 bytes.
  return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

function decryptV10(encrypted: Buffer, key: Buffer): string {
  // Strip "v10" prefix, AES-128-CBC, IV = 16 bytes of 0x20.
  const ciphertext = encrypted.subarray(3);
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  // Modern Chromium (M118+) prepends a 32-byte SHA256(host) to the plaintext
  // before encrypting, to prevent cross-host cookie swap attacks. If the leading
  // bytes aren't printable, assume that prefix is present and strip it.
  const looksPrintable = decrypted.subarray(0, 5).every((b) => b >= 0x20 && b < 0x7f);
  const value = looksPrintable ? decrypted : decrypted.subarray(32);
  return value.toString("utf8");
}

export function extractCookie(): string {
  // Env override lets the program run anywhere — Linux servers, containers, etc.
  // No Mac Keychain or SQLite cookie store needed when SLACK_D_COOKIE is set.
  const fromEnv = process.env.SLACK_D_COOKIE;
  if (fromEnv) return fromEnv.trim();

  const cookiesPath = join(SLACK_DIR, "Cookies");
  // Copy to a temp file so we don't fight Slack for the lock.
  const tmp = join(mkdtempSync(join(tmpdir(), "slack-cookies-")), "Cookies");
  copyFileSync(cookiesPath, tmp);

  const db = new Database(tmp, { readonly: true, fileMustExist: true });
  const row = db
    .prepare(
      `SELECT encrypted_value FROM cookies WHERE host_key = '.slack.com' AND name = 'd'`,
    )
    .get() as { encrypted_value: Buffer } | undefined;
  db.close();

  if (!row) throw new Error("No 'd' cookie found in Slack Cookies db");

  const key = deriveKey(getKeychainPassword());
  const value = decryptV10(row.encrypted_value, key);
  // Slack's d cookie value is URL-encoded by the browser; the raw decrypted form
  // is what we should send back as the Cookie header value.
  return value;
}

export function extractTokens(): string[] {
  const dir = join(SLACK_DIR, "Local Storage", "leveldb");
  const re = /xoxc-[0-9]+-[0-9]+-[0-9]+-[a-f0-9]{64}/g;
  const found = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ldb") && !file.endsWith(".log")) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(join(dir, file));
    } catch {
      continue;
    }
    const text = buf.toString("binary");
    for (const m of text.matchAll(re)) found.add(m[0]);
  }
  return [...found];
}

export function extractCreds(preferredToken?: string): Creds {
  const cookie = extractCookie();
  // When running off-host with SLACK_D_COOKIE, we don't need any xoxc tokens
  // locally — the workspace HTML will mint a fresh one on demand.
  if (process.env.SLACK_D_COOKIE) {
    return { token: "", cookie, allTokens: [] };
  }
  const tokens = extractTokens();
  if (tokens.length === 0) throw new Error("No xoxc tokens found in LevelDB");
  const token =
    (preferredToken && tokens.find((t) => t.startsWith(preferredToken))) ||
    tokens[0];
  return { token, cookie, allTokens: tokens };
}

// CLI: `tsx src/extract-creds.ts` — prints what it found (token suffixes only).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { token, cookie, allTokens } = extractCreds();
  const mask = (s: string) => s.slice(0, 12) + "…" + s.slice(-6);
  console.log("tokens found:", allTokens.length);
  for (const t of allTokens) console.log("  ", mask(t));
  console.log("using:        ", mask(token));
  console.log("cookie d=     ", mask(cookie), `(${cookie.length} chars)`);
}
