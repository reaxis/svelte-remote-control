<script module lang="ts">
	/**
	 * RemoteControl — UI for the WebRTC primitive (QR code + popover status).
	 *
	 * Add <RemoteControl /> to any route that needs a connection. Pass
	 * `remoteHref="/remote"` to point the QR at a different route; omit for
	 * same-route connections. Pass `connection={...}` to bind the UI to a
	 * non-singleton `WebRTCConnection` instance.
	 *
	 * The transport and reactive-sync primitives live in sibling files. The
	 * canonical consumer import path is the package entry point:
	 *
	 *   import RemoteControl, { send, onMessage, makeCall, onCall, connStatus, rcState }
	 *     from '@reaxis/svelte-remote-control';
	 *
	 * These names are also re-exported from this file's `<script module>` for
	 * backwards compatibility with internal `$lib` imports.
	 */

	export {
		rcState,
		deleteRcState,
		connStatus,
		send,
		makeCall,
		startCall,
		onCall,
		onMessage
	} from './rcState.svelte.js';

	export { WebRTCConnection } from './webrtc.svelte.js';
	export type { ConnectionStatus, WebRTCConnectionOptions } from './webrtc.svelte.js';

	// Tracks which `WebRTCConnection` instances are currently bound to a live
	// `<RemoteControl />`. Used to warn when two components share one connection.
	const _mountedConnections = new WeakSet<object>();
</script>

