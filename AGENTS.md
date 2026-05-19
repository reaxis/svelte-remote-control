# Agent Instructions — svelte-remote-control

After completing **any** change to this library — new files, modified logic, new dependencies, architectural decisions, or discovered gotchas — **update this file** to reflect the current state. Keep the Known Gotchas, Key Architecture Decisions, and File Layout sections accurate and up to date. Do not defer updates to a later session.

---

## Scope

This folder is a self-contained WebRTC connection primitive (`svelte-remote-control`). It is designed to be extractable into a standalone npm package. Keep it free of app-specific logic — the consuming project lives in `src/routes/`, not here.

---

## File Layout

| File | Responsibility | Dependencies |
|---|---|---|
| `webrtc.svelte.ts` | `WebRTCConnection` class: PeerJS transport + reactive `$state` fields for status/peers. | `peerjs`, Svelte 5 runes |
| `rcState.svelte.ts` | Module-level singleton `connection`, `__sync` wiring, public functional API (`send`, `onMessage`, `onCall`, `makeCall`, `startCall`, `rcState`, `deleteRcState`, `connStatus`). | `webrtc.svelte.ts` |
| `RemoteControl.svelte` | UI (QR + popover status). Re-exports the full public API through `<script module>`. | `rcState.svelte.ts`, `qrcode` |
| `index.ts` | Package entry point — re-exports full public API (preferred consumer import path). | `RemoteControl.svelte`, `rcState.svelte.ts`, `webrtc.svelte.ts` |
| `rcState.test.ts` | Tests for `rcState` LWW semantics, storage, validators. | vitest, jsdom |
| `webrtc.test.ts` | Tests for `WebRTCConnection` state machine. | vitest, jsdom |
| `README.md` | Consumer-facing package documentation. |  |

**Import rule:** No file in `src/lib/` may import from `$app/*` or any SvelteKit-specific module. All three library files are SvelteKit-independent.

---

## Public API Surface

All of these are exported from `src/lib/index.ts` (the canonical package entry point):

```ts
import RemoteControl, {
    rcState, deleteRcState, connStatus,
    send, onMessage,
    makeCall, startCall, onCall,
    connection,           // raw singleton WebRTCConnection instance
    WebRTCConnection,     // class, for advanced/multi-instance use
    DEFAULT_ICE_SERVERS,
} from 'svelte-remote-control';
```

`WebRTCConnection`, `ConnectionStatus`, `PeerServerOptions`, and `WebRTCConnectionOptions` are also exported for consumers who want the bare class without the singleton or UI.

Note: `RemoteControl.svelte`'s `<script module>` still re-exports the API for backwards compatibility, but `index.ts` is the authoritative entry point. Consumers using `import ... from 'svelte-remote-control'` get a default export (the component) plus all named exports.

---

## Key Architecture Decisions

