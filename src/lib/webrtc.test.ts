import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── PeerJS mock ───────────────────────────────────────────────────────────────
// Allows tests to control whether the mock peer fires 'open' or 'error'.
let firePeerError: Error | null = null;
const peerCtorCalls: unknown[][] = [];

interface MockPeerHandle {
	emit(event: string, ...args: unknown[]): void;
	connect: ReturnType<typeof vi.fn>;
	call: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	id: string;
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
		private _handlers = new Map<string, ((...args: unknown[]) => void)[]>();
		once = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
			if (event === 'open') queueMicrotask(() => fn());
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
		destroyed = false;
		private _handlers = new Map<string, ((...args: unknown[]) => void)[]>();
		private _onceError: ((...args: unknown[]) => void) | null = null;

		constructor(...args: unknown[]) {
			peerCtorCalls.push(args);
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