<script lang="ts">
	import QRCode from 'qrcode';
	import { connection as defaultConnection } from './rcState.svelte.js';
	import type { WebRTCConnection, WebRTCConnectionOptions } from './webrtc.svelte.js';

	interface Props {
		/**
		 * Path clients should be sent to (e.g. `"/remote"`). Defaults to the
		 * current page path (same route + `?id=`).
		 */
		remoteHref?: string;
		/** ICE servers, peer server, and other connection options. */
		config?: WebRTCConnectionOptions;
		/**
		 * Optional `WebRTCConnection` instance to bind this UI to. Defaults to the
		 * module-level singleton used by `send`, `onMessage`, `rcState`, etc. Pass
		 * your own when you need multiple independent connections in one app.
		 */
		connection?: WebRTCConnection;
	}

	let { remoteHref, config, connection: injectedConnection }: Props = $props();

	// Swapping the `connection` prop mid-life is not supported (the lifecycle
	// effects below bind to whatever instance is current at mount). `$derived`
	// silences the `state_referenced_locally` warning while keeping the
	// initial-binding semantics consumers actually want.
	const myConn = $derived(injectedConnection ?? defaultConnection);

	const isBrowser = typeof window !== 'undefined';

	// Captured once on mount: client-side URL rewrites (e.g. history.pushState to
	// strip `?id=…` after connecting) must not tear down the live connection.
	const clientId = isBrowser ? new URLSearchParams(window.location.search).get('id') : null;
	const isClient = $derived(clientId !== null ? myConn.role !== 'host' : myConn.role === 'client');

	// ── Host state ──────────────────────────────────────────────────────────
	const PEER_ID_KEY = 'rc:hostPeerId';
	let peerQr = $state('');
	let copied = $state(false);
	let copiedUrl = $state(false);

	// ── Client state ────────────────────────────────────────────────────────
	let peerIdInput = $state('');
	let popoverEl = $state<HTMLElement | null>(null);
	let popoverOpen = $state(false);
	let retryPeerId = $state<string | null>(null);
	let retryAttempt = $state(0);
	let retryCountdown = $state(0);
	let hostQr = $state('');
	let copiedHostId = $state(false);
	let copiedHostUrl = $state(false);

	// ── Derived URLs ─────────────────────────────────────────────────────────
	// `$derived` caches by `===`, so downstream `$effect`s that depend on a URL
	// only re-run when the string actually changes.

	const basePath = $derived(
		isBrowser ? (remoteHref ?? window.location.pathname).replace(/\/?$/, '/') : '/'
	);

	const remoteUrl = $derived(
		!isClient && myConn.localPeerId && isBrowser
			? `${window.location.origin}${basePath}?id=${myConn.localPeerId}`
			: ''
	);

	// First connected peer (the host, for clients). Empty string when no peers
	// are connected; guards every site that previously read `connectedPeers[0]`.
	const connectedPeer = $derived(myConn.connectedPeers[0] ?? '');

	const hostUrl = $derived(
		isClient && myConn.status === 'connected' && connectedPeer && isBrowser
			? `${window.location.origin}${basePath}?id=${connectedPeer}`
			: ''
	);

	// ── Lifecycle ────────────────────────────────────────────────────────────
	// Dev guard: warn if two `<RemoteControl />` instances bind to the same
	// `WebRTCConnection`. Each instance owns the lifecycle of its connection
	// (createOffer / destroy on mount/unmount), so sharing one leads to
	// connection thrash. Pass distinct `connection={...}` props instead.
	$effect(() => {
		if (_mountedConnections.has(myConn)) {
			console.warn(
				'RemoteControl: multiple components are bound to the same WebRTCConnection. ' +
				'Pass a distinct `connection={...}` prop per instance.'
			);
		}
		_mountedConnections.add(myConn);
		return () => { _mountedConnections.delete(myConn); };
	});
	$effect(() => { if (config) myConn.configure(config); });

	$effect(() => {
		if (clientId) connect(clientId);
		else startOffer();
		return () => myConn.destroy();
	});

	$effect(() => myConn.onMessage((msg) => {
		if (msg.type === '__kick') disconnect();
	}));

	// Popover open/close as a single source of truth. The effect syncs state
	// → DOM (idempotent — checks current popover state first), and `ontoggle`
	// on the popover element syncs DOM → state (captures manual user dismiss
	// via Escape / outside click / trigger button).
	$effect(() => {
		if (!popoverEl) return;
		const isOpen = popoverEl.matches(':popover-open');
		if (popoverOpen && !isOpen) popoverEl.showPopover();
		else if (!popoverOpen && isOpen) popoverEl.hidePopover();
	});

	// Client flow: auto-open while connecting, auto-close once connected.
	// The user can still manually reopen via the trigger button at any time.
	$effect(() => {
		if (!isClient) return;
		if (myConn.status === 'gathering') popoverOpen = true;
		else if (myConn.status === 'connected') popoverOpen = false;
	});

	$effect(() => {
		if (!retryPeerId || (myConn.status !== 'disconnected' && myConn.status !== 'error')) return;

		// `retryAttempt` is a tracked dependency: each bump re-runs this effect
		// and schedules the next retry, regardless of whether `status` also changed.
		const delay = Math.min(1000 * 2 ** retryAttempt, 30_000);
		retryCountdown = Math.ceil(delay / 1000);

		const tick = setInterval(() => { retryCountdown--; }, 1000);
		const timer = setTimeout(async () => {
			clearInterval(tick);
			try {
				await connect(retryPeerId!);
				retryAttempt = 0;
			} catch {
				retryAttempt++; // triggers this effect again for the next retry
			}
		}, delay);

		return () => { clearInterval(tick); clearTimeout(timer); };
	});

	// Generate QR codes only when the underlying URL actually changes.
	// The `$derived` URLs cache by `===`, so flipping unrelated reactive state
	// (copy feedback flags, status transitions without identity change) does
	// not re-trigger `QRCode.toDataURL`.

	const QR_OPTS = { errorCorrectionLevel: 'M' as const, width: 240, margin: 3 };

	$effect(() => {
		if (!remoteUrl) { peerQr = ''; return; }
		let cancelled = false;
		QRCode.toDataURL(remoteUrl, QR_OPTS).then(qr => { if (!cancelled) peerQr = qr; });
		return () => { cancelled = true; };
	});

	$effect(() => {
		if (!hostUrl) { hostQr = ''; return; }
		let cancelled = false;
		QRCode.toDataURL(hostUrl, QR_OPTS).then(qr => { if (!cancelled) hostQr = qr; });
		return () => { cancelled = true; };
	});

	// ── Host functions ───────────────────────────────────────────────────────

	async function startOffer() {
		myConn.destroy();
		const hasStorage = typeof sessionStorage !== 'undefined';
		const savedId = hasStorage ? (sessionStorage.getItem(PEER_ID_KEY) ?? undefined) : undefined;
		await myConn.createOffer(savedId);
		if (hasStorage) sessionStorage.setItem(PEER_ID_KEY, myConn.localPeerId);
		// QR/URL generated by the reactive $effect above.
	}

	async function copyId() {
		await navigator.clipboard.writeText(myConn.localPeerId);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	async function copyUrl() {
		await navigator.clipboard.writeText(remoteUrl);
		copiedUrl = true;
		setTimeout(() => (copiedUrl = false), 2000);
	}

	// ── Client functions ─────────────────────────────────────────────────────

	async function connect(id = peerIdInput.trim()) {
		retryPeerId = id;
		await myConn.acceptOffer(id);
	}

	async function copyHostId() {
		if (!connectedPeer) return;
		await navigator.clipboard.writeText(connectedPeer);
		copiedHostId = true;
		setTimeout(() => (copiedHostId = false), 2000);
	}

	async function copyHostUrl() {
		if (!hostUrl) return;
		await navigator.clipboard.writeText(hostUrl);
		copiedHostUrl = true;
		setTimeout(() => (copiedHostUrl = false), 2000);
	}

	function disconnect() {
		// `startOffer()` already calls `myConn.destroy()` internally; calling
		// `stopRetry()` here would destroy twice and churn reactive status.
		retryPeerId = null;
		retryAttempt = 0;
		startOffer();
	}

	function stopRetry() {
		retryPeerId = null;
		retryAttempt = 0;
		myConn.destroy();
	}

	// ── Shared helpers ───────────────────────────────────────────────────────

	function shortId(id: string | undefined): string {
		return id ? id.slice(-8) : '';
	}
</script>

<div class="conn-anchor">
	<button class="conn-trigger" popovertarget="conn-popover" aria-label="Connection status">
		{#if myConn.status === 'idle' || myConn.status === 'gathering'}
			<span class="trigger-spinner"></span>
		{:else if myConn.status === 'connected'}
			<span class="trigger-dot connected"></span>
			{#if isClient}
				<span class="trigger-role">CLIENT</span>
				<span class="trigger-label">…{shortId(myConn.localPeerId)}</span>
			{:else}
				<span class="trigger-role">HOST</span>
				<span class="trigger-label">…{shortId(myConn.localPeerId)}</span>
				<span class="trigger-count">{myConn.connectedPeers.length}</span>
			{/if}
		{:else if myConn.status === 'awaiting'}
			<span class="trigger-dot awaiting"></span>
			<span class="trigger-label">…{shortId(myConn.localPeerId)}</span>
		{:else if myConn.status === 'disconnected'}
			<span class="trigger-dot disconnected"></span>
			{#if myConn.localPeerId}<span class="trigger-label">…{shortId(myConn.localPeerId)}</span>{/if}
		{:else if myConn.status === 'error'}
			<span class="trigger-dot" class:error={!retryPeerId} class:disconnected={!!retryPeerId}></span>
			{#if myConn.localPeerId}<span class="trigger-label">…{shortId(myConn.localPeerId)}</span>{/if}
		{/if}
	</button>

	<div
		id="conn-popover"
		popover="auto"
		class="conn-popover"
		bind:this={popoverEl}
		ontoggle={(e) => { popoverOpen = (e as ToggleEvent).newState === 'open'; }}
	>
		<div class="conn-header">
			<h2>Remote Control</h2>
			{#if isClient && myConn.status === 'connected'}
				<button class="btn secondary btn-sm" onclick={disconnect}>Disconnect</button>
			{/if}
		</div>

		{#if isClient}
			<!-- ── Client mode ── -->
			{#if myConn.status === 'gathering'}
				<p class="hint">Connecting…</p>
				<div class="spinner"></div>

			{:else if myConn.status === 'idle' && retryPeerId}
				<p class="status-badge disconnected">Disconnected</p>
				<button class="btn secondary" onclick={() => connect(retryPeerId!)}>Reconnect</button>

			{:else if myConn.status === 'connected'}
				{#if hostQr}
					<img src={hostQr} alt="Host QR code" class="qr" />
				{/if}
				<div class="peer-field-row">
					<span class="peer-field-label">URL</span>
					<div class="peer-id">
						<span>{hostUrl}</span>
						<button class="btn-copy-inline" class:copied={copiedHostUrl} onclick={copyHostUrl} title="Copy URL"></button>
					</div>
				</div>
				<div class="peer-field-row">
					<span class="peer-field-label">ID</span>
					<div class="peer-id">
						<span>{connectedPeer}</span>
						<button class="btn-copy-inline" class:copied={copiedHostId} onclick={copyHostId} title="Copy host ID"></button>
					</div>
				</div>

			{:else if myConn.status === 'disconnected'}
				<p class="status-badge disconnected">Disconnected</p>
				{#if retryPeerId}
					<p class="hint">Retrying in {retryCountdown}s…</p>
					<button class="btn secondary" onclick={stopRetry}>Stop</button>
				{:else}
					<button class="btn secondary" onclick={() => myConn.destroy()}>Reset</button>
				{/if}

			{:else if myConn.status === 'error'}
				{#if retryPeerId}
					<p class="status-badge disconnected">Disconnected</p>
					<p class="hint">Retrying in {retryCountdown}s…</p>
					<button class="btn secondary" onclick={stopRetry}>Stop</button>
				{:else}
					<p class="status-badge error">Error: {myConn.error}</p>
					<button class="btn secondary" onclick={() => myConn.destroy()}>Reset</button>
				{/if}
			{/if}

		{:else}
			<!-- ── Host mode ── -->
			{#if myConn.status === 'idle' || myConn.status === 'gathering'}
				<div class="spinner"></div>

			{:else if myConn.status === 'awaiting' || myConn.status === 'connected'}
				{#if peerQr}
					<img src={peerQr} alt="Peer ID QR code" class="qr" />
				{/if}
				<div class="peer-field-row">
					<span class="peer-field-label">URL</span>
					<div class="peer-id">
						<span>{remoteUrl}</span>
						<button class="btn-copy-inline" class:copied={copiedUrl} onclick={copyUrl} title="Copy URL"></button>
					</div>
				</div>
				<div class="peer-field-row">
					<span class="peer-field-label">ID</span>
					<div class="peer-id">
						<span>{myConn.localPeerId}</span>
						<button class="btn-copy-inline" class:copied={copied} onclick={copyId} title="Copy ID"></button>
					</div>
				</div>

				{#if myConn.status === 'awaiting'}
					<p class="hint">Waiting for a client to connect…</p>
					<hr class="divider" />
					<p class="hint">… or connect to a host by ID:</p>
					<div class="peer-connect-row">
						<input class="peer-input" type="text" placeholder="Paste ID…" bind:value={peerIdInput} />
						<button class="btn secondary btn-sm" onclick={() => connect()} disabled={!peerIdInput.trim()}>Connect</button>
					</div>
				{:else}
					<hr class="divider" />
					<div class="remotes">
						<span class="remotes-label">Connected clients</span>
						<ul class="remotes-list">
							{#each myConn.connectedPeers as id (id)}
								<li title={id}>
									<span>…{shortId(id)}</span>
									<button class="btn-kick" onclick={() => myConn.kick(id)} aria-label="Disconnect {id}">✕</button>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

			{:else if myConn.status === 'disconnected'}
				<p class="status-badge disconnected">Disconnected</p>
				<button class="btn secondary" onclick={startOffer}>Reconnect</button>

			{:else if myConn.status === 'error'}
				<p class="status-badge error">Error: {myConn.error}</p>
				<button class="btn secondary" onclick={startOffer}>Retry</button>
			{/if}

		{/if}
	</div>
</div>

<style>
	.conn-anchor {
		position: fixed;
		top: 1rem;
		right: 1rem;
		z-index: 10;
	}

	.conn-trigger {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.65rem;
		background: #fff;
		border: 1px solid #ddd;
		border-radius: 8px;
		cursor: pointer;
		box-shadow: 0 1px 4px rgba(0,0,0,0.08);
		transition: box-shadow 0.15s;
	}

	.conn-trigger:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12); }

	.trigger-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}

	.trigger-dot.connected    { background: #28a745; }
	.trigger-dot.awaiting     { background: #aaa; }
	.trigger-dot.disconnected { background: #ffc107; }
	.trigger-dot.error        { background: #dc3545; }

	.trigger-role {
		font-size: 0.65rem;
		font-weight: 700;
		font-family: system-ui, sans-serif;
		color: #888;
		letter-spacing: 0.04em;
	}

	.trigger-label {
		font-size: 0.8rem;
		font-family: monospace;
		color: #333;
	}

	.trigger-count {
		font-size: 0.8rem;
		font-family: monospace;
		color: #aaa;
	}

	.trigger-spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid #e0e0e0;
		border-top-color: #555;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	.conn-popover {
		position: fixed;
		inset: unset;
		top: 3.5rem;
		right: 1rem;
		width: 280px;
		max-height: calc(100dvh - 6.5rem);
		overflow-y: auto;
		padding: 1rem;
		background: #fff;
		border: 1px solid #ddd;
		border-radius: 10px;
		box-shadow: 0 4px 20px rgba(0,0,0,0.12);
		flex-direction: column;
		gap: 0.75rem;
		margin: 0;
		font-family: system-ui, sans-serif;
		font-size: 0.95rem;
	}

	.conn-popover:popover-open { display: flex; }

	.conn-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.conn-header h2 {
		margin: 0;
		font-size: 1.25rem;
	}

	.btn-sm {
		padding: 0.35rem 0.75rem;
		font-size: 0.8rem;
	}

	.qr {
		width: 240px;
		height: 240px;
		display: block;
		align-self: center;
	}

	.peer-id {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: monospace;
		font-size: 0.7rem;
		color: #555;
		background: #f5f5f5;
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		padding: 0.4rem 0.4rem 0.4rem 0.6rem;
	}

	.peer-id span {
		flex: 1;
		word-break: break-all;
	}

	.peer-field-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.peer-field-row .peer-id {
		flex: 1;
	}

	.peer-field-label {
		width: 1.75rem;
		flex-shrink: 0;
		font-size: 0.7rem;
		font-weight: 600;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		text-align: right;
	}

	.btn-copy-inline {
		flex-shrink: 0;
		border: 1px solid #d0d0d0;
		cursor: pointer;
		width: 2rem;
		aspect-ratio: 1 / 1;
		border-radius: 4px;
		line-height: 1;
		transition: color 0.1s, background 0.1s, border-color 0.1s;
		align-self: flex-start;
		background-color: #fff;
		background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 12 12' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M7.5 10v1.5h-6v-8h1.5M10.5 2.5v6h-6v-8h4z' fill='none' stroke='%23000' /%3E%3C/svg%3E");
		background-size: 60%;
		background-position: center;
		background-repeat: no-repeat;
	}

	.btn-copy-inline.copied {
		background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 12 12' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1.5 5.5l3.5 3.5l5.5 -5.5' fill='none' stroke='%23000' /%3E%3C/svg%3E");
	}

	.btn-copy-inline:hover {
		color: #333;
		background-color: #f0f0f0;
		border-color: #aaa;
	}

	.peer-label {
		font-size: 0.8rem;
		font-weight: 600;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0;
	}

	.divider {
		border: none;
		border-top: 1px solid #e8e8e8;
		margin: 0;
	}

	.peer-connect-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.peer-connect-row .peer-input {
		flex: 1;
	}

	.peer-input {
		font-family: monospace;
		font-size: 0.85rem;
		border: 1px solid #ccc;
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		width: 100%;
		box-sizing: border-box;
	}

	.peer-input:focus { outline: none; border-color: #888; }

	.remotes {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.remotes-label {
		font-size: 0.8rem;
		font-weight: 600;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.remotes-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.remotes-list li {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-family: monospace;
		font-size: 0.8rem;
		background: #e8f4e8;
		color: #155724;
		border-radius: 4px;
		padding: 0.2rem 0.35rem 0.2rem 0.5rem;
	}

	.btn-kick {
		background: none;
		border: none;
		cursor: pointer;
		color: #155724;
		font-size: 0.7rem;
		line-height: 1;
		padding: 0.1rem 0.15rem;
		border-radius: 3px;
		opacity: 0.5;
		transition: opacity 0.1s;
	}

	.btn-kick:hover { opacity: 1; }

	.status-badge {
		display: inline-block;
		padding: 0.3rem 0.75rem;
		border-radius: 4px;
		font-size: 0.85rem;
		font-weight: 600;
		margin: 0;
	}

	.status-badge.connected    { background: #d4edda; color: #155724; }
	.status-badge.disconnected { background: #fff3cd; color: #856404; }
	.status-badge.error        { background: #f8d7da; color: #721c24; }

	.spinner {
		width: 28px;
		height: 28px;
		border: 3px solid #e0e0e0;
		border-top-color: #555;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	.btn {
		padding: 0.6rem 1.25rem;
		border: none;
		border-radius: 6px;
		font-size: 0.95rem;
		cursor: pointer;
		align-self: flex-start;
		transition: opacity 0.15s;
	}

	.btn:disabled { opacity: 0.4; cursor: default; }
	.btn.secondary { background: #e8e8e8; color: #333; }
	.btn.secondary:hover { background: #ddd; }

	.hint {
		color: #666;
		font-size: 0.9rem;
		margin: 0;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
