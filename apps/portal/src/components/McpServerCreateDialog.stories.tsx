// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { http, HttpResponse } from "msw";
import type { McpServerDocument } from "@/types";
import { getSelectedProjectId, setSelectedProjectIdHolder } from "@/lib/project-scope";
import { Button } from "@/components/ui/button";
import { McpServerCreateDialog } from "./McpServerCreateDialog";

const existingServers: McpServerDocument[] = [
  {
    _id: "learn-docs",
    name: "Learn Docs",
    type: "http",
    url: "https://learn.example.com/mcp",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

function DialogHarness() {
  const [open, setOpen] = useState(true);
  const [created, setCreated] = useState<string>("");
  const [scopeReady, setScopeReady] = useState(false);

  useEffect(() => {
    const previousProjectId = getSelectedProjectId();
    setSelectedProjectIdHolder("demo-project");
    setScopeReady(true);
    return () => setSelectedProjectIdHolder(previousProjectId);
  }, []);

  if (!scopeReady) return null;

  return (
    <div className="p-6 space-y-2">
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        New MCP server…
      </Button>
      <p data-testid="created" className="text-sm text-muted-foreground">{created}</p>
      <McpServerCreateDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={(server) => {
          setCreated(server._id);
          setOpen(false);
        }}
      />
    </div>
  );
}

const meta = {
  component: McpServerCreateDialog,
  render: () => <DialogHarness />,
  args: {
    open: true,
    onOpenChange: () => {},
    onCreated: () => {},
  },
  tags: ["ai-generated", "needs-work"],
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/v1/mcp/servers", () => HttpResponse.json(existingServers)),
        http.post("*/api/v1/mcp/servers", async ({ request }) => {
          const body = (await request.json()) as Partial<McpServerDocument>;
          return HttpResponse.json(
            { ...body, createdAt: new Date().toISOString() },
            { status: 201 },
          );
        }),
      ],
    },
  },
} satisfies Meta<typeof McpServerCreateDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const DuplicateSlug: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const slug = await page.findByLabelText(/slug/i);
    await userEvent.type(slug, "learn-docs");
    await expect(await page.findByText(/already exists in this project/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /create server/i })).toBeDisabled();
  },
};

export const CreateAndSelect: Story = {
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(await page.findByLabelText(/slug/i), "github-search");
    await userEvent.type(page.getByLabelText(/^url/i), "https://example.com/mcp");
    await userEvent.click(page.getByRole("button", { name: /create server/i }));
    await expect(await canvas.findByText("github-search")).toBeVisible();
  },
};
