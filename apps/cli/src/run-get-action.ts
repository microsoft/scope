// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Action handler for `run get` subcommand — extracted for testability.
 */
import { colorLevel, dimTimestamp, errorText, successText, label, value, banner, warnBanner, criterionIcon } from "./utils/style.js";
import { GATE_METADATA, GATE_ORDER, type ConversationTurn, type GateId, type GateRunSummary, type RequestDocument } from "shared/types";
import { formatData, isMachineReadable } from "./utils/formatters.js";
import type { OutputFormat, DisplayField } from "./utils/types.js";
import { apiFetch } from "./utils/api-client.js";

function gateLabel(gate: GateId): string {
  return GATE_METADATA[gate]?.label ?? gate;
}

function formatGateStatus(summary: GateRunSummary | undefined): string {
  if (!summary) return dimTimestamp("not run");
  const text = `${summary.status} (${summary.iterations} iter${summary.iterations === 1 ? "" : "s"})`;
  if (summary.status === "passed") return successText(text);
  if (summary.status === "failed") return errorText(text);
  return warnBanner(text);
}

function gateStatusIcon(summary: GateRunSummary | undefined): string {
  if (!summary) return "  ";
  if (summary.status === "passed") return criterionIcon(true, true);
  if (summary.status === "failed") return criterionIcon(true, false);
  return "○";
}

export interface RunGetOptions {
  id: string;
  url: string;
  output: string;
}

