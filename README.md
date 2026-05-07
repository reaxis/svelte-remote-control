# @reaxis/svelte-remote-control

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
npm install @reaxis/svelte-remote-control
```

Peer dependencies: `svelte >= 5.0`, `peerjs`, `qrcode`.

## Quick start

### Laptop / host route (`src/routes/+page.svelte`)

```svelte
<script lang="ts">
    import RemoteControl, { onCall } from '@reaxis/svelte-remote-control';

    let videoEl: HTMLVideoElement;

    $effect(() => onCall((stream) => {
        videoEl.srcObject = stream;
        videoEl.play();
    }));
</script>

<RemoteControl remoteHref="/remote" />

<video bind:this={videoEl} autoplay playsinline muted></video>
```

### Phone / client route (`src/routes/remote/+page.svelte`)

```svelte
<script lang="ts">
    import RemoteControl, { startCall, connStatus } from '@reaxis/svelte-remote-control';

    $effect(() => {
        if (connStatus() === 'connected') {
            startCall({ video: { facingMode: 'environment' }, audio: false });
        }
    });
</script>

<RemoteControl remoteHref="/remote" />
```

Open the laptop page, scan the QR code with the phone — and you're connected.

## Component

### `<RemoteControl />`

Renders a small floating status trigger (top-right by default) with a popover containing:
- A QR code and copyable URL for clients to scan.
- Connection status (idle / gathering / awaiting / connected / disconnected / error).
- The list of connected peer IDs on the host side.
- A manual-entry field for pasting a peer ID.
- Retry state (countdown and stop button) on the client side.

#### Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `remoteHref` | `string` | current page path | Path clients should be sent to (e.g. `"/remote"`). Omit for same-route connections (useful for peer-to-peer symmetric apps); set when host and client interfaces are on different routes. |

The component auto-detects its role from the URL: if `?id=…` is present, it acts as a client and joins that peer ID; otherwise, it acts as a host and advertises its own ID.

## Reactive state API

### `rcState<T>(key, initial, validate?)`

Create a reactive value that automatically syncs to all connected peers.

```ts
import { rcState } from '@reaxis/svelte-remote-control';

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
import { send } from '@reaxis/svelte-remote-control';

send({ type: 'notification', title: 'Hi!' });
```

Messages must have a `type` field. Beyond that, the payload is free-form — this primitive optimises for flexibility.

### `onMessage(handler)`

Register an incoming-message handler. Returns an unsubscribe function — wrap in a `$effect` for automatic cleanup:

```ts
import { onMessage } from '@reaxis/svelte-remote-control';

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
import { startCall } from '@reaxis/svelte-remote-control';

await startCall({ video: true });                              // video only
await startCall({ audio: true });                              // audio only
await startCall({ video: true, audio: true });                 // both
await startCall({ video: { facingMode: 'environment' } });     // constraints
```

Returns the acquired `MediaStream` so you can stop its tracks when disconnecting.

### `makeCall(stream)`

Lower-level: call all connected peers with a stream you acquired yourself. Use this when you want control over the timing of `getUserMedia` separately from the call (e.g. acquire before connection, call after).

```ts
import { makeCall } from '@reaxis/svelte-remote-control';

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
// …later, once connected…
makeCall(stream);
```

### `onCall(handler)`

Register an incoming-stream handler. Returns an unsubscribe function — wrap in a `$effect` for automatic cleanup:

```ts
import { onCall } from '@reaxis/svelte-remote-control';

$effect(() => onCall((stream) => {
    videoEl.srcObject = stream;
    videoEl.play();
}));
```

## Advanced: multi-instance connections

The singleton API covers most cases, but if you need multiple independent connections from one app (e.g. a dashboard that hosts one connection and clients on another), use the class directly:

```ts
import { WebRTCConnection } from '@reaxis/svelte-remote-control';

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
```

Pass custom ICE servers if you need TURN relays:

```ts
const conn = new WebRTCConnection([
    { urls: 'stun:stun.l.google.com:19302' },
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

## How it works

- **Signalling** uses the free public [PeerJS broker](https://peerjs.com/peerserver). No server setup required. The host publishes a random peer ID, the client scans/enters it to establish a WebRTC connection. After that, all traffic is peer-to-peer.
- **Topology** is a star: clients connect to the host; the host relays `__sync` messages between clients so they stay in sync with each other.
- **Storage** uses `sessionStorage` with the `rc:` prefix (`rc:state`, `rc:hostPeerId`) so the library is self-contained and won't collide with host-app keys.
- **Transport** is PeerJS DataConnections (reliable, JSON-serialised) for messages, and MediaConnections for streams.

## Requirements

- Svelte 5.0 or newer (uses runes). Works with SvelteKit, plain Vite + Svelte, or any other build setup.
- A browser with WebRTC support (all modern evergreen browsers).
- HTTPS or `localhost` for `getUserMedia` in media calls.

## Security considerations

- Messages are **not authenticated**. Any peer that knows the ID can connect and send arbitrary payloads. The peer ID serves as a capability token — treat it like a share-link.
- For privileged operations, implement an application-level handshake using `__sync` or a custom message type with a shared secret exchanged out-of-band (e.g. via the QR code).
- WebRTC itself encrypts all traffic (DTLS for data, SRTP for media), so payloads are private in transit.
- `getUserMedia()` requires HTTPS or `localhost`.

## Troubleshooting

- **"Connected" status but video never appears** — check that the host calls `onCall()` before the client calls `startCall()`. If the stream event fires before the handler registers, the first stream is missed.
- **Peers connect on desktop but not on phone** — WebRTC requires HTTPS on non-localhost origins. Serve your app over HTTPS (e.g. `ngrok`, Cloudflare Tunnel, or a TLS cert).
- **Connection drops behind restrictive NAT / corporate firewalls** — the default STUN servers are insufficient. Provide TURN servers via `new WebRTCConnection({ iceServers: [...] })`.
- **QR code scans, app opens, but never connects** — the phone's PeerJS client can't reach the signalling broker. Usually a corporate captive portal. Switch networks or host your own PeerJS server.
- **iOS Safari: audio doesn't play** — autoplay is blocked without a user gesture. Require a "Start" button tap before calling `startCall()`.

## Development playground

Run `npm run dev` to open the playground. The home route (`/`) acts as the host pane; scan the QR code with a phone (or open `/remote?id=…` in a second tab) to connect as a client.

## License

MIT
