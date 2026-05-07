<script lang="ts">
	import RemoteControl, { rcState } from '$lib/index.js';

	const brightness = rcState('brightness', 50);
	const hue = rcState('hue', 180);
</script>

<RemoteControl remoteHref="/remote" />

<main>
	<h1>Remote</h1>
	<p class="hint">Adjust the sliders to control the host display.</p>

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
</style>
