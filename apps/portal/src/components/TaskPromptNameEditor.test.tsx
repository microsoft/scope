// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskPromptNameEditor } from "./TaskPromptNameEditor";

afterEach(cleanup);

/** Open the editor and type `value` into the name input. */
function editTo(value: string) {
  fireEvent.click(screen.getByRole("button", { name: /edit name|add name/i }));
  fireEvent.change(screen.getByLabelText("Task prompt name"), { target: { value } });
}

describe("TaskPromptNameEditor", () => {
  it("shows the name, or a placeholder when there is none", () => {
    const { rerender } = render(<TaskPromptNameEditor name="order-api" onSave={vi.fn()} />);
    expect(screen.getByText("order-api")).toBeTruthy();

    rerender(<TaskPromptNameEditor onSave={vi.fn()} />);
    expect(screen.getByText("No name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add name" })).toBeTruthy();
  });

  it("saves a trimmed new name and closes", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskPromptNameEditor name="old" onSave={onSave} />);

    editTo("  new-name  ");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("new-name"));
    await waitFor(() => expect(screen.queryByLabelText("Task prompt name")).toBeNull());
  });

  it("clears the name when saved empty", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskPromptNameEditor name="old" onSave={onSave} />);

    editTo("   ");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it("does not save an unchanged name", async () => {
    const onSave = vi.fn();
    render(<TaskPromptNameEditor name="same" onSave={onSave} />);

    editTo("same");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(screen.queryByLabelText("Task prompt name")).toBeNull());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the editor open and shows the error when saving fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("name must be at most 100 characters"));
    render(<TaskPromptNameEditor onSave={onSave} />);

    editTo("x");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(await screen.findByText("name must be at most 100 characters")).toBeTruthy();
    expect(screen.getByLabelText("Task prompt name")).toBeTruthy();
  });

  it("cancel discards the draft", () => {
    const onSave = vi.fn();
    render(<TaskPromptNameEditor name="keep" onSave={onSave} />);

    editTo("discard me");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("keep")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});
