// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { PORTAL_AI_PROVIDERS } from "../token-manager/types.js";

extendZodWithOpenApi(z);

export const PortalAiSettingsSchema = z.object({
  provider: z.enum(PORTAL_AI_PROVIDERS).openapi({
    description: "Portal authoring provider. auto preserves the legacy Foundry → GitHub Models chain.",
  }),
  keyId: z.string().min(1).regex(/\S/, "Key ID must not be blank").optional().openapi({
    description: "Optional registered credential ID; otherwise round-robin within the selected provider.",
  }),
  model: z.string().min(1).regex(/\S/, "Model must not be blank").optional().openapi({
    description: "Optional Portal authoring model override.",
  }),
}).openapi("PortalAiSettings");

export const UpdatePortalAiSettingsSchema = PortalAiSettingsSchema.superRefine((settings, ctx) => {
  if (settings.provider === "auto" && (settings.keyId !== undefined || settings.model !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Automatic selection does not accept keyId or model overrides",
      path: ["provider"],
    });
  }
}).openapi("UpdatePortalAiSettings", {
  description: "Replaces the Portal-only provider selection. Use {\"provider\":\"auto\"} without keyId/model to restore legacy defaults.",
});

export const KeyInputSchema = z
  .object({})
  .passthrough()
  .openapi("KeyInput");

export const KeyResponseSchema = z
  .object({})
  .passthrough()
  .openapi("KeyResponse");

export const ValidateKeyInputSchema = z
  .object({
    token: z.string(),
  })
  .openapi("ValidateKeyInput");
