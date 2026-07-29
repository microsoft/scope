// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { evaluateTrigger } from './trigger-evaluator.js';
import type {
  RequestDocument,
  TaskPromptDocument,
  ReportTrigger,
} from '@scope/core';

// --- Helpers ---

function makeRun(overrides: Partial<RequestDocument> = {}): RequestDocument {
  return {
    _id: 'run-1',
    scenario: { task: 'Build an Express API', criteria: ['has_azure', 'has_cloud'] },
    workerType: 'coder-acp-copilot',
    status: 'completed',
    createdAt: new Date(),
    taskPromptId: 'tp-uuid-1',
    ...overrides,
  } as RequestDocument;
}

function makeTaskPrompt(
  overrides: Partial<TaskPromptDocument> = {}
): TaskPromptDocument {
  return {
    _id: 'tp-uuid-1',
    text: 'Build an Express API',
    features: [
      { featureId: 'asks_for_api', detected: true, evaluated: true },
      { featureId: 'asks_for_azure', detected: true, evaluated: true },
      { featureId: 'asks_for_docker', detected: false, evaluated: true },
    ],
    createdAt: new Date(),
    ...overrides,
  };
}

// --- Tests ---

describe('evaluateTrigger', () => {
  describe('no trigger / always', () => {
    it('returns true when trigger is undefined', () => {
      expect(evaluateTrigger(undefined, makeRun())).toBe(true);
    });

    it('returns true when trigger is null', () => {
      expect(evaluateTrigger(null, makeRun())).toBe(true);
    });

    it('returns true for type: always', () => {
      expect(evaluateTrigger({ type: 'always' }, makeRun())).toBe(true);
    });
  });

  describe('criteria trigger', () => {
    it('matches when any criteria ID is present (default match)', () => {
      const trigger: ReportTrigger = {
        type: 'criteria',
        criteriaIds: ['has_azure', 'has_unknown'],
      };
      expect(evaluateTrigger(trigger, makeRun())).toBe(true);
    });

    it('matches when all criteria IDs are present', () => {
      const trigger: ReportTrigger = {
        type: 'criteria',
        criteriaIds: ['has_azure', 'has_cloud'],
        match: 'all',
      };
      expect(evaluateTrigger(trigger, makeRun())).toBe(true);
    });

    it('does not match when match=all and some criteria are missing', () => {
      const trigger: ReportTrigger = {
        type: 'criteria',
        criteriaIds: ['has_azure', 'has_unknown'],
        match: 'all',
      };
      expect(evaluateTrigger(trigger, makeRun())).toBe(false);
    });

    it('does not match when no criteria IDs overlap', () => {
      const trigger: ReportTrigger = {
        type: 'criteria',
        criteriaIds: ['has_gcp'],
      };
      expect(evaluateTrigger(trigger, makeRun())).toBe(false);
    });

    it('does not match when criteriaIds is empty', () => {
      const trigger: ReportTrigger = {
        type: 'criteria',
        criteriaIds: [],
      };
      expect(evaluateTrigger(trigger, makeRun())).toBe(false);
    });

    it('does not match when run has no criteria', () => {
      const trigger: ReportTrigger = {
        type: 'criteria',
        criteriaIds: ['has_azure'],
      };
      const run = makeRun({ scenario: { task: 'test', criteria: [] } });
      expect(evaluateTrigger(trigger, run)).toBe(false);
    });
  });

  describe('taskPrompt trigger', () => {
    it('matches when run taskPromptId is in the list', () => {
      const trigger: ReportTrigger = {
        type: 'taskPrompt',
        taskPromptIds: ['tp-uuid-1', 'tp-uuid-2'],
      };
      expect(evaluateTrigger(trigger, makeRun())).toBe(true);
    });

    it('does not match when run taskPromptId is not in the list', () => {
      const trigger: ReportTrigger = {
        type: 'taskPrompt',
        taskPromptIds: ['tp-uuid-other'],
      };
      expect(evaluateTrigger(trigger, makeRun())).toBe(false);
    });

    it('does not match when run has no taskPromptId', () => {
      const trigger: ReportTrigger = {
        type: 'taskPrompt',
        taskPromptIds: ['tp-uuid-1'],
      };
      const run = makeRun({ taskPromptId: undefined });
      expect(evaluateTrigger(trigger, run)).toBe(false);
    });
  });

  describe('promptFeature trigger', () => {
    it('matches when any feature is detected (default match)', () => {
      const trigger: ReportTrigger = {
        type: 'promptFeature',
        featureIds: ['asks_for_api', 'asks_for_unknown'],
      };
      expect(evaluateTrigger(trigger, makeRun(), makeTaskPrompt())).toBe(true);
    });

    it('matches when all features are detected', () => {
      const trigger: ReportTrigger = {
        type: 'promptFeature',
        featureIds: ['asks_for_api', 'asks_for_azure'],
        match: 'all',
      };
      expect(evaluateTrigger(trigger, makeRun(), makeTaskPrompt())).toBe(true);
    });

    it('does not match when match=all and some features not detected', () => {
      const trigger: ReportTrigger = {
        type: 'promptFeature',
        featureIds: ['asks_for_api', 'asks_for_docker'], // docker is detected: false
        match: 'all',
      };
      expect(evaluateTrigger(trigger, makeRun(), makeTaskPrompt())).toBe(false);
    });

    it('does not match when no features overlap', () => {
      const trigger: ReportTrigger = {
        type: 'promptFeature',
        featureIds: ['asks_for_python'],
      };
      expect(evaluateTrigger(trigger, makeRun(), makeTaskPrompt())).toBe(false);
    });

    it('does not match when featureIds is empty', () => {
      const trigger: ReportTrigger = {
        type: 'promptFeature',
        featureIds: [],
      };
      expect(evaluateTrigger(trigger, makeRun(), makeTaskPrompt())).toBe(false);
    });

    it('does not match when taskPrompt is undefined', () => {
      const trigger: ReportTrigger = {
        type: 'promptFeature',
        featureIds: ['asks_for_api'],
      };
      expect(evaluateTrigger(trigger, makeRun())).toBe(false);
    });

    it('does not match when taskPrompt has no features', () => {
      const trigger: ReportTrigger = {
        type: 'promptFeature',
        featureIds: ['asks_for_api'],
      };
      const tp = makeTaskPrompt({ features: [] });
      expect(evaluateTrigger(trigger, makeRun(), tp)).toBe(false);
    });

    it('ignores features where detected is false', () => {
      const trigger: ReportTrigger = {
        type: 'promptFeature',
        featureIds: ['asks_for_docker'], // detected: false in fixture
      };
      expect(evaluateTrigger(trigger, makeRun(), makeTaskPrompt())).toBe(false);
    });
  });

  describe('unknown trigger type', () => {
    it('returns false for unknown trigger type', () => {
      const trigger = { type: 'unknown' } as unknown as ReportTrigger;
      expect(evaluateTrigger(trigger, makeRun())).toBe(false);
    });
  });
});
