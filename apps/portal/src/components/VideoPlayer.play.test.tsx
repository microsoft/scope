// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { composeStories } from "@storybook/react-vite";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as stories from "./VideoPlayer.stories";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";

beforeEach(() => {
  vi.stubGlobal("navigator", { serviceWorker: {
    getRegistrations: async () => [{ scope: window.location.origin + "/", active: { scriptURL: window.location.origin + "/mockServiceWorker.js" } }],
    addEventListener() {}, removeEventListener() {},
  } });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
});
afterEach(() => { cleanup(); localStorage.removeItem(PROJECT_STORAGE_KEY); vi.unstubAllGlobals(); });

describe("VideoPlayer stories", () => {
  for (const [name, Story] of Object.entries(composeStories(stories))) {
    it(name, async () => {
      const { container } = render(<Story />);
      await Story.play?.({ canvas: within(container), canvasElement: container });
    });
  }
});
