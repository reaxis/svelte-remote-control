/**
 * WebRTCConnection — transport-level primitive (data channel + media call).
 *
 * Pure class with Svelte 5 `$state` fields for reactive status. No SvelteKit
 * dependencies, so it can be published standalone or reused in any Svelte 5
 * project.
 */

import type { Peer, DataConnection, MediaConnection } from 'peerjs';

/**
 * Lifecycle states of a `WebRTCConnection`.
 *
 * - `'idle'`      — never started, or just destroyed. The connection has no
 *                    live `Peer` and no broker session. Use this to detect
 *                    "nothing to do" rather than "just lost a peer".
 * - `'gathering'` — broker handshake / ICE gathering in progress.
 * - `'awaiting'`  — host registered with the broker, waiting for a client.
 * - `'connected'` — at least one DataConnection is open.
 * - `'disconnected'` — the last peer went away while a connection was alive.
 *                    Distinct from `'idle'`: implies prior connectivity, and
 *                    typically pairs with a retry attempt on the client side.
 * - `'error'`     — a fatal failure occurred; see `.error` for the message.
 */
export type ConnectionStatus =
	| 'idle'
	| 'gathering'
	| 'awaiting'
	| 'connected'
	| 'disconnected'
	| 'error';

/**
 * PeerJS broker server configuration. These fields are spread directly into
 * the PeerJS `Peer` constructor; see the PeerJS docs for full semantics.
 *
 * - `host`/`port`/`path` — broker location (defaults to PeerJS’s public broker).
 * - `secure` — use `wss://` (`true`) vs `ws://` (`false`). Defaults to `false`
 *               in PeerJS unless the page is served over HTTPS.
 * - `key` — API key required by some self-hosted brokers.
 */
export type PeerServerOptions = {
	host?: string;
	port?: number;
	path?: string;
	secure?: boolean;
	key?: string;
};

export type WebRTCConnectionOptions = {
	iceServers?: RTCIceServer[];
	peerServer?: PeerServerOptions;
};

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: 'stun:stun1.l.google.com:19302' },
	{ urls: 'stun:stun2.l.google.com:19302' }
];

export class WebRTCConnection<TMessage extends Record<string, unknown> = Record<string, unknown>> {
	status = $state<ConnectionStatus>('idle');
	error = $state<string | null>(null);
	connectedPeers = $state<string[]>([]);
	role = $state<'host' | 'client' | null>(null);
	localPeerId = $state('');

	#peer: Peer | null = null;
	#connections = new Map<string, DataConnection>();
	#mediaCalls = new Set<MediaConnection>();
	#handlers = new Set<(msg: TMessage, fromPeerId: string) => void>();
	#connectHandlers = new Set<(peerId: string) => void>();
	#callHandlers = new Set<(stream: MediaStream) => void>();
	#iceServers: RTCIceServer[];
	#peerServer: PeerServerOptions | undefined;
	#unloadHandler: (() => void) | null = null;

	constructor(options?: RTCIceServer[] | WebRTCConnectionOptions) {
		if (Array.isArray(options)) {
			this.#iceServers = options;
			this.#peerServer = undefined;
		} else {
			this.#iceServers = options?.iceServers ?? DEFAULT_ICE_SERVERS;
			this.#peerServer = options?.peerServer;
		}
	}

	/**
	 * Update connection options. Only fields that are explicitly present in
	 * `options` are applied; omitted fields keep their existing value. Pass
	 * `{ peerServer: undefined }` to explicitly clear a previously-set broker.
	 *
	 * Changes take effect on the next `createOffer()` / `acceptOffer()`. The
	 * live `Peer` is not reconfigured in place — call `destroy()` and start
	 * over to apply changes to an active connection.
	 */
	configure(options: WebRTCConnectionOptions): void {
		if ('iceServers' in options && options.iceServers) this.#iceServers = options.iceServers;
		if ('peerServer' in options) this.#peerServer = options.peerServer;
	}

