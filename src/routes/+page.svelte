<script lang="ts">
	import RemoteControl, { rcState } from '$lib/index.js';

	const brightness = rcState('brightness', 50);
	const hue = rcState('hue', 180);
</script>

<RemoteControl />

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
