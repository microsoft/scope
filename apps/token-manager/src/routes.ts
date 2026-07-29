// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Router } from "express";
import { Collection } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { KeyDocument, CreateKeyRequest, UpdateKeyRequest, AcquireKeyRequest, deriveSecretName } from "@scope/secrets";
import { KeyType, KeyCapability, AcquireKeyResponse } from "@scope/secrets";
import { SecretStore } from "./keyvault-store.js";
import { validateToken } from "./token-validators.js";
import { RoundRobinMap } from "./round-robin.js";

const VALID_TYPES: KeyType[] = [
  "github-pat-classic",
  "github-pat-fine-grained",
  "github-oauth",
  "github-oauth-cookie-state",
  "anthropic-api-key",
  "anthropic-oauth",
  "azure-ai-foundry",
];
const VALID_CAPABILITIES: KeyCapability[] = [
  "github-models",
  "github-public-api",
  "copilot-models",
  "copilot-sdk",
  "copilot-cli",
  "claude-code-cli",
  "anthropic-api",
  "azure-ai-inference",
];

export function createKeyRouter(
  collection: Collection<KeyDocument>,
  store: SecretStore
): Router {
  const router = Router();
  const roundRobin = new RoundRobinMap<KeyDocument>();

  // ──────────────────────────────────────────────
  // POST /api/v1/keys/preview — Validate without storing
  // ──────────────────────────────────────────────
  router.post("/api/v1/keys/preview", async (req, res, next) => {
    try {
      const { type, value } = req.body as { type: KeyType; value: string };

      if (!type || !VALID_TYPES.includes(type)) {
        res.status(400).json({
          error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
        });
        return;
      }
      if (!value || typeof value !== "string") {
        res.status(400).json({ error: "value is required" });
        return;
      }

      const result = await validateToken(type, value);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // POST /api/v1/keys — Register a new key
  // ──────────────────────────────────────────────
  router.post("/api/v1/keys", async (req, res, next) => {
    try {
      const body = req.body as CreateKeyRequest;

      // Validate required fields
      if (!body.type || !VALID_TYPES.includes(body.type)) {
        res.status(400).json({
          error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
        });
        return;
      }
      if (!body.value || typeof body.value !== "string") {
        res.status(400).json({ error: "value is required" });
        return;
      }

      const id = uuidv4();
      const secretName = deriveSecretName(body.type, id);

      // Store secret value
      await store.setSecret(secretName, body.value);

      // Create metadata document (capabilities set after validation)
      const doc: KeyDocument = {
        _id: id,
        type: body.type,
        capabilities: [],
        secretName,
        enabled: body.enabled !== false,
        lastValidationStatus: "unknown",
        acquireCount: 0,
        createdAt: new Date(),
      };

      if (body.expiresAt) {
        doc.expiresAt = new Date(body.expiresAt);
      }

      if (typeof body.comment === "string" && body.comment.trim()) {
        doc.comment = body.comment.trim().substring(0, 500);
      }

      await collection.insertOne(doc as any);

      // Fire-and-forget validation — portal polls until status !== "unknown"
      validateToken(body.type, body.value)
        .then(async (result) => {
          const now = new Date();
          await collection.updateOne(
            { _id: id },
            {
              $set: {
                lastValidatedAt: now,
                lastValidationStatus: result.status,
                lastValidationError: result.error ?? undefined,
                capabilities: result.capabilities ?? [],
                updatedAt: now,
              },
            }
          );
        })
        .catch((err) => {
          console.error(`[routes] Background validation failed for ${id}:`, err);
        });

      // Return metadata immediately (never the value)
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // GET /api/v1/keys — List all keys (metadata)
  // ──────────────────────────────────────────────
  router.get("/api/v1/keys", async (req, res, next) => {
    try {
      const filter: Record<string, unknown> = {
        deletedAt: { $exists: false },
      };

      if (req.query.capability) {
        filter.capabilities = { $in: [req.query.capability] };
      }

      const tokens = await collection.find(filter).toArray();
      tokens.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      res.json(tokens);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // GET /api/v1/keys/:id — Get one key (metadata)
  // ──────────────────────────────────────────────
  router.get("/api/v1/keys/:id", async (req, res, next) => {
    try {
      const token = await collection.findOne({
        _id: req.params.id,
        deletedAt: { $exists: false },
      });

      if (!token) {
        res.status(404).json({ error: "Key not found" });
        return;
      }

      res.json(token);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // PUT /api/v1/keys/:id — Update metadata only
  // ──────────────────────────────────────────────
  router.put("/api/v1/keys/:id", async (req, res, next) => {
    try {
      const body = req.body as UpdateKeyRequest;
      const update: Record<string, unknown> = { updatedAt: new Date() };

      if (typeof body.enabled === "boolean") {
        update.enabled = body.enabled;
      }

      if (body.expiresAt !== undefined) {
        update.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      }

      if (body.comment !== undefined) {
        update.comment = typeof body.comment === "string" && body.comment.trim()
          ? body.comment.trim().substring(0, 500)
          : null;
      }

      const result = await collection.findOneAndUpdate(
        { _id: req.params.id, deletedAt: { $exists: false } },
        { $set: update },
        { returnDocument: "after" }
      );

      if (!result) {
        res.status(404).json({ error: "Key not found" });
        return;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // DELETE /api/v1/keys/:id — Soft-delete
  // ──────────────────────────────────────────────
  router.delete("/api/v1/keys/:id", async (req, res, next) => {
    try {
      const result = await collection.findOneAndUpdate(
        { _id: req.params.id, deletedAt: { $exists: false } },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } },
        { returnDocument: "after" }
      );

      if (!result) {
        res.status(404).json({ error: "Key not found" });
        return;
      }

      // KeyVault secret stays — soft-delete is reversible
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // POST /api/v1/keys/:id/validate — On-demand validation
  // ──────────────────────────────────────────────
  router.post("/api/v1/keys/:id/validate", async (req, res, next) => {
    try {
      const token = await collection.findOne({
        _id: req.params.id,
        deletedAt: { $exists: false },
      });

      if (!token) {
        res.status(404).json({ error: "Key not found" });
        return;
      }

      const value = await store.getSecret(token.secretName);
      const result = await validateToken(token.type, value);

      const now = new Date();
      const update = {
        lastValidatedAt: now,
        lastValidationStatus: result.status,
        lastValidationError: result.error ?? undefined,
        capabilities: result.capabilities ?? [],
        updatedAt: now,
      };

      await collection.updateOne(
        { _id: token._id },
        { $set: update }
      );

      // Return full updated document so the UI can refresh immediately
      res.json({ ...token, ...update });
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────
  // POST /api/v1/keys/acquire — Round-robin key acquisition (internal)
  // ──────────────────────────────────────────────
  router.post("/api/v1/keys/acquire", async (req, res, next) => {
    try {
      const body = req.body as AcquireKeyRequest;

      if (!body.capability || !VALID_CAPABILITIES.includes(body.capability)) {
        res.status(400).json({
          error: `Invalid capability. Must be one of: ${VALID_CAPABILITIES.join(", ")}`,
        });
        return;
      }

      const tokens = await collection
        .find({
          capabilities: { $in: [body.capability] },
          enabled: true,
          lastValidationStatus: "valid",
          deletedAt: { $exists: false },
        })
        .toArray();

      if (tokens.length === 0) {
        res.status(404).json({
          error: `No valid keys available for capability '${body.capability}'`,
        });
        return;
      }

      // If a preferred keyType was requested, try those first
      let pool = tokens;
      if (body.keyType) {
        const preferred = tokens.filter((t) => t.type === body.keyType);
        if (preferred.length > 0) {
          pool = preferred;
        }
      }

      // Round-robin selection
      const selected = roundRobin.next(body.capability, pool);

      // Increment acquire count (fire-and-forget)
      collection
        .updateOne(
          { _id: selected._id },
          { $inc: { acquireCount: 1 }, $set: { lastAcquiredAt: new Date() } }
        )
        .catch((err) =>
          console.error(`[routes] Failed to update acquireCount for ${selected._id}:`, err)
        );

      // Read secret value
      const value = await store.getSecret(selected.secretName);

      const response: AcquireKeyResponse = {
        value,
        keyId: selected._id,
        keyType: selected.type,
        capability: body.capability,
        expiresAt: selected.expiresAt,
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