- **Three-file split** is deliberate: all three files have zero SvelteKit deps. The library works in any Svelte 5 project — SvelteKit, plain Vite + Svelte, etc. `isBrowser = typeof window !== 'undefined'` guards SSR paths in `RemoteControl.svelte` instead of the former `browser` from `$app/environment`.
- **Singleton + class, both exported.** The singleton (`connection` in `rcState.svelte.ts`) covers the common case. `WebRTCConnection` is exported as a class for apps that need multiple independent connections.
- **Message types stay flexible, not strongly generic.** `send()` and `onMessage()` use `Record<string, unknown>` — any plain object. A `type` field is conventional for switch-style dispatch but not required; the library only reserves `__`-prefixed `type` values (`__sync`, `__sync_delete`, `__kick`) for internal routing. A generic `createChannel<T>()` was considered and deliberately rejected — flexibility is valued over compile-time message typing.
- **`rcState` is last-write-wins (LWW)**, no causal ordering. Documented in the module docstring and README. Suitable for UI state, not counters/carts.
- **Star topology assumption.** Clients connect to the host; the host rebroadcasts `__sync` messages to all other clients (sender excluded to prevent echo). A `onPeerConnect` hook flushes the full value map to each new peer.
- **Optional validators** on `rcState(key, initial, validate?)`. Invalid persisted values are replaced with `initial`; invalid incoming `__sync` payloads are dropped and **not** rebroadcast.
- **Storage is namespaced** with `rc:` prefix (`rc:state`, `rc:hostPeerId`) to avoid colliding with host-app `sessionStorage` keys.
- **`onMessage` / `onCall` auto-cleanup was removed** (was a silent `try { onDestroy(unsub) } catch {}` that only worked during top-level component init). Callers now wrap in `$effect(() => onMessage(...))` — Svelte's effect teardown runs the returned unsub deterministically.
- **`_peerId` / `_role` tagging was removed** from `send()`. The `fromPeerId` argument in `onMessage((msg, fromPeerId) => ...)` comes from the underlying DataConnection and is authoritative / un-spoofable.
- **Reactive UI URLs** in `RemoteControl.svelte` use `$derived` (not `$state` + effect) so `QRCode.toDataURL()` only re-runs when the URL string identity actually changes. A `cancelled` flag on the generation effect prevents stale promises from overwriting newer QRs.
- **Popover state** uses a single `popoverOpen` $state with a DOM-sync `$effect` (idempotent, guards with `:popover-open`) plus an `ontoggle` handler to capture manual dismiss. No imperative `showPopover()` / `hidePopover()` scattered through lifecycle code.
- **Retry uses reactive `retryAttempt`** (`$state`). The retry `$effect` depends on it explicitly, so increments deterministically schedule the next attempt instead of relying on status-transition coincidence.
- **`WebRTCConnection` constructor accepts an options object or a legacy `RTCIceServer[]` array.** `new WebRTCConnection({ iceServers, peerServer })` or the old `new WebRTCConnection(iceServersArray)` both work. `peerServer` is spread into the PeerJS constructor config, enabling custom brokers (host/port/path/secure/key). The array form is preserved for backwards compat.
- **`__kick` is a system message for bidirectional disconnect.** `WebRTCConnection.kick(peerId)` sends `{ type: '__kick' }` to the target peer — it does NOT close the DataConnection itself. The receiver calls `disconnect()` (stops retry, transitions to host mode). This same path handles both host-initiated kicks and client-initiated disconnects (the client's "Disconnect" button calls `disconnect()` directly; the host's kick button sends `__kick` and the client calls `disconnect()` in response). Consumer message types must not use `__`-prefixed type strings.
- **`isClient` respects `role === 'host'`.** Derived as `clientId !== null ? role !== 'host' : role === 'client'`. A URL client (`clientId` set) remains in client mode only while `role` is not `'host'`. Once `disconnect()` calls `startOffer()` and `role` becomes `'host'` (set synchronously inside `createOffer()`), `isClient` flips to `false` immediately — no separate flag needed.
- **`disconnect()` resets retry state inline and calls `startOffer()`.** `startOffer()` already performs `destroy()` internally; `disconnect()` deliberately does not call `stopRetry()` (which would destroy a second time and churn reactive status). It is `async` but not awaited by callers — the role transition completes asynchronously, so consumers inspecting `connection.role` immediately after a disconnect should yield a microtask.
- **`clientId` is captured once at component init**, not as a `$derived`. Client-side URL rewrites (e.g. `history.pushState` to strip `?id=…` after connecting) must not tear down the live connection. `isClient` remains derived so it tracks `role` changes for the post-disconnect flip back to host.
- **`<RemoteControl />` accepts an optional `connection={...}` prop.** Defaults to the module-level singleton. A `WeakSet`-backed mount guard emits a `console.warn` when two component instances bind to the same connection (each instance owns lifecycle — sharing one causes thrash).
- **`configure()` merges fields.** Only fields explicitly present in the options object are applied; omitted fields keep their existing value. Pass `{ peerServer: undefined }` to explicitly clear a previously-set broker. Changes take effect on the next `createOffer()` / `acceptOffer()`; the live `Peer` is not reconfigured in place.
- **`__sync` and `__sync_delete` are idempotent on receive.** Incoming sync messages whose key+value already match local state are dropped without rebroadcast; deletes for absent keys are also dropped. This prevents amplification across N peers even when the star-topology sender-exclusion isn't sufficient (e.g. future mesh topologies).
- **Popover auto-opens only during `'gathering'`, not `'idle'`.** The `idle` status is ambiguous — it means both "never connected" and "just destroyed". Auto-opening on `idle` caused the popover to hang in "Connecting…" after disconnect. The `idle && retryPeerId` combination in the client template is used to detect the post-disconnect case and show a "Disconnected" state instead.

---

## Known Gotchas

