// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal run — only required fields, no turns/persona/model */
const minimalRun = {
  id: 'run-001',
  workerType: 'coder-acp-copilot',
  run: {
    status: 'pending',
  },
  scenario: { task: 'Add a button', criteria: ['has_button'] },
  logs: [],
  createdAt: '2025-06-01T10:00:00Z',
};

/** Full run with all optional fields populated */
const fullRun = {
  id: 'run-002',
  workerType: 'coder-acp-claude-code',
  model: 'claude-sonnet-4-20250514',
  run: {
    status: 'completed',
    outcome: 'succeeded',
    turns: [
      {
        iteration: 1,
        codingAgentResponse: 'code v1',
        judgeFeedback: 'needs tests',
        snapshotUrl: 'https://snap/1',
        passed: false,
        timestamp: '2025-06-01T10:05:00Z',
        criteriaResults: [
          { criterionId: 'has_form', passed: true, evaluated: true },
          { criterionId: 'has_validation', passed: true, evaluated: true },
          { criterionId: 'has_tests', passed: false, evaluated: true },
        ],
      },
      {
        iteration: 2,
        codingAgentResponse: 'code v2',
        judgeFeedback: 'all good',
        snapshotUrl: 'https://snap/2',
        passed: true,
        timestamp: '2025-06-01T10:10:00Z',
        criteriaResults: [
          { criterionId: 'has_form', passed: true, evaluated: true },
          { criterionId: 'has_validation', passed: true, evaluated: true },
          { criterionId: 'has_tests', passed: true, evaluated: true },
        ],
      },
    ],
    error: undefined,
  },
  scenario: {
    version: 'v2' as const,
    task: 'Implement login form\nwith validation',
    criteria: ['has_form', 'has_validation', 'has_tests'],
  },
  maxIterations: 3,
  persona: {
    personality: 'demanding' as const,
    experience: 'senior' as const,
    verbosity: 'brief' as const,
    type: 'traditional' as const,
  },
  createdAt: '2025-06-01T10:00:00Z',
  updatedAt: '2025-06-01T10:10:00Z',
};

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a stripped-down Commander program that registers only the `run get`
 * subcommand so we can invoke it programmatically.
 *
 * We dynamically import the real CLI module to pick up the registered command,
 * but that also boots every other command and runs dotenv, etc.  Instead we
 * replicate the minimal wiring here — it tests the same display logic because
 * we call it through Commander's `.parseAsync()`.
 */
async function buildRunGetCommand() {
  // Re-import the module each time so vi.stubGlobal('fetch') is picked up.
  // Dynamic import with cache-bust to avoid stale module.
  const mod = await import('./index.js');
  // The default export is the program; grab the 'run' parent command.
  // Commander nests: program → run → get
  const program: Command = (mod as unknown as { default: Command }).default ?? (mod as unknown as { program: Command }).program;

  // If the module doesn't export program directly, we build our own mini program
  // that mirrors the real `run get` logic — but that defeats the purpose.
  // Instead, we test the output formatting inline.
  return program;
}

/** Capture all console.log calls and return them joined by newlines. */
function captureConsole() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const errLines: string[] = [];
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errLines.push(args.map(String).join(' '));
  });
  return {
    lines,
    errLines,
    restore: () => { spy.mockRestore(); errSpy.mockRestore(); },
  };
}

