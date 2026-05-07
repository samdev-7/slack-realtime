import { createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import WebSocket from "ws";
import { extractCreds } from "./extract-creds.js";
import { loadTzCoords, tzToLatLng } from "./tz-coords.js";
import { UserCache, ThreadAuthorCache, type CachedUser } from "./caches.js";
import { startWsServer } from "./server/broadcast.js";
import { staticHandler } from "./server/static.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
// Workspace HTML is fetched once on startup; the embedded api_token is the
// freshest xoxc available (Slack rotates these and the on-disk LevelDB copy
// often goes stale). Override via env if you want a different workspace.
const WORKSPACE_URL =
  process.env.SLACK_WORKSPACE_URL ?? "https://hackclub.slack.com/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const LOG_PATH = process.env.LOG_FILE ?? join(process.cwd(), "streamer.log");
const WS_HOST = process.env.WS_HOST ?? "127.0.0.1";
const WS_PORT = Number(process.env.WS_PORT ?? 8787);

// Mirror everything to a log file so it can be tail'd / inspected after the fact.
const logFile = createWriteStream(LOG_PATH, { flags: "a" });
logFile.write(`\n=== ${new Date().toISOString()} run start ===\n`);

const { cookie } = extractCreds();

// Fetch the workspace landing page with the d cookie and pull `api_token`
// out of the embedded boot_data. This always returns the current token for
// the active session — tokens stored on disk go stale quickly.
async function fetchFreshToken(workspaceUrl: string): Promise<string> {
  const res = await fetch(workspaceUrl, {
    headers: { Cookie: `d=${cookie}`, "User-Agent": UA },
    redirect: "follow",
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `GET ${workspaceUrl} → ${res.status} (the d cookie is likely invalid; re-run \`npm run print-cookie\` and update SLACK_D_COOKIE)`,
    );
  }
  if (!res.ok) throw new Error(`GET ${workspaceUrl} → HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/"api_token":"(xoxc-[A-Za-z0-9-]+)"/);
  if (!m) {
    throw new Error(
      `no api_token in ${workspaceUrl} response (cookie may be invalid)`,
    );
  }
  return m[1];
}

// Errors that mean the xoxc token went stale and we should re-fetch it from
// boot_data. Other errors are passed through to the caller.
const AUTH_REFRESH_ERRORS = new Set([
  "invalid_auth",
  "token_expired",
  "token_revoked",
  "not_authed",
]);

// Wrapper around Slack's HTTP API that holds the current xoxc token and
// transparently refreshes it (once per call) when Slack rejects it as expired.
class ApiClient {
  private token: string = "";

  constructor(public readonly workspaceUrl: string) {}

  async refresh(): Promise<void> {
    log("INFO", `refreshing token from ${this.workspaceUrl}…`);
    this.token = await fetchFreshToken(this.workspaceUrl);
    log(
      "INFO",
      `got token ${this.token.slice(0, 18)}…${this.token.slice(-6)}`,
    );
  }

  async call(
    baseUrl: string,
    method: string,
    params: Record<string, string> = {},
    _retried = false,
  ): Promise<any> {
    if (!this.token) await this.refresh();
    const res = await fetch(`${baseUrl}/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Cookie: `d=${cookie}`,
        "User-Agent": UA,
      },
      body: new URLSearchParams({ token: this.token, ...params }),
    });
    const json = (await res.json()) as any;
    if (json.ok) return json;
    if (!_retried && AUTH_REFRESH_ERRORS.has(json.error)) {
      log("WARN", `${method}: ${json.error} — refreshing token and retrying`);
      await this.refresh();
      return this.call(baseUrl, method, params, true);
    }
    throw new Error(`${method}: ${json.error}`);
  }
}

const tzCoords = loadTzCoords();

// Verbosity:
//   default: only [OUTPUT] lines on stdout
//   -v:      + lifecycle and active events on stderr
//   -vv:     + ignored events on stderr
// The full log file always gets every line regardless of verbosity.
const VERBOSITY = process.argv.includes("-vv")
  ? 2
  : process.argv.includes("-v")
    ? 1
    : 0;

