// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, userEvent, type within } from "storybook/test";
import { Toaster } from "sonner";
import { useProjectContext } from "@/contexts/ProjectContext";
import { ArtifactDownloadButton } from "./ArtifactDownloadButton";

function ProjectSelection({ children }: { children: React.ReactNode }) {
  const { setSelectedProjectId } = useProjectContext();
  useEffect(() => setSelectedProjectId("demo-project"), [setSelectedProjectId]);
  return <>{children}<Toaster /></>;
}

const meta = {
  component: ArtifactDownloadButton,
  tags: ["ai-generated", "needs-work"],
  decorators: [(Story) => <ProjectSelection><Story /></ProjectSelection>],
  args: { url: "/api/v1/requests/demo/runs/attempt-1/archive", children: "Download archive" },
} satisfies Meta<typeof ArtifactDownloadButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready = {
  parameters: { msw: { handlers: [
    http.get("*/api/v1/requests/demo/runs/attempt-1/archive", () => new HttpResponse(
      new Uint8Array([0x1f, 0x8b, 0x08, 0]),
      { headers: { "content-type": "application/gzip", "content-disposition": 'attachment; filename="demo.tar.gz"' } },
    )),
  ] } },
} satisfies Story;

export const PendingAndCancel = {
  parameters: { msw: { handlers: [
    http.get("*/api/v1/requests/demo/runs/attempt-1/archive", async ({ request }) => {
      await new Promise<void>(resolve => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return HttpResponse.error();
    }),
  ] } },
  play: async ({ canvas }: { canvas: ReturnType<typeof within> }) => {
    const action = await canvas.findByRole("button", { name: "Download archive" });
    await expect(action).toBeEnabled();
    await userEvent.click(action);
    await expect(action).toBeDisabled();
    await userEvent.click(await canvas.findByRole("button", { name: "Cancel download" }));
    await expect(action).toBeEnabled();
  },
} satisfies Story;

export const AccessDenied = {
  parameters: { msw: { handlers: [
    http.get("*/api/v1/requests/demo/runs/attempt-1/archive", () => HttpResponse.json(
      { error: "Project access was removed." }, { status: 403 },
    )),
  ] } },
  play: async ({ canvas }: { canvas: ReturnType<typeof within> }) => {
    const action = await canvas.findByRole("button", { name: "Download archive" });
    await userEvent.click(action);
    await expect(await canvas.findByText(/HTTP 403/)).toBeVisible();
  },
} satisfies Story;
