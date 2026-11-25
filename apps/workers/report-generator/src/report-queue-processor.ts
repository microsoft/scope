// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DequeuedMessageItem } from "@azure/storage-queue";
import { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  BaseQueueProcessor,
  BaseQueueProcessorConfig,
  LogEvent,
  ReportDocument,
  RequestDocument,
  ReportTemplateDocument,
  Reporter,
  TokenManagerClient,
  type VisibilityHeartbeat,
} from "shared";
import { trackMetric, trackEvent } from "telemetry";
import { createReportTools } from "./tools.js";
import { REPORT_SYSTEM_PROMPT, withRetry } from "shared";

export interface ReportQueueProcessorConfig extends BaseQueueProcessorConfig {
  /** The LLM model to use for report generation, e.g. "gpt-4.1" */
  reportModel: string;
  /** Base URL of the scope-mt API, e.g. "http://localhost:3001" */
  apiBaseUrl: string;
  /** Timeout in ms for the Copilot SDK session (default: 5 min) */
  sessionTimeoutMs?: number;
}

/**
 * How long a report job for an unfinished run is hidden before it is
 * re-checked (seconds). The report stays `pending` meanwhile.
 */
export const RUN_NOT_FINISHED_DEFER_SECONDS = 60;

/**
 * Whether a report can be generated for its run yet (issue #1287).
 *  - `ready`         — the run finished and has at least one turn to assess.
 *  - `waiting`       — the run is still pending/queued/processing/paused.
 *  - `non-evaluable` — the run finished without producing any turn, so there
 *                      is no implementation to score.
 */
export type RunReadiness =
  | { state: "ready" }
  | { state: "waiting"; runStatus: string }
  | { state: "non-evaluable"; reason: string };

/**
 * Classify a run for report generation from its request document.
 *
 * @param request - The run's request document as returned by the API.
 */
export function classifyRunReadiness(request: Pick<RequestDocument, "run">): RunReadiness {
  const run = request.run;
  const runStatus = run?.status ?? "pending";
  if (runStatus !== "done") {
    return { state: "waiting", runStatus };
  }

  if ((run?.turns?.length ?? 0) === 0) {
    const detail = run?.error ? `: ${run.error}` : "";
    return {
      state: "non-evaluable",
      reason: `Run finished (${run?.outcome ?? "unknown outcome"}) without any turns, so there is no implementation to assess${detail}`,
    };
  }

  return { state: "ready" };
}

export interface ResolvedReportPrompts {
  userPrompt: string;
  systemPrompt: string;
}

export function resolveReportPrompts(
  template: Pick<ReportTemplateDocument, "userPrompt" | "systemPrompt">,
  requestId: string,
): ResolvedReportPrompts {
  const userPrompt = template.userPrompt.replace(
    /\{\{requestId\}\}|\{requestId\}/g,
    requestId,
  );
  if (!template.systemPrompt) {
    return { userPrompt, systemPrompt: REPORT_SYSTEM_PROMPT };
  }
  if (template.systemPrompt.mode === "override") {
    return { userPrompt, systemPrompt: template.systemPrompt.content };
  }
  return {
    userPrompt,
    systemPrompt: `${REPORT_SYSTEM_PROMPT}\n\n${template.systemPrompt.content}`,
  };
}

/**
 * Queue processor for LLM-generated run reports.
 *
 * Extends BaseQueueProcessor<ReportDocument>. Picks up report jobs from the
 * queue, fetches run data via REST API tools, invokes the Copilot SDK to
 * generate a markdown report, and persists the result to MongoDB.
 */
export class ReportQueueProcessor extends BaseQueueProcessor<ReportDocument> {
  private reportConfig: ReportQueueProcessorConfig;
  private tokenClient: TokenManagerClient;
  private static coldStartTracked = false;

  constructor(config: ReportQueueProcessorConfig) {
    super(config, "report-generator");
    this.reportConfig = config;
    this.tokenClient = new TokenManagerClient();
  }

  /**
   * Report queue messages use `reportId` (not `requestId`).
   */
  protected override extractDocumentId(payload: Record<string, unknown>): string {
    return payload.reportId as string;
  }

