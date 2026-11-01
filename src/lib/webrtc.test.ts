import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── PeerJS mock ───────────────────────────────────────────────────────────────
// Allows tests to control whether the mock peer fires 'open' or 'error'.
let firePeerError: Error | null = null;
// When true, the mock DataConnection never opens, so a test can fail its ICE.
let holdDcOpen = false;
let lastDc: { peerConnection: EventTarget & { connectionState: string }; close: ReturnType<typeof vi.fn> } | null = null;
const peerCtorCalls: unknown[][] = [];

interface MockPeerHandle {
	emit(event: string, ...args: unknown[]): void;
	connect: ReturnType<typeof vi.fn>;
	call: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	id: string;
	options: { config?: RTCConfiguration };
}
interface MockMediaConnectionHandle {
	peer: string;
	emit(event: string, ...args: unknown[]): void;
	answer: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}
let lastPeer: MockPeerHandle | null = null;
const mediaCalls: MockMediaConnectionHandle[] = [];

vi.mock('peerjs', () => {
	class MockDataConnection {
		peer = 'host-peer-id';
		open = true;
		peerConnection = Object.assign(new EventTarget(), { connectionState: 'new', iceConnectionState: 'new' });
		private _handlers = new Map<string, ((...args: unknown[]) => void)[]>();
		constructor() { lastDc = this; }
		once = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
			if (event === 'open' && !holdDcOpen) queueMicrotask(() => fn());
		});
		on = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
			if (!this._handlers.has(event)) this._handlers.set(event, []);
			this._handlers.get(event)!.push(fn);
		});
		emit(event: string, ...args: unknown[]) {
			for (const h of this._handlers.get(event) ?? []) h(...args);
		}
		send = vi.fn();
		close = vi.fn();
	}

	class MockMediaConnection {
		peer: string;
		private _handlers = new Map<string, ((...args: unknown[]) => void)[]>();
		constructor(peer: string) {
			this.peer = peer;
			mediaCalls.push(this as unknown as MockMediaConnectionHandle);
		}
		on(event: string, fn: (...args: unknown[]) => void) {
			if (!this._handlers.has(event)) this._handlers.set(event, []);
			this._handlers.get(event)!.push(fn);
		}
		emit(event: string, ...args: unknown[]) {
			for (const h of this._handlers.get(event) ?? []) h(...args);
		}
		answer = vi.fn();
		close = vi.fn();
	}

	class MockPeer {
		id: string;
		options: { config?: RTCConfiguration };
		destroyed = false;
		private _handlers = new Map<string, ((...args: unknown[]) => void)[]>();
		private _onceError: ((...args: unknown[]) => void) | null = null;

		constructor(...args: unknown[]) {
			peerCtorCalls.push(args);
			this.options = (typeof args[0] === 'string' ? args[1] : args[0]) as { config?: RTCConfiguration };
			this.id = 'mock-peer-' + Math.random().toString(36).slice(2);
			lastPeer = this as unknown as MockPeerHandle;
		}

		on(event: string, fn: (...args: unknown[]) => void) {
			if (!this._handlers.has(event)) this._handlers.set(event, []);
			this._handlers.get(event)!.push(fn);
		}

		emit(event: string, ...args: unknown[]) {
			for (const h of this._handlers.get(event) ?? []) h(...args);
		}

		once(event: string, fn: (...args: unknown[]) => void) {
			if (event === 'open' && !firePeerError) {
				queueMicrotask(() => fn());
			} else if (event === 'error' && firePeerError) {
				const err = firePeerError;
				queueMicrotask(() => fn(err));
			} else if (event === 'error') {
				this._onceError = fn;
			}
		}

		off(event: string, fn: (...args: unknown[]) => void) {
			const list = this._handlers.get(event);
			if (list) {
				const idx = list.indexOf(fn);
				if (idx !== -1) list.splice(idx, 1);
			}
			if (event === 'error' && this._onceError === fn) this._onceError = null;
		}

		connect = vi.fn(() => new MockDataConnection());
		call = vi.fn((peerId: string) => new MockMediaConnection(peerId));
		destroy = vi.fn(() => { this.destroyed = true; });
	}

	return { Peer: MockPeer };
});

import { WebRTCConnection } from './webrtc.svelte.js';

