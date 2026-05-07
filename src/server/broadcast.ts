import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";

const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED_BYTES = 1024 * 1024; // 1 MB per client; terminate beyond that
const PROTOCOL_VERSION = "0.1";

type Logger = (level: string, ...args: any[]) => void;

export interface Broadcaster {
  broadcast(payload: object): void;
  shutdown(): Promise<void>;
  clientCount(): number;
}

export function startWsServer(opts: {
  host: string;
  port: number;
  log: Logger;
}): Broadcaster {
  const { host, port, log } = opts;
  const wss = new WebSocketServer({ host, port });

  let nextId = 1;
  const clients = new Map<
    number,
    { ws: WebSocket; remote: string; alive: boolean }
  >();

  wss.on("listening", () =>
    log("INFO", `ws server listening on ws://${host}:${port}/`),
  );
  wss.on("error", (e) => log("WARN", `ws server error: ${e.message}`));

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const id = nextId++;
    const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    clients.set(id, { ws, remote, alive: true });
    log(
      "INFO",
      `ws client #${id} connected (${remote}); total=${clients.size}`,
    );

    safeSend(ws, { type: "hello", version: PROTOCOL_VERSION });

    ws.on("pong", () => {
      const c = clients.get(id);
      if (c) c.alive = true;
    });
    ws.on("close", (code, reason) => {
      clients.delete(id);
      log(
        "INFO",
        `ws client #${id} disconnected ${code} ${reason?.toString() || ""}; total=${clients.size}`,
      );
    });
    ws.on("error", (e) =>
      log("WARN", `ws client #${id} error: ${e.message}`),
    );
    ws.on("message", (data) => {
      // No client→server protocol in v1.
      log(
        "INFO",
        `ws client #${id} message ignored: ${data.toString().slice(0, 80)}`,
      );
    });
  });

  // Heartbeat: ping every interval; terminate clients that didn't pong since
  // the previous tick. Standard ws.org pattern.
  const heartbeat = setInterval(() => {
    for (const [id, c] of clients) {
      if (!c.alive) {
        log("WARN", `ws client #${id} heartbeat timeout; terminating`);
        c.ws.terminate();
        clients.delete(id);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        // ignored — terminated client, will be cleaned up next tick
      }
    }
  }, HEARTBEAT_MS);

  function safeSend(ws: WebSocket, payload: object) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Client gone; close handler will clean up.
    }
  }

  return {
    broadcast(payload: object) {
      if (clients.size === 0) return;
      const line = JSON.stringify(payload);
      for (const [id, c] of clients) {
        if (c.ws.readyState !== WebSocket.OPEN) continue;
        if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          log(
            "WARN",
            `ws client #${id} backpressure (${c.ws.bufferedAmount}b); terminating`,
          );
          c.ws.terminate();
          clients.delete(id);
          continue;
        }
        try {
          c.ws.send(line);
        } catch (e: any) {
          log("WARN", `ws client #${id} send failed: ${e.message}`);
        }
      }
    },
    shutdown() {
      clearInterval(heartbeat);
      for (const [, c] of clients) {
        try {
          c.ws.close(1001, "server shutdown");
        } catch {
          // ignored
        }
      }
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    clientCount() {
      return clients.size;
    },
  };
}
