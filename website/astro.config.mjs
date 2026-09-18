// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import remarkBasePath from './src/plugins/remark-base-path.mjs';
import remarkHttpSnippets from './src/plugins/remark-http-snippets.mjs';

// https://astro.build/config
// `site` and `base` are driven by the GitHub Pages deployment URL in CI
// (set explicitly in the deployment workflow), with safe defaults
// for local development.
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
	server: { port: docPort },
	markdown: {
		remarkPlugins: [[remarkBasePath, { base }], remarkHttpSnippets],
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
			},
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
						{ label: 'Local development', slug: 'getting-started/local-development' },
						{ label: 'Install the CLI', slug: 'getting-started/install-cli' },
						{ label: 'Your first run', slug: 'getting-started/first-run' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Submitting requests (Portal)', slug: 'guides/submitting-requests-portal' },
						{ label: 'Submitting requests (REST API)', slug: 'guides/submitting-requests-api' },
					{ label: 'Submitting requests (CLI)', slug: 'guides/submitting-requests-cli' },
						{ label: 'Managing task prompts', slug: 'guides/managing-task-prompts' },
						{ label: 'Defining evaluation criteria', slug: 'guides/defining-criteria' },
						{ label: 'Defining profiles', slug: 'guides/defining-profiles' },
						{ label: 'Working with prompt features', slug: 'guides/prompt-features' },
						{ label: 'Choosing a coding agent', slug: 'guides/choosing-a-coding-agent' },
					{ label: 'Choosing software stacks', slug: 'guides/software-stacks' },
						{ label: 'Prioritizing & pausing requests', slug: 'guides/prioritizing-requests' },
						{ label: 'Importing MCP servers', slug: 'guides/importing-mcp-servers' },
						{ label: 'Importing skills', slug: 'guides/importing-skills' },
						{ label: 'Importing VS Code extensions', slug: 'guides/importing-extensions' },
						{ label: 'Using MCP servers, skills & extensions', slug: 'guides/mcp-skills-extensions' },
					],
				},
				{
					label: 'Reference',
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
					label: 'Contributing',
					items: [
						{ label: 'Contributor guide', slug: 'resources/contributing' },
						{ label: 'Development guide', slug: 'resources/development' },
					],
				},
				{
					label: 'Resources',
					items: [
						{ label: 'Support and security', slug: 'resources/support' },
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
