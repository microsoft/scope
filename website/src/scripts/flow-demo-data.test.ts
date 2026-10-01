// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from 'vitest';
import { sampleAgents, sampleProfiles } from './sample-agents';
import { criterionOutcomes, demoCriteria, exampleScenario, formatDelta, formatDuration, gateOutcomes, passedGateCount, totalTokens } from './flow-demo-data';

describe('interactive example fixtures', () => {
	it('only runs supported agents and identifies a single base profile', () => {
		expect(sampleProfiles.filter((profile) => profile.id === 'base')).toHaveLength(1);
		expect(sampleProfiles.every((profile) => profile.agent.status === 'Supported today')).toBe(true);
		expect(sampleAgents.filter((agent) => agent.status === 'Planned').map((agent) => agent.name)).toEqual(['OpenAI Codex', 'OpenCode']);
		expect(sampleProfiles[1].agent).toBe(sampleProfiles[0].agent);
	});

	it('provides one task-board example with complete metrics for every profile', () => {
		expect(exampleScenario.id).toBe('task-board');
		expect(Object.keys(exampleScenario.results)).toEqual(sampleProfiles.map((profile) => profile.id));
		for (const profile of sampleProfiles) {
			const result = exampleScenario.results[profile.id];
			expect(totalTokens(result)).toBe(result.inputTokens + result.outputTokens);
			expect(result.inputTokens).toBeGreaterThan(0);
			expect(result.outputTokens).toBeGreaterThan(0);
			expect(result.durationSeconds).toBeGreaterThan(0);
			expect(criterionOutcomes(result).size).toBe(demoCriteria.length);
		}
	});

	it('skips later gates after a failed build', () => {
		const result = exampleScenario.results.agent;
		expect(gateOutcomes(result)).toEqual(['Pass', 'Fail', 'Skipped']);
		expect([...criterionOutcomes(result).values()]).toEqual(['Pass', 'Fail', 'Skipped', 'Skipped', 'Skipped']);
	});

	it('skips both dependent checks when their parent fails', () => {
		const result: typeof exampleScenario.results.base = { ...exampleScenario.results.base, failedCriterion: 'tests_run' };
		expect(gateOutcomes(result)).toEqual(['Pass', 'Pass', 'Fail']);
		expect([...criterionOutcomes(result).values()]).toEqual(['Pass', 'Pass', 'Fail', 'Skipped', 'Skipped']);
	});

	it('does not skip a sibling criterion when the edge-case check fails', () => {
		expect([...criterionOutcomes(exampleScenario.results.base).values()]).toEqual(['Pass', 'Pass', 'Pass', 'Pass', 'Fail']);
	});

	it('reports all gates passed only when every criterion passes', () => {
		expect(gateOutcomes(exampleScenario.results.skills)).toEqual(['Pass', 'Pass', 'Pass']);
	});

	it('derives the chart from the profile outcomes', () => {
		expect(sampleProfiles.map((profile) => passedGateCount(exampleScenario.results[profile.id]))).toEqual([2, 3, 1]);
	});

	it('formats exact, signed deltas against the base', () => {
		expect(formatDelta(18000, 21600, 'tokens')).toBe('-3,600 tokens vs base');
		expect(formatDelta(23400, 13500, 'tokens')).toBe('+9,900 tokens vs base');
		expect(formatDelta(128, 154, 'sec')).toBe('-26 sec vs base');
		expect(formatDelta(154, 154, 'sec')).toBe('Same as base');
		expect(formatDuration(154)).toBe('2m 34s');
		expect(formatDuration(60)).toBe('1m 00s');
	});
});
