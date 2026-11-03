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

/**
 * ICE servers as a fixed list, or a function that returns one. A function is
 * called for every new `Peer` (each `createOffer()` / `acceptOffer()`) and
 * again every `ICE_REFRESH_MS` while it lives, so short-lived TURN credentials
 * can be fetched fresh. If it throws or rejects, a new `Peer` falls back to
 * `DEFAULT_ICE_SERVERS` and a refresh keeps the previous list.
 */
export type IceServersSource = RTCIceServer[] | (() => RTCIceServer[] | Promise<RTCIceServer[]>);

export type WebRTCConnectionOptions = {
	iceServers?: IceServersSource;
	peerServer?: PeerServerOptions;
};

/** How long a client waits for the host to answer its offer. */
const ANSWER_TIMEOUT_MS = 10_000;

/** How often a live `Peer` re-runs an `iceServers` function (1 hour). */
const ICE_REFRESH_MS = 60 * 60 * 1000;

/** Thrown by an attempt that a later `createOffer()` / `acceptOffer()` / `destroy()` replaced. */
class SupersededError extends Error {
	readonly type = 'superseded';
	constructor() { super('WebRTCConnection: superseded by a newer attempt'); }
}

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: 'stun:stun1.l.google.com:19302' },
	{ urls: 'stun:stun2.l.google.com:19302' }
];

export class WebRTCConnection<TMessage extends Record<string, unknown> = Record<string, unknown>> {
	status = $state<ConnectionStatus>('idle');
	error = $state<string | null>(null);
	/**
	 * Machine-readable kind of the current `error`: PeerJS's error type (e.g.
	 * `'peer-unavailable'`, `'network'`), or `'no-route'` when the devices
	 * found each other but no network path between them worked (see the
	 * README's "TURN servers"). `null` when there is no error or no type.
	 */
	errorType = $state<string | null>(null);
	connectedPeers = $state<string[]>([]);
	role = $state<'host' | 'client' | null>(null);
	localPeerId = $state('');

	/**
	 * Bumped by every `#cleanup()`. An attempt remembers the value it started
	 * with and stops (`SupersededError`) once it changes, so a slow attempt
	 * can't install its `Peer` after a newer attempt or a `destroy()`.
	 */
	#epoch = 0;
	#peer: Peer | null = null;
	#connections = new Map<string, DataConnection>();
	#mediaCalls = new Set<MediaConnection>();
	#handlers = new Set<(msg: TMessage, fromPeerId: string) => void>();
	#connectHandlers = new Set<(peerId: string) => void>();
	#callHandlers = new Set<(stream: MediaStream) => void>();
	#iceServers: IceServersSource;
	/** The list the live `Peer` uses: `#iceServers`, resolved. */
	#activeIceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
	#iceRefreshTimer: ReturnType<typeof setInterval> | null = null;
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

