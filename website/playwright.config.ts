// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	workers: 1,
	use: {
		baseURL: 'http://127.0.0.1:14321',
		reducedMotion: 'reduce',
		trace: 'retain-on-failure',
	},
	projects: (['light', 'dark'] as const).flatMap((colorScheme) =>
		[1280, 320].map((width) => ({
			name: `${colorScheme}-${width}`,
			use: {
				colorScheme,
				viewport: { width, height: 900 },
			},
		})),
	),
	webServer: {
		command: 'BASE_PATH=/scope pnpm exec astro preview --host 127.0.0.1 --port 14321',
		url: 'http://127.0.0.1:14321/scope/',
		reuseExistingServer: false,
	},
});