const LEVEL_MIN: Record<string, number> = {
  OUTPUT: 0, // always — written to stdout
  WARN: 0, // always — written to stderr
  INFO: 1, // -v+
  EVENT: 1, // -v+ (active dispatch / partial drops)
  IGNORED: 2, // -vv only
};

function log(level: keyof typeof LEVEL_MIN, ...args: any[]) {
  const ts = new Date().toISOString().slice(11, 23);
  const parts = args.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a),
  );
  const line = `${ts} [${level}] ${parts.join(" ")}\n`;
  logFile.write(line);
  if (VERBOSITY >= LEVEL_MIN[level]) {
    (level === "WARN" ? process.stderr : process.stderr).write(line);
  }
}

// HTTP server: serves the globe HTML/assets statically AND hosts the WS
// upgrades on the same port (Coolify's reverse proxy only exposes 80/443,
// so HTTP and WS need to share an origin in deployment).
const here = dirname(fileURLToPath(import.meta.url));
// Prefer GLOBE_DIR env (deployment can override), fall back to ../src/globe
// relative to this file at build/run time.
const GLOBE_DIR = process.env.GLOBE_DIR ?? resolvePath(here, "globe");
const serveStatic = staticHandler(GLOBE_DIR);
const httpServer = createServer(async (req, res) => {
  if (await serveStatic(req, res)) return;
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("not found");
});
httpServer.on("error", (e: any) =>
  log("WARN", `http server error: ${e.message}`),
);
httpServer.listen(WS_PORT, WS_HOST, () =>
  log(
    "INFO",
    `http+ws server listening on http://${WS_HOST}:${WS_PORT}/ (globeDir=${GLOBE_DIR})`,
  ),
);

// Three sinks for emitted events:
//   - WS broadcast: privacy-safe payload only (what real consumers see)
//   - stdout:       privacy-safe payload (for `tail` / piping)
//   - log file:     payload + debug block for after-the-fact inspection
const broadcaster = startWsServer({ server: httpServer, log });

function emitOut(payload: object, debug: object) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`${ts} [OUTPUT] ${JSON.stringify(payload)}\n`);
  logFile.write(
    `${ts} [OUTPUT] ${JSON.stringify({ ...payload, debug })}\n`,
  );
  broadcaster.broadcast(payload);
}

