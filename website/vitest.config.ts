// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	test: {
		include: ['src/scripts/**/*.test.ts'],
		environment: 'node',
	},
});
