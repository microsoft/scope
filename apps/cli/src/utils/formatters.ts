// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Central formatting engine for CLI output.
 * Supports table, TSV, JSON, and YAML output formats.
 * Ported from ca-geo/packages/cli reference implementation, with JSON and YAML added.
 */

import Table from 'cli-table3';
import { stringify } from 'csv-stringify/sync';
import { stringify as yamlStringify } from 'yaml';
import type { TableColumn, ListItem, OutputFormat, DisplayField } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get value or return 'N/A' placeholder.
 */
export function getValueOrNA(value: any): string {
  if (value === null || value === undefined || value === '') return 'N/A';
  return String(value);
}

/**
 * Format a date string or Date object to a locale string.
 */
export function formatDate(date?: string | Date): string {
  if (!date) return 'N/A';
  try {
    return new Date(date).toLocaleString();
  } catch {
    return 'N/A';
  }
}

/**
 * Calculate the maximum width needed for a table column based on the data.
 *
 * @param data - Array of data objects
 * @param field - Field name to calculate width for
 * @param minWidth - Optional minimum width (defaults to data-driven width)
 * @param padding - Additional padding to add (default: 2)
 * @returns Maximum column width
 */
export function maxColumnWidth<T>(
  data: T[],
  field: keyof T | string,
  minWidth?: number,
  padding: number = 2,
): number {
  if (data.length === 0) return (minWidth ?? 10) + padding;
  const dataMaxLength = Math.max(
    ...data.map((item) => {
      const value = item[field as keyof T];
      return String(value || '').length;
    }),
  );
  const maxLength =
    minWidth !== undefined ? Math.max(dataMaxLength, minWidth) : dataMaxLength;
  return maxLength + padding;
}

// ── Format: Table ────────────────────────────────────────────────────────────

/**
 * Format items as a bordered table using cli-table3.
 */
export function formatAsTable<T extends ListItem>(
  items: T[],
  columns: TableColumn<T>[],
): string {
  const hasWidths = columns.some((col) => col.width !== undefined);
  const tableOptions: any = {
    head: columns.map((col) => col.header),
    truncate: '…',
    wordWrap: true,
  };

  if (hasWidths) {
    tableOptions.colWidths = columns.map((col) => col.width ?? null);
  }

  const table = new Table(tableOptions);

  for (const item of items) {
    const row = columns.map((col) => {
      // Prefer tableFormatter (styled) over formatter (plain) for table output
      if (col.tableFormatter) return col.tableFormatter(item);
      if (col.formatter) return col.formatter(item);
      return getValueOrNA(item[col.key]);
    });
    table.push(row);
  }

  return table.toString();
}

// ── Format: TSV ──────────────────────────────────────────────────────────────

/**
 * Format items as TSV (tab-separated values) without headers.
 * Clean output suitable for piping to cut, awk, grep, xargs, etc.
 */
export function formatAsTSV<T extends ListItem>(
  items: T[],
  fields: DisplayField<T>[],
): string {
  const rows = items.map((item) =>
    fields.map((field) => {
      if (field.formatter) return field.formatter(item);
      return getValueOrNA(item[field.key]);
    }),
  );

  const output = stringify(rows, {
    delimiter: '\t',
    header: false,
  });

  // Remove trailing newline for cleaner piping
  return output.trimEnd();
}

// ── Workspace snapshot sizes ─────────────────────────────────────────────────

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Format a byte count using binary (1024-based) units up to TB.
 *
 * @param bytes - Non-negative byte count.
 * @returns e.g. `"512 B"`, `"1.5 KB"`, `"2.3 GB"`.
 */
export function formatBytes(bytes: number): string {
  let size = bytes;
  let unitIndex = 0;

  // Step up a unit while the value is at least 1024 and a larger unit exists.
  while (size >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return unitIndex === 0 ? `${size} B` : `${size.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * Sum the recorded workspace snapshot sizes (`workspaceSizeBytes`) of a run's turns.
 * Legacy/imported turns have no recorded size and are counted as `missing`
 * rather than as zero bytes.
 *
 * @param turns - Turns of a single run attempt.
 * @returns `totalBytes` over the `measured` turns, plus the `missing` count.
 */
export function summarizeWorkspaceSizes(
  turns: ReadonlyArray<{ workspaceSizeBytes?: number }>,
): { totalBytes: number; measured: number; missing: number } {
  let totalBytes = 0;
  let measured = 0;

  for (const turn of turns) {
    if (typeof turn.workspaceSizeBytes === 'number') {
      totalBytes += turn.workspaceSizeBytes;
      measured++;
    }
  }

  return { totalBytes, measured, missing: turns.length - measured };
}

// ── Format: JSON ─────────────────────────────────────────────────────────────

/**
 * Format items as pretty-printed JSON.
 * Uses the display fields' formatters to transform values, keyed by field key.
 */
export function formatAsJSON<T extends ListItem>(
  items: T[],
  fields: DisplayField<T>[],
): string {
  const rows = items.map((item) => {
    const obj: Record<string, string> = {};
    for (const field of fields) {
      obj[field.key] = field.formatter
        ? field.formatter(item)
        : getValueOrNA(item[field.key]);
    }
    return obj;
  });
  return JSON.stringify(rows, null, 2);
}

// ── Format: YAML ─────────────────────────────────────────────────────────────

/**
 * Format items as YAML.
 * Uses the display fields' formatters to transform values, keyed by field key.
 */
export function formatAsYAML<T extends ListItem>(
  items: T[],
  fields: DisplayField<T>[],
): string {
  const rows = items.map((item) => {
    const obj: Record<string, string> = {};
    for (const field of fields) {
      obj[field.key] = field.formatter
        ? field.formatter(item)
        : getValueOrNA(item[field.key]);
    }
    return obj;
  });
  return yamlStringify(rows).trimEnd();
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Format data based on output format.
 * Routes to the appropriate formatter (table, tsv, json, or yaml).
 */
export function formatData<T extends ListItem>(
  items: T[],
  fields: DisplayField<T>[],
  format: OutputFormat,
): string {
  switch (format) {
    case 'table': {
      const columns: TableColumn<T>[] = fields.map((field) => ({
        key: field.key,
        header: field.label,
        width: field.width,
        formatter: field.formatter,
        tableFormatter: field.tableFormatter,
      }));
      return formatAsTable(items, columns);
    }
    case 'tsv':
      return formatAsTSV(items, fields);
    case 'json':
      return formatAsJSON(items, fields);
    case 'yaml':
      return formatAsYAML(items, fields);
    default:
      throw new Error(`Unsupported output format: ${format}`);
  }
}

/**
 * Check if the given format is machine-readable (tsv, json, or yaml).
 * Used to suppress decorative output (banners, styled headers) for piping.
 */
export function isMachineReadable(format: OutputFormat): boolean {
  return format === 'tsv' || format === 'json' || format === 'yaml';
}
