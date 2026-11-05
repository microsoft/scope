// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { getListSectionIcon, navigationIcons, type NavigationIconKey } from "./navigation-icons";

const sections: [string, NavigationIconKey][] = [
  ["runs", "runs"],
  ["reports", "reports"],
  ["report-templates", "reports"],
  ["insights", "insights"],
  ["task-prompts", "prompts"],
  ["criteria", "criteria"],
  ["prompt-features", "features"],
  ["profiles", "profiles"],
  ["skills", "skills"],
  ["codebases", "codebases"],
  ["resources", "resources"],
  ["mcp-servers", "mcp"],
  ["extensions", "extensions"],
  ["agents", "agents"],
  ["models", "models"],
  ["tokens", "secrets"],
  ["accounts", "secrets"],
];

describe("getListSectionIcon", () => {
  it.each(sections)("maps %s to the %s navigation icon", (storageKey, section) => {
    expect(getListSectionIcon(storageKey)).toBe(navigationIcons[section]);
  });

  it.each([undefined, "", "custom-list", "__proto__", "constructor", "toString"])(
    "leaves unregistered storage key %s to the caller's fallback",
    (storageKey) => {
      expect(getListSectionIcon(storageKey)).toBeNull();
    },
  );
});