- **`localPeerId` is cleared on `destroy()`.** This means the trigger UI loses its peer-ID label immediately on disconnect. This is intentional — the field represents "current" identity, not "last known". Do not change this without a conscious decision.
- **Module-level handlers in `rcState.svelte.ts` are never unsubscribed.** This is intentional — they live for the lifetime of the singleton. `connection.destroy()` preserves handler sets by design so the wiring survives reconnects. The relevant comment is above the `connection.onMessage(...)` call.
- **`onDestroy` wrapping in try/catch is dead-end magic.** Don't bring it back. If you need automatic cleanup, wrap the subscription in `$effect(() => onMessage(...))` at the call site.
- **`acceptOffer` / `#createPeer` remove listeners mutually on resolve.** Don't simplify this into single `.once('error', reject)` + `.once('open', resolve)` — the stray listeners leak and mask later errors.
- **Post-open peer errors** are handled by a persistent `peer.on('error')` in `#createPeer`. Fatal errors (`peer.destroyed`) set `status = 'error'`; transient `peer-unavailable` / `webrtc` errors only warn. A stale-listener guard (`this.#peer !== peer`) protects against callbacks firing after `destroy()`.
- **Media calls are tracked** in `#mediaCalls: Set<MediaConnection>`. `#cleanup` closes them explicitly — don't rely on `peer.destroy()` cascading.
- **`sessionStorage` is guarded** at module init (`typeof sessionStorage !== 'undefined'`) because a future SSR context might load this module before `window` exists. Don't remove the guard.
- **Closing a browser tab doesn't cleanly close WebRTC DataConnections** — the SCTP channel doesn't send a FIN unless `dc.close()` is called explicitly. A `beforeunload` handler registered in `#createPeer` closes all open DataConnections so the remote peer receives `dc.on('close')` immediately instead of waiting ~30s for ICE keepalive timeout. The handler is deregistered in `#cleanup` to avoid leaks on explicit disconnect/reconnect.
- **`remoteHref` is typed `string`**. Previously typed as `AppRoute` (SvelteKit's route union) but decoupled — consumers pass a plain path string like `"/remote"`.
- **Writing large Svelte files via shell heredoc fails** when content contains backticks. Use `create_file` or edit via tool calls.
- **`kick()` only signals — it does not close the DataConnection.** If the remote peer does not handle `__kick` (e.g. a non-`RemoteControl` client), the connection stays open. Don't add `dc.close()` back to `kick()` without reconsidering the whole disconnect flow.

---

## Publishing checklist

The package is ready to publish:
- `package.json` has `"exports"`, `"svelte"`, `"types"` fields (correct).
- Peer deps: `svelte`, `peerjs`, `qrcode` (no `@sveltejs/kit` needed — fully decoupled).
- `src/lib/index.ts` is the single entry point.
- `npm run prepack` builds `dist/` cleanly with `publint` passing.

Remaining before `npm publish`:
1. Set `repository` and `homepage` in `package.json` once the git remote is set.
2. Tag `v0.1.0`.
3. Run `npm publish --access public`.

---

## Dependencies

| Package | Where | Purpose |
|---|---|---|
| `peerjs` | peerDep + devDep | WebRTC data + media connections |
| `qrcode` | peerDep + devDep | QR code generation for peer ID URL |
| `svelte` ≥ 5 | peerDep + devDep | Runes (`$state`, `$derived`, `$effect`) |
| `@types/qrcode` | devDep | TypeScript types |
| `vitest`, `jsdom` | devDep | Test runner + environment |

---

## Testing

Run tests: `npm test`  
Watch mode: `npm run test:watch`

Tests live in `src/lib/`:
- `webrtc.test.ts` — mocks `peerjs` via `vi.mock`; tests `WebRTCConnection` state machine.
- `rcState.test.ts` — mocks `./webrtc.svelte.js` via `vi.mock` + `vi.hoisted`; tests `rcState` LWW semantics, storage, and validators.

**Gotcha:** The `vi.mock` factory runs before variable declarations, so mock state (e.g. captured handlers) must be created via `vi.hoisted()`. Using arrow functions in `vi.fn(...)` for constructors doesn't work — use `vi.fn(function() { return obj; })`.

**Gotcha:** The `@sveltejs/vite-plugin-svelte` plugin is required in `vitest.config.ts` so that `.svelte.ts` runes (`$state`, etc.) are compiled correctly in tests.

---

## Project Configuration

- **Language**: TypeScript
- **Package Manager**: npm
- **Add-ons**: mcp

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.
