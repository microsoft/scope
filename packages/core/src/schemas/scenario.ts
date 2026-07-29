// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const PersonalitySchema = z.enum(["demanding", "friendly"]);
export const ExperienceSchema = z.enum(["junior", "senior"]);
export const VerbositySchema = z.enum(["brief", "moderate"]);
export const UserTypeSchema = z.enum(["traditional", "ai_assisted", "vibe"]);

export const PersonaSchema = z
  .object({
    personality: PersonalitySchema,
    experience: ExperienceSchema,
    verbosity: VerbositySchema,
    type: UserTypeSchema,
  })
  .openapi("Persona");

export const ScenarioSchema = z
  .object({
    version: z.enum(["v1", "v2"]).optional(),
    task: z.string(),
    criteria: z.array(z.string()),
  })
  .openapi("Scenario");
