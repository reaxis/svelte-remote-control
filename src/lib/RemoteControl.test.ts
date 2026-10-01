import { vi, describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

// ── WebRTCConnection mock ─────────────────────────────────────────────────────
// Just enough of the connection for the component to mount as an idle host.
const mocks = vi.hoisted(() => ({
	connection: {
		status: 'idle' as string,
		role: null as string | null,
		localPeerId: '',
		connectedPeers: [] as string[],
		error: null as string | null,
		createOffer: vi.fn(async () => {}),
		acceptOffer: vi.fn(async () => {}),
		destroy: vi.fn(),
		configure: vi.fn(),
		kick: vi.fn(),
		onMessage: vi.fn(() => () => {}),
		onPeerConnect: vi.fn(() => () => {}),
		send: vi.fn(),
		sendTo: vi.fn(),
	},
}));

vi.mock('./webrtc.svelte.js', () => ({
	WebRTCConnection: vi.fn(function () { return mocks.connection; }),
	DEFAULT_ICE_SERVERS: [],
}));

import RemoteControl from './RemoteControl.svelte';

// jsdom has no Popover API, like Safari before 17 — the case the fallback is for.
describe('RemoteControl without the Popover API', () => {
	let component: ReturnType<typeof mount> | undefined;

	afterEach(() => {
		if (component) unmount(component);
		component = undefined;
		document.body.innerHTML = '';
	});

	function setup() {
		component = mount(RemoteControl, { target: document.body });
		flushSync();
		return {
			trigger: document.querySelector<HTMLButtonElement>('.conn-trigger')!,
			panel: document.querySelector<HTMLElement>('.conn-popover')!,
		};
	}

	it('mounts even where :popover-open is an invalid selector', () => {
		// What Safari 16's matches() does. Before the fallback, this threw while
		// mounting and aborted every effect after it on the page.
		const matches = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (selector: string) {
			if (selector.includes(':popover-open')) {
				throw new DOMException('The string did not match the expected pattern.', 'SyntaxError');
			}
			return false;
		});
		try {
			expect(setup).not.toThrow();
		} finally {
			matches.mockRestore();
		}
	});

	it('the trigger toggles the panel itself', () => {
		const { trigger, panel } = setup();
		expect(panel.classList.contains('fallback')).toBe(true);
		expect(panel.classList.contains('open')).toBe(false);

		trigger.click();
		flushSync();
		expect(panel.classList.contains('open')).toBe(true);
		expect(trigger.getAttribute('aria-expanded')).toBe('true');

		trigger.click();
		flushSync();
		expect(panel.classList.contains('open')).toBe(false);
	});

	it('Escape and a press outside close it, a press inside does not', () => {
		const { trigger, panel } = setup();
		const press = (target: EventTarget) => {
			target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
			flushSync();
		};

		trigger.click();
		flushSync();
		press(panel);
		expect(panel.classList.contains('open')).toBe(true);
		press(document.body);
		expect(panel.classList.contains('open')).toBe(false);

		trigger.click();
		flushSync();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		flushSync();
		expect(panel.classList.contains('open')).toBe(false);
	});
});
