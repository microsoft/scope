#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  QUALITY_FAMILIES,
  type DatasetCase,
  type QualityFamily,
} from "./harvest.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATASET_ROOT = resolve(PACKAGE_ROOT, "datasets");
const FAMILY_MINIMUMS: Record<QualityFamily, number> = {
  "criteria-authoring": 15,
  "parent-dependency-suggestion": 15,
  "child-dependency-suggestion": 15,
  "task-prompt-generation": 15,
  "task-prompt-variation": 15,
  "prompt-feature-authoring": 15,
  "prompt-feature-extraction": 25,
  "judge-instructions": 25,
  "developer-feedback": 25,
  "run-report": 25,
};

interface DatasetManifest {
  schemaVersion: number;
  datasetVersion: string;
  status: string;
  harvestedAt: string;
  source: {
    environment: string;
    project: { id: string; name: string };
    endpoints: string[];
    openapiSha256: string;
    codeRevision: string;
  };
  selection: {
    seed: string;
    algorithm: string;
    counts: Record<string, number>;
  };
  files: Array<{ path: string; sha256: string; rows: number; families: string[] }>;
}

interface EvaluationManifest {
  qualityFamilies?: Array<{ id?: string; variants?: string[] }>;
}

interface RubricManifest {
  families?: Record<string, {
    deterministic?: Array<{ check?: string; metric?: string }>;
    evaluators?: Array<string | { name?: string }>;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string, errors: string[]): asserts condition {
  if (!condition) errors.push(message);
}

function hasSecret(text: string): boolean {
  return [
    /\bBearer\s+(?!\[REDACTED_SECRET\])[A-Za-z0-9._~+/=-]+/i,
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /https?:\/\/[^"\s]*blob\.core\.windows\.net[^"\s]*/i,
    /[?&](?:sig|se|sp|sv|spr|srt|ss|token|key|code)=/i,
    /\/Users\/(?!\[REDACTED_USER\])[^/\s"]+/,
    /C:\\Users\\(?!\[REDACTED_USER\])[^\\\s"]+/i,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  ].some((pattern) => pattern.test(text));
}

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return hasSecret(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  if (isRecord(value)) return Object.values(value).some(containsSecret);
  return false;
}

function parseJsonLine(line: string, path: string, lineNumber: number, errors: string[]): DatasetCase | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) {
      errors.push(`${path}:${lineNumber}: row must be an object`);
      return undefined;
    }
    return value as unknown as DatasetCase;
  } catch (error) {
    errors.push(`${path}:${lineNumber}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

function validateFamilyContract(row: DatasetCase, prefix: string, errors: string[]): void {
  const input = row.input;
  const expected = row.expected;
  const stringField = (record: Record<string, unknown>, key: string): boolean =>
    typeof record[key] === "string" && (record[key] as string).length > 0;
  const arrayField = (record: Record<string, unknown>, key: string): boolean =>
    Array.isArray(record[key]);

  switch (row.family) {
    case "criteria-authoring":
    case "parent-dependency-suggestion":
    case "child-dependency-suggestion":
      assert(stringField(input, "behavior"), `${prefix}: input.behavior is required`, errors);
      assert(arrayField(input, "existingCriteria"), `${prefix}: input.existingCriteria must be an array`, errors);
      assert(arrayField(input, "gates"), `${prefix}: input.gates must be an array`, errors);
      if (row.family === "criteria-authoring") {
        assert(stringField(expected, "referencePrompt"), `${prefix}: expected.referencePrompt is required`, errors);
      } else {
        assert(
          arrayField(input, "candidates") && (input.candidates as unknown[]).length > 0,
          `${prefix}: input.candidates must be a non-empty array`,
          errors,
        );
        assert(arrayField(expected, "suggestions"), `${prefix}: expected.suggestions must be an array`, errors);
      }
      break;
    case "task-prompt-generation":
      assert(stringField(input, "description"), `${prefix}: input.description is required`, errors);
      assert(arrayField(input, "existingPrompts"), `${prefix}: input.existingPrompts must be an array`, errors);
      assert(stringField(expected, "referenceTaskPrompt"), `${prefix}: expected.referenceTaskPrompt is required`, errors);
      break;
    case "task-prompt-variation":
      assert(stringField(input, "existingPrompt"), `${prefix}: input.existingPrompt is required`, errors);
      assert(arrayField(input, "existingPrompts"), `${prefix}: input.existingPrompts must be an array`, errors);
      assert(stringField(expected, "referenceTaskPrompt"), `${prefix}: expected.referenceTaskPrompt is required`, errors);
      break;
    case "prompt-feature-authoring":
      assert(stringField(input, "behavior"), `${prefix}: input.behavior is required`, errors);
      assert(arrayField(input, "existingFeatures"), `${prefix}: input.existingFeatures must be an array`, errors);
      break;
    case "prompt-feature-extraction":
      assert(stringField(input, "taskText"), `${prefix}: input.taskText is required`, errors);
      assert(arrayField(input, "features"), `${prefix}: input.features must be an array`, errors);
      assert(arrayField(expected, "results"), `${prefix}: expected.results must be an array`, errors);
      break;
    case "judge-instructions":
      assert(arrayField(input, "criteria") && (input.criteria as unknown[]).length > 0, `${prefix}: input.criteria must be non-empty`, errors);
      assert(arrayField(input, "conversationHistory"), `${prefix}: input.conversationHistory must be an array`, errors);
      assert(arrayField(input, "iterationToolCalls"), `${prefix}: input.iterationToolCalls must be an array`, errors);
      assert(stringField(input, "currentAgentResponse"), `${prefix}: input.currentAgentResponse is required`, errors);
      assert(arrayField(expected, "results"), `${prefix}: expected.results must be an array`, errors);
      if (arrayField(input, "criteria") && arrayField(expected, "results")) {
        const criterionIds = new Set(
          (input.criteria as unknown[])
            .filter((criterion): criterion is Record<string, unknown> =>
              typeof criterion === "object" && criterion !== null && !Array.isArray(criterion))
            .map((criterion) => criterion.id)
            .filter((id): id is string => typeof id === "string"),
        );
        for (const result of expected.results as unknown[]) {
          if (!result || typeof result !== "object" || Array.isArray(result)) continue;
          const criterionId = (result as Record<string, unknown>).criterionId;
          assert(
            typeof criterionId === "string" && criterionIds.has(criterionId),
            `${prefix}: expected criterion '${String(criterionId)}' is missing from input.criteria`,
            errors,
          );
        }
      }
      break;
    case "developer-feedback":
      assert(arrayField(input, "criteria") && (input.criteria as unknown[]).length > 0, `${prefix}: input.criteria must be non-empty`, errors);
      assert(arrayField(input, "judgeResults") && (input.judgeResults as unknown[]).length > 0, `${prefix}: input.judgeResults must be non-empty`, errors);
      assert(typeof input.includeDescendantGuard === "boolean", `${prefix}: input.includeDescendantGuard must be boolean`, errors);
      break;
    case "run-report":
      assert(stringField(input, "requestId"), `${prefix}: input.requestId is required`, errors);
      assert(stringField(input, "reportId"), `${prefix}: input.reportId is required`, errors);
      assert(stringField(input, "userPrompt"), `${prefix}: input.userPrompt is required`, errors);
      if (row.variant === "append" || row.variant === "override-control") {
        assert(stringField(input, "systemPromptContent"), `${prefix}: input.systemPromptContent is required for ${row.variant}`, errors);
      }
      break;
  }
}

function validateCase(
  row: DatasetCase,
  path: string,
  lineNumber: number,
  allowedVariants: Map<string, Set<string>>,
  allowedEvaluators: Map<string, Set<string>>,
  errors: string[],
): void {
  const prefix = `${path}:${lineNumber}`;
  assert(row.schemaVersion === 1, `${prefix}: schemaVersion must be 1`, errors);
  assert(typeof row.id === "string" && /^[a-z0-9-]+-[a-f0-9]{16}$/.test(row.id), `${prefix}: invalid stable case id`, errors);
  assert((QUALITY_FAMILIES as readonly string[]).includes(row.family), `${prefix}: unknown family '${row.family}'`, errors);
  assert(typeof row.variant === "string" && row.variant.length > 0, `${prefix}: missing variant`, errors);
  const variants = allowedVariants.get(row.family);
  assert(Boolean(variants?.has(row.variant)), `${prefix}: variant '${row.variant}' is not declared for ${row.family}`, errors);
  assert(isRecord(row.input), `${prefix}: input must be an object`, errors);
  assert(isRecord(row.expected), `${prefix}: expected must be an object`, errors);
  assert(Array.isArray(row.evaluators) && row.evaluators.length > 0, `${prefix}: evaluators must be non-empty`, errors);
  const familyEvaluators = allowedEvaluators.get(row.family);
  for (const evaluator of row.evaluators ?? []) {
    assert(Boolean(familyEvaluators?.has(evaluator)), `${prefix}: evaluator '${evaluator}' is not configured for ${row.family}`, errors);
  }
  assert(Array.isArray(row.tags), `${prefix}: tags must be an array`, errors);
  assert(isRecord(row.provenance), `${prefix}: provenance must be an object`, errors);
  assert(
    row.provenance?.kind === "integration" || row.provenance?.kind === "synthetic-reviewed",
    `${prefix}: invalid provenance kind`,
    errors,
  );
  assert(
    Array.isArray(row.provenance?.sourceEndpoints),
    `${prefix}: provenance.sourceEndpoints must be an array`,
    errors,
  );
  if (row.provenance?.kind === "integration") {
    assert((row.provenance.sourceEndpoints?.length ?? 0) > 0, `${prefix}: integration case needs a source endpoint`, errors);
  } else {
    assert(Boolean(row.provenance?.note), `${prefix}: synthetic case needs a provenance note`, errors);
  }
  assert(Boolean(row.provenance?.projectId), `${prefix}: provenance.projectId is required`, errors);
  assert(
    Array.isArray(row.provenance?.sourceEntityIds) && row.provenance.sourceEntityIds.length > 0,
    `${prefix}: sourceEntityIds must be non-empty`,
    errors,
  );
  assert(/^[a-f0-9]{64}$/.test(row.provenance?.sourceHash ?? ""), `${prefix}: invalid sourceHash`, errors);
  assert(Boolean(row.provenance?.selectionSeed), `${prefix}: selectionSeed is required`, errors);
  assert(!Number.isNaN(Date.parse(row.provenance?.harvestedAt ?? "")), `${prefix}: harvestedAt must be ISO-like`, errors);
  assert(row.review?.status === "approved", `${prefix}: only approved cases may be committed`, errors);
  assert(Boolean(row.review?.method), `${prefix}: review.method is required`, errors);
  assert(!containsSecret(row), `${prefix}: possible secret, signed URL, email, or user path`, errors);
  validateFamilyContract(row, prefix, errors);
}

export async function validateDataset(
  datasetRoot = DEFAULT_DATASET_ROOT,
  minimums: Partial<Record<QualityFamily, number>> = FAMILY_MINIMUMS,
): Promise<{ cases: DatasetCase[]; counts: Record<string, number> }> {
  const errors: string[] = [];
  const manifestPath = resolve(datasetRoot, "manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as DatasetManifest;
  const evaluationManifest = YAML.parse(
    await readFile(resolve(PACKAGE_ROOT, "evaluation-manifest.yaml"), "utf8"),
  ) as EvaluationManifest;
  const rubricManifest = YAML.parse(
    await readFile(resolve(PACKAGE_ROOT, "evaluators/rubrics.yaml"), "utf8"),
  ) as RubricManifest;
  const allowedVariants = new Map(
    (evaluationManifest.qualityFamilies ?? []).map((family) => [
      family.id ?? "",
      new Set(family.variants ?? []),
    ]),
  );
  const allowedEvaluators = new Map(
    Object.entries(rubricManifest.families ?? {}).map(([family, config]) => [
      family,
      new Set([
        ...(config.deterministic ?? []).map((entry) => entry.metric ?? entry.check ?? ""),
        ...(config.evaluators ?? []).map((entry) => typeof entry === "string" ? entry : entry.name ?? ""),
      ].filter(Boolean)),
    ]),
  );

  assert(manifest.schemaVersion === 1, "manifest.schemaVersion must be 1", errors);
  assert(manifest.status === "approved", "manifest.status must be approved", errors);
  assert(Boolean(manifest.datasetVersion), "manifest.datasetVersion is required", errors);
  assert(Boolean(manifest.source?.project?.id), "manifest source project id is required", errors);
  assert(Boolean(manifest.selection?.seed), "manifest selection seed is required", errors);
  assert(/^[a-f0-9]{64}$/.test(manifest.source?.openapiSha256 ?? ""), "manifest OpenAPI hash is invalid", errors);

  const directoryFiles = (await readdir(resolve(datasetRoot, manifest.datasetVersion)))
    .filter((filename) => filename.endsWith(".jsonl"))
    .sort();
  const declaredFiles = manifest.files.map((entry) => entry.path.split("/").at(-1) ?? "").sort();
  assert(
    JSON.stringify(directoryFiles) === JSON.stringify(declaredFiles),
    `manifest files do not match ${manifest.datasetVersion} JSONL files`,
    errors,
  );

  const cases: DatasetCase[] = [];
  const ids = new Set<string>();
  const semanticKeys = new Set<string>();
  for (const file of manifest.files) {
    const path = resolve(datasetRoot, file.path);
    const content = await readFile(path, "utf8");
    assert(sha256(content) === file.sha256, `${file.path}: SHA-256 does not match manifest`, errors);
    const rows = content.split(/\r?\n/).filter(Boolean);
    assert(rows.length === file.rows, `${file.path}: expected ${file.rows} rows, found ${rows.length}`, errors);
    const fileFamilies = new Set<string>();
    rows.forEach((line, index) => {
      const row = parseJsonLine(line, file.path, index + 1, errors);
      if (!row) return;
      validateCase(row, file.path, index + 1, allowedVariants, allowedEvaluators, errors);
      assert(!ids.has(row.id), `${file.path}:${index + 1}: duplicate id ${row.id}`, errors);
      ids.add(row.id);
      const semanticKey = `${row.family}:${row.variant}:${JSON.stringify(row.input)}`;
      assert(!semanticKeys.has(semanticKey), `${file.path}:${index + 1}: duplicate family/variant/input`, errors);
      semanticKeys.add(semanticKey);
      fileFamilies.add(row.family);
      cases.push(row);
    });
    assert(
      JSON.stringify([...fileFamilies].sort()) === JSON.stringify([...file.families].sort()),
      `${file.path}: family list does not match rows`,
      errors,
    );
  }

  const counts = Object.fromEntries(
    QUALITY_FAMILIES.map((family) => [family, cases.filter((row) => row.family === family).length]),
  );
  for (const family of QUALITY_FAMILIES) {
    assert(allowedVariants.has(family), `evaluation manifest does not declare ${family}`, errors);
    assert(allowedEvaluators.has(family), `rubrics do not declare ${family}`, errors);
    assert(
      counts[family] === manifest.selection.counts[family],
      `${family}: manifest count ${manifest.selection.counts[family]} does not match ${counts[family]}`,
      errors,
    );
    assert(counts[family] >= (minimums[family] ?? 1), `${family}: ${counts[family]} cases is below minimum ${minimums[family] ?? 1}`, errors);
    const presentVariants = new Set(cases.filter((row) => row.family === family).map((row) => row.variant));
    for (const variant of allowedVariants.get(family) ?? []) {
      assert(presentVariants.has(variant), `${family}: missing declared variant '${variant}'`, errors);
    }
  }

  const integrationCases = cases.filter((row) => row.provenance.kind === "integration");
  assert(integrationCases.length > 0, "dataset must contain integration-derived cases", errors);
  const syntheticCases = cases.filter((row) => row.provenance.kind === "synthetic-reviewed");
  assert(
    syntheticCases.every((row) =>
      row.family === "judge-instructions"
      || (row.family === "run-report" && (row.variant === "default" || row.variant === "override-control"))
      || (row.family === "developer-feedback" && row.variant === "persona")),
    "synthetic cases are only permitted for unavailable judge evidence, feedback persona, and report override controls",
    errors,
  );
  const hasTag = (family: QualityFamily, tag: string): boolean =>
    cases.some((row) => row.family === family && row.tags.includes(tag));
  for (const family of ["parent-dependency-suggestion", "child-dependency-suggestion"] as const) {
    assert(hasTag(family, "positive"), `${family}: missing positive dependency case`, errors);
    assert(hasTag(family, "negative"), `${family}: missing negative dependency case`, errors);
  }
  assert(hasTag("prompt-feature-extraction", "positive"), "prompt-feature-extraction: missing positive-label case", errors);
  assert(hasTag("prompt-feature-extraction", "negative"), "prompt-feature-extraction: missing negative-label case", errors);
  assert(hasTag("prompt-feature-extraction", "no-existing-features"), "prompt-feature-extraction: missing no-existing-feature case", errors);
  assert(hasTag("judge-instructions", "passed"), "judge-instructions: missing passing evidence case", errors);
  assert(hasTag("judge-instructions", "failed"), "judge-instructions: missing failing evidence case", errors);
  assert(hasTag("judge-instructions", "tool-evidence"), "judge-instructions: missing tool-history evidence case", errors);
  assert(hasTag("judge-instructions", "filesystem-evidence"), "judge-instructions: missing filesystem evidence case", errors);
  assert(hasTag("developer-feedback", "multi-turn"), "developer-feedback: missing multi-turn case", errors);
  const reportTemplateTags = new Set(
    cases
      .filter((row) => row.family === "run-report" && row.provenance.kind === "integration")
      .flatMap((row) => row.tags)
      .filter((tag) => !["succeeded", "failed", "finished", "pending", "done"].includes(tag)),
  );
  assert(reportTemplateTags.size >= 3, `run-report: expected three integration template categories, found ${reportTemplateTags.size}`, errors);

  if (errors.length > 0) {
    throw new Error(`Dataset validation failed:\n- ${errors.join("\n- ")}`);
  }
  return { cases, counts };
}

function parseDatasetRoot(argv: string[]): string {
  const index = argv.indexOf("--dataset-root");
  if (index < 0) return DEFAULT_DATASET_ROOT;
  const value = argv[index + 1];
  if (!value) throw new Error("--dataset-root requires a path");
  return resolve(value);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  validateDataset(parseDatasetRoot(process.argv.slice(2)))
    .then(({ cases, counts }) => {
      console.log(`Validated ${cases.length} approved dataset cases`);
      for (const family of QUALITY_FAMILIES) console.log(`  ${family}: ${counts[family]}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
