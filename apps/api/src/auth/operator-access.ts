// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { MongoClient, type Db, type Document } from "mongodb";
import { z } from "zod";
import { AdminOperations, AccessError, adminIntentFingerprint, type AdminIntent } from "./admin-operations.js";

const operatorInput = z.object({
  database: z.string().min(1), confirmDatabase: z.string().min(1),
  operator: z.string().trim().min(1), reason: z.string().trim().min(1),
  operationId: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/).optional(),
  apply: z.boolean().default(false),
});

export const OperatorAccessInput = operatorInput.extend({
  idp: z.literal("entra"), tenant: z.string().min(1), subject: z.string().min(1),
  userId: z.string().uuid(), revision: z.coerce.number().int().nonnegative().optional(),
  role: z.enum(["admin", "user"]), disabled: z.enum(["true", "false"]),
  bootstrap: z.boolean().default(false),
}).strict().superRefine((input, ctx) => {
  if (input.apply && (input.revision === undefined || !input.operationId)) {
    ctx.addIssue({ code: "custom", message: "--apply requires --revision and --operation-id" });
  }
  if (input.bootstrap && (input.role !== "admin" || input.disabled !== "false")) {
    ctx.addIssue({ code: "custom", message: "Bootstrap can only promote an enabled account" });
  }
});

export const OperatorOperationInput = operatorInput.extend({
  operationId: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),
}).strict();

function confirmDatabase(db: Db, input: z.infer<typeof operatorInput>): void {
  if (db.databaseName !== input.database || input.database !== input.confirmDatabase) {
    throw new AccessError(400, "database_mismatch", "Explicit database confirmation does not match");
  }
}

export async function operatorAccess(db: Db, rawInput: unknown) {
  const input = OperatorAccessInput.parse(rawInput);
  confirmDatabase(db, input);
  const user = await db.collection<Document & { _id: string }>("users").findOne({
    _id: input.userId, idp: input.idp, idpTenant: input.tenant, idpSubject: input.subject,
  }, { timeoutMS: 5_000 });
  if (!user) throw new AccessError(404, "identity_mismatch", "Exact existing identity and Scope UUID not found");
  const currentRevision = z.number().int().nonnegative().parse(user.revision ?? 0);
  const currentRole = z.enum(["admin", "user"]).parse(user.role);
  if (input.bootstrap && user.disabledAt) throw new AccessError(409, "user_disabled", "Bootstrap cannot enable a disabled account; use an explicitly reviewed set-user-access change");
  const operations = new AdminOperations(db);
  const prior = input.operationId ? await operations.inspect(input.operationId) : null;
  const intent: AdminIntent = {
    _id: input.operationId ?? "dry-run", actor: `operator:${input.operator}`, reason: input.reason,
    collection: "users", targetId: user._id, expectedRevision: input.revision ?? currentRevision,
    condition: { idp: input.idp, idpTenant: input.tenant, idpSubject: input.subject,
      ...(input.bootstrap ? { role: "user", disabledAt: { $exists: false } } : {}) },
    change: { role: input.role, ...(input.disabled === "true" ? { disabledAt: "$operationTime" } : {}) },
    unset: input.disabled === "false" ? ["disabledAt"] : [],
    backup: prior?.backup ?? user,
  };
  if (prior && prior.fingerprint !== adminIntentFingerprint(intent)) {
    throw new AccessError(409, "idempotency_conflict", "Operation ID was already used for different input");
  }
  if (prior?.state === "conflict" || (!prior && input.revision !== undefined && input.revision !== currentRevision)) {
    throw new AccessError(409, "revision_conflict", "Target revision or preconditions changed");
  }
  if (!prior && !await operations.isComplete(user.lastOperationId)) {
    throw new AccessError(409, "operation_pending", `Ask an operator to repair operation ${String(user.lastOperationId)} before another change`);
  }
  const summary = {
    userId: user._id, currentRevision, currentRole, currentlyDisabled: Boolean(user.disabledAt),
    requestedRole: input.role, requestedDisabled: input.disabled === "true",
  };
  if (!input.apply) return { state: "dry-run" as const, ...summary };
  if (!prior && input.bootstrap && currentRole === "admin") {
    return { state: "unchanged" as const, ...summary };
  }
  return operations.execute(intent);
}