// Graceful shutdown: close client sockets, flush log file.
async function shutdown(reason: string) {
  log("INFO", `shutting down (${reason})`);
  await broadcaster.shutdown();
  await new Promise<void>((r) => httpServer.close(() => r()));
  logFile.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Compact one-line summary for any RTM event so we can see the full firehose.
function summarizeEvent(ev: any): string {
  const fields: string[] = [`type=${ev.type ?? "?"}`];
  if (ev.subtype) fields.push(`subtype=${ev.subtype}`);
  if (ev.channel_type) fields.push(`ct=${ev.channel_type}`);
  if (ev.channel) fields.push(`ch=${ev.channel}`);
  if (ev.user) fields.push(`u=${ev.user}`);
  if (ev.thread_ts) fields.push(`thr=${ev.thread_ts}`);
  if (ev.ts) fields.push(`ts=${ev.ts}`);
  if (ev.reply_to !== undefined) fields.push(`reply_to=${ev.reply_to}`);
  if (typeof ev.text === "string") {
    const t = ev.text.replace(/\s+/g, " ").slice(0, 60);
    fields.push(`text=${JSON.stringify(t)}`);
  }
  return fields.join(" ");
}

// Try to fetch a fresh token + verify auth. Retries forever with backoff
// so transient Slack outages or a stale cookie don't take down the http
// server with the rest of the process — operations can replace the cookie
// at runtime via the env, and the next attempt will pick it up.
async function bootstrapWithRetry(api: ApiClient): Promise<{
  teamUrl: string;
  auth: any;
}> {
  let delay = 5_000;
  while (true) {
    try {
      await api.refresh();
      const auth = await api.call("https://slack.com", "auth.test");
      const teamUrl = (auth.url as string).replace(/\/$/, "");
      return { teamUrl, auth };
    } catch (e: any) {
      log(
        "WARN",
        `slack bootstrap failed: ${e.message}; retrying in ${Math.round(delay / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

(async () => {
  const api = new ApiClient(WORKSPACE_URL);
  const { teamUrl, auth } = await bootstrapWithRetry(api);
  log(
    "INFO",
    `signed in as ${auth.user} on ${auth.team} (${teamUrl}); tz table size=${tzCoords.size}`,
  );

  const users = new UserCache(SIX_HOURS_MS, async (id) => {
    try {
      const r = await api.call(teamUrl, "users.info", { user: id });
      const u = r.user;
      const tz: string = u.tz || "";
      return {
        id,
        name:
          u.profile?.display_name?.trim() ||
          u.profile?.real_name ||
          u.name ||
          id,
        tz,
        latlng: tzToLatLng(tzCoords, tz),
        isBot: !!u.is_bot || u.id === "USLACKBOT",
      };
    } catch (e: any) {
      log("WARN", `users.info(${id}) failed: ${e.message}`);
      return null;
    }
  });

  const threads = new ThreadAuthorCache(SIX_HOURS_MS);
  setInterval(
    () => {
      threads.pruneAll();
      users.prune();
    },
    5 * 60 * 1000,
  );

  type Reason = "thread" | "mention" | "reaction";

  // Unified emission. Resolves recipient ids, drops self/bots/no-latlng,
  // and emits either a streamer (≥1 valid recipient) or a spot fallback
  // (sender's location only). Spec rules:
  //   - sender without latlng → skip entirely (nothing to plot)
  //   - no recipients (or all self/invalid) → spot
  //   - some recipients valid, others invalid → streamer to the valid ones
  async function dispatch(
    sender: CachedUser,
    recipientIds: string[],
    reason: Reason,
    ev: any,
  ) {
    if (!sender.latlng) {
      log(
        "EVENT",
        `${reason} skipped: sender ${sender.name} has no latlng (tz=${sender.tz || "?"})`,
      );
      return;
    }

    const channel = ev.channel ?? ev.item?.channel;
    const debugBase = {
      reason,
      fromUser: sender.name,
      fromTz: sender.tz,
      channel,
      ts: ev.ts ?? ev.item?.ts,
      thread_ts: ev.thread_ts ?? null,
    };

    // Filter recipients: drop self, dedupe, lookup, drop bots / missing latlng.
    const seen = new Set<string>([sender.id]);
    const wanted: string[] = [];
    for (const id of recipientIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      wanted.push(id);
    }

    if (wanted.length === 0) {
      emitOut({ type: "spot", at: sender.latlng }, debugBase);
      return;
    }

    const looked = await Promise.all(wanted.map((id) => users.get(id)));
    const valid: CachedUser[] = [];
    const skipped: { id: string; why: string }[] = [];
    for (let i = 0; i < wanted.length; i++) {
      const r = looked[i];
      const id = wanted[i];
      if (!r) {
        skipped.push({ id, why: "lookup_failed" });
        continue;
      }
      if (r.isBot) {
        skipped.push({ id, why: "bot" });
        continue;
      }
      if (!r.latlng) {
        skipped.push({ id, why: `no_latlng_tz=${r.tz || "?"}` });
        continue;
      }
      // Same coordinates as sender → effectively a self-interaction; drop.
      // We compare via tz which is what produced the coords (avoids float fuzz).
      if (r.tz === sender.tz) {
        skipped.push({ id, why: `same_tz=${r.tz}` });
        continue;
      }
      valid.push(r);
    }

    if (skipped.length) {
      log(
        "EVENT",
        `${reason} sender=${sender.name}: dropped ${skipped.length}/${wanted.length} → ${skipped
          .map((s) => `${s.id}(${s.why})`)
          .join(",")}`,
      );
    }

    if (valid.length === 0) {
      emitOut(
        { type: "spot", at: sender.latlng },
        { ...debugBase, fallback: "all_recipients_invalid" },
      );
      return;
    }

    emitOut(
      {
        type: "streamer",
        reason,
        from: sender.latlng,
        to: valid.map((t) => t.latlng),
      },
      {
        ...debugBase,
        toUsers: valid.map((t) => t.name),
        toTz: valid.map((t) => t.tz),
      },
    );
  }

  // Slack mention syntax: <@U012ABC> or <@W012ABC|name>. Skip <!here>, <!channel>, <!subteam^…>.
  function extractMentions(text: string | undefined): string[] {
    if (!text) return [];
    return [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g)].map(
      (m) => m[1],
    );
  }

  function isPublicChannelId(ch: unknown, channelType?: unknown): boolean {
    // Slack's RTM often omits channel_type on message events. Fall back to the
    // channel-id prefix: C = public channel, G = private/mpim, D = im.
    if (channelType === "channel") return true;
    return (
      !channelType &&
      typeof ch === "string" &&
      ch.startsWith("C")
    );
  }

  async function handleMessage(ev: any, summary: string) {
    if (!isPublicChannelId(ev.channel, ev.channel_type)) {
      log("IGNORED", `not_public ${summary}`);
      return;
    }
    if (
      ev.subtype &&
      !["thread_broadcast", "me_message"].includes(ev.subtype)
    ) {
      log("IGNORED", `subtype=${ev.subtype} ${summary}`);
      return;
    }
    if (!ev.user) {
      log("IGNORED", `no_user ${summary}`);
      return;
    }
    if (ev.bot_id) {
      log("IGNORED", `bot_id=${ev.bot_id} ${summary}`);
      return;
    }

    const sender = await users.get(ev.user);
    if (!sender) {
      log("IGNORED", `user_lookup_failed ${summary}`);
      return;
    }
    if (sender.isBot) {
      log("IGNORED", `bot_user=${sender.name} ${summary}`);
      return;
    }

    const isReply = ev.thread_ts && ev.thread_ts !== ev.ts;
    const now = Date.now();

    if (isReply) {
      const key = `${ev.channel}:${ev.thread_ts}`;
      const otherIds = threads.others(key, ev.user);
      threads.record(key, ev.user, now);
      log(
        "EVENT",
        `thread_reply sender=${sender.name} fanout=${otherIds.length} ${summary}`,
      );
      await dispatch(sender, otherIds, "thread", ev);
    } else {
      const key = `${ev.channel}:${ev.ts}`;
      threads.record(key, ev.user, now);
      const mentionIds = extractMentions(ev.text).filter((m) => m !== ev.user);
      log(
        "EVENT",
        `top_level sender=${sender.name} mentions=${mentionIds.length} ${summary}`,
      );
      // dispatch handles spot fallback when mentionIds is empty.
      await dispatch(sender, mentionIds, "mention", ev);
    }
  }

  async function handleReaction(ev: any, summary: string) {
    if (ev.item?.type !== "message") {
      log("IGNORED", `reaction_non_message ${summary}`);
      return;
    }
    const ch = ev.item.channel;
    if (!isPublicChannelId(ch)) {
      log("IGNORED", `reaction_not_public ${summary}`);
      return;
    }
    if (!ev.user) {
      log("IGNORED", `reaction_no_user ${summary}`);
      return;
    }
    const sender = await users.get(ev.user);
    if (!sender) {
      log("IGNORED", `reaction_user_lookup_failed ${summary}`);
      return;
    }
    if (sender.isBot) {
      log("IGNORED", `reaction_bot_user=${sender.name} ${summary}`);
      return;
    }

    // Reacting to your own message → self-interaction → spot (handled by dispatch
    // since recipientIds will be filtered to empty).
    const targets =
      ev.item_user && ev.item_user !== ev.user ? [ev.item_user] : [];

    log(
      "EVENT",
      `reaction sender=${sender.name} target=${ev.item_user ?? "-"} reaction=${ev.reaction ?? "?"} ${summary}`,
    );
    // Provide channel/ts on the event so dispatch's debug block stays useful.
    await dispatch(
      sender,
      targets,
      "reaction",
      { ...ev, channel: ch, ts: ev.item.ts },
    );
  }

  async function routeEvent(data: WebSocket.RawData) {
    let ev: any;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      log("IGNORED", `unparseable ${data.toString().slice(0, 100)}`);
      return;
    }
    const summary = summarizeEvent(ev);
    if (ev.type === "message") return handleMessage(ev, summary);
    if (ev.type === "reaction_added") return handleReaction(ev, summary);
    log("IGNORED", `type=${ev.type} ${summary}`);
  }

  // Open one Slack RTM WebSocket and resolve when it closes. Always re-fetch
  // the wss URL via rtm.connect (which itself may refresh the token if Slack
  // says it's stale).
  async function connectOnce(): Promise<{ uptimeMs: number }> {
    const rtm = await api.call(teamUrl, "rtm.connect", {
      batch_presence_aware: "1",
      presence_sub: "false",
    });
    const wsUrl = rtm.url as string;
    log("INFO", `connecting to ${wsUrl.split("?")[0]}…`);

    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: `d=${cookie}`, "User-Agent": UA },
    });

    let openedAt = 0;
    let pingTimer: NodeJS.Timeout | null = null;
    let pingId = 1;

    return new Promise((resolve) => {
      ws.on("open", () => {
        openedAt = Date.now();
        log("INFO", "● ws connected");
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", id: pingId++ }));
          }
        }, 30_000);
      });
      ws.on("error", (e) => log("WARN", `ws error: ${e.message}`));
      ws.on("close", (code, reason) => {
        if (pingTimer) clearInterval(pingTimer);
        const uptimeMs = openedAt ? Date.now() - openedAt : 0;
        log(
          "INFO",
          `● ws disconnected code=${code} reason=${reason?.toString() || "-"} uptime=${Math.round(uptimeMs / 1000)}s`,
        );
        resolve({ uptimeMs });
      });
      ws.on("message", (data) => void routeEvent(data));
    });
  }

  // Reconnect forever with exponential backoff + jitter. Reset the backoff
  // once a connection has been stable for at least 60s, so transient blips
  // don't push us into a slow-retry regime.
  async function runForever(): Promise<never> {
    const MIN_DELAY_MS = 1_000;
    const MAX_DELAY_MS = 30_000;
    const STABLE_MS = 60_000;
    let delay = MIN_DELAY_MS;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const { uptimeMs } = await connectOnce();
        if (uptimeMs >= STABLE_MS) delay = MIN_DELAY_MS;
      } catch (e: any) {
        log("WARN", `connection attempt failed: ${e.message}`);
      }
      const jitter = Math.random() * delay * 0.25;
      const wait = Math.round(delay + jitter);
      log("INFO", `reconnecting in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }

  await runForever();
})().catch((e) => {
  // The Slack pipeline is allowed to fail without taking down the http
  // server hosting the globe. Log loudly; the next deploy/restart picks
  // it up. (`bootstrapWithRetry` already loops on auth, so reaching here
  // means something genuinely unrecoverable like a programming error.)
  log("WARN", `slack pipeline crashed (http server still serving): ${e.message}`);
});

// Top-level safety nets: log instead of crashing the process. Coolify will
// otherwise restart on any unhandled rejection, briefly killing the static
// server too. Runtime errors here are already surfaced where they happen;
// these handlers just keep the process alive.
process.on("unhandledRejection", (reason: any) => {
  log("WARN", `unhandledRejection: ${reason?.message ?? String(reason)}`);
});
process.on("uncaughtException", (e: Error) => {
  log("WARN", `uncaughtException: ${e.message}`);
});