export async function runGetAction(options: RunGetOptions): Promise<void> {
  const format = (options.output || 'table') as OutputFormat;
  try {
  const response = await apiFetch(options.url, `/requests/${options.id}`);

  if (!response.ok) {
    const error = await response.json();
    console.error(errorText("Error:"), error.error || JSON.stringify(error));
    process.exit(1);
  }

  const run = await response.json() as RequestDocument & { id?: string; completedAt?: string | Date };
  // Per-attempt state is nested under run.run (RunState).
  const rs = run.run;

  // Machine-readable output
  if (isMachineReadable(format)) {
    const fields: DisplayField[] = [
      { key: 'id', label: 'ID' },
      { key: 'workerType', label: 'Worker' },
      { key: 'model', label: 'Model' },
      { key: 'profileId', label: 'Profile', formatter: (r: any) => r.profileId ?? '' },
      { key: 'status', label: 'Status' },
      { key: 'maxIterations', label: 'Max Iterations' },
      { key: 'gatesCount', label: 'Gates' },
      { key: 'gateSummaries', label: 'Gate Status' },
      { key: 'turnsCount', label: 'Turns' },
      { key: 'passed', label: 'Passed' },
      { key: 'task', label: 'Task' },
      { key: 'criteriaCount', label: 'Criteria' },
      { key: 'createdAt', label: 'Created' },
      { key: 'updatedAt', label: 'Updated' },
      { key: 'error', label: 'Error' },
    ];
    const row = {
      ...run,
      status: rs?.status,
      outcome: rs?.outcome,
      error: rs?.error,
      turnsCount: rs?.turns?.length ?? 0,
      gatesCount: run.gates?.length ?? run.gateSummaries?.length ?? 0,
      gateSummaries: (run.gateSummaries ?? []).map((g) => `${g.gate}:${g.status}`).join(', '),
      passed: rs?.outcome === 'succeeded' ? 'yes' : rs?.outcome === 'failed' || rs?.outcome === 'finished' ? 'no' : '-',
      task: run.scenario?.task ?? '',
      criteriaCount: run.scenario?.criteria?.length ?? 0,
    };
    console.log(formatData([row], fields, format));
    return;
  }

  // Human-readable output
  console.log(`${label('ID:')}             ${value(run.id ?? run._id)}`);
  console.log(`${label('Worker:')}         ${value(run.workerType)}`);
  if (run.model) console.log(`${label('Model:')}          ${value(run.model)}`);
  if (run.profileId) console.log(`${label('Profile:')}        ${value(run.profileId)}`);
  if (run.profileVersionId) console.log(`${label('Profile Ver:')}    ${dimTimestamp(run.profileVersionId)}`);

  const statusColor = rs?.outcome === 'succeeded' ? successText
    : (rs?.outcome === 'failed' || rs?.outcome === 'finished') ? errorText
    : value;
  console.log(`${label('Status:')}         ${statusColor(rs?.status ?? 'unknown')}`);
  if (rs?.outcome) console.log(`${label('Outcome:')}        ${statusColor(rs.outcome)}`);

  if (run.maxIterations != null) console.log(`${label('Max Iterations:')} ${value(String(run.maxIterations))}`);
  if (run.gates?.length) {
    console.log(`${label('Configured Gates:')} ${value(run.gates.map((g) => gateLabel(g.gate)).join(' → '))}`);
  }
  if (run.createdAt) console.log(`${label('Created:')}        ${dimTimestamp(new Date(run.createdAt).toLocaleString())}`);
  if (run.updatedAt) console.log(`${label('Updated:')}        ${dimTimestamp(new Date(run.updatedAt).toLocaleString())}`);
  if (run.completedAt) console.log(`${label('Completed:')}      ${dimTimestamp(new Date(run.completedAt).toLocaleString())}`);

  // Persona
  if (run.persona) {
    const p = run.persona;
    console.log(`${label('Persona:')}        ${value(`${p.personality} / ${p.experience} / ${p.verbosity} / ${p.type}`)}`);
  }

  // Scenario
  if (run.scenario) {
    console.log(`${label('Task:')}`);
    for (const line of (run.scenario.task ?? '').trim().split('\n')) {
      console.log(`  ${line}`);
    }
    if (run.scenario.criteria?.length > 0) {
      console.log(`${label('Criteria:')}       ${value(String(run.scenario.criteria.length))} criterion/criteria`);
      // Build a lookup from the last turn's criteria results
      const lastTurn = rs?.turns?.length ? rs.turns[rs.turns.length - 1] : null;
      const resultsMap = new Map<string, { passed: boolean; evaluated: boolean }>();
      if (lastTurn?.criteriaResults) {
        for (const cr of lastTurn.criteriaResults) {
          resultsMap.set(cr.criterionId, { passed: cr.passed, evaluated: cr.evaluated });
        }
      }
      for (const c of run.scenario.criteria) {
        const r = resultsMap.get(c);
        const icon = r ? criterionIcon(r.evaluated, r.passed) : '  ';
        console.log(`  ${icon} ${c}`);
      }
    }
  }

  // Gates and turns summary
  const gateSummaries = run.gateSummaries ?? [];
  if (gateSummaries.length > 0) {
    console.log(`\n${banner('─── Gates ───')}`);
    for (const summary of gateSummaries) {
      console.log(`  ${gateStatusIcon(summary)} ${label(`${gateLabel(summary.gate)}:`)} ${formatGateStatus(summary)}`);
    }
  }

  if (rs?.turns?.length && rs.turns.length > 0) {
    console.log(`\n${banner('─── Turns ───')}`);
    const turnsByGate = new Map<GateId, ConversationTurn[]>();
    for (const turn of rs.turns) {
      const gate = turn.gate ?? "select";
      const turns = turnsByGate.get(gate) ?? [];
      turns.push(turn);
      turnsByGate.set(gate, turns);
    }

    const gatesToDisplay = GATE_ORDER.filter((gate) => turnsByGate.has(gate) || gateSummaries.some((summary) => summary.gate === gate));
    for (const gate of gatesToDisplay) {
      const summary = gateSummaries.find((item) => item.gate === gate);
      console.log(`  ${label(`${gateLabel(gate)} gate:`)} ${formatGateStatus(summary)}`);
      // Iterations are numbered globally and continuously across all gates.
      (turnsByGate.get(gate) ?? []).forEach((turn) => {
        const passIcon = criterionIcon(true, turn.passed);
        const criteriaStr = turn.criteriaResults?.length
          ? ` — ${turn.criteriaResults.filter((cr: { passed: boolean }) => cr.passed).length}/${turn.criteriaResults.length} criteria passed`
          : '';
        console.log(`    ${label(`Iteration ${turn.iteration}:`)} ${passIcon}${criteriaStr}`);
      });
    }
  }

  // Error
  if (rs?.error) {
    console.log(`${label('Error:')}          ${errorText(rs.error)}`);
  }

  // Soft-deleted
  if (run.deletedAt) {
    console.log(`${label('Deleted:')}        ${warnBanner(new Date(run.deletedAt).toLocaleString())}`);
  }
  } catch (error) {
    console.error(errorText("Error:"), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
