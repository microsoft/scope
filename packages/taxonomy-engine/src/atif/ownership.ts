// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

interface ObjectSlot {
  owner: Record<string, unknown>;
  key: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Detaches opaque schema values that Zod intentionally passes through by
 * reference. Known ATIF objects/arrays are already validation-owned copies.
 */
export function detachParsedAtifOpaqueValues(
  trajectory: Record<string, unknown>,
): void {
  const slots: ObjectSlot[] = [];
  const addOpaqueRecord = (value: unknown) => {
    const owner = record(value);
    if (!owner) return;
    for (const [key, child] of Object.entries(owner)) {
      if (child && typeof child === "object") {
        slots.push({ owner, key });
      }
    }
  };
  const visitTrajectory = (value: Record<string, unknown>) => {
    addOpaqueRecord(value.extra);
    const agent = record(value.agent);
    addOpaqueRecord(agent?.extra);
    const toolDefinitions = agent?.tool_definitions;
    if (Array.isArray(toolDefinitions)) {
      for (const definitionValue of toolDefinitions) {
        addOpaqueRecord(record(definitionValue)?.function);
      }
    }
    addOpaqueRecord(record(value.final_metrics)?.extra);

    const steps = value.steps;
    if (Array.isArray(steps)) {
      for (const stepValue of steps) {
        const step = record(stepValue);
        addOpaqueRecord(step?.extra);
        addOpaqueRecord(record(step?.metrics)?.extra);
        const calls = step?.tool_calls;
        if (Array.isArray(calls)) {
          for (const callValue of calls) {
            const call = record(callValue);
            addOpaqueRecord(call?.arguments);
            addOpaqueRecord(call?.extra);
          }
        }
        const results = record(step?.observation)?.results;
        if (Array.isArray(results)) {
          for (const resultValue of results) {
            const result = record(resultValue);
            addOpaqueRecord(result?.extra);
            const references = result?.subagent_trajectory_ref;
            if (Array.isArray(references)) {
              for (const referenceValue of references) {
                addOpaqueRecord(record(referenceValue)?.extra);
              }
            }
          }
        }
      }
    }

    const children = value.subagent_trajectories;
    if (Array.isArray(children)) {
      for (const child of children) {
        const childRecord = record(child);
        if (childRecord) visitTrajectory(childRecord);
      }
    }
  };

  visitTrajectory(trajectory);
  if (!slots.length) return;
  const detached = structuredClone(
    slots.map(slot => slot.owner[slot.key]),
  );
  slots.forEach((slot, index) => {
    slot.owner[slot.key] = detached[index];
  });
}
