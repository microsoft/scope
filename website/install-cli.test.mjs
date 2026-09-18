// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('./install-cli.sh', import.meta.url));
const releasesEndpoint = 'repos/microsoft/scope/releases';
const assetUrl = 'https://api.github.com/repos/microsoft/scope/releases/assets/123';

for (const client of ['gh', 'curl']) {
	test(`installs from microsoft/scope using ${client}`, () => {
		const fixture = join(process.cwd(), `.installer-test-${randomUUID()}`);
		const bin = join(fixture, 'bin');
		const callsFile = join(fixture, 'calls.jsonl');
		const installDir = client === 'gh'
			? join(fixture, '.local', 'bin')
			: join(fixture, 'custom-bin');
		mkdirSync(bin, { recursive: true });

		try {
			symlinkSync(process.execPath, join(bin, 'node'));
			for (const command of ['mkdir', 'chmod', 'tr', 'grep']) {
				const path = ['/bin', '/usr/bin'].map((dir) => join(dir, command)).find(existsSync);
				assert.ok(path, `${command} is required`);
				symlinkSync(path, join(bin, command));
			}

			const releases = [
				{ tag_name: 'other/v99.0.0', assets: [] },
				{ tag_name: 'cli/v1.2.3', assets: [{ name: 'scope.mjs', url: assetUrl }] },
			];
			const bundle = '#!/usr/bin/env node\nconsole.log("1.2.3");\n';
			writeFileSync(join(bin, client), `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
if (args.includes(${JSON.stringify(client === 'gh' ? releasesEndpoint : `https://api.github.com/${releasesEndpoint}`)})) {
	process.stdout.write(${JSON.stringify(JSON.stringify(releases))});
} else if (args.includes(${JSON.stringify(assetUrl)})) {
	const output = args.indexOf('-o');
	if (output >= 0) fs.writeFileSync(args[output + 1], ${JSON.stringify(bundle)});
	else process.stdout.write(${JSON.stringify(bundle)});
} else {
	console.error('Unexpected request: ' + JSON.stringify(args));
	process.exit(1);
}
`, { mode: 0o755 });

			const result = spawnSync('/bin/bash', [installer], {
				encoding: 'utf8',
				timeout: 10_000,
				env: {
					...process.env,
					PATH: bin,
					HOME: fixture,
					SCOPE_INSTALL_DIR: client === 'gh' ? '' : installDir,
					GH_TOKEN: 'mock-token',
					GITHUB_TOKEN: '',
				},
			});

			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stdout, /Installed scope 1\.2\.3/);
			assert.equal(readFileSync(join(installDir, 'scope'), 'utf8'), bundle);
			const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
			assert.equal(calls.length, 2);
			assert.ok(calls[0].includes(client === 'gh'
				? releasesEndpoint
				: `https://api.github.com/${releasesEndpoint}`));
			assert.ok(calls[1].includes(assetUrl));
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
}