describe('WebRTCConnection', () => {
	afterEach(() => {
		firePeerError = null;
		peerCtorCalls.length = 0;
		lastPeer = null;
		mediaCalls.length = 0;
	});

	it('initial status is idle', () => {
		const conn = new WebRTCConnection();
		expect(conn.status).toBe('idle');
		expect(conn.error).toBeNull();
		expect(conn.connectedPeers).toEqual([]);
		expect(conn.role).toBeNull();
		expect(conn.localPeerId).toBe('');
	});

	it('createOffer transitions gathering → awaiting', async () => {
		const conn = new WebRTCConnection();
		const peerId = await conn.createOffer();
		expect(conn.status).toBe('awaiting');
		expect(conn.role).toBe('host');
		expect(typeof peerId).toBe('string');
		expect(peerId.length).toBeGreaterThan(0);
	});

	it('acceptOffer transitions to connected', async () => {
		const conn = new WebRTCConnection();
		await conn.acceptOffer('host-peer-id');
		expect(conn.status).toBe('connected');
		expect(conn.role).toBe('client');
		expect(conn.connectedPeers).toContain('host-peer-id');
	});

	it('destroy returns to idle', async () => {
		const conn = new WebRTCConnection();
		await conn.createOffer();
		expect(conn.status).toBe('awaiting');
		conn.destroy();
		expect(conn.status).toBe('idle');
		expect(conn.error).toBeNull();
		expect(conn.localPeerId).toBe('');
	});

	it('error during createOffer sets status to error', async () => {
		firePeerError = new Error('broker-unreachable');
		const conn = new WebRTCConnection();
		await expect(conn.createOffer()).rejects.toThrow();
		expect(conn.status).toBe('error');
		expect(conn.error).toContain('broker-unreachable');
	});
});

describe('WebRTCConnection.configure', () => {
	afterEach(() => {
		peerCtorCalls.length = 0;
	});

	const lastPeerConfig = (): Record<string, unknown> | undefined => {
		const args = peerCtorCalls.at(-1);
		if (!args) return undefined;
		// Peer is called as either new Peer(config) or new Peer(id, config).
		return (typeof args[0] === 'string' ? args[1] : args[0]) as Record<string, unknown>;
	};

	it('updates only the iceServers field when peerServer is omitted', async () => {
		const initial = [{ urls: 'stun:initial.example' }];
		const broker = { host: 'broker.example', port: 9000 };
		const conn = new WebRTCConnection({ iceServers: initial, peerServer: broker });

		const updated = [{ urls: 'stun:updated.example' }];
		conn.configure({ iceServers: updated });
		await conn.createOffer();

		const config = lastPeerConfig();
		expect((config?.config as { iceServers: unknown }).iceServers).toEqual(updated);
		// peerServer must NOT have been reset to undefined.
		expect(config?.host).toBe('broker.example');
		expect(config?.port).toBe(9000);
	});

	it('updates only the peerServer field when iceServers is omitted', async () => {
		const initial = [{ urls: 'stun:keep.example' }];
		const conn = new WebRTCConnection({ iceServers: initial });

		conn.configure({ peerServer: { host: 'new-broker.example', port: 443, secure: true } });
		await conn.createOffer();

		const config = lastPeerConfig();
		expect((config?.config as { iceServers: unknown }).iceServers).toEqual(initial);
		expect(config?.host).toBe('new-broker.example');
		expect(config?.secure).toBe(true);
	});

	it('explicitly passing peerServer: undefined clears the broker', async () => {
		const conn = new WebRTCConnection({
			peerServer: { host: 'old.example', port: 1234 }
		});

		conn.configure({ peerServer: undefined });
		await conn.createOffer();

		const config = lastPeerConfig();
		expect(config?.host).toBeUndefined();
		expect(config?.port).toBeUndefined();
	});
});

describe('WebRTCConnection.kick', () => {
	afterEach(() => { lastPeer = null; });

	it('sends a __kick message on the target peer connection but does not close it', async () => {
		const conn = new WebRTCConnection();
		await conn.createOffer();

		// Simulate an incoming client connection.
		const dc = { peer: 'client-a', open: true, send: vi.fn(), close: vi.fn(), on: vi.fn() };
		lastPeer!.emit('connection', dc);
		// Drive the dc.on('open') registration so #attachConnection promotes to connected.
		const openHandler = (dc.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'open')?.[1];
		openHandler?.();

		conn.kick('client-a');

		expect(dc.send).toHaveBeenCalledWith({ type: '__kick' });
		expect(dc.close).not.toHaveBeenCalled();
	});

	it('is a no-op for an unknown peer id', async () => {
		const conn = new WebRTCConnection();
		await conn.createOffer();
		expect(() => conn.kick('unknown-peer')).not.toThrow();
	});
});

