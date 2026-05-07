# slack-realtime streamer protocol

Server broadcasts a stream of geographic activity events derived from Slack
RTM. The wire payload carries no user IDs, names, channels, or message
content — only timezone-resolved coordinates.

## Connection

```
ws://127.0.0.1:8787/
```

Defaults; override via `WS_HOST` and `WS_PORT`. The server binds to localhost
by default — expose it intentionally.

The server is **read-only**. Any client → server frames are logged and
discarded.

## Frame format

Every WebSocket message is a single JSON object on one frame. UTF-8.
Coordinates are `[lat, lng]` decimal degrees.

## Server → client messages

### `hello`

Sent once immediately after the handshake completes.

```json
{ "type": "hello", "version": "0.1" }
```

`version` follows the protocol version below; bumped on any breaking schema
change.

### `spot`

A single point of activity at one location. Emitted when:

- a top-level message in a public channel has no @-mentions (or only mentions
  the sender themselves);
- a thread reply lands in a thread where only the sender has previously
  posted within the last 6h;
- a user reacts to their own message;
- a streamer would have fired but every recipient was dropped (no resolvable
  timezone, bot, or sharing the sender's timezone).

```json
{ "type": "spot", "at": [37.77, -122.42] }
```

### `streamer`

A directed flow from one user's location to one or more others'. Emitted for
thread replies (sender → other recent thread participants), @-mentions
(sender → mentioned users), and cross-user reactions (reactor → message
author).

```json
{
  "type": "streamer",
  "reason": "thread",
  "from": [37.77, -122.42],
  "to": [
    [51.51, -0.13],
    [35.68, 139.76]
  ]
}
```

`reason` is one of `"thread" | "mention" | "reaction"`. `to` is always an
array; mentions/reactions are typically length 1, threads can have several.

## Coordinate resolution

User → coordinates is derived from the user's Slack profile timezone (IANA
name) via `zone1970.tab` plus the IANA `backward` alias map. Resolution is
country/major-city centroid, not per-user precision. Senders or recipients
without a resolvable timezone are dropped (which may downgrade a `streamer`
to a `spot` — see `spot` rules above).

## Ordering & delivery

Events are pushed in the order the server processes them. There is no
sequence number, no ack, no replay. A client that disconnects misses
everything emitted while it was offline.

## Heartbeat

Server sends a WebSocket ping every 30s. If a client hasn't ponged by the
next ping, the server terminates the connection. The standard `ws` browser
API responds to pings transparently; no client logic needed beyond
processing messages.

## Backpressure

Per-client send buffer cap is 1 MB. A client whose buffered amount exceeds
the cap is terminated immediately. Clients should drain messages without
blocking on rendering — buffer or drop on your side, don't hold the recv
loop hostage.

## Reconnection

The server does no replay. Clients should reconnect on close with
exponential backoff (recommended: start at 1s, cap at 30s, jitter
±25%). A normal `hello` arrives on each successful reconnect.

## Privacy

By design the wire protocol contains:

- coordinates (rounded to a timezone centroid)
- a `reason` enum

It does **not** contain:

- user IDs, names, profile fields
- channel IDs or names
- message text, thread IDs, timestamps
- workspace identifiers

The server-side log file (`streamer.log`) does include a debug block with
this information for local inspection. Do not ship that file.

## Versioning

`hello.version` is a string. While pre-1.0 the schema may change between any
two minor versions. A 1.0 release will lock the schema; subsequent breaking
changes bump the major.
