// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdir, open, readFile, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const headerSchema = z.object({ type: z.literal("budget"), cap: z.number().int().positive().max(500) }).strict();
const eventSchema = z.discriminatedUnion(
  "type",
  [
    headerSchema,
    z.object({
      type: z.literal("reserved"),
      id: z.number().int().positive(),
      model: z.string(),
      purpose: z.string(),
      at: z.string()
    }).strict(),
    z.object({
      type: z.literal("finished"),
      id: z.number().int().positive(),
      ok: z.boolean(),
      latency_ms: z.number(),
      usage: z.record(z.unknown()).nullable(),
      model_attempts: z.number().int().nonnegative().nullable(),
    }).strict(),
  ]
);

/**
 * One append-only budget event.
 *
 * Budget events declare the immutable cap; reservations charge a call before
 * submission; finished events record outcome, latency in milliseconds, SDK
 * usage when exposed, and observed model-attempt count.
 */
export type LedgerEvent = z.infer<typeof eventSchema>;

/** Durable reservations are never refunded, including crashes and failed calls. */
export class CallLedger {
  /** Absolute path of the shared JSONL ledger. */
  readonly path: string;

  /**
   * @param path - Ledger path shared by every process/command in one experiment.
   */
  constructor(path: string) {
    this.path = resolve(path);
  }

  /**
   * Serializes one read-modify-write operation across processes with a fail-closed lock.
   *
   * @param work - Operation that exclusively owns the ledger lock.
   */
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;

    // Directory creation arbitrates across processes; a stale lock fails closed.
    await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") {
        throw new Error("Call ledger is locked; concurrent calls or a crashed owner require explicit reconciliation");
      }
      throw error;
    });

    try {
      return await work();
    } finally {
      await rmdir(lock);
    }
  }

  /**
   * Appends and fsyncs one validated event before control returns to the caller.
   *
   * @param event - Validated budget/reservation/completion event.
   */
  private async append(event: LedgerEvent): Promise<void> {
    const file = await open(this.path, "a", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(event)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  /**
   * Creates a ledger once or verifies the existing cap; never resets usage.
   *
   * @param cap - Positive maximum request count, default and hard maximum 500.
   */
  async initialize(cap = 500): Promise<void> {
    headerSchema.parse({ type: "budget", cap });

    await this.locked(async () => {
      try {
        const file = await open(this.path, "wx", 0o600);
        try {
          await file.writeFile(`${JSON.stringify({ type: "budget", cap })}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }

        const events = await this.events();
        if (events[0]?.type !== "budget" || events[0].cap !== cap) {
          throw new Error("Existing ledger budget cannot be reset or changed");
        }
      }
    });
  }

  /**
   * Parses the complete append-only log and verifies its header and reservation sequence.
   *
   * @returns Validated events in durable file order.
   */
  async events(): Promise<LedgerEvent[]> {
    const text = await readFile(this.path, "utf8");
    const events = text.trim().split("\n").map(line => eventSchema.parse(JSON.parse(line) as unknown));

    // The first event fixes the cap; reservations then form a gap-free monotonic sequence.
    if (events[0]?.type !== "budget" || events.slice(1).some(event => event.type === "budget")) {
      throw new Error("Invalid cumulative ledger header");
    }

    const reservationIds = events.filter(event => event.type === "reserved").map(event => event.id);
    if (reservationIds.some((id, index) => id !== index + 1)) {
      throw new Error("Invalid cumulative ledger sequence");
    }

    return events;
  }

  /**
   * Flushes one reservation before returning; exhausted budgets throw before submission.
   *
   * @param model - Exact configured model ID for this request.
   * @param purpose - Stable experiment phase label such as `eval` or `optimize:teacher`.
   * @returns Monotonic 1-based reservation ID.
   */
  async reserve(model: string, purpose: string): Promise<number> {
    return this.locked(async () => {
      const events = await this.events();
      const header = headerSchema.parse(events[0]);
      const used = events.filter(event => event.type === "reserved").length;
      if (used >= header.cap) {
        throw new Error(`Live-call budget exhausted (${used}/${header.cap}); no SDK call made`);
      }

      const id = used + 1;
      await this.append({ type: "reserved", id, model, purpose, at: new Date().toISOString() });
      return id;
    });
  }

  /**
   * Completes a reservation exactly once; unknown SDK usage/attempt counts remain null.
   *
   * @param id - Existing unfinished reservation ID.
   * @param ok - Whether the SDK operation completed successfully.
   * @param latency_ms - Wall-clock operation duration in milliseconds.
   * @param usage - SDK usage payload, or null when unavailable.
   * @param model_attempts - Observed model-attempt events, or null when unavailable.
   */
  async finish(
    id: number,
    ok: boolean,
    latency_ms: number,
    usage: Record<string, unknown> | null,
    model_attempts: number | null,
  ): Promise<void> {
    await this.locked(async () => {
      const events = await this.events();
      if (
        !events.some(event => event.type === "reserved" && event.id === id) ||
        events.some(event => event.type === "finished" && event.id === id)
      ) {
        throw new Error("Ledger completion must reference one unfinished reservation");
      }

      await this.append(eventSchema.parse({ type: "finished", id, ok, latency_ms, usage, model_attempts }));
    });
  }

  /**
   * Reports durable usage from reservations; unfinished and failed calls remain used.
   *
   * @returns Cap, used/remaining request counts, and all validated events.
   */
  async summary() {
    const events = await this.events();
    const header = headerSchema.parse(events[0]);
    const used = events.filter(event => event.type === "reserved").length;
    return { cap: header.cap, used, remaining: header.cap - used, events };
  }
}