describe('WebRTCConnection media calls', () => {
	afterEach(() => {
		lastPeer = null;
		mediaCalls.length = 0;
	});

	it('makeCall calls peer.call() once per connected peer', async () => {
		const conn = new WebRTCConnection();
		await conn.acceptOffer('host-peer-id');

		const stream = { id: 'fake-stream' } as unknown as MediaStream;
		conn.makeCall(stream);

		expect(lastPeer!.call).toHaveBeenCalledTimes(1);
		expect(lastPeer!.call).toHaveBeenCalledWith('host-peer-id', stream);
		expect(mediaCalls).toHaveLength(1);
	});

	it('startCall throws if both audio and video are falsy', async () => {
		const conn = new WebRTCConnection();
		await conn.acceptOffer('host-peer-id');
		await expect(conn.startCall({ audio: false, video: false })).rejects.toThrow(/audio.*video/i);
	});

	it('onCall fires registered handlers with the incoming stream', async () => {
		const conn = new WebRTCConnection();
		await conn.acceptOffer('host-peer-id');

		const received: MediaStream[] = [];
		conn.onCall((s) => received.push(s));

		// Simulate an inbound call: peer emits 'call' with a media connection.
		const incoming = { peer: 'host-peer-id', answer: vi.fn(), close: vi.fn(), on: vi.fn() };
		const onHandlers: Record<string, (...a: unknown[]) => void> = {};
		incoming.on.mockImplementation((event: string, fn: (...a: unknown[]) => void) => {
			onHandlers[event] = fn;
		});
		lastPeer!.emit('call', incoming);

		expect(incoming.answer).toHaveBeenCalled();
		const stream = { id: 'incoming-stream' } as unknown as MediaStream;
		onHandlers.stream(stream);

		expect(received).toEqual([stream]);
	});

	it('onCall returns an unsubscribe function', async () => {
		const conn = new WebRTCConnection();
		const handler = vi.fn();
		const unsub = conn.onCall(handler);
		unsub();

		await conn.acceptOffer('host-peer-id');
		const incoming = { peer: 'host-peer-id', answer: vi.fn(), close: vi.fn(), on: vi.fn() };
		const onHandlers: Record<string, (...a: unknown[]) => void> = {};
		incoming.on.mockImplementation((event: string, fn: (...a: unknown[]) => void) => {
			onHandlers[event] = fn;
		});
		lastPeer!.emit('call', incoming);
		onHandlers.stream({} as MediaStream);

		expect(handler).not.toHaveBeenCalled();
	});
});

