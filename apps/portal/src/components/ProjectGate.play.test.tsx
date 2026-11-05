// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { describe, it, afterEach } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import * as projectGate from "./ProjectGate.stories";

const modules: Record<string, Record<string, unknown>> = { projectGate };

afterEach(() => {
  cleanup();
  localStorage.clear();
});

for (const [name, mod] of Object.entries(modules)) {
  describe(name, () => {
    for (const [storyName, raw] of Object.entries(mod)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Story = raw as any;
      if (typeof Story !== "object" || Story === null || !("render" in Story)) {
        continue;
      }
      it(`${storyName} renders and play passes`, async () => {
        const { container } = render(<MemoryRouter><Story.render /></MemoryRouter>);
        if (Story.play) {
          await Story.play({ canvas: within(container), canvasElement: container });
        }
      });
    }
  });
}
