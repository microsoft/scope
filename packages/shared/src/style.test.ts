// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { banner, colorLevel, errorText, label, successText, value } from "./style.js";

function withStdoutIsTty(isTTY: boolean, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("style helpers", () => {
  it("emit plain text when stdout is not a TTY", () => {
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("NO_COLOR", undefined);

    withStdoutIsTty(false, () => {
      expect(banner("Scope Server is ready.")).toBe("Scope Server is ready.");
      expect(label("Portal:")).toBe("Portal:");
      expect(value("http://127.0.0.1:45000")).toBe("http://127.0.0.1:45000");
      expect(errorText("Error:")).toBe("Error:");
      expect(successText("OK")).toBe("OK");
      expect(colorLevel("warn")).toBe("WARN ");
    });
  });
});