describe('WebRTCConnection.destroy', () => {
	afterEach(() => { lastPeer = null; });

	it('preserves onMessage handlers across reconnects', async () => {
		const conn = new WebRTCConnection();
		const received: unknown[] = [];
		conn.onMessage((msg) => received.push(msg));

		await conn.acceptOffer('host-peer-id');
		conn.destroy();
		expect(conn.status).toBe('idle');

		// Reconnect; the same handler must still receive data.
		await conn.acceptOffer('host-peer-id');

		// Drive a 'data' event on the most-recent DataConnection.
		// The DC was created by peer.connect(); grab it via mock results.
		const dc = (lastPeer!.connect as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value as {
			on: ReturnType<typeof vi.fn>;
		};
		const dataHandler = dc.on.mock.calls.find((c: unknown[]) => c[0] === 'data')?.[1];
		dataHandler({ type: 'hello' });

		expect(received).toEqual([{ type: 'hello' }]);
	});

	it('preserves onCall handlers across reconnects', async () => {
		const conn = new WebRTCConnection();
		const seen: MediaStream[] = [];
		conn.onCall((s) => seen.push(s));

		await conn.acceptOffer('host-peer-id');
		conn.destroy();
		await conn.acceptOffer('host-peer-id');

		const incoming = { peer: 'host-peer-id', answer: vi.fn(), close: vi.fn(), on: vi.fn() };
		const onHandlers: Record<string, (...a: unknown[]) => void> = {};
		incoming.on.mockImplementation((event: string, fn: (...a: unknown[]) => void) => {
			onHandlers[event] = fn;
		});
		lastPeer!.emit('call', incoming);
		const stream = { id: 'post-destroy' } as unknown as MediaStream;
		onHandlers.stream(stream);

		expect(seen).toEqual([stream]);
	});
});

describe('WebRTCConnection ICE failure warnings', () => {
	let warn: ReturnType<typeof vi.spyOn>;
	beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
	afterEach(() => { warn.mockRestore(); lastPeer = null; });

	/** Host with one incoming connection whose RTCPeerConnection events the test drives. */
	async function hostWithIncoming(iceServers?: RTCIceServer[]) {
		const conn = new WebRTCConnection(iceServers ? { iceServers } : undefined);
		await conn.createOffer();
		const pc = Object.assign(new EventTarget(), { connectionState: 'new', iceConnectionState: 'new' });
		const dc = { peer: 'client-a', open: false, peerConnection: pc, send: vi.fn(), close: vi.fn(), on: vi.fn() };
		lastPeer!.emit('connection', dc);
		return {
			state: (state: string) => {
				pc.connectionState = state;
				pc.dispatchEvent(new Event('connectionstatechange'));
			},
			iceState: (state: string) => {
				pc.iceConnectionState = state;
				pc.dispatchEvent(new Event('iceconnectionstatechange'));
			},
			candidate: (type: string) => pc.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: { type } })),
			turnError: (url: string, errorCode: number, errorText: string) =>
				pc.dispatchEvent(Object.assign(new Event('icecandidateerror'), { url, errorCode, errorText }))
		};
	}
	const turn = [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }];
	const message = () => String(warn.mock.calls.at(-1)?.[0]);

	it('suggests a TURN server when none is configured', async () => {
		const { state, candidate } = await hostWithIncoming();
		candidate('host');
		candidate('srflx');
		state('connecting');
		state('failed');
		expect(warn).toHaveBeenCalledOnce();
		expect(message()).toContain('could not connect to peer client-a');
		expect(message()).toContain('No TURN server is configured');
		expect(message()).toContain('#turn-servers');
	});

	it('lists TURN errors when a TURN server gave no relay address', async () => {
		const { state, candidate, turnError } = await hostWithIncoming(turn);
		candidate('srflx');
		turnError('stun:stun.example:3478', 701, 'ignored');
		turnError('turn:turn.example:3478?transport=udp', 401, 'Unauthorized');
		state('failed');
		expect(message()).toContain('None of the configured TURN servers');
		expect(message()).toContain('turn:turn.example:3478?transport=udp (401 Unauthorized)');
		expect(message()).not.toContain('stun.example');
	});

	it('points at the other device when this one got a relay address', async () => {
		const { state, candidate } = await hostWithIncoming(turn);
		candidate('relay');
		state('failed');
		expect(message()).toContain('other device couldn');
	});

	it('reports a lost connection, not a setup problem, after ICE had connected', async () => {
		const { state } = await hostWithIncoming();
		state('connected');
		state('disconnected');
		state('failed');
		expect(message()).toContain('lost the connection to peer client-a');
		expect(message()).not.toContain('TURN');
	});

	it('also catches a failure reported only through iceConnectionState, once', async () => {
		const { state, iceState } = await hostWithIncoming();
		iceState('checking');
		iceState('failed');
		state('failed');
		expect(warn).toHaveBeenCalledOnce();
		expect(message()).toContain('No TURN server is configured');
	});

	it('stays quiet when ICE succeeds', async () => {
		const { state } = await hostWithIncoming();
		state('connecting');
		state('connected');
		expect(warn).not.toHaveBeenCalled();
	});
});

describe('WebRTCConnection when no network path works', () => {
	let warn: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		holdDcOpen = true;
		lastDc = null;
	});
	afterEach(() => { warn.mockRestore(); holdDcOpen = false; lastDc = null; lastPeer = null; });

	it('rejects acceptOffer with errorType no-route instead of waiting forever', async () => {
		const conn = new WebRTCConnection();
		const accepting = conn.acceptOffer('host-peer-id');
		await vi.waitFor(() => expect(lastDc).not.toBeNull());
		const pc = lastDc!.peerConnection;
		pc.connectionState = 'failed';
		pc.dispatchEvent(new Event('connectionstatechange'));

		await expect(accepting).rejects.toMatchObject({ type: 'no-route' });
		expect(conn.status).toBe('error');
		expect(conn.errorType).toBe('no-route');
		expect(conn.error).toContain('no network path');
		expect(lastDc!.close).toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
	});

	it('clears errorType on the next attempt and on destroy', async () => {
		const conn = new WebRTCConnection();
		const accepting = conn.acceptOffer('host-peer-id');
		await vi.waitFor(() => expect(lastDc).not.toBeNull());
		lastDc!.peerConnection.connectionState = 'failed';
		lastDc!.peerConnection.dispatchEvent(new Event('connectionstatechange'));
		await accepting.catch(() => {});

		holdDcOpen = false;
		const retry = conn.acceptOffer('host-peer-id');
		expect(conn.errorType).toBeNull();
		await retry;
		conn.destroy();
		expect(conn.errorType).toBeNull();
	});
});