	/**
	 * Register with the broker as a host and wait for clients. Rejects on
	 * failure (also shown through `status` / `error`), or with an error of
	 * `type` `'superseded'` when a newer attempt or `destroy()` replaced it.
	 */
	async createOffer(preferredId?: string): Promise<string> {
		this.#cleanup();
		const epoch = this.#epoch;
		try {
			this.status = 'gathering';
			this.error = null;
			this.errorType = null;
			this.role = 'host';

			let peer: Peer;
			try {
				peer = await this.#createPeer(epoch, preferredId);
			} catch (err) {
				if (preferredId && (err as { type?: string }).type === 'unavailable-id') {
					peer = await this.#createPeer(epoch);
				} else {
					throw err;
				}
			}

			peer.on('connection', (dc) => {
				this.#watchIce(dc);
				this.#attachConnection(dc, false);
			});
			this.status = 'awaiting';
			return peer.id;
		} catch (err) {
			if (epoch !== this.#epoch) throw err; // a newer attempt owns the state
			this.status = 'error';
			this.error = err instanceof Error ? err.message : String(err);
			this.errorType = errorTypeOf(err);
			throw err;
		}
	}

	/**
	 * Connect to the host with ID `hostId`. Rejects on failure (also shown
	 * through `status` / `error` / `errorType`), or with an error of `type`
	 * `'superseded'` when a newer attempt or `destroy()` replaced it.
	 */
	async acceptOffer(hostId: string): Promise<void> {
		this.#cleanup();
		const epoch = this.#epoch;
		try {
			this.status = 'gathering';
			this.error = null;
			this.errorType = null;
			this.role = 'client';

			const peer = await this.#createPeer(epoch);

			const dc = await new Promise<DataConnection>((resolve, reject) => {
				const conn = peer.connect(hostId, { reliable: true, serialization: 'json' });
				const fail = (message: string, type: string) => {
					clearTimeout(answerTimer);
					if (this.#peer !== peer) return; // destroyed meanwhile
					conn.close();
					reject(Object.assign(new Error(message), { type }));
				};
				// Without these two, the client can wait forever: a connection with
				// no working network path never settles in Chrome (see #watchIce),
				// and the broker reports a missing host (`peer-unavailable`) only
				// sometimes; on a retry it often stays silent.
				this.#watchIce(conn, () => fail(
					`Could not reach peer ${hostId}: no network path between the devices worked.`,
					'no-route'
				));
				const answerTimer = setTimeout(() => {
					if (!conn.peerConnection?.remoteDescription) fail(`Peer ${hostId} did not answer.`, 'peer-unavailable');
				}, ANSWER_TIMEOUT_MS);
				conn.once('open', () => { clearTimeout(answerTimer); resolve(conn); });
				conn.once('error', (err) => { clearTimeout(answerTimer); reject(err); });
				peer.once('error', (err) => { clearTimeout(answerTimer); reject(err); });
			});

			if (epoch !== this.#epoch) { dc.close(); throw new SupersededError(); }
			this.#connections.set(dc.peer, dc);
			this.connectedPeers = [...this.#connections.keys()];
			this.status = 'connected';
			this.#attachConnection(dc, true);
		} catch (err) {
			if (epoch !== this.#epoch) throw err; // a newer attempt owns the state
			this.status = 'error';
			this.error = err instanceof Error ? err.message : String(err);
			this.errorType = errorTypeOf(err);
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
		this.errorType = null;
		// Do NOT clear #handlers or #connectHandlers — module-level registrations
		// persist across reconnects by design.
	}

	async #createPeer(epoch: number, peerId?: string): Promise<Peer> {
		const { Peer: PeerClass } = await import('peerjs');
		const iceServers = (await this.#resolveIceServers()) ?? DEFAULT_ICE_SERVERS;
		// Either await can outlast a newer attempt (e.g. a destroy() and a new
		// start right after mounting). Creating the Peer anyway would orphan it,
		// still registered with the broker under the same ID.
		if (epoch !== this.#epoch) throw new SupersededError();
		this.#activeIceServers = iceServers;
		const peerConfig = { config: { iceServers: this.#activeIceServers }, ...(this.#peerServer ?? {}) };
		const peer = peerId
			? new PeerClass(peerId, peerConfig)
			: new PeerClass(peerConfig);
		this.#peer = peer;

		await new Promise<void>((resolve, reject) => {
			const off = () => { peer.off('open', onOpen); peer.off('error', onError); peer.off('close', onClose); };
			const onOpen = () => { off(); resolve(); };
			const onError = (err: Error) => { off(); reject(err); };
			// destroy() while opening: PeerJS then emits 'close', not 'error'.
			const onClose = () => { off(); reject(new SupersededError()); };
			peer.once('open', onOpen);
			peer.once('error', onError);
			peer.once('close', onClose);
		});
		if (this.#peer !== peer) throw new SupersededError(); // destroyed while opening

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
				this.errorType = type;
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

		// PeerJS reads `peer.options.config` for every new RTCPeerConnection, so
		// refreshing it keeps a long-lived host's TURN credentials valid for the
		// clients that join later.
		if (this.#iceRefreshTimer) clearInterval(this.#iceRefreshTimer);
		if (typeof this.#iceServers === 'function') {
			this.#iceRefreshTimer = setInterval(async () => {
				const iceServers = await this.#resolveIceServers();
				if (!iceServers || this.#peer !== peer) return;
				this.#activeIceServers = iceServers;
				peer.options.config = { ...peer.options.config, iceServers };
			}, ICE_REFRESH_MS);
		}

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

	/** Resolve `#iceServers`; `null` (after a warning) if its function fails. */
	async #resolveIceServers(): Promise<RTCIceServer[] | null> {
		const source = this.#iceServers;
		if (typeof source !== 'function') return source;
		try {
			const iceServers = await source();
			if (!Array.isArray(iceServers)) throw new TypeError(`expected an array, got ${typeof iceServers}`);
			return iceServers;
		} catch (err) {
			console.warn('WebRTCConnection: the iceServers function failed; using DEFAULT_ICE_SERVERS (no TURN) for a new connection, or the previous list for a refresh:', err);
			return null;
		}
	}

	/**
	 * Explain a failed connection in the console. PeerJS reports nothing useful
	 * here: in Chrome, `iceConnectionState` stops at `'disconnected'` and never
	 * reaches `'failed'`, so PeerJS's `negotiation-failed` error never fires and
	 * the client waits forever. `connectionState` does reach `'failed'`, about
	 * 15 s after the checks start; `iceConnectionState` is watched too, for
	 * browsers that only report that one. Candidate types and
	 * TURN errors are recorded along the way to tell the likely causes apart.
	 */
	#watchIce(conn: { peer: string; peerConnection?: RTCPeerConnection }, onFailed?: () => void): void {
		const pc = conn.peerConnection;
		if (!pc) return;
		const candidateTypes = new Set<string>();
		const turnErrors = new Set<string>();
		let wasConnected = false;
		let warned = false;
		pc.addEventListener('icecandidate', (e) => {
			if (e.candidate?.type) candidateTypes.add(e.candidate.type);
		});
		pc.addEventListener('icecandidateerror', (e) => {
			if (/^turns?:/.test(e.url)) turnErrors.add(`${e.url} (${e.errorCode} ${e.errorText})`);
		});
		const onStateChange = (state: string) => {
			if (state === 'connected' || state === 'completed') wasConnected = true;
			if (state !== 'failed' || warned) return;
			warned = true;
			if (wasConnected) {
				console.warn(`WebRTCConnection: lost the connection to peer ${conn.peer}: the network changed, or the other device went offline.`);
				return;
			}
			console.warn(iceFailureMessage(conn.peer, this.#activeIceServers, candidateTypes, [...turnErrors]));
			onFailed?.();
		};
		pc.addEventListener('connectionstatechange', () => onStateChange(pc.connectionState));
		pc.addEventListener('iceconnectionstatechange', () => onStateChange(pc.iceConnectionState));
	}

	#attachMediaCall(call: MediaConnection): void {
		this.#watchIce(call);
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
				this.errorType = errorTypeOf(err);
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
		this.#epoch++;
		if (this.#iceRefreshTimer) {
			clearInterval(this.#iceRefreshTimer);
			this.#iceRefreshTimer = null;
		}
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

function errorTypeOf(err: unknown): string | null {
	const type = (err as { type?: unknown } | null)?.type;
	return typeof type === 'string' ? type : null;
}

const TURN_DOCS = 'https://github.com/reaxis/svelte-remote-control#turn-servers';

function hasTurnServer(iceServers: RTCIceServer[]): boolean {
	return iceServers.some((s) => [s.urls].flat().some((url) => /^turns?:/.test(url)));
}

function iceFailureMessage(
	peerId: string,
	iceServers: RTCIceServer[],
	candidateTypes: Set<string>,
	turnErrors: string[]
): string {
	const head = `WebRTCConnection: could not connect to peer ${peerId}: no network path between the two devices worked.`;
	if (!hasTurnServer(iceServers)) {
		return `${head}
No TURN server is configured, so only direct connections were tried. These often fail when:
- both devices are on the same Wi-Fi, and the router blocks traffic between its devices or doesn't support NAT hairpinning;
- either device is on a guest, public or corporate network;
- either device is behind a strict NAT (some mobile networks).
Switching one device to mobile data often works around it. To fix it, configure a TURN relay: ${TURN_DOCS}`;
	}
	if (!candidateTypes.has('relay')) {
		const errors = turnErrors.length ? `\nTURN errors:\n- ${turnErrors.join('\n- ')}` : '';
		return `${head}
None of the configured TURN servers gave this device a relay address. Check the TURN URLs, and that the credentials are valid (temporary ones expire).${errors}
See ${TURN_DOCS}`;
	}
	return `${head}
This device got a TURN relay address, but the other device couldn't use it. Check that the other device has the same TURN servers configured, with valid credentials, and that its network allows TURN (a turns: URL on port 443 gets through the most firewalls).
See ${TURN_DOCS}`;
}
