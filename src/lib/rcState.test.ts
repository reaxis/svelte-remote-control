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
});
