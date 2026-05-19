import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── WebRTCConnection mock ─────────────────────────────────────────────────────
// vi.mock() is hoisted above imports, so the mock state must also be hoisted
// via vi.hoisted() to be reachable from inside the factory.
const mocks = vi.hoisted(() => {
	const captured: { messageHandler: ((msg: unknown, from: string) => void) | null } = {
		messageHandler: null,
	};
	const connection = {
		status: 'idle' as string,
		connectedPeers: [] as string[],
		onMessage: vi.fn((h: (msg: unknown, from: string) => void) => {
			captured.messageHandler = h;
			return () => {};
		}),
		onPeerConnect: vi.fn(() => () => {}),
		send: vi.fn(),
		sendTo: vi.fn(),
	};
	return { connection, captured };
});

vi.mock('./webrtc.svelte.js', () => ({
	WebRTCConnection: vi.fn(function () { return mocks.connection; }),
	DEFAULT_ICE_SERVERS: [],
}));

import { rcState, deleteRcState } from './rcState.svelte.js';

const STORAGE_KEY = 'rc:state';

describe('rcState', () => {
	beforeEach(() => {
		sessionStorage.clear();
		mocks.connection.send.mockClear();
		mocks.connection.sendTo.mockClear();
	});

	it('setting a value persists to sessionStorage', () => {
		const s = rcState('persist-test', 0);
		s.value = 42;
		const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY)!);
		expect(stored['persist-test']).toBe(42);
	});

	it('reading returns the last written value', () => {
		const s = rcState('read-test', 'hello');
		s.value = 'world';
		expect(s.value).toBe('world');
	});

	it('deleteRcState removes the key from sessionStorage', () => {
		const s = rcState('delete-test', 99);
		s.value = 99;
		deleteRcState('delete-test');
		const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}');
		expect('delete-test' in stored).toBe(false);
	});

	it('deleteRcState causes the next rcState() call to return initial', () => {
		const s = rcState('delete-reset-test', 'init');
		s.value = 'changed';
		deleteRcState('delete-reset-test');
		const s2 = rcState('delete-reset-test', 'init');
		expect(s2.value).toBe('init');
	});

	it('validator rejects invalid in-memory value on registration', () => {
		const unvalidated = rcState('validator-reg-test', 'light');
		(unvalidated as { value: unknown }).value = 42; // write an invalid value
		const validated = rcState(
			'validator-reg-test',
			'light',
			(v): v is 'light' | 'dark' => v === 'light' || v === 'dark'
		);
		expect(validated.value).toBe('light'); // reset to initial
	});

	it('validator drops invalid incoming __sync payloads', () => {
		const s = rcState(
			'sync-valid-test',
			'light',
			(v): v is 'light' | 'dark' => v === 'light' || v === 'dark'
		);
		expect(mocks.captured.messageHandler).not.toBeNull();

		// Invalid value: should be dropped
		mocks.captured.messageHandler!(
			{ type: '__sync', key: 'sync-valid-test', value: 'bogus' },
			'some-peer'
		);
		expect(s.value).toBe('light');

		// Valid value: should be accepted
		mocks.captured.messageHandler!(
			{ type: '__sync', key: 'sync-valid-test', value: 'dark' },
			'some-peer'
		);
		expect(s.value).toBe('dark');
	});

	it('rebroadcasts __sync to all peers except the sender', () => {
		rcState('rebroadcast-test', 0);
		mocks.connection.connectedPeers = ['peer-a', 'peer-b', 'peer-c'];

		mocks.captured.messageHandler!(
			{ type: '__sync', key: 'rebroadcast-test', value: 7 },
			'peer-a'
		);

		const targets = mocks.connection.sendTo.mock.calls.map((c) => c[0]);
		expect(targets).toEqual(['peer-b', 'peer-c']);
	});

	it('does not rebroadcast __sync when the value is unchanged', () => {
		const s = rcState('idempotent-sync-test', 0);
		s.value = 5;
		mocks.connection.connectedPeers = ['peer-a', 'peer-b'];
		mocks.connection.sendTo.mockClear();

		mocks.captured.messageHandler!(
			{ type: '__sync', key: 'idempotent-sync-test', value: 5 },
			'peer-a'
		);

		expect(mocks.connection.sendTo).not.toHaveBeenCalled();
	});

	it('does not rebroadcast __sync_delete when the key is already absent', () => {
		mocks.connection.connectedPeers = ['peer-a', 'peer-b'];
		mocks.connection.sendTo.mockClear();

		mocks.captured.messageHandler!(
			{ type: '__sync_delete', key: 'never-existed' },
			'peer-a'
		);

		expect(mocks.connection.sendTo).not.toHaveBeenCalled();
	});

	it('drops malformed __sync messages missing key or value', () => {
		mocks.connection.connectedPeers = ['peer-a', 'peer-b'];
		mocks.connection.sendTo.mockClear();

		// Missing key
		mocks.captured.messageHandler!(
			{ type: '__sync', value: 1 },
			'peer-a'
		);
		// Missing value
		mocks.captured.messageHandler!(
			{ type: '__sync', key: 'x' },
			'peer-a'
		);
		// Non-string key
		mocks.captured.messageHandler!(
			{ type: '__sync', key: 42, value: 1 },
			'peer-a'
		);

		expect(mocks.connection.sendTo).not.toHaveBeenCalled();
	});
});
