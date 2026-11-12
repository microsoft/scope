// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { dirname, join } from "path";

// --- Types (local to CLI, no dependency on shared) ---

type Personality = "demanding" | "friendly";
type Experience = "junior" | "senior";
type Verbosity = "brief" | "moderate";
type UserType = "traditional" | "ai_assisted" | "vibe";

interface Persona {
  personality: Personality;
  experience: Experience;
  verbosity: Verbosity;
  type: UserType;
}

interface Scenario {
  task: string;
  criteria: string[];
}

interface TraitDescriptions {
  personality: Record<Personality, string>;
  experience: Record<Experience, string>;
  verbosity: Record<Verbosity, string>;
  type: Record<UserType, string>;
}

// --- Loaders ---

function loadPersona(filePath: string): Persona {
  const raw = readFileSync(filePath, "utf-8");
  const data = parseYaml(raw);

  if (!data || typeof data !== "object") {
    throw new Error(`Persona file ${filePath} must contain a YAML object`);
  }

  const validPersonality: Personality[] = ["demanding", "friendly"];
  const validExperience: Experience[] = ["junior", "senior"];
  const validVerbosity: Verbosity[] = ["brief", "moderate"];
  const validType: UserType[] = ["traditional", "ai_assisted", "vibe"];

  if (!validPersonality.includes(data.personality)) {
    throw new Error(
      `Invalid personality "${data.personality}" in ${filePath}. Valid: ${validPersonality.join(", ")}`
    );
  }
  if (!validExperience.includes(data.experience)) {
    throw new Error(
      `Invalid experience "${data.experience}" in ${filePath}. Valid: ${validExperience.join(", ")}`
    );
  }
  if (!validVerbosity.includes(data.verbosity)) {
    throw new Error(
      `Invalid verbosity "${data.verbosity}" in ${filePath}. Valid: ${validVerbosity.join(", ")}`
    );
  }
  if (!validType.includes(data.type)) {
    throw new Error(
      `Invalid type "${data.type}" in ${filePath}. Valid: ${validType.join(", ")}`
    );
  }

  return {
    personality: data.personality,
    experience: data.experience,
    verbosity: data.verbosity,
    type: data.type,
  };
}

function loadScenario(filePath: string): Scenario {
  const raw = readFileSync(filePath, "utf-8");
  const data = parseYaml(raw);

  if (!data || typeof data !== "object") {
    throw new Error(`Scenario file ${filePath} must contain a YAML object`);
  }

  if (!data.task || typeof data.task !== "string") {
    throw new Error(`Scenario file ${filePath} must have a "task" string field`);
  }

  if (
    !data.criteria ||
    !Array.isArray(data.criteria) ||
    data.criteria.length === 0
  ) {
    throw new Error(
      `Scenario file ${filePath} must have a non-empty "criteria" array`
    );
  }

  // Criteria must be strings (criteria IDs)
  for (const criterion of data.criteria) {
    if (typeof criterion !== 'string') {
      throw new Error(
        `Scenario ${filePath} criteria must be strings (criteria IDs), got: ${typeof criterion}`
      );
    }
  }

  return {
    task: data.task.trim(),
    criteria: data.criteria.map((c: unknown) => String(c).trim()),
  };
}

function loadTraits(filePath: string): TraitDescriptions {
  const raw = readFileSync(filePath, "utf-8");
  const data = parseYaml(raw);

  if (!data || typeof data !== "object") {
    throw new Error(`Traits file ${filePath} must contain a YAML object`);
  }

  if (!data.personality || !data.experience || !data.verbosity || !data.type) {
    throw new Error(
      `Traits file ${filePath} must have personality, experience, verbosity, and type sections`
    );
  }

  return data as TraitDescriptions;
}

function buildPersonaInstructions(
  persona: Persona,
  traits: TraitDescriptions
): string {
  const sections: string[] = [];

  if (traits.personality[persona.personality]) {
    sections.push(traits.personality[persona.personality].trim());
  }
  if (traits.experience[persona.experience]) {
    sections.push(traits.experience[persona.experience].trim());
  }
  if (traits.verbosity[persona.verbosity]) {
    sections.push(traits.verbosity[persona.verbosity].trim());
  }
  if (traits.type[persona.type]) {
    sections.push(traits.type[persona.type].trim());
  }

  return sections.filter(Boolean).join("\n\n");
}

// --- Public API ---

export function resolveScenarioAndPersona(
  scenarioPath: string,
  personaPath?: string,
  traitsPath?: string
): {
  task: string;
  criteria: string[];
  personaInstructions?: string;
  persona?: { personality: string; experience: string; verbosity: string; type: string };
} {
  const scenario = loadScenario(scenarioPath);

  let personaInstructions: string | undefined;
  let personaObj: Persona | undefined;

  if (personaPath) {
    const persona = loadPersona(personaPath);
    personaObj = persona;

    // Resolve traits.yaml: explicit path > sibling of persona dir > config/traits.yaml
    let traits: TraitDescriptions;
    if (traitsPath) {
      traits = loadTraits(traitsPath);
    } else {
      const fallback = join(dirname(personaPath), "..", "traits.yaml");
      traits = loadTraits(fallback);
    }

    personaInstructions = buildPersonaInstructions(persona, traits);
  }

  return {
    task: scenario.task,
    criteria: scenario.criteria,
    ...(personaInstructions ? { personaInstructions } : {}),
    ...(personaObj ? { persona: personaObj } : {}),
  };
}
