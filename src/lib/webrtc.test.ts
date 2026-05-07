import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── PeerJS mock ───────────────────────────────────────────────────────────────
// Allows tests to control whether the mock peer fires 'open' or 'error'.
let firePeerError: Error | null = null;

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

		constructor() {
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
