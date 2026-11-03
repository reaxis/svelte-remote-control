<script lang="ts">
	import { browser } from '$app/env';
	import RemoteControl, { rcState, type PeerServerOptions, type WebRTCConnectionOptions } from '#lib/index.js';

	const brightness = rcState('brightness', 50);
	const hue = rcState('hue', 180);

	// Optional endpoint returning `{ iceServers }` with TURN credentials, set at
	// build time (see the README's "TURN servers"). Without it: STUN only.
	const turnUrl: string | undefined = import.meta.env.VITE_TURN_CREDENTIALS_URL;

	async function iceServers(): Promise<RTCIceServer[]> {
		const res = await fetch(turnUrl!, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) throw new Error(`TURN credentials: HTTP ${res.status}`);
		return (await res.json()).iceServers;
	}

	// Optional PeerJS broker (e.g. a self-hosted peerjs-server), set at build time as
	// its address: absolute, or a path on this site. Without it: the public broker.
	const brokerUrl: string | undefined = import.meta.env.VITE_PEER_SERVER_URL;

	function peerServer(url: string): PeerServerOptions {
		const { protocol, hostname, port, pathname } = new URL(url, location.href);
		const secure = protocol === 'https:';
		return { host: hostname, port: port ? Number(port) : secure ? 443 : 80, path: pathname, secure };
	}

	const config: WebRTCConnectionOptions | undefined =
		turnUrl || brokerUrl && browser
			? { ...(turnUrl && { iceServers }), ...(brokerUrl && browser && { peerServer: peerServer(brokerUrl) }) }
			: undefined;
</script>

<RemoteControl {config} />

<main>
	<h1>svelte-remote-control demo</h1>
	<p class="hint">Open this page on another device (open the link or scan the QR in the top-right) to see state sync in action.</p>

	<div class="sliders">
		<label>
			<span>Brightness <strong>{brightness.value}</strong></span>
			<input type="range" min="0" max="100" bind:value={brightness.value} />
		</label>

		<label>
			<span>Hue <strong>{hue.value}°</strong></span>
			<input type="range" min="0" max="360" bind:value={hue.value} />
		</label>
	</div>

	<div
		class="swatch"
		style="background: hsl({hue.value}deg {brightness.value}% 50%)"
	></div>


</main>

<style>
	main {
		max-width: 480px;
		margin: 4rem auto;
		padding: 0 1.5rem;
		font-family: system-ui, sans-serif;
	}

	h1 {
		margin-bottom: 0.5rem;
	}

	.hint {
		color: #666;
		font-size: 0.95rem;
		margin-bottom: 2rem;
	}

	.sliders {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		margin-bottom: 2rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	label span {
		font-size: 0.9rem;
		color: #444;
	}

	input[type="range"] {
		width: 100%;
		accent-color: currentColor;
	}

	.swatch {
		width: 100%;
		height: 120px;
		border-radius: 12px;
		transition: background 0.1s;
	}
</style>
