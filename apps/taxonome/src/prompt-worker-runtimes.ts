// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Minimal worker-owned prompt runtime lifecycle. */
export interface WorkerPromptRuntime {
  /** Whether the runtime can safely process another prompt job. */
  healthy(): boolean;
  /** Closes transport/session resources. */
  close(): Promise<void>;
}

/**
 * Lazily owns one independent prompt runtime per scheduler worker.
 *
 * Healthy runtimes are reused only by their worker. Poisoned runtimes are
 * closed and replaced before that worker's next prompt job.
 */
export class PromptWorkerRuntimes<Runtime extends WorkerPromptRuntime> {
  private readonly runtimes = new Map<number, Runtime>();

  constructor(private readonly createRuntime: () => Promise<Runtime>) {}

  /** Returns one healthy worker runtime, creating/replacing lazily. */
  async get(workerId: number): Promise<Runtime> {
    const current = this.runtimes.get(workerId);
    if (current?.healthy()) return current;
    if (current) {
      this.runtimes.delete(workerId);
      await current.close();
    }
    const runtime = await this.createRuntime();
    this.runtimes.set(workerId, runtime);
    return runtime;
  }

  /** Closes and removes one poisoned runtime after a failed SDK call. */
  async replaceIfPoisoned(workerId: number): Promise<void> {
    const runtime = this.runtimes.get(workerId);
    if (!runtime || runtime.healthy()) return;
    this.runtimes.delete(workerId);
    await runtime.close();
  }

  /** Closes every worker independently and returns all cleanup failures. */
  async closeAll(): Promise<unknown[]> {
    const entries = [...this.runtimes.entries()];
    this.runtimes.clear();
    const settled = await Promise.allSettled(
      entries.map(([, runtime]) => runtime.close()),
    );
    return settled.flatMap(result =>
      result.status === "rejected" ? [result.reason as unknown] : []
    );
  }

  /** Returns worker IDs that currently own runtimes. */
  workerIds(): number[] {
    return [...this.runtimes.keys()].sort((left, right) => left - right);
  }
}
