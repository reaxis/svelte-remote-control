# svelte-remote-control

[![npm version](https://img.shields.io/npm/v/svelte-remote-control.svg)](https://www.npmjs.com/package/svelte-remote-control)
[![CI](https://github.com/reaxis/svelte-remote-control/actions/workflows/ci.yml/badge.svg)](https://github.com/reaxis/svelte-remote-control/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/svelte-remote-control.svg)](./LICENSE)

Peer-to-peer connection primitive for Svelte 5 apps. Connect a host (e.g. a laptop) to one or more clients (e.g. phones) over WebRTC with a single `<RemoteControl />` component — no signalling server to run yourself, a QR code UI out of the box, and reactive state that syncs across peers.

Built on [PeerJS](https://peerjs.com) for WebRTC transport, Svelte 5 runes for reactivity.

## Features

- **Drop-in UI** — `<RemoteControl />` renders a floating status indicator with QR code, copyable peer ID, and connection management.
- **Data channel** — broadcast JSON messages between peers with `send()` / `onMessage()`.
- **Media calls** — stream camera or microphone between peers with `startCall()` / `onCall()`.
- **Synced reactive state** — `rcState()` returns a `$state`-like object whose value automatically syncs across all connected peers (last-write-wins).
- **Auto-reconnect** — exponential backoff on connection loss, preserving the peer ID across session reloads.
- **Framework-independent** — no SvelteKit dependency; works in any Svelte 5 app (SvelteKit, Vite, etc.).
- **No signalling server required** — uses the free public PeerJS broker by default; bring your own via the class API.

## Installation

```bash
npm install svelte-remote-control
```

Peer dependencies: `svelte >= 5.0`, `peerjs`, `qrcode`.

## Quick start

Drop `<RemoteControl />` onto a single page and share one `rcState` value
between the host (laptop) and any client (phone) that connects to it:

```svelte
<script lang="ts">
    import RemoteControl, { rcState } from 'svelte-remote-control';

    const brightness = rcState('brightness', 50);
</script>

<RemoteControl />

<input type="range" min="0" max="100" bind:value={brightness.value} />
<p>Brightness: {brightness.value}</p>
```

Open the page on your laptop, scan the QR code with your phone or open the link in another tab, and dragging
the slider on either device/tab updates the other instantly.

## Component

### `<RemoteControl />`

Renders a small floating status trigger (top-right by default) with a popover containing:
- A QR code and copyable URL for clients to scan.
- Connection status (idle / gathering / awaiting / connected / disconnected / error).
- The list of connected peer IDs on the host side.
- A manual-entry field for pasting a peer ID.
- Retry state (countdown and stop button) on the client side, with the reason when it can't connect: "Host not found", or "Can't reach the host" (see [TURN servers](#turn-servers)).

#### Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `remoteHref` | `string` | current page path | Path clients should be sent to (e.g. `"/remote"`). Omit for same-route connections (useful for peer-to-peer symmetric apps); set when host and client interfaces are on different routes. |
| `config` | `WebRTCConnectionOptions` | — | ICE servers and/or PeerJS broker for this instance. Merged into the bound `WebRTCConnection` via `configure()`; fields take effect on the next `createOffer()` / `acceptOffer()`. |
| `connection` | `WebRTCConnection` | module singleton | Bind this UI to a caller-supplied `WebRTCConnection`. Use when you need multiple independent connections in one app. Rendering two `<RemoteControl />` components against the same connection is a no-op-with-warning (each owns the connection's lifecycle). |

The component auto-detects its role from the URL: if `?id=…` is present, it acts as a client and joins that peer ID; otherwise, it acts as a host and advertises its own ID.

## Reactive state API

### `rcState<T>(key, initial, validate?)`

Create a reactive value that automatically syncs to all connected peers.

```ts
import { rcState } from 'svelte-remote-control';

const brightness = rcState('brightness', 50);

// template:
<input type="range" min="0" max="100" bind:value={brightness.value} />
```

Reading or writing `brightness.value` works like any `$state` rune. Writes broadcast a `__sync` message to all peers; receivers update their local copy and rebroadcast to their remaining peers (with the sender excluded to prevent echo).

Values are persisted to `sessionStorage` (`rc:state`) so they survive page reloads within the tab.

#### Validation

Pass an optional type-guard to protect against malformed peers and schema changes across sessions:

```ts
const mode = rcState<'light' | 'dark'>('mode', 'light',
    (v): v is 'light' | 'dark' => v === 'light' || v === 'dark');
```

- Persisted values that fail validation are replaced with `initial`.
- Incoming `__sync` messages that fail validation are dropped and **not** rebroadcast.

#### Sync semantics

`rcState` is **last-write-wins (LWW)** without causal ordering. Concurrent writes from different peers silently overwrite each other; the order of arrival on each peer determines the final value, so peers may temporarily disagree until the network settles. Suitable for UI state (slider positions, toggles, form inputs) where occasional lost updates are tolerable. **Not** suitable for counters, carts, or anything requiring convergence under concurrent edits.

### `deleteRcState(key)`

Remove a synced key locally and broadcast the deletion. Subsequent `rcState(key, initial)` calls will reset to `initial`. Deletion is also LWW — a concurrent write on another peer may resurrect the key.

### `connStatus()`

Returns the current connection status reactively. Call inside a `$derived`, `$effect`, or template:

```ts
const isConnected = $derived(connStatus() === 'connected');
```

Possible values: `'idle' | 'gathering' | 'awaiting' | 'connected' | 'disconnected' | 'error'`.

## Messaging API

### `send(message)`

Broadcast a JSON-serialisable message to all connected peers.

```ts
import { send } from 'svelte-remote-control';

send({ title: 'Hi!', urgency: 2 });
```

The payload is any plain object. A `type` field is conventional for
switch-style dispatch in `onMessage`, but not required — the only constraint
is that `type` values starting with `__` are reserved for library-internal
messages (`__sync`, `__sync_delete`, `__kick`).

### `onMessage(handler)`

Register an incoming-message handler. Returns an unsubscribe function — wrap in a `$effect` for automatic cleanup:

```ts
import { onMessage } from 'svelte-remote-control';

$effect(() => onMessage((msg, fromPeerId) => {
    if (msg.type === 'notification') {
        console.log(`From ${fromPeerId}: ${msg.title}`);
    }
}));
```

`fromPeerId` is the authoritative peer ID from the underlying DataConnection — it cannot be spoofed by the sender.

## Media / calls API

### `startCall(constraints): Promise<MediaStream>`

Acquire a local media stream via `getUserMedia` and call all connected peers with it. Supports audio-only, video-only, or both:

```ts
import { startCall } from 'svelte-remote-control';

await startCall({ video: true });                              // video only
await startCall({ audio: true });                              // audio only
await startCall({ video: true, audio: true });                 // both
await startCall({ video: { facingMode: 'environment' } });     // constraints
```

Returns the acquired `MediaStream` so you can stop its tracks when disconnecting.

### `makeCall(stream)`

Lower-level: call all connected peers with a stream you acquired yourself. Use this when you want control over the timing of `getUserMedia` separately from the call (e.g. acquire before connection, call after).

```ts
import { makeCall } from 'svelte-remote-control';

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
// …later, once connected…
makeCall(stream);
```

### `onCall(handler)`

Register an incoming-stream handler. Returns an unsubscribe function — wrap in a `$effect` for automatic cleanup:

```ts
import { onCall } from 'svelte-remote-control';

$effect(() => onCall((stream) => {
    videoEl.srcObject = stream;
    videoEl.play();
}));
```

## Advanced: multi-instance connections

The singleton API covers most cases, but if you need multiple independent connections from one app (e.g. a dashboard that hosts one connection and clients on another), use the class directly:

```ts
import { WebRTCConnection } from 'svelte-remote-control';

const conn = new WebRTCConnection();

await conn.createOffer();      // host
await conn.acceptOffer(hostId); // client

conn.send({ type: 'ping' });
conn.onMessage((msg, from) => console.log(from, msg));

// Reactive `$state` fields:
conn.status;           // ConnectionStatus
conn.connectedPeers;   // string[]
conn.localPeerId;      // string
conn.role;             // 'host' | 'client' | null
conn.error;            // string | null
conn.errorType;        // string | null: 'no-route', 'peer-unavailable', or another PeerJS error type
```

Pass custom ICE servers if you need TURN relays (see [TURN servers](#turn-servers)):

```ts
import { WebRTCConnection, DEFAULT_ICE_SERVERS } from 'svelte-remote-control';

const conn = new WebRTCConnection([
    ...DEFAULT_ICE_SERVERS,
    { urls: 'turn:my-turn.example.com', username: 'u', credential: 'c' },
]);
```

Pass a custom PeerJS broker (e.g. a self-hosted [peerjs-server](https://github.com/peers/peerjs-server)) alongside optional ICE servers:

```ts
const conn = new WebRTCConnection({
    iceServers: [{ urls: 'turn:my-turn.example.com', username: 'u', credential: 'c' }],
    peerServer: { host: 'my-peer.example.com', port: 9000, path: '/myapp', secure: true },
});
```

## TURN servers

Out of the box the library only uses STUN servers (`DEFAULT_ICE_SERVERS`), so the two devices must reach each other directly. That works on most networks, but not all. Typical failures:

- **Both devices on the same Wi-Fi.** Many routers block traffic between their own devices (guest networks usually do), or don't route a device's traffic to the network's own public address ("NAT hairpinning"). The give-away: it works as soon as you switch the phone to mobile data.
- **Guest, public or corporate networks** that only allow web traffic.
- **Strict NATs**, on some mobile networks.

A TURN server fixes all of these: when no direct path works, it relays the traffic. WebRTC tries direct paths first and only falls back to the relay, so you only pay for traffic that couldn't go direct.

### Symptom

After about 15 seconds of trying, the client shows "Can't reach the host" (and keeps retrying), and both devices log a `WebRTCConnection: could not connect to peer …` warning in the console. It says whether a TURN server was configured and, if it was, what went wrong with it. `chrome://webrtc-internals` shows the details for each attempt.

### Setup

**1. Get a TURN service.** For example:

- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/): 1,000 GB free, then $0.05/GB. Includes `turns:` on port 443, which gets through most firewalls. Credentials are short-lived and generated by an API call.
- [Metered](https://www.metered.ca/stun-turn): a small free tier, with an API for credentials.
- Your own [coturn](https://github.com/coturn/coturn) server. Needs open UDP/TCP ports on the server.

**2. Keep the API secret on a server, and give the browser short-lived credentials.** TURN credentials in client code can be copied and used by anyone, so get them from an endpoint of your own. With Cloudflare and a SvelteKit server route:

```ts
// src/routes/api/turn/+server.ts
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET() {
    const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl: 86400 }), // seconds the credentials stay valid
        },
    );
    if (!res.ok) return json({ error: 'No TURN credentials' }, { status: 502 });
    const { iceServers } = await res.json(); // STUN and TURN entries, ready for RTCPeerConnection
    return json({ iceServers });
}
```

A static site can't have a server route; put the endpoint anywhere else (a Cloudflare Worker, a small Node server) and allow your site's origin with CORS.

**3. Pass a function as `iceServers`.** It's called for every new connection (including each automatic retry) and once an hour while a connection lives, so the credentials are always fresh. If it throws, that connection uses `DEFAULT_ICE_SERVERS` (with a console warning), so the app keeps working on networks that don't need a relay:

```svelte
<script lang="ts">
    import RemoteControl from 'svelte-remote-control';

    async function iceServers(): Promise<RTCIceServer[]> {
        const res = await fetch('/api/turn', { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`TURN credentials: HTTP ${res.status}`);
        return (await res.json()).iceServers;
    }
</script>

<RemoteControl config={{ iceServers }} />
```

Do this on every page that renders `<RemoteControl />`, host and client alike. The list replaces the defaults rather than adding to them, so include STUN servers too (Cloudflare's response already does; otherwise spread `...DEFAULT_ICE_SERVERS` in). Give the credentials a `ttl` of a few hours or more: the hourly refresh only reaches new connections, so a relayed connection that outlives its credentials drops, and then reconnects with fresh ones.

The function form works with the class API too, in the constructor or in `configure()`:

```ts
const conn = new WebRTCConnection({ iceServers });
```

A fixed list (`iceServers: [...]`) works as well, e.g. with static credentials, but isn't refreshed.

## How it works

- **Signalling** uses the free public [PeerJS broker](https://peerjs.com/peerserver). No server setup required. The host publishes a random peer ID, the client scans/enters it to establish a WebRTC connection. After that, all traffic is peer-to-peer.
- **Topology** is a star: clients connect to the host; the host relays `__sync` messages between clients so they stay in sync with each other.
- **Storage** uses `sessionStorage` with the `rc:` prefix (`rc:state`, `rc:hostPeerId`) so the library is self-contained and won't collide with host-app keys.
- **Transport** is PeerJS DataConnections (reliable, JSON-serialised) for messages, and MediaConnections for streams.

## Requirements

- Svelte 5.0 or newer (uses runes). Works with SvelteKit, plain Vite + Svelte, or any other build setup.
- A browser with WebRTC support (all modern evergreen browsers). The status panel uses the Popover API where available and falls back to its own show/hide elsewhere (e.g. Safari before 17).
- HTTPS or `localhost` for `getUserMedia` in media calls.

## Security considerations

- Messages are **not authenticated**. Any peer that knows the ID can connect and send arbitrary payloads. The peer ID serves as a capability token — treat it like a share-link.
- For privileged operations, implement an application-level handshake using `__sync` or a custom message type with a shared secret exchanged out-of-band (e.g. via the QR code).
- WebRTC itself encrypts all traffic (DTLS for data, SRTP for media), so payloads are private in transit.
- `getUserMedia()` requires HTTPS or `localhost`.

## Troubleshooting

- **"Connected" status but video never appears** — check that the host calls `onCall()` before the client calls `startCall()`. If the stream event fires before the handler registers, the first stream is missed.
- **Peers connect on desktop but not on phone** — WebRTC requires HTTPS on non-localhost origins. Serve your app over HTTPS (e.g. `ngrok`, Cloudflare Tunnel, or a TLS cert).
- **Client says "Can't reach the host", e.g. with both devices on the same Wi-Fi, or behind a corporate firewall** — no direct path between the devices works, and there is no relay to fall back on. The console explains more. Configure a TURN server: see [TURN servers](#turn-servers).
- **Client says "Host not found"** — the host didn't answer within 10 seconds: its page is closed, or it has a new ID (scan its QR code again).
- **QR code scans, app opens, but never connects** — the phone's PeerJS client can't reach the signalling broker. Usually a corporate captive portal. Switch networks or host your own PeerJS server.
- **iOS Safari: audio doesn't play** — autoplay is blocked without a user gesture. Require a "Start" button tap before calling `startCall()`.

## Development playground

Run `npm run dev` to open the playground. The home route (`/`) acts as the host pane; scan the QR code with a phone (or open `/remote?id=…` in a second tab) to connect as a client. To try it with TURN, set `VITE_TURN_CREDENTIALS_URL` to an endpoint like the one in [TURN servers](#turn-servers) when running or building it.

## License

MIT
