// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  Cpu,
  FileText,
  FlaskConical,
  FolderGit2,
  FolderKanban,
  KeyRound,
  Lightbulb,
  List,
  MessageSquareText,
  Puzzle,
  Server,
  SlidersHorizontal,
  Tags,
  type LucideIcon,
} from "lucide-react";

export const navigationIcons = {
  runs: List,
  statistics: BarChart3,
  reports: FileText,
  insights: Lightbulb,
  prompts: MessageSquareText,
  criteria: FlaskConical,
  features: Tags,
  profiles: SlidersHorizontal,
  skills: BookOpen,
  codebases: FolderGit2,
  resources: Boxes,
  mcp: Server,
  extensions: Puzzle,
  agents: Bot,
  models: Cpu,
  secrets: KeyRound,
  projects: FolderKanban,
} as const satisfies Record<string, LucideIcon>;

export type NavigationIconKey = keyof typeof navigationIcons;

const listSectionByStorageKey = {
  runs: "runs",
  reports: "reports",
  "report-templates": "reports",
  insights: "insights",
  "task-prompts": "prompts",
  criteria: "criteria",
  "prompt-features": "features",
  profiles: "profiles",
  skills: "skills",
  codebases: "codebases",
  resources: "resources",
  "mcp-servers": "mcp",
  extensions: "extensions",
  agents: "agents",
  models: "models",
  tokens: "secrets",
  accounts: "secrets",
} as const satisfies Record<string, NavigationIconKey>;

export function getListSectionIcon(storageKey: string | undefined): LucideIcon | null {
  if (!storageKey || !Object.prototype.hasOwnProperty.call(listSectionByStorageKey, storageKey)) {
    return null;
  }

  const section = listSectionByStorageKey[storageKey as keyof typeof listSectionByStorageKey];
  return navigationIcons[section];
}
