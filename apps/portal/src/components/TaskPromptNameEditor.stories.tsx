// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { TaskPromptNameEditor } from "./TaskPromptNameEditor";

/** Stateful harness: saving updates the shown name, like the detail page. */
function EditorHarness({ initialName }: { initialName?: string }) {
  const [name, setName] = useState<string | undefined>(initialName);
  return (
    <TaskPromptNameEditor
      name={name}
      onSave={async (next) => {
        setName(next ?? undefined);
      }}
    />
  );
}

const meta = {
  component: TaskPromptNameEditor,
  tags: ["ai-generated", "needs-work"],
  args: { name: "ecommerce-order-api", onSave: async () => {} },
} satisfies Meta<typeof TaskPromptNameEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A named prompt: edit, rename, and the new name shows. */
export const Named: Story = {
  render: () => <EditorHarness initialName="ecommerce-order-api" />,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Edit name" }));
    const input = canvas.getByLabelText("Task prompt name");
    await userEvent.clear(input);
    await userEvent.type(input, "order-api-v2{Enter}");
    await expect(await canvas.findByText("order-api-v2")).toBeVisible();
  },
};

/** An unnamed prompt shows a placeholder and an "Add name" action. */
export const Unnamed: Story = {
  render: () => <EditorHarness />,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("No name")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Add name" })).toBeVisible();
  },
};

/** A failed save keeps the editor open with the server's error. */
export const SaveError: Story = {
  args: {
    name: undefined,
    onSave: async () => {
      throw new Error("name must be at most 100 characters");
    },
  },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Add name" }));
    await userEvent.type(canvas.getByLabelText("Task prompt name"), "x{Enter}");
    await expect(await canvas.findByText(/at most 100 characters/)).toBeVisible();
  },
};