describe('WebRTCConnection when the host never answers', () => {
	beforeEach(() => { vi.useFakeTimers(); holdDcOpen = true; lastDc = null; });
	afterEach(() => { vi.useRealTimers(); holdDcOpen = false; lastDc = null; lastPeer = null; });

	it('rejects acceptOffer with peer-unavailable after 10 s without an answer', async () => {
		const conn = new WebRTCConnection();
		const accepting = conn.acceptOffer('gone-host');
		const settled = accepting.catch((err) => err);
		await vi.advanceTimersByTimeAsync(9_999);
		expect(conn.status).toBe('gathering');
		await vi.advanceTimersByTimeAsync(1);
		expect(await settled).toMatchObject({ type: 'peer-unavailable' });
		expect(conn.status).toBe('error');
		expect(conn.errorType).toBe('peer-unavailable');
		expect(lastDc!.close).toHaveBeenCalled();
	});

	it('leaves a host that answered to ICE', async () => {
		const conn = new WebRTCConnection();
		conn.acceptOffer('slow-host').catch(() => {});
		await vi.advanceTimersByTimeAsync(0);
		Object.assign(lastDc!.peerConnection, { remoteDescription: { type: 'answer', sdp: '' } });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(conn.status).toBe('gathering');
	});

	it('does nothing once destroyed', async () => {
		const conn = new WebRTCConnection();
		conn.acceptOffer('gone-host').catch(() => {});
		await vi.advanceTimersByTimeAsync(0);
		conn.destroy();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(conn.status).toBe('idle');
		expect(conn.errorType).toBeNull();
	});
});

describe('WebRTCConnection errorType', () => {
	afterEach(() => { firePeerError = null; lastPeer = null; });

	it('takes the PeerJS error type', async () => {
		firePeerError = Object.assign(new Error('broker down'), { type: 'network' });
		const conn = new WebRTCConnection();
		await expect(conn.createOffer()).rejects.toThrow('broker down');
		expect(conn.errorType).toBe('network');
	});
});

describe('WebRTCConnection iceServers function', () => {
	let warn: ReturnType<typeof vi.spyOn>;
	beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
	afterEach(() => { warn.mockRestore(); vi.useRealTimers(); lastPeer = null; });

	const turn = (n: number) => [{ urls: 'turn:turn.example', username: `u${n}`, credential: 'c' }];

	it('is called for every new Peer, and its result configures it', async () => {
		let n = 0;
		const iceServers = vi.fn(async () => turn(++n));
		const conn = new WebRTCConnection({ iceServers });
		await conn.createOffer();
		expect(lastPeer!.options.config?.iceServers).toEqual(turn(1));
		await conn.acceptOffer('host-peer-id');
		expect(lastPeer!.options.config?.iceServers).toEqual(turn(2));
		expect(iceServers).toHaveBeenCalledTimes(2);
	});

	it('falls back to DEFAULT_ICE_SERVERS when it rejects', async () => {
		const { DEFAULT_ICE_SERVERS } = await import('./webrtc.svelte.js');
		const conn = new WebRTCConnection({ iceServers: async () => { throw new Error('endpoint down'); } });
		await conn.createOffer();
		expect(lastPeer!.options.config?.iceServers).toEqual(DEFAULT_ICE_SERVERS);
		expect(conn.status).toBe('awaiting');
		expect(String(warn.mock.calls[0]?.[0])).toContain('iceServers function failed');
	});

	it('also accepts a function set through configure()', async () => {
		const conn = new WebRTCConnection();
		conn.configure({ iceServers: () => turn(7) });
		await conn.createOffer();
		expect(lastPeer!.options.config?.iceServers).toEqual(turn(7));
	});

	it('refreshes the live Peer every hour, keeping the old list if a refresh fails', async () => {
		vi.useFakeTimers();
		let n = 0;
		let fail = false;
		const conn = new WebRTCConnection({
			iceServers: async () => { if (fail) throw new Error('down'); return turn(++n); }
		});
		await conn.createOffer();
		const peer = lastPeer!;
		expect(peer.options.config?.iceServers).toEqual(turn(1));

		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(peer.options.config?.iceServers).toEqual(turn(2));

		fail = true;
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(peer.options.config?.iceServers).toEqual(turn(2));

		fail = false;
		conn.destroy();
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(n).toBe(2);
	});

	it('sets no refresh timer for a fixed list', async () => {
		vi.useFakeTimers();
		const conn = new WebRTCConnection({ iceServers: turn(1) });
		await conn.createOffer();
		expect(vi.getTimerCount()).toBe(0);
	});
});