export async function operatorOperation(db: Db, rawInput: unknown) {
  const input = OperatorOperationInput.parse(rawInput);
  confirmDatabase(db, input);
  const operations = new AdminOperations(db);
  const operation = await operations.inspect(input.operationId);
  if (!operation) throw new AccessError(404, "not_found", "Operation not found");
  if (!input.apply) return {
    state: "inspection" as const, operationId: operation._id, operationState: operation.state,
    collection: operation.collection, targetId: operation.targetId, expectedRevision: operation.expectedRevision,
  };
  const result = await operations.reconcile(input.operationId);
  console.error(JSON.stringify({
    event: "operator-operation-repair", operator: input.operator, reason: input.reason,
    database: input.database, operationId: input.operationId, state: result.state,
  }));
  return result;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    database: { type: "string" }, "confirm-database": { type: "string" }, idp: { type: "string" },
    tenant: { type: "string" }, subject: { type: "string" }, "user-id": { type: "string" },
    revision: { type: "string" }, role: { type: "string" }, disabled: { type: "string" },
    operator: { type: "string" }, reason: { type: "string" }, "operation-id": { type: "string" },
    apply: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  const [command] = positionals;
  if (values.help) {
    console.log("Usage: operator-access.js <bootstrap-admin|set-user-access|inspect-operation|repair-operation>\n" +
      "All commands: --database DB --confirm-database DB --operator NAME --reason TEXT\n" +
      "User commands: --idp entra --tenant TID --subject OID --user-id UUID\n" +
      "set-user-access additionally requires --role admin|user --disabled true|false\n" +
      "Inspection/repair: --operation-id ID\n" +
      "Mutations default to dry run. Apply with --apply --operation-id ID; user changes also require --revision N.\n" +
      "Use AUTH_OPERATOR_MONGO_URI from secure operator configuration. No authentication bypass or new account creation.");
    return;
  }
  if (positionals.length !== 1 || !["bootstrap-admin", "set-user-access", "inspect-operation", "repair-operation"].includes(command)) {
    throw new Error("Choose bootstrap-admin, set-user-access, inspect-operation or repair-operation; use --help");
  }
  if (values.apply && values["dry-run"]) throw new Error("--apply and --dry-run are mutually exclusive");
  if (command === "inspect-operation" && values.apply) throw new Error("Inspection cannot apply changes; use repair-operation");
  const common = {
    database: values.database, confirmDatabase: values["confirm-database"],
    operator: values.operator, reason: values.reason, operationId: values["operation-id"], apply: values.apply ?? false,
  };
  const operationCommand = command === "inspect-operation" || command === "repair-operation";
  if (operationCommand && [values.idp, values.tenant, values.subject, values["user-id"], values.revision, values.role, values.disabled].some(value => value !== undefined)) {
    throw new Error("Operation commands use the recorded intent; user-target flags are not accepted");
  }
  if (command === "bootstrap-admin" && (values.role !== undefined || values.disabled !== undefined)) {
    throw new Error("Bootstrap does not accept role/disabled overrides; use set-user-access");
  }
  const input = operationCommand ? OperatorOperationInput.parse(common) : OperatorAccessInput.parse({
    ...common, idp: values.idp, tenant: values.tenant, subject: values.subject,
    userId: values["user-id"], revision: values.revision,
    role: command === "bootstrap-admin" ? "admin" : values.role,
    disabled: command === "bootstrap-admin" ? "false" : values.disabled, bootstrap: command === "bootstrap-admin",
  });
  const uri = process.env.AUTH_OPERATOR_MONGO_URI;
  if (!uri) throw new Error("AUTH_OPERATOR_MONGO_URI is required; use authenticated operator credentials outside local emulation");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const result = operationCommand
      ? await operatorOperation(client.db(input.database), input)
      : await operatorAccess(client.db(input.database), input);
    console.log(JSON.stringify(result));
    if (result.state === "pending") process.exitCode = 2;
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
