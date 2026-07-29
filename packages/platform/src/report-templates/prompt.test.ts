// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { REPORT_SYSTEM_PROMPT } from './prompt.js';

describe('REPORT_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof REPORT_SYSTEM_PROMPT).toBe('string');
    expect(REPORT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('describes the report generation task', () => {
    expect(REPORT_SYSTEM_PROMPT).toContain('report');
    expect(REPORT_SYSTEM_PROMPT).toContain('agentic coding session');
  });

  it('documents the available tools', () => {
    expect(REPORT_SYSTEM_PROMPT).toContain('get_run_summary');
    expect(REPORT_SYSTEM_PROMPT).toContain('list_turns');
    expect(REPORT_SYSTEM_PROMPT).toContain('get_turn_detail');
    expect(REPORT_SYSTEM_PROMPT).toContain('extract_snapshot');
  });

  it('includes insight management guidelines', () => {
    expect(REPORT_SYSTEM_PROMPT).toContain('search_insights');
    expect(REPORT_SYSTEM_PROMPT).toContain('create_insight');
    expect(REPORT_SYSTEM_PROMPT).toContain('reference_insight');
  });

  it('explains simulation design and criterion blindness', () => {
    expect(REPORT_SYSTEM_PROMPT).toContain('Simulation Design');
    expect(REPORT_SYSTEM_PROMPT).toContain('blind to criteria by design');
    expect(REPORT_SYSTEM_PROMPT).toContain('never sees the criteria list');
    expect(REPORT_SYSTEM_PROMPT).toContain('Iterative discovery is the expected pattern');
  });
});