  protected override async handleRequest(
    doc: ReportDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    const generationStart = Date.now();
    const reportId = doc._id;
    const requestId = doc.requestId;

    if (!ReportQueueProcessor.coldStartTracked) {
      ReportQueueProcessor.coldStartTracked = true;
      trackMetric({ name: "report_generator.cold_start_ms", value: process.uptime() * 1000, properties: { service: "report-generator" } });
    }

    trackEvent({ name: "report_generator.generation_started", properties: { requestId, reportId, templateId: doc.templateId || "unknown" } });
    await log("info", `Starting report generation for run ${requestId}`);

    // --- Prepare snapshots temp directory ---
    const snapshotsDir = join(tmpdir(), `report-${reportId}`);
    mkdirSync(snapshotsDir, { recursive: true });

    try {
      // --- Create Copilot SDK tools ---
      const tools = createReportTools(
        this.reportConfig.apiBaseUrl,
        requestId,
        snapshotsDir,
        reportId
      );

      await log("info", "Initialized tools, starting Copilot SDK session");

      // --- Resolve report template ---
      if (!doc.templateId) {
        throw new Error(`Report ${reportId} has no templateId — reports without a template are no longer supported`);
      }

      const template = await this.fetchReportTemplate(doc.templateId, doc.projectId);
      if (!template) {
        throw new Error(`Report template '${doc.templateId}' not found for report ${reportId}`);
      }

      await log("info", `Using report template '${template.id}' (${template.name})`);

      // --- Wait for an evaluable run ---
      // Generating before the run finishes yields a stale "0 turns / 0%"
      // report that later looks like the real result (issue #1287).
      const readiness = classifyRunReadiness(await this.fetchRun(requestId));
      if (readiness.state === "waiting") {
        await log(
          "info",
          `Waiting for run ${requestId} to finish (status: ${readiness.runStatus}); re-checking in ${RUN_NOT_FINISHED_DEFER_SECONDS}s`,
        );
        // Keep the report pending and hide the message until the next check.
        const popReceipt = heartbeat.stop();
        await this.safeDeferMessage(message.messageId, popReceipt, RUN_NOT_FINISHED_DEFER_SECONDS);
        return;
      }
      if (readiness.state === "non-evaluable") {
        await this.markNonEvaluable(reportId, readiness.reason, log);
        const popReceipt = heartbeat.stop();
        await this.safeDeleteMessage(message.messageId, popReceipt);
        return;
      }

      // Resolve model: template override → global config fallback
      const resolvedModel = template.model ?? this.reportConfig.reportModel;

      // --- Build reporter identity ---
      const reporter: Reporter = {
        id: "report-generator",
        name: "Report Generator",
        gitHash: process.env.GIT_COMMIT || "unknown",
        model: resolvedModel,
        agentId: "copilot-sdk",
        agentVersion: this.getAgentVersion(),
      };

      // Update status to "generating" and set reporter
      await withRetry(() => this.collection.updateOne(
        { _id: reportId } as any,
        {
          $set: {
            status: "generating",
            reporter,
            updatedAt: new Date(),
          },
        } as any
      ));

      await log("info", `Reporter: ${reporter.agentId}@${reporter.agentVersion}, model: ${reporter.model}`);

      const {
        userPrompt: resolvedUserPrompt,
        systemPrompt: resolvedSystemPrompt,
      } = resolveReportPrompts(template, requestId);

      // --- Run Copilot SDK session ---
      const resolvedTimeoutMs = template.timeoutMs ?? this.reportConfig.sessionTimeoutMs ?? 5 * 60 * 1000;
      const llmStart = Date.now();
      const content = await this.runCopilotSession(
        tools,
        resolvedUserPrompt,
        resolvedSystemPrompt,
        resolvedModel,
        resolvedTimeoutMs,
        log
      );
      trackMetric({ name: "report_generator.llm_session_duration_ms", value: Date.now() - llmStart, properties: { service: "report-generator" } });

      // --- Persist report content ---
      await withRetry(() => this.collection.updateOne(
        { _id: reportId } as any,
        {
          $set: {
            status: "completed",
            content,
            updatedAt: new Date(),
          },
        } as any
      ));

      await log("info", `Report completed (${content.length} chars)`, { final: true });
      trackMetric({ name: "report_generator.generation_duration_ms", value: Date.now() - generationStart, properties: { service: "report-generator" } });
      trackEvent({ name: "report_generator.generation_completed", properties: { requestId, reportId } });
    } finally {
      // Clean up extracted snapshot files
      if (existsSync(snapshotsDir)) {
        try {
          rmSync(snapshotsDir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[report-generator] Failed to clean up snapshots dir: ${err}`);
        }
      }
    }

    // Stop the heartbeat before deleting so the pop receipt is stable.
    // The base class also calls stop() in its finally block (idempotent).
    const finalPopReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, finalPopReceipt);
  }

  /** Char-count interval for emitting delta progress logs */
  private static readonly DELTA_LOG_INTERVAL = 2000;

  /**
   * Run a Copilot SDK session with the report tools and system prompt.
   * Streams response deltas and logs progress.  Forwards key
   * {@link SessionEvent} types to `log()` so the portal can display
   * real-time progress on the Logs tab.
   */
  private async runCopilotSession(
    tools: ReturnType<typeof createReportTools>,
    userPrompt: string,
    systemPrompt: string,
    model: string,
    timeoutMs: number,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<string> {
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    await log("info", "Acquired Copilot SDK token");

    const client = new CopilotClient({ gitHubToken: githubToken });
    let fullResponse = "";
    let lastLoggedCharCount = 0;

    // Track in-flight tool names so we can pair start/complete events
    const toolNames = new Map<string, string>();

    try {
      const session = await client.createSession({
        model,
        streaming: true,
        tools,
        systemMessage: { mode: "replace", content: systemPrompt },
      });

      // Forward session events to structured log
      session.on((event: SessionEvent) => {
        switch (event.type) {
          // --- Session lifecycle ---
          case "session.start":
            void log("info", "Copilot session started", {
              sessionId: event.data.sessionId,
              model: event.data.selectedModel,
            });
            break;

          case "session.error":
            void log("error", `Session error: ${event.data.message}`, {
              errorType: event.data.errorType,
            });
            break;

          case "session.info":
            void log("info", `Session: ${event.data.message}`);
            break;

          // --- Assistant turns ---
          case "assistant.turn_start":
            void log("info", "Assistant turn started", {
              turnId: event.data.turnId,
            });
            break;

          case "assistant.turn_end":
            void log("info", "Assistant turn ended", {
              turnId: event.data.turnId,
            });
            break;

          // --- Tool calls ---
          case "tool.execution_start":
            toolNames.set(event.data.toolCallId, event.data.toolName);
            void log("info", `Tool call: ${event.data.toolName}`, {
              toolCallId: event.data.toolCallId,
              arguments: event.data.arguments as Record<string, unknown> | undefined,
            });
            break;

          case "tool.execution_complete": {
            const name = toolNames.get(event.data.toolCallId) ?? "unknown";
            toolNames.delete(event.data.toolCallId);
            const status = event.data.success ? "success" : "failed";
            const extra: Record<string, unknown> = { toolCallId: event.data.toolCallId };
            if (event.data.error) {
              extra.error = event.data.error.message;
            }
            void log("info", `Tool result: ${name} (${status})`, extra);
            break;
          }

          // --- Streamed response ---
          case "assistant.message_delta":
            fullResponse += event.data.deltaContent;

            // Emit periodic progress logs (throttled by char count)
            if (fullResponse.length - lastLoggedCharCount >= ReportQueueProcessor.DELTA_LOG_INTERVAL) {
              lastLoggedCharCount = fullResponse.length;
              void log("info", `Generating report… (${fullResponse.length} chars so far)`);
            }
            break;
        }
      });

      const timeout = timeoutMs;

      await log("info", `Sending prompt to Copilot SDK, awaiting response (timeout: ${Math.round(timeout / 1000)}s)...`);
      await session.sendAndWait({ prompt: userPrompt }, timeout);
      await client.stop();

      if (!fullResponse.trim()) {
        throw new Error("Copilot SDK returned an empty response");
      }

      return fullResponse;
    } catch (error) {
      try { await client.stop(); } catch { /* ignore */ }
      throw error;
    }
  }

  /**
   * Read the @github/copilot-sdk version from its package.json.
   */
  private getAgentVersion(): string {
    try {
      const copilotPkgPath = require.resolve("@github/copilot-sdk/package.json");
      const pkg = JSON.parse(readFileSync(copilotPkgPath, "utf-8"));
      return pkg.version || "unknown";
    } catch {
      // ESM fallback: try relative path from node_modules
      try {
        const fallbackPath = join(
          process.cwd(),
          "node_modules",
          "@github",
          "copilot-sdk",
          "package.json"
        );
        const pkg = JSON.parse(readFileSync(fallbackPath, "utf-8"));
        return pkg.version || "unknown";
      } catch {
        return "unknown";
      }
    }
  }

  /**
   * Fetch the run a report is about.
   *
   * @throws When the API does not return the run (missing run, API outage);
   *   the base processor then records the failure.
   */
  private async fetchRun(requestId: string): Promise<Pick<RequestDocument, "run">> {
    const response = await fetch(`${this.reportConfig.apiBaseUrl}/api/v1/requests/${encodeURIComponent(requestId)}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch run ${requestId} for report readiness: ${response.status}`);
    }
    return await response.json() as Pick<RequestDocument, "run">;
  }

  /**
   * Fail a report whose run produced nothing to assess, with an explicit
   * reason instead of a misleading 0% implementation score.
   */
  private async markNonEvaluable(
    reportId: string,
    reason: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const error = `Non-evaluable run: ${reason}`;
    await withRetry(() => this.collection.updateOne(
      { _id: reportId } as any,
      { $set: { status: "failed", error, updatedAt: new Date() } } as any,
    ));
    await log("warn", error, { final: true });
    trackEvent({ name: "report_generator.run_non_evaluable", properties: { reportId } });
  }

  /**
   * Fetch a report template from the API by its slug ID, scoped to the report's
   * project. Report templates are project-scoped, so the slug `id` is only
   * unique within a project; the `?projectId=` query param is required for the
   * lookup to resolve (the API 4xxs a slug-only request). Returns null if the
   * template is not found or on error.
   */
  private async fetchReportTemplate(
    templateId: string,
    projectId: string
  ): Promise<ReportTemplateDocument | null> {
    try {
      const response = await fetch(
        `${this.reportConfig.apiBaseUrl}/api/v1/report-templates/${encodeURIComponent(templateId)}?projectId=${encodeURIComponent(projectId)}`
      );
      if (!response.ok) {
        console.warn(`[report-generator] Failed to fetch template '${templateId}' (project ${projectId}): ${response.status}`);
        return null;
      }
      return await response.json() as ReportTemplateDocument;
    } catch (error) {
      console.warn(`[report-generator] Error fetching template '${templateId}' (project ${projectId}): ${error}`);
      return null;
    }
  }
}
