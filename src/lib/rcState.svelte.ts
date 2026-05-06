/**
 * rcState — module-level singleton wiring over WebRTCConnection, plus the
 * reactive `rcState` helper for syncing values across peers.
 *
 * Everything here is Svelte 5 + Web APIs only — no SvelteKit dependency.
 *
 * ## Sync semantics
 *
 * `rcState` values are **last-write-wins (LWW)** without causal ordering:
 * - Every write broadcasts a `__sync` message to all connected peers.
 * - Receivers accept the new value unconditionally and rebroadcast it to their
 *   other peers (the sender is excluded to prevent echo).
 * - Concurrent writes from different peers **silently overwrite** each other;
 *   the order of arrival on each peer determines the final value, so peers
 *   may temporarily disagree until the network settles.
 * - On peer connect, the whole value map is flushed to the new peer. In a
 *   star topology (guests ↔ host) this is exactly one pass per new guest.
 *
 * Suitable for UI state (slider positions, toggles, form inputs) where
 * occasional lost updates are tolerable. **Not** suitable for counters,
 * shopping carts, or anything requiring convergence under concurrent edits.
 *
 * Keys can be deleted via `deleteRcState(key)` — deletion is broadcast and
 * also LWW.
 */

import { WebRTCConnection } from './webrtc.svelte.js';

type SyncMsg = { type: '__sync'; key: string; value: unknown };
type DeleteMsg = { type: '__sync_delete'; key: string };

// ── Module-level connection singleton ─────────────────────────────────────

export const connection = new WebRTCConnection<{ type: string }>();

// ── rcState storage ───────────────────────────────────────────────────────

const _values = $state<Record<string, unknown>>({});

const STORAGE_KEY = 'rc:state';
if (typeof sessionStorage !== 'undefined') {
	try {
		const stored = sessionStorage.getItem(STORAGE_KEY);
		if (stored) Object.assign(_values, JSON.parse(stored));
	} catch {
		/* ignore malformed persisted state */
	}
}

function persistValues(): void {
	if (typeof sessionStorage === 'undefined') return;
	try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(_values)); } catch { /* ignore */ }
}

// Per-key validators registered via rcState()'s third arg. Used to drop
// invalid incoming `__sync` payloads before they corrupt local state.
const _validators = new Map<string, (v: unknown) => boolean>();

// ── Wire sync handlers ────────────────────────────────────────────────────
// These handlers are registered once at module init and intentionally never
// unsubscribed — they live for the lifetime of the singleton `connection`.
// `connection.destroy()` wipes live DataConnections but preserves the class's
// handler sets by design, so the wiring below survives reconnects.

connection.onMessage((msg, fromPeerId) => {
	if (msg.type === '__sync') {
		const m = msg as unknown as SyncMsg;
		const validate = _validators.get(m.key);
		if (validate && !validate(m.value)) {
			console.warn(`rcState: dropping invalid __sync for "${m.key}"`, m.value);
			return;
		}
		_values[m.key] = m.value;
		persistValues();
		for (const peerId of connection.connectedPeers) {
			if (peerId !== fromPeerId) connection.sendTo(peerId, msg);
		}
	} else if (msg.type === '__sync_delete') {
		const m = msg as unknown as DeleteMsg;
		delete _values[m.key];
		persistValues();
		for (const peerId of connection.connectedPeers) {
			if (peerId !== fromPeerId) connection.sendTo(peerId, msg);
		}
	}
});

