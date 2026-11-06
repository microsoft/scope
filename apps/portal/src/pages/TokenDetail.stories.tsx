// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, userEvent, waitFor } from "storybook/test";
import { Route, Routes, useNavigate } from "react-router-dom";

import { TokenDetail } from "./TokenDetail";
import type { KeyDocument, UpdateKeyRequest } from "@/types";

const TOKEN_ID = "demo-foundry-key";
let currentModel = "gpt-4.1";
let validationReadyAt = 0;
let currentComment = "Synthetic key for the model-editing demo";
let lastUpdate: UpdateKeyRequest | undefined;

function makeToken(): KeyDocument {
  const validationComplete = Date.now() >= validationReadyAt;

  return {
    _id: TOKEN_ID,
    type: "azure-ai-foundry",
    capabilities: ["azure-ai-inference"],
    secretName: "demo-foundry-key",
    lastValidationStatus: validationComplete ? "valid" : "unknown",
    lastValidatedAt: validationComplete ? "2026-09-22T08:00:00.000Z" : undefined,
    enabled: true,
    comment: currentComment,
    acquireCount: 3,
    createdAt: "2026-09-22T07:30:00.000Z",
    updatedAt: "2026-09-22T08:00:00.000Z",
    model: currentModel,
  };
}

function TokenDetailDemo() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(`/secrets/keys/${TOKEN_ID}`, { replace: true });
  }, [navigate]);

  return (
    <div className="min-h-screen bg-background p-8">
      <Routes>
        <Route path="/secrets/keys/:id" element={<TokenDetail />} />
        <Route path="*" element={<p className="text-sm text-muted-foreground">Loading demo…</p>} />
      </Routes>
    </div>
  );
}

const meta = {
  title: "Pages/TokenDetail",
  component: TokenDetailDemo,
  tags: ["ai-generated", "needs-work"],
  beforeEach: () => {
    currentModel = "gpt-4.1";
    currentComment = "Synthetic key for the model-editing demo";
    validationReadyAt = 0;
    lastUpdate = undefined;
  },
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get(`/api/v1/keys/${TOKEN_ID}`, () => HttpResponse.json(makeToken())),
        http.put(`/api/v1/keys/${TOKEN_ID}`, async ({ request }) => {
          const body = await request.json() as UpdateKeyRequest;
          lastUpdate = body;
          if (body.comment !== undefined) currentComment = body.comment ?? "";
          if (body.model !== undefined && (body.model ?? "") !== currentModel) {
            currentModel = body.model ?? "";
            validationReadyAt = Date.now() + 1500;
          }
          return HttpResponse.json(makeToken());
        }),
      ],
    },
  },
} satisfies Meta<typeof TokenDetailDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AzureAiFoundryModelEdit: Story = {};

export const MetadataOnlyEdit: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Edit" }));
    await userEvent.clear(canvas.getByRole("textbox", { name: "" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "" }), "Updated metadata only");
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
    await canvas.findByRole("button", { name: "Edit" }, { timeout: 5000 });
    await waitFor(() => expect(lastUpdate).toMatchObject({ comment: "Updated metadata only" }));
    expect(lastUpdate).not.toHaveProperty("model");
    expect(currentModel).toBe("gpt-4.1");
    expect(validationReadyAt).toBe(0);
  },
};

export const UnavailableModelMetadataEdit: Story = {
  ...MetadataOnlyEdit,
  parameters: {
    msw: {
      handlers: [
        http.get(`/api/v1/keys/${TOKEN_ID}`, () => {
          const { model: _model, ...metadata } = makeToken();
          return HttpResponse.json(metadata);
        }),
        http.put(`/api/v1/keys/${TOKEN_ID}`, async ({ request }) => {
          lastUpdate = await request.json() as UpdateKeyRequest;
          currentComment = lastUpdate.comment ?? "";
          const { model: _model, ...metadata } = makeToken();
          return HttpResponse.json(metadata);
        }),
      ],
    },
  },
};
