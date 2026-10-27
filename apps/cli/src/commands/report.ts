// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { configureHelp } from "../utils/helpFormatter.js";
import { banner, colorLevel, dimTimestamp, errorText, successText, label, value, warnBanner } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { OutputFormat, DisplayField } from "../utils/types.js";
import { withOutputOption, withProjectOption, getCliName, getDefaultApiUrl } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch, apiEventSource } from "../utils/api-client.js";

export function registerReportCommands(program: Command): void {
// ─── Report management ──────────────────────────────────────────────────────

const report = program
  .command("report")
  .description("Generate, view, and monitor run reports")
  .action(() => {
    report.help();
  });

configureHelp(report);

report
  .command("generate")
  .description("Generate a report for a benchmark run")
  .requiredOption("-i, --id <requestId>", "Run ID to generate a report for")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--stream", "Stream report generation logs in real time", true)
  .option("--no-stream", "Do not stream logs after submission")
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: options.id }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const result = await response.json() as { id: string; requestId: string; status: string };
      console.log(`${successText("Report queued")} ${dimTimestamp(`(${result.id})`)}`);
      console.log(`${label('Report ID:')} ${value(result.id)}`);
      console.log(`${label('Run ID:')}    ${value(result.requestId)}`);

      if (options.stream) {
        console.log(`\n${label('Streaming logs...')}\n`);
        const eventSource = await apiEventSource(options.url, `/reports/${result.id}/logs?fromStart=true`);

        eventSource.onmessage = (event: MessageEvent) => {
          try {
            const log = JSON.parse(event.data) as {
              timestamp: string;
              level: string;
              source?: string;
              message: string;
            };
            const ts = dimTimestamp(new Date(log.timestamp).toLocaleTimeString());
            const lvl = colorLevel(log.level);
            const src = log.source ? ` ${dimTimestamp(`[${log.source}]`)}` : "";
            console.log(`${ts} ${lvl}${src} ${log.message}`);
          } catch {
            console.log(event.data);
          }
        };

        eventSource.addEventListener("done", () => {
          console.log(`\n${successText("Report generation complete")}`);
          console.log(`\n${label('Next steps:')}`);
          console.log(`  ${dimTimestamp('View report:')} ${getCliName()} report get -i ${result.id}`);
          eventSource.close();
          process.exit(0);
        });

        eventSource.addEventListener("timeout", () => {
          console.log(`\n${warnBanner("Stream timed out")}`);
          eventSource.close();
          process.exit(0);
        });

        eventSource.onerror = () => {
          eventSource.close();
          process.exit(1);
        };
      } else {
        console.log(`\n${label('Next steps:')}`);
        console.log(`  ${dimTimestamp('Stream logs:')}  ${getCliName()} report logs -i ${result.id}`);
        console.log(`  ${dimTimestamp('View report:')} ${getCliName()} report get -i ${result.id}`);
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
report
  .command("get")
  .description("Get a report by ID")
  .requiredOption("-i, --id <reportId>", "Report ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
, ['markdown'])
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/reports/${options.id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const report = await response.json() as {
        id: string;
        requestId: string;
        status: string;
        reporter?: { id: string; name: string; model: string; agentId: string; agentVersion: string };
        content?: string;
        createdAt: string;
        updatedAt?: string;
        error?: string;
      };

      if (format === 'markdown') {
        console.log(report.content ?? '');
        return;
      }

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'requestId', label: 'Run' },
          { key: 'status', label: 'Status' },
          { key: 'reporter', label: 'Reporter', formatter: (r: any) => r.reporter ? `${r.reporter.name} (${r.reporter.agentId}@${r.reporter.agentVersion})` : '' },
          { key: 'model', label: 'Model', formatter: (r: any) => r.reporter?.model || '' },
          { key: 'content', label: 'Content', formatter: (r: any) => r.content || '' },
          { key: 'error', label: 'Error', formatter: (r: any) => r.error || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([report], fields, format));
        return;
      }

      console.log(`${label('Report:')}    ${value(report.id)}`);
      console.log(`${label('Run:')}       ${value(report.requestId)}`);
      console.log(`${label('Status:')}    ${colorLevel(report.status === "completed" ? "info" : report.status === "failed" ? "error" : "warn")} ${report.status}`);
      console.log(`${label('Created:')}   ${dimTimestamp(new Date(report.createdAt).toLocaleString())}`);
      if (report.updatedAt) {
        console.log(`${label('Updated:')}   ${dimTimestamp(new Date(report.updatedAt).toLocaleString())}`);
      }
      if (report.reporter) {
        console.log(`${label('Reporter:')}  ${value(report.reporter.name)} (${report.reporter.agentId}@${report.reporter.agentVersion})`);
        console.log(`${label('Model:')}     ${value(report.reporter.model)}`);
      }
      if (report.error) {
        console.log(`${label('Error:')}     ${errorText(report.error)}`);
      }
      if (report.content) {
        console.log(`\n${banner('─── Report Content ───')}\n`);
        console.log(report.content);
      } else if (report.status === "pending" || report.status === "generating") {
        console.log(`\n${dimTimestamp('Report is still being generated. Stream logs with:')}`);
        console.log(`  ${getCliName()} report logs -i ${report.id}`);
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
report
  .command("list")
  .description("List all reports (optionally filter by run)")
  .option("-r, --run <requestId>", "Filter by run ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const params = new URLSearchParams();
      if (options.run) params.set("requestId", options.run);
      const qs = params.toString();
      const response = await apiFetch(options.url, `/reports${qs ? `?${qs}` : ""}`, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const reports = await response.json() as Array<{
        id: string;
        requestId: string;
        status: string;
        reporter?: { model: string };
        createdAt: string;
      }>;

      if (reports.length === 0) {
        if (!isMachineReadable(format)) console.log(dimTimestamp("No reports found"));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(`${label(`Reports (${reports.length}):`)}\n`);
      }

      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID',
          tableFormatter: (r: any) => value(r.id),
        },
        { key: 'requestId', label: 'Run ID',
          tableFormatter: (r: any) => dimTimestamp(r.requestId),
        },
        { key: 'status', label: 'Status',
          tableFormatter: (r: any) => {
            return r.status === 'completed' ? successText('✓ ' + r.status)
              : r.status === 'failed' ? errorText('✗ ' + r.status)
              : dimTimestamp('… ' + r.status);
          },
        },
        { key: 'model', label: 'Model', formatter: (r: any) => r.reporter?.model ?? 'N/A',
          tableFormatter: (r: any) => r.reporter?.model ? dimTimestamp(r.reporter.model) : 'N/A',
        },
        { key: 'createdAt', label: 'Created', formatter: (r: any) => new Date(r.createdAt).toLocaleString(),
          tableFormatter: (r: any) => dimTimestamp(new Date(r.createdAt).toLocaleString()),
        },
      ];

      console.log(formatData(reports, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

report
  .command("logs")
  .description("Stream report generation logs")
  .requiredOption("-i, --id <reportId>", "Report ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--from-start", "Include historical logs from the beginning", false)
  .action(async (options) => {
    try {
      // Verify report exists first
      const checkResponse = await apiFetch(options.url, `/reports/${options.id}`);
      if (!checkResponse.ok) {
        const error = await checkResponse.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const fromStartParam = options.fromStart ? "?fromStart=true" : "";
      const eventSource = await apiEventSource(options.url, `/reports/${options.id}/logs${fromStartParam}`);

      eventSource.onmessage = (event: MessageEvent) => {
        try {
          const log = JSON.parse(event.data) as {
            timestamp: string;
            level: string;
            source?: string;
            message: string;
          };
          const ts = dimTimestamp(new Date(log.timestamp).toLocaleTimeString());
          const lvl = colorLevel(log.level);
          const src = log.source ? ` ${dimTimestamp(`[${log.source}]`)}` : "";
          console.log(`${ts} ${lvl}${src} ${log.message}`);
        } catch {
          console.log(event.data);
        }
      };

      eventSource.addEventListener("done", () => {
        console.log(`\n${successText("Report generation complete")}`);
        eventSource.close();
        process.exit(0);
      });

      eventSource.addEventListener("timeout", () => {
        console.log(`\n${warnBanner("Stream timed out")}`);
        eventSource.close();
        process.exit(0);
      });

      eventSource.onerror = () => {
        eventSource.close();
        process.exit(1);
      };
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

}
