// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import remarkHttpSnippets from './src/plugins/remark-http-snippets.mjs';
import remarkBaseLinks from './src/plugins/remark-base-links.mjs';

// https://astro.build/config
// `site` and `base` are driven by the GitHub Pages deployment URL in CI
// (set via env vars from `actions/configure-pages` outputs), with safe
// defaults for local development.
//
// `DOC_PORT` is read from the `.env` file that `worktree-env` writes to
// the git repo root (so each worktree binds to a unique dev/preview
// port). This site lives in a `website/` subdirectory, so we resolve the
// repo root explicitly rather than assuming `.env` sits next to
// `astro.config.mjs`. We parse `.env` directly rather than relying on
// `${DOC_PORT}` shell substitution in package.json, because that would
// expand before `worktree-env` runs.
function repoRoot() {
	try {
		return execSync('git rev-parse --show-toplevel', {
			encoding: 'utf8',
		}).trim();
	} catch {
		return process.cwd();
	}
}
function readDotEnv(name) {
	if (process.env[name]) return process.env[name];
	// Prefer a local `.env` (standalone repo) and fall back to the repo
	// root `.env` (when nested under scope-core's `website/`).
	for (const dir of [process.cwd(), repoRoot()]) {
		try {
			const content = readFileSync(join(dir, '.env'), 'utf8');
			const match = content.match(new RegExp(`^${name}=(.*)$`, 'm'));
			if (match) return match[1].trim();
		} catch {
			// ignore missing/unreadable .env and try the next location
		}
	}
	return undefined;
}
const docPort = Number(readDotEnv('DOC_PORT')) || 4300;
const base = process.env.BASE_PATH || '/';

export default defineConfig({
	site: process.env.SITE || `http://localhost:${docPort}`,
	base,
	output: 'static',
	server: { port: docPort },
	markdown: {
		remarkPlugins: [remarkHttpSnippets, [remarkBaseLinks, { base }]],
	},
	integrations: [
		starlight({
			title: 'Scope',
			logo: {
				light: './src/assets/scope-logo-light.svg',
				dark: './src/assets/scope-logo-dark.svg',
				alt: 'Scope',
			},
			customCss: ['./src/styles/landing.css'],
			components: {
				SiteTitle: './src/components/SiteTitle.astro',
				Header: './src/components/Header.astro',
				PageTitle: './src/components/PageTitle.astro',
			},
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/microsoft/scope' }],
			plugins: [
				starlightOpenAPI([
					{
						base: 'reference/api',
						label: 'REST API reference',
						schema: './src/openapi/scope-openapi.json',
					},
				]),
			],
			sidebar: [
				{
					label: 'Introduction',
					items: [
						{ label: 'What is Scope?', slug: 'introduction/what-is-scope' },
						{ label: 'Concepts', slug: 'introduction/concepts' },
					],
				},
				{
					label: 'Getting Started',
					items: [
						{ label: 'Access', slug: 'getting-started/access' },
						{ label: 'Install the CLI', slug: 'getting-started/install-cli' },
						{ label: 'Your first run', slug: 'getting-started/first-run' },
					],
				},
				{
					label: 'Guides',
					items: [
						{
							label: 'Run experiments',
							items: [
								{ label: 'Submit from the Portal', slug: 'guides/submitting-requests-portal' },
								{ label: 'Submit from the CLI', slug: 'guides/submitting-requests-cli' },
								{ label: 'Submit through the API', slug: 'guides/submitting-requests-api' },
								{ label: 'Prioritize & pause', slug: 'guides/prioritizing-requests' },
							],
						},
						{
							label: 'Design your benchmark',
							collapsed: true,
							items: [
								{ label: 'Task prompts', slug: 'guides/managing-task-prompts' },
								{ label: 'Evaluation criteria', slug: 'guides/defining-criteria' },
								{ label: 'Agent profiles', slug: 'guides/defining-profiles' },
								{ label: 'Prompt features', slug: 'guides/prompt-features' },
								{ label: 'Choose a coding agent', slug: 'guides/choosing-a-coding-agent' },
								{ label: 'Software stacks', slug: 'guides/software-stacks' },
							],
						},
						{
							label: 'Connect tools & skills',
							collapsed: true,
							items: [
								{ label: 'Import MCP servers', slug: 'guides/importing-mcp-servers' },
								{ label: 'Import skills', slug: 'guides/importing-skills' },
								{ label: 'Import VS Code extensions', slug: 'guides/importing-extensions' },
								{ label: 'Use tools, skills & extensions', slug: 'guides/mcp-skills-extensions' },
							],
						},
					],
				},
				{
					label: 'Reference',
					collapsed: true,
					items: [
						{ label: 'REST API overview', slug: 'reference/rest-api' },
						{ label: 'Profile schema', slug: 'reference/profile-schema' },
						{ label: 'Criteria schema', slug: 'reference/criteria-schema' },
						{ label: 'Prompt feature schema', slug: 'reference/prompt-feature-schema' },
						{ label: 'Coding agents & capabilities', slug: 'reference/workers' },
					],
				},
				...openAPISidebarGroups,
				{
					label: 'Resources',
					collapsed: true,
					items: [
						{ label: 'FAQ', slug: 'resources/faq' },
						{ label: 'Data collection and privacy', slug: 'resources/data-collection' },
						{ label: 'Troubleshooting', slug: 'resources/troubleshooting' },
						{ label: 'Glossary', slug: 'resources/glossary' },
					],
				},
			],
		}),
	],
});
