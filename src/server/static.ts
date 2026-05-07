import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, resolve, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// Tiny static handler — resolves URL paths against a root directory, serves
// the file with a streaming body and a guessed Content-Type. Rejects anything
// that escapes the root (path traversal). 404 falls through to the caller via
// the returned boolean so a higher-level handler can answer.
export function staticHandler(rootDir: string) {
  const root = resolve(rootDir);

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const url = new URL(req.url || "/", "http://x");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";

    const filePath = resolve(join(root, normalize(pathname)));
    if (!filePath.startsWith(root + "/") && filePath !== root) {
      res.statusCode = 403;
      res.end("forbidden");
      return true;
    }

    let info;
    try {
      info = await stat(filePath);
    } catch {
      return false;
    }
    if (!info.isFile()) return false;

    res.setHeader("Content-Type", MIME[extname(filePath)] || "application/octet-stream");
    res.setHeader("Content-Length", info.size);
    res.setHeader("Cache-Control", "no-cache");
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    // Stream the file, but defend against mid-flight read errors and client
    // disconnects so a single bad request can't leak resources or crash the
    // process via an unhandled stream `error` event.
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("read error");
      } else {
        res.destroy();
      }
    });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return true;
  };
}
