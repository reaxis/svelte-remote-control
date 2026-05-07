<script lang="ts">
	import RemoteControl, { startCall, connStatus } from '$lib/index.js';

	$effect(() => {
		if (connStatus() === 'connected') {
			startCall({ video: { facingMode: 'environment' }, audio: false });
		}
	});
</script>

<RemoteControl remoteHref="/remote" />

<main>
	<h1>Guest</h1>
	<p>Connected to host. Streaming camera…</p>
</main>

<style>
	main {
		max-width: 480px;
		margin: 4rem auto;
		padding: 0 1.5rem;
		font-family: system-ui, sans-serif;
	}
</style>