// Stub process.exit to prevent vitest from dying
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('run get', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    exitSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('human-readable output', () => {
    it('displays all fields for a full run', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(fullRun),
      });
      vi.stubGlobal('fetch', mockFetch);

      const { lines, restore } = captureConsole();
      try {
        // Import fresh to pick up stubbed fetch
        const { runGetAction } = await import('./run-get-action.js');
        await runGetAction({ id: 'run-002', url: 'http://localhost:3100', output: 'table' });
      } finally {
        restore();
      }

      const output = lines.join('\n');

      // Core fields
      expect(output).toContain('run-002');
      expect(output).toContain('coder-acp-claude-code');
      expect(output).toContain('claude-sonnet-4-20250514');
      expect(output).toContain('completed');

      // Persona
      expect(output).toContain('demanding');
      expect(output).toContain('senior');

      // Task
      expect(output).toContain('Implement login form');

      // Criteria listed
      expect(output).toContain('has_form');
      expect(output).toContain('has_validation');
      expect(output).toContain('has_tests');

      // Turns summary (grouped per gate, iterations numbered globally across gates)
      expect(output).toContain('Iteration 1');
      expect(output).toContain('Iteration 2');
      expect(output).toContain('3/3 criteria passed');
    });

    it('displays minimal run without optional fields', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(minimalRun),
      });
      vi.stubGlobal('fetch', mockFetch);

      const { lines, restore } = captureConsole();
      try {
        const { runGetAction } = await import('./run-get-action.js');
        await runGetAction({ id: 'run-001', url: 'http://localhost:3100', output: 'table' });
      } finally {
        restore();
      }

      const output = lines.join('\n');

      expect(output).toContain('run-001');
      expect(output).toContain('coder-acp-copilot');
      expect(output).toContain('pending');
      expect(output).toContain('Add a button');

      // Should NOT contain optional fields
      expect(output).not.toContain('Model:');
      expect(output).not.toContain('Persona:');
      expect(output).not.toContain('Turn ');
      expect(output).not.toContain('Prompt Features:');
    });
  });

  describe('JSON output', () => {
    it('outputs the full run as formatted JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(fullRun),
      });
      vi.stubGlobal('fetch', mockFetch);

      const { lines, restore } = captureConsole();
      try {
        const { runGetAction } = await import('./run-get-action.js');
        await runGetAction({ id: 'run-002', url: 'http://localhost:3100', output: 'json' });
      } finally {
        restore();
      }

      const output = lines.join('\n');
      // Should contain valid JSON with key fields
      expect(output).toContain('"id"');
      expect(output).toContain('"run-002"');
      expect(output).toContain('"workerType"');
    });
  });

  describe('workspace snapshot sizes (#1564)', () => {
    /** Run `run get` against a copy of `fullRun` whose turns carry the given sizes. */
    async function runWithSizes(sizes: Array<number | undefined>, output: string) {
      const run = {
        ...fullRun,
        run: {
          ...fullRun.run,
          turns: fullRun.run.turns.map((turn, i) => ({ ...turn, workspaceSizeBytes: sizes[i] })),
        },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(run) }));

      const { lines, restore } = captureConsole();
      try {
        const { runGetAction } = await import('./run-get-action.js');
        await runGetAction({ id: 'run-002', url: 'http://localhost:3100', output });
      } finally {
        restore();
      }
      return lines.join('\n');
    }

    it('shows per-iteration sizes and the total', async () => {
      const output = await runWithSizes([1024, 2048], 'table');

      expect(output).toContain('snapshot 1.0 KB');
      expect(output).toContain('snapshot 2.0 KB');
      expect(output).toMatch(/Workspace snapshots:.*3\.0 KB/);
      expect(output).not.toContain('measured');
    });

    it('notes partial coverage when some iterations lack a size', async () => {
      const output = await runWithSizes([1024, undefined], 'table');

      expect(output).toMatch(/Workspace snapshots:.*1\.0 KB.*1\/2 iterations measured/);
    });

    it('shows unavailable for legacy runs without recorded sizes', async () => {
      const output = await runWithSizes([undefined, undefined], 'table');

      expect(output).toMatch(/Workspace snapshots:.*unavailable/);
      expect(output).not.toContain('0 B');
    });

    it('includes the total bytes in JSON output', async () => {
      const output = await runWithSizes([1024, 2048], 'json');

      expect(JSON.parse(output)[0].workspaceSizeBytes).toBe('3072');
    });

    it('reports N/A in JSON output when no size was recorded', async () => {
      const output = await runWithSizes([undefined, undefined], 'json');

      expect(JSON.parse(output)[0].workspaceSizeBytes).toBe('N/A');
    });
  });

  describe('error handling', () => {
    it('exits with error on 404', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Request not found' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const { errLines, restore } = captureConsole();
      try {
        const { runGetAction } = await import('./run-get-action.js');
        await runGetAction({ id: 'nonexistent', url: 'http://localhost:3100', output: 'table' });
      } catch {
        // process.exit throws
      } finally {
        restore();
      }

      const errOutput = errLines.join('\n');
      expect(errOutput).toContain('Request not found');
    });

    it('exits with error on network failure', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      const { errLines, restore } = captureConsole();
      try {
        const { runGetAction } = await import('./run-get-action.js');
        await runGetAction({ id: 'run-001', url: 'http://localhost:3100', output: 'table' });
      } catch {
        // process.exit throws
      } finally {
        restore();
      }

      const errOutput = errLines.join('\n');
      expect(errOutput).toContain('ECONNREFUSED');
    });
  });
});