	async createOffer(preferredId?: string): Promise<string> {
		try {
			this.#cleanup();
			this.status = 'gathering';
			this.error = null;
			this.role = 'host';

			let peer: Peer;
			try {
				peer = await this.#createPeer(preferredId);
			} catch (err) {
				if (preferredId && (err as { type?: string }).type === 'unavailable-id') {
					peer = await this.#createPeer();
				} else {
					throw err;
				}
			}

			peer.on('connection', (dc) => { this.#attachConnection(dc, false); });
			this.status = 'awaiting';
			return peer.id;
		} catch (err) {
			this.status = 'error';
			this.error = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	async acceptOffer(hostId: string): Promise<void> {
		try {
			this.#cleanup();
			this.status = 'gathering';
			this.error = null;
			this.role = 'client';

			const peer = await this.#createPeer();

			const dc = await new Promise<DataConnection>((resolve, reject) => {
				const conn = peer.connect(hostId, { reliable: true, serialization: 'json' });
				conn.once('open', () => resolve(conn));
				conn.once('error', reject);
				peer.once('error', reject);
			});

			this.#connections.set(dc.peer, dc);
			this.connectedPeers = [...this.#connections.keys()];
			this.status = 'connected';
			this.#attachConnection(dc, true);
		} catch (err) {
			this.status = 'error';
			this.error = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	send(message: TMessage): void {
		let sent = false;
		for (const dc of this.#connections.values()) {
			if (dc.open) { dc.send(message); sent = true; }
		}
		if (!sent) console.warn('WebRTCConnection: cannot send — no open connections');
	}

	sendTo(peerId: string, message: TMessage): void {
		const dc = this.#connections.get(peerId);
		if (dc?.open) dc.send(message);
		else console.warn(`WebRTCConnection: cannot send to ${peerId} — not connected`);
	}

	onMessage(handler: (msg: TMessage, fromPeerId: string) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	onPeerConnect(handler: (peerId: string) => void): () => void {
		this.#connectHandlers.add(handler);
		return () => this.#connectHandlers.delete(handler);
	}

	/**
	 * Call all connected peers with the given media stream.
	 *
	 * Does **not** de-duplicate against existing media calls: invoking this
	 * twice creates two independent `MediaConnection`s per peer. Track the
	 * returned `MediaStream` from `startCall()` and stop its tracks before
	 * calling again if you want to replace, not stack, streams.
	 */
	makeCall(stream: MediaStream): void {
		if (!this.#peer) { console.warn('WebRTCConnection: cannot call — peer not initialised'); return; }
		for (const peerId of this.#connections.keys()) {
			const call = this.#peer.call(peerId, stream);
			this.#attachMediaCall(call);
		}
	}

	/**
	 * Convenience: acquire a local media stream via `getUserMedia` and call all
	 * connected peers with it. Supports audio-only, video-only, or both.
	 *
	 * @example
	 *   await conn.startCall({ video: true });                              // video only
	 *   await conn.startCall({ audio: true });                              // audio only
	 *   await conn.startCall({ video: true, audio: true });                 // both
	 *   await conn.startCall({ video: { facingMode: 'environment' } });     // constraints
	 *
	 * @returns the acquired `MediaStream` so the caller can stop its tracks
	 * when disconnecting.
	 */
	async startCall(constraints: MediaStreamConstraints): Promise<MediaStream> {
		if (!constraints.audio && !constraints.video) {
			throw new Error('WebRTCConnection.startCall: at least one of `audio` or `video` must be set');
		}
		const stream = await navigator.mediaDevices.getUserMedia(constraints);
		this.makeCall(stream);
		return stream;
	}

	/** Register a handler for incoming media streams. Returns an unsubscribe function. */
	onCall(handler: (stream: MediaStream) => void): () => void {
		this.#callHandlers.add(handler);
		return () => this.#callHandlers.delete(handler);
	}

	/**
	 * Signal a peer to disconnect by sending a `__kick` message on its data
	 * channel. **Does not close the underlying `DataConnection`** — the
	 * receiving peer is expected to recognise `__kick` and call `destroy()`
	 * itself (which is what `<RemoteControl />` does). A non-cooperating peer
	 * remains connected.
	 *
	 * The `__` prefix on message type strings is reserved for library-internal
	 * use (`__kick`, `__sync`, `__sync_delete`). Consumer messages must not use
	 * `type` values starting with `__`.
	 */
	kick(peerId: string): void {
		const dc = this.#connections.get(peerId);
		if (!dc) return;
		dc.send({ type: '__kick' } as unknown as TMessage);
	}

	destroy(): void {
		this.#cleanup();
		this.status = 'idle';
		this.error = null;
		// Do NOT clear #handlers or #connectHandlers — module-level registrations
		// persist across reconnects by design.
	}

	async #createPeer(peerId?: string): Promise<Peer> {
		const { Peer: PeerClass } = await import('peerjs');
		const peerConfig = { config: { iceServers: this.#iceServers }, ...(this.#peerServer ?? {}) };
		const peer = peerId
			? new PeerClass(peerId, peerConfig)
			: new PeerClass(peerConfig);
		this.#peer = peer;

		await new Promise<void>((resolve, reject) => {
			const onOpen = () => { peer.off('error', onError); resolve(); };
			const onError = (err: Error) => { peer.off('open', onOpen); reject(err); };
			peer.once('open', onOpen);
			peer.once('error', onError);
		});

		// Persistent error handler for post-open errors (signaling loss, fatal
		// socket errors, transient peer-unavailable on later connect/call attempts).
		// PeerJS sets peer.destroyed after fatal errors; peer.disconnected on
		// transient signaling loss (may auto-reconnect).
		peer.on('error', (err: Error & { type?: string }) => {
			if (this.#peer !== peer) return; // stale listener after destroy()
			const type = err.type ?? 'unknown';
			if (peer.destroyed) {
				this.status = 'error';
				this.error = `${type}: ${err.message}`;
			} else if (type === 'peer-unavailable' || type === 'webrtc') {
				// Transient per-attempt error; active connections are unaffected.
				console.warn(`WebRTCConnection: non-fatal peer error (${type}):`, err.message);
			} else {
				// disconnected / network — signaling is gone but p2p may survive.
				console.warn(`WebRTCConnection: peer signaling issue (${type}):`, err.message);
			}
		});

		// Wire incoming media calls
		peer.on('call', (call: MediaConnection) => {
			call.answer();
			this.#attachMediaCall(call);
		});

		this.localPeerId = peer.id;

		// Explicitly close DataConnections on tab close so the remote end receives
		// an SCTP FIN and fires dc.on('close') immediately (without this, the host
		// waits ~30s for ICE keepalives to time out).
		if (this.#unloadHandler) window.removeEventListener('beforeunload', this.#unloadHandler);
		this.#unloadHandler = () => {
			for (const dc of this.#connections.values()) { try { dc.close(); } catch { /* ignore */ } }
		};
		window.addEventListener('beforeunload', this.#unloadHandler);

		return peer;
	}

	#attachMediaCall(call: MediaConnection): void {
		this.#mediaCalls.add(call);
		call.on('stream', (stream: MediaStream) => {
			for (const h of this.#callHandlers) h(stream);
		});
		call.on('close', () => {
			this.#mediaCalls.delete(call);
		});
		call.on('error', (err: Error) => {
			this.#mediaCalls.delete(call);
			console.warn(`WebRTCConnection: media call error (peer ${call.peer}):`, err.message);
		});
	}

	#attachConnection(dc: DataConnection, alreadyOpen: boolean): void {
		if (!alreadyOpen) {
			dc.on('open', () => {
				this.#connections.set(dc.peer, dc);
				this.connectedPeers = [...this.#connections.keys()];
				this.status = 'connected';
				for (const h of this.#connectHandlers) h(dc.peer);
			});
		}

		dc.on('close', () => {
			if (!this.#connections.has(dc.peer)) return;
			this.#connections.delete(dc.peer);
			this.connectedPeers = [...this.#connections.keys()];
			if (this.#connections.size === 0) {
				this.status = this.role === 'host' ? 'awaiting' : 'disconnected';
			}
		});

		dc.on('error', (err) => {
			if (!this.#connections.has(dc.peer)) return;
			if (this.#connections.size === 0) {
				this.status = 'error';
				this.error = err instanceof Error ? err.message : String(err);
			}
		});

		dc.on('data', (data) => {
			if (!this.#connections.has(dc.peer)) return;
			try {
				const msg = (typeof data === 'string' ? JSON.parse(data) : data) as TMessage;
				for (const handler of this.#handlers) handler(msg, dc.peer);
			} catch {
				console.warn('WebRTCConnection: failed to parse message:', data);
			}
		});
	}

	#cleanup(): void {
		if (this.#unloadHandler) {
			window.removeEventListener('beforeunload', this.#unloadHandler);
			this.#unloadHandler = null;
		}
		for (const call of this.#mediaCalls) {
			try { call.close(); } catch { /* ignore */ }
		}
		this.#mediaCalls.clear();
		for (const dc of this.#connections.values()) {
			try { dc.close(); } catch { /* ignore */ }
		}
		this.#connections.clear();
		this.connectedPeers = [];
		this.localPeerId = '';
		if (this.#peer) {
			try { this.#peer.destroy(); } catch { /* ignore */ }
			this.#peer = null;
		}
		this.role = null;
	}
}
