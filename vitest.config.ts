import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
	plugins: [svelte()],
	// Svelte's browser build, so component tests can mount() in jsdom.
	resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
	test: {
		environment: 'jsdom',
		exclude: ['dist/**', '.svelte-kit/**', 'node_modules/**'],
	},
});
