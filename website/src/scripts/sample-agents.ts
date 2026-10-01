// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Availability is separate from the fictional profiles and their results.
export const sampleAgents = [
	{ name: 'GitHub Copilot', initial: 'G', status: 'Supported today' },
	{ name: 'Claude Code', initial: 'C', status: 'Supported today' },
	{ name: 'OpenAI Codex', initial: 'Co', status: 'Planned' },
	{ name: 'OpenCode', initial: 'O', status: 'Planned' },
	{ name: 'Cursor', initial: 'Cu', status: 'Not integrated' },
] as const;

export const sampleProfiles = [
	{ id: 'base', agent: sampleAgents[0], label: 'Base', name: 'Baseline', setup: 'Pinned model, no extra skills.' },
	{ id: 'skills', agent: sampleAgents[0], label: 'Var 1', name: 'Add a skill', setup: 'Same agent and model, with a task skill.' },
	{ id: 'agent', agent: sampleAgents[1], label: 'Var 2', name: 'Change agent', setup: 'Different agent and model, same task.' },
] as const;

export type SampleProfile = typeof sampleProfiles[number]['id'];
