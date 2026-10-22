// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/AgentBadge", () => ({
  AgentBadge: () => <span>GitHub Copilot CLI</span>,
}));

import * as stories from "./ProfilePicker.stories";

const { BaseProfile, VariationProfile, NoMatchingProfiles, NoAvailableProfiles } = composeStories(stories);

afterEach(cleanup);

describe("ProfilePicker stories", () => {
  it.each([
    ["base profile", BaseProfile, stories.BaseProfile],
    ["variation profile", VariationProfile, stories.VariationProfile],
    ["no matches", NoMatchingProfiles, stories.NoMatchingProfiles],
    ["no available profiles", NoAvailableProfiles, stories.NoAvailableProfiles],
  ] as const)("%s renders and play passes", async (_name, Story, raw) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}><Story /></QueryClientProvider>,
    );
    await raw.play?.({ canvas: within(container) } as Parameters<NonNullable<typeof raw.play>>[0]);
    queryClient.clear();
  });
});
