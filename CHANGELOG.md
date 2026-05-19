# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-05-19

### Added
- `<RemoteControl />` `connection` prop for binding the UI to a caller-supplied
  `WebRTCConnection` instance (multi-connection apps).
- `<RemoteControl />` `config` prop for per-instance ICE servers / PeerJS broker.
- `WebRTCConnection` constructor now accepts an options object
  (`{ iceServers, peerServer }`) alongside the legacy `RTCIceServer[]` form.
- `WebRTCConnection.configure()` merges options into the instance; takes effect
  on the next `createOffer()` / `acceptOffer()`.
- `WebRTCConnectionOptions` and `PeerServerOptions` exported from the package
  entry point.
- `__sync` / `__sync_delete` are now idempotent on receive — incoming messages
  that match local state are dropped without rebroadcast.
- Tab-close cleanup: `beforeunload` handler closes open DataConnections so
  remote peers see `close` immediately instead of waiting on ICE timeout.

### Changed
- `RemoteControl.svelte` no longer depends on `$app/*` (SvelteKit). Works in
  any Svelte 5 project. `remoteHref` prop is now `string` instead of `AppRoute`.
- Removed `@sveltejs/kit` from `peerDependencies`.
- `send()` and `onMessage()` no longer require a `type` field on user messages.
  The library only reserves `__`-prefixed `type` values (`__sync`,
  `__sync_delete`, `__kick`) for internal routing.
- `onMessage` / `onCall` no longer auto-unsubscribe via `onDestroy`. Wrap the
  call in `$effect(() => onMessage(...))` for deterministic cleanup.
- `kick()` now signals via `__kick` instead of closing the DataConnection;
  receiving peers call `disconnect()` in response.
- `sessionStorage` keys are now namespaced with `rc:` (`rc:state`,
  `rc:hostPeerId`) to avoid colliding with host-app keys.

### Fixed
- `configure()` no longer resets omitted fields.
- `__sync` rebroadcast no longer echoes messages back to the sender or forwards
  malformed payloads.
- Reactive UI URLs use `$derived` with a `cancelled` guard so stale QR-code
  promises can't overwrite newer ones.
- Retry uses an explicit reactive `retryAttempt` counter for deterministic
  scheduling across status transitions.

## [0.1.0] - 2026-05-06

### Added
- Initial release.
- `WebRTCConnection` class with PeerJS transport + reactive `$state` fields.
- Module-level singleton API: `send`, `onMessage`, `makeCall`, `startCall`, `onCall`.
- `rcState` reactive synced state with optional validators and LWW semantics.
- `deleteRcState` for key removal across peers.
- `<RemoteControl />` UI component with QR code, popover status, auto-reconnect.
