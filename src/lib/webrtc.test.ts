import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── PeerJS mock ───────────────────────────────────────────────────────────────
// Allows tests to control whether the mock peer fires 'open' or 'error'.
let firePeerError: Error | null = null;
const peerCtorCalls: unknown[][] = [];

vi.mock('peerjs', () => {
	class MockDataConnection {
		peer = 'host-peer-id';
		open = true;
		once = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
			if (event === 'open') queueMicrotask(() => fn());
		});
		on = vi.fn();
		send = vi.fn();
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
		}

		on(event: string, fn: (...args: unknown[]) => void) {
			if (!this._handlers.has(event)) this._handlers.set(event, []);
			this._handlers.get(event)!.push(fn);
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
		call = vi.fn();
		destroy = vi.fn(() => { this.destroyed = true; });
	}

	return { Peer: MockPeer };
});

import { WebRTCConnection } from './webrtc.svelte.js';

describe('WebRTCConnection', () => {
	afterEach(() => {
		firePeerError = null;
		peerCtorCalls.length = 0;
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