connection.onPeerConnect((peerId) => {
	for (const key of Object.keys(_values)) {
		connection.sendTo(peerId, { type: '__sync', key, value: _values[key] } as { type: string });
	}
});

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Reactive value that syncs to all connected peers.
 *
 * See module docstring for sync semantics (last-write-wins, no causal
 * ordering, suitable for UI state).
 *
 * @param key    Unique key across all peers.
 * @param initial Default value if no value is already stored or synced.
 * @param validate Optional type-guard. If supplied:
 *   - Persisted values that fail validation are replaced with `initial`
 *     (protects against schema changes between sessions).
 *   - Incoming `__sync` messages that fail validation are dropped and not
 *     rebroadcast (protects against misbehaving peers).
 *
 * @example
 * // Plain:
 * let brightness = rcState('brightness', 0);
 *
 * // With validation:
 * let mode = rcState('mode', 'light' as 'light' | 'dark',
 *   (v): v is 'light' | 'dark' => v === 'light' || v === 'dark');
 */
export function rcState<T>(
	key: string,
	initial: T,
	validate?: (v: unknown) => v is T
): { value: T } {
	if (validate) {
		_validators.set(key, validate);
		// Re-check any already-stored value (e.g. loaded from sessionStorage
		// with a different schema version).
		if (key in _values && !validate(_values[key])) {
			_values[key] = initial;
			persistValues();
		}
	}
	if (!(key in _values)) _values[key] = initial;

	return {
		get value(): T { return _values[key] as T; },
		set value(v: T) {
			_values[key] = v;
			persistValues();
			if (connection.status === 'connected') {
				connection.send({ type: '__sync', key, value: v } as { type: string });
			}
		}
	};
}

/**
 * Remove a synced key locally and broadcast the deletion to all peers.
 * Subsequent `rcState(key, initial)` calls will reset to `initial`.
 *
 * Deletion is LWW — a concurrent write on another peer may resurrect the key.
 */
export function deleteRcState(key: string): void {
	delete _values[key];
	_validators.delete(key);
	persistValues();
	if (connection.status === 'connected') {
		connection.send({ type: '__sync_delete', key } as { type: string });
	}
}

/**
 * Reactive connection status. Call inside a `$derived` or template to react to status changes.
 * e.g. `$derived(connStatus() === 'connected')`
 */
export function connStatus() { return connection.status; }

/**
 * Broadcast a message to all connected peers.
 *
 * The sender's identity is available to receivers as the second argument of
 * `onMessage((msg, fromPeerId) => ...)` — authoritative and un-spoofable.
 */
export function send(msg: { type: string; [k: string]: unknown }): void {
	connection.send(msg as { type: string });
}

/**
 * Call all connected peers with a local media stream (camera/screen).
 * Call this after the connection is established.
 */
export function makeCall(stream: MediaStream): void {
	connection.makeCall(stream);
}

/**
 * Convenience: acquire a local media stream via `getUserMedia` and call all
 * connected peers with it. Supports audio-only, video-only, or both.
 *
 * @example
 *   await startCall({ video: true });
 *   await startCall({ audio: true });
 *   await startCall({ video: { facingMode: 'environment' }, audio: true });
 *
 * @returns the acquired `MediaStream` so the caller can stop its tracks
 * when disconnecting.
 */
export function startCall(constraints: MediaStreamConstraints): Promise<MediaStream> {
	return connection.startCall(constraints);
}

/**
 * Register a handler for an incoming media stream from a peer.
 * Returns an unsubscribe function — callers are responsible for cleanup.
 *
 * Inside a component, the idiomatic pattern is:
 *   $effect(() => onCall((stream) => { ... }));
 * (Svelte will invoke the returned unsub on teardown.)
 */
export function onCall(handler: (stream: MediaStream) => void): () => void {
	return connection.onCall(handler);
}

/**
 * Register a handler for incoming messages. Returns an unsubscribe function —
 * callers are responsible for cleanup.
 *
 * Inside a component, the idiomatic pattern is:
 *   $effect(() => onMessage((msg) => { ... }));
 * (Svelte will invoke the returned unsub on teardown.)
 */
export function onMessage(
	handler: (msg: { type: string; [k: string]: unknown }, fromPeerId: string) => void
): () => void {
	return connection.onMessage(handler as (msg: { type: string }, fromPeerId: string) => void);
}
