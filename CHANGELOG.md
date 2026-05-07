# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-05-06

### Added
- Initial release.
- `WebRTCConnection` class with PeerJS transport + reactive `$state` fields.
- Module-level singleton API: `send`, `onMessage`, `makeCall`, `startCall`, `onCall`.
- `rcState` reactive synced state with optional validators and LWW semantics.
- `deleteRcState` for key removal across peers.
- `<RemoteControl />` UI component with QR code, popover status, auto-reconnect.
