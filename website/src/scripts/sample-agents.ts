// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Illustrative roster, not a ranking or a list of supported Scope workers.
export const sampleAgents = [
	{ profile: 'A', name: 'GitHub Copilot', initial: 'G' },
	{ profile: 'B', name: 'Claude Code', initial: 'C' },
	{ profile: 'C', name: 'Cursor', initial: 'Cu' },
	{ profile: 'D', name: 'OpenAI Codex', initial: 'Co' },
	{ profile: 'E', name: 'OpenCode', initial: 'O' },
] as const;

export type SampleProfile = typeof sampleAgents[number]['profile'];
