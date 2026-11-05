// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { MongoClient, type Db, type Document } from "mongodb";
import { z } from "zod";
import { ProjectRoleSchema } from "shared";
import { AdminOperations, AccessError } from "./admin-operations.js";

export const LegacyMembershipManifest = z.object({
  database: z.string().min(1), reviewedBy: z.string().min(1), reviewedAt: z.string().datetime(),
  reason: z.string().min(1),
  entries: z.array(z.object({
    projectId: z.string().uuid(), userId: z.string().uuid(), role: ProjectRoleSchema,
    revision: z.number().int().nonnegative(), operationId: z.string().min(1),
  }).strict()),
}).strict().superRefine((manifest, ctx) => {
  const pairs = new Set<string>();
  const operations = new Set<string>();
  for (const entry of manifest.entries) {
    const pair = `${entry.projectId}:${entry.userId}`;
    if (pairs.has(pair) || operations.has(entry.operationId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate membership or operation ID" });
    pairs.add(pair); operations.add(entry.operationId);
  }
});

export async function mapLegacyMemberships(db: Db, manifest: z.infer<typeof LegacyMembershipManifest>, apply: boolean) {
  if (manifest.database !== db.databaseName) throw new AccessError(400, "database_mismatch", "Manifest database does not match the explicit target database");
  // Validate the entire mapping before the first possible grant.
  for (const entry of manifest.entries) {
    const project = await db.collection<Document & { _id: string }>("projects").findOne({ _id: entry.projectId, deletedAt: { $exists: false } }, { timeoutMS: 5_000 });
    const user = await db.collection<Document & { _id: string }>("users").findOne({ _id: entry.userId }, { timeoutMS: 5_000 });
    if (!project || !user) throw new AccessError(404, "not_found", "Manifest references a missing project or enrolled user");
  }
  if (!apply) return { dryRun: true, entries: manifest.entries.length };
  const operations = new AdminOperations(db);
  const results = [];
  for (const entry of manifest.entries) {
    const result = await operations.execute({
      _id: entry.operationId, actor: `reviewed-mapping:${manifest.reviewedBy}`,
      reason: `${manifest.reason}; reviewed ${manifest.reviewedAt}`,
      collection: "project_memberships", targetId: `${entry.projectId}:${entry.userId}`,
      expectedRevision: entry.revision, change: { role: entry.role }, unset: ["revokedAt"],
      initial: { projectId: entry.projectId, userId: entry.userId, createdByUserId: manifest.reviewedBy },
    });
    results.push(result);
    if (result.state !== "completed") break;
  }
  return { dryRun: false, results };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { manifest: { type: "string" }, database: { type: "string" }, apply: { type: "boolean" }, "confirm-reviewer": { type: "string" } } });
  if (!values.manifest || !values.database) throw new Error("--manifest and --database are required (default is dry-run)");
  const raw: unknown = JSON.parse(await readFile(values.manifest, "utf8"));
  const manifest = LegacyMembershipManifest.parse(raw);
  if (values.apply && values["confirm-reviewer"] !== manifest.reviewedBy) throw new Error("--apply requires --confirm-reviewer matching the administrator-reviewed manifest");
  const uri = process.env.AUTH_OPERATOR_MONGO_URI;
  if (!uri) throw new Error("AUTH_OPERATOR_MONGO_URI is required");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const result = await mapLegacyMemberships(client.db(values.database), manifest, Boolean(values.apply));
    console.log(JSON.stringify(result));
    if ("results" in result && result.results?.some(operation => operation.state !== "completed")) process.exitCode = 2;
  } finally { await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
